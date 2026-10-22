//! Transcribing while the reader is still talking, on models that stream.
//!
//! A worker borrows the model for the length of a recording, pulls what the
//! microphone caught every [`PULL_EVERY`], and feeds the speech in it to the
//! model's stream — so a stop only has the last fraction of a second left to
//! decode. Measured on Parakeet over a 56s clip: ~0.2s from stop to text,
//! against ~1.1s for the batch run.
//!
//! **Only speech reaches the stream**, through the same [`Gate`] the batch run
//! trims with. Fed every sample, the stream dropped the first word after an
//! 8s pause; fed the speech alone it wrote what the batch run wrote.
//!
//! **Every way the stream can fail ends in the batch run**, on the same model
//! in the same thread: a load that lands after the stop, a stream that errors,
//! one that answers nothing. The worker keeps the whole stretch at 16kHz for
//! that, since the model is lent here and a batch run elsewhere would find the
//! slot empty and load a second copy.

use std::sync::mpsc::{self, RecvTimeoutError};
use std::time::Duration;

use anyhow::Result;
use tokio::sync::oneshot;
use transcribe_cpp::{RunOptions, Session, Stream, StreamOptions};

use super::audio::{to_mono, Gate, Resampler, Tap};
use super::catalog::TranscriptionModel;
use super::download;
use super::engine::{run_whole, Engine};

/// How often the worker reads the microphone's buffer. Short enough that a stop
/// finds little unread, long enough that a feed is worth its call.
const PULL_EVERY: Duration = Duration::from_millis(160);

/// Unread audio at a stop or cut past which the stream is skipped for the batch
/// run. Feeding runs at ~5x real time, so a backlog this size — a stop landing
/// before the model had loaded — decodes slower streamed than in one run.
const BACKLOG_SECS: usize = 2;

/// What the model made of a stretch, and which model made it.
pub struct Heard {
    pub model_id: &'static str,
    pub text: Result<String>,
}

enum Ask {
    /// Close the stretch and start the next. No reply means the stretch is
    /// thrown away rather than transcribed — a cut that caught only silence.
    Cut { unpulled: Vec<f32>, reply: Option<oneshot::Sender<Heard>> },
    Finish { unpulled: Vec<f32>, reply: oneshot::Sender<Heard> },
}

/// A recording's live decode. Dropping it abandons the stream and hands the
/// model back.
pub struct Live {
    tx: mpsc::Sender<Ask>,
}

impl Live {
    /// Starts loading `model` and, if it streams, decoding `tap` as it fills.
    ///
    /// Also the press's warm: a model that cannot stream is loaded and left in
    /// the slot for the batch run at the stop.
    pub fn start(engine: Engine, model: &'static TranscriptionModel, tap: Tap) -> Self {
        // Taken before any await, for `warm_selected`'s old reason: a switch
        // landing in a gap would otherwise be adopted as this load's own.
        let token = engine.token();
        let (tx, rx) = mpsc::channel();

        tauri::async_runtime::spawn(async move {
            let Ok(path) = download::model_path(model).await else { return };
            let Some((session, loan)) = engine.lend(token, model.id, &path).await else { return };

            let decoded = tokio::task::spawn_blocking(move || decode(session, &tap, &rx, model.id)).await;
            let Ok((session, last)) = decoded else { return };

            // Back in the slot before the stop hears anything, so whatever it
            // does next finds the model where it expects it.
            engine.give_back(token, model.id, session, loan).await;
            if let Some((reply, heard)) = last {
                let _ = reply.send(heard);
            }
        });

        Self { tx }
    }

    /// Closes the stretch a cut just took. `transcribe` false throws it away.
    ///
    /// Sent now, answered later: the caller sends under the same lock its
    /// take ran under, so a stop cannot reach the worker ahead of the cut.
    pub fn cut(&self, unpulled: Vec<f32>, transcribe: bool) -> Pending {
        let (reply, answer) = oneshot::channel();
        let reply = transcribe.then_some(reply);
        Pending(self.tx.send(Ask::Cut { unpulled, reply }).ok().map(|_| answer))
    }

    /// Closes the recording.
    pub fn finish(self, unpulled: Vec<f32>) -> Pending {
        let (reply, answer) = oneshot::channel();
        Pending(self.tx.send(Ask::Finish { unpulled, reply }).ok().map(|_| answer))
    }
}

/// The worker's answer to a cut or a stop, still on its way.
pub struct Pending(Option<oneshot::Receiver<Heard>>);

impl Pending {
    /// `None` where nothing was decoding live.
    pub async fn heard(self) -> Option<Heard> {
        self.0?.await.ok()
    }
}

/// The worker. Hands the session back, with the stop's reply when there was one.
fn decode(
    mut session: Session,
    tap: &Tap,
    rx: &mpsc::Receiver<Ask>,
    model_id: &'static str,
) -> (Session, Option<(oneshot::Sender<Heard>, Heard)>) {
    loop {
        let mut stretch = Stretch::new(tap);
        let mut stream = session.stream(&RunOptions::default(), &StreamOptions::default()).ok();

        let ask = loop {
            match rx.recv_timeout(PULL_EVERY) {
                Ok(ask) => break ask,
                Err(RecvTimeoutError::Timeout) => {
                    let speech = stretch.push(&tap.pull());
                    feed(&mut stream, &speech);
                }
                Err(RecvTimeoutError::Disconnected) => {
                    drop(stream);
                    return (session, None);
                }
            }
        };

        let (unpulled, reply, last) = match ask {
            Ask::Cut { unpulled, reply } => (unpulled, reply, false),
            Ask::Finish { unpulled, reply } => (unpulled, Some(reply), true),
        };

        let heard = if reply.is_some() {
            let behind = unpulled.len() / tap.channels.max(1) as usize > tap.rate as usize * BACKLOG_SECS;
            if behind {
                stream = None;
            }
            let speech = stretch.close(&unpulled);
            feed(&mut stream, &speech);
            let streamed = stream.as_mut().and_then(|s| {
                s.finalize().ok()?;
                Some(s.text().full.trim().to_string()).filter(|t| !t.is_empty())
            });
            drop(stream);
            let text = match streamed {
                Some(text) => Ok(text),
                None => run_whole(&mut session, stretch.heard),
            };
            Some(Heard { model_id, text })
        } else {
            drop(stream);
            None
        };

        if last {
            return (session, reply.zip(heard));
        }
        if let (Some(reply), Some(heard)) = (reply, heard) {
            let _ = reply.send(heard);
        }
        tap.release();
    }
}

/// Feeds speech to a live stream, giving it up on the first error — the
/// batch run at the close reads the whole stretch instead.
fn feed(stream: &mut Option<Stream<'_>>, speech: &[f32]) {
    if speech.is_empty() {
        return;
    }
    if let Some(s) = stream {
        if let Err(e) = s.feed(speech) {
            eprintln!("[transcription stream err] {e}");
            *stream = None;
        }
    }
}

/// One stretch of a recording on its way to 16kHz mono speech.
struct Stretch {
    channels: u16,
    resampler: Resampler,
    gate: Gate,
    /// Everything heard, at 16kHz, for the batch run if the stream fails.
    heard: Vec<f32>,
}

impl Stretch {
    fn new(tap: &Tap) -> Self {
        Self {
            channels: tap.channels,
            resampler: Resampler::new(tap.rate),
            gate: Gate::default(),
            heard: Vec::new(),
        }
    }

    /// The speech in newly captured raw samples.
    fn push(&mut self, raw: &[f32]) -> Vec<f32> {
        let audio = self.resampler.push(&to_mono(raw, self.channels));
        self.heard.extend_from_slice(&audio);
        self.gate.push(&audio)
    }

    /// The speech in the last raw samples, and whatever the filters held back.
    fn close(&mut self, raw: &[f32]) -> Vec<f32> {
        let mut speech = self.push(raw);
        let tail = self.resampler.finish();
        self.heard.extend_from_slice(&tail);
        speech.extend(self.gate.push(&tail));
        speech.extend(self.gate.finish());
        speech
    }
}
