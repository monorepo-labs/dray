//! Microphone capture, and the resampling that gets it to what a model eats.
//!
//! Every model here wants **16kHz mono `f32`**, and no capture device offers
//! that: macOS hands back 44.1 or 48kHz, often stereo. So the recorder captures
//! at whatever the device's default config is and converts once at the end
//! rather than per callback — the audio callback runs on a realtime thread,
//! where allocating or resampling risks a dropout, and a dropout is a word the
//! reader has to notice is missing.

use std::sync::{
    atomic::{AtomicU32, Ordering},
    Arc, Mutex,
};

use anyhow::{anyhow, Context, Result};
use cpal::traits::{DeviceTrait, HostTrait, StreamTrait};
use rubato::{
    Resampler as _, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
};
use serde::Serialize;
use ts_rs::TS;

/// What the models take. Not negotiable — a model fed 48kHz transcribes it as
/// speech at three times the speed and answers with nonsense rather than an
/// error.
pub const TARGET_RATE: u32 = 16_000;

/// An input the reader can pick in settings.
#[derive(Debug, Clone, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct InputDevice {
    /// Also the identity: devices are stored and matched by name.
    ///
    /// cpal offers an enumeration index too, and Handy persists that. It is the
    /// wrong key — the order changes when a USB mic is unplugged, so a stored
    /// index silently starts naming a different device.
    pub name: String,
    pub is_default: bool,
}

pub fn list_input_devices() -> Result<Vec<InputDevice>> {
    let host = cpal::default_host();
    let default = host.default_input_device().and_then(|d| d.name().ok());

    let devices = host
        .input_devices()
        .context("could not enumerate input devices")?
        .filter_map(|d| d.name().ok())
        .map(|name| InputDevice {
            is_default: Some(&name) == default.as_ref(),
            name,
        })
        .collect();

    Ok(devices)
}

/// Resolves a stored device name to a live device, falling back to the system
/// default.
///
/// Falling back rather than failing is deliberate: the stored name belongs to a
/// mic that may simply be unplugged right now, and refusing to record because
/// of it would be worse than recording from the built-in one.
fn open_device(preferred: Option<&str>) -> Result<cpal::Device> {
    let host = cpal::default_host();

    if let Some(name) = preferred {
        if let Ok(mut devices) = host.input_devices() {
            if let Some(found) = devices.find(|d| d.name().is_ok_and(|n| n == name)) {
                return Ok(found);
            }
        }
    }

    host.default_input_device()
        .ok_or_else(|| anyhow!("no microphone is available"))
}

/// Whether the speakers are muted right now on a recording's behalf, and what
/// they were before.
///
/// Module-level rather than on the `Recording`, because a recording that is
/// dropped rather than stopped must still put the sound back.
static PRIOR_MUTED: std::sync::Mutex<Option<bool>> = std::sync::Mutex::new(None);

/// Silences the speakers for the duration of a recording. Blocking.
///
/// The microphone hears them, so anything playing lands in the transcript as
/// words nobody said — nothing here can capture the mic and the system's own
/// output separately.
///
/// Best effort throughout: a machine with no output device, or an `osascript`
/// that refuses, records anyway. Failing the press over this would be worse
/// than the audio it is trying to keep out.
pub fn mute_other_audio() {
    let Ok(mut prior) = PRIOR_MUTED.lock() else {
        return;
    };

    // A reading already held is the one from before we touched anything, and
    // the only thing that can put the sound back. Overwriting it with our own
    // `true` is what would leave a machine muted for good.
    if prior.is_some() {
        return;
    }

    let Some(was_muted) = read_muted() else {
        return;
    };

    if set_muted(true) {
        *prior = Some(was_muted);
    }
}

/// Puts the sound back. Harmless where nothing was muted. Blocking.
pub fn restore_other_audio() {
    let Ok(mut prior) = PRIOR_MUTED.lock() else {
        return;
    };

    // Restored to what it was, never unconditionally unmuted: a reader who was
    // already muted before they started talking stays that way.
    let Some(was_muted) = *prior else {
        return;
    };

    // Cleared only once the machine has actually been put back. Taking it
    // first read as tidier and was the one way to leave somebody silent for
    // good: a single failed `osascript` would drop the only record of what to
    // restore, and every later stop would then find nothing to do.
    if set_muted(was_muted) {
        *prior = None;
    }
}

/// Whether the system output is muted, or `None` where it cannot be read.
#[cfg(target_os = "macos")]
fn read_muted() -> Option<bool> {
    parse_muted(&osascript("output muted of (get volume settings) as text").ok()?)
}

#[cfg(target_os = "macos")]
fn set_muted(muted: bool) -> bool {
    osascript(&format!("set volume output muted {muted}")).is_ok()
}

/// Reads `"true"` or `"false"` back out of the AppleScript above.
///
/// Split from the spawn so it is testable, since the failure it guards is
/// silent: a machine with no output device answers `missing value`, and taking
/// that as "not muted" would leave the sound off on the way back out.
fn parse_muted(answer: &str) -> Option<bool> {
    answer.trim().parse().ok()
}

/// Runs one line of AppleScript.
///
/// AppleScript rather than CoreAudio: `set volume` is the documented way to
/// move the *system* output, where the CoreAudio route is a device lookup plus
/// a property write per channel for the same answer.
#[cfg(target_os = "macos")]
fn osascript(line: &str) -> Result<String> {
    let output = std::process::Command::new("/usr/bin/osascript")
        .args(["-e", line])
        .output()
        .context("could not run osascript")?;

    if !output.status.success() {
        return Err(anyhow!(
            "osascript failed: {}",
            String::from_utf8_lossy(&output.stderr).trim()
        ));
    }

    Ok(String::from_utf8_lossy(&output.stdout).trim().to_string())
}

/// Every other target answers as though there were nothing to mute. The
/// setting still draws, since a row that vanishes reads as one the app forgot.
#[cfg(not(target_os = "macos"))]
fn read_muted() -> Option<bool> {
    None
}

#[cfg(not(target_os = "macos"))]
fn set_muted(_muted: bool) -> bool {
    false
}

/// Anything below this peak, over a whole recording, is silence.
///
/// Not zero, because a live-but-muted input still carries dither a hair above
/// it. Well under speech, which peaks near 1.0 — this only has to separate "a
/// device is feeding us something" from "a device is feeding us nothing".
const SILENCE_PEAK: f32 = 1e-4;

/// Seconds of capture the buffer is sized for up front. See `Recording::start`.
const PREALLOC_SECS: usize = 60;

/// A capture in flight. Dropping it stops the stream.
pub struct Recording {
    stream: cpal::Stream,
    tap: Tap,
    /// Loudest sample since the last read, reset by reading it.
    ///
    /// Written from the audio thread as an ordinary atomic rather than pushed
    /// through the sample buffer, so the meter costs the realtime callback one
    /// compare-and-swap and never a lock it could block on. `f32` has no atomic,
    /// so the bits ride a `u32`.
    peak: Arc<AtomicU32>,
}

/// The captured samples, interleaved at the device's rate, and how far the
/// live decoder has read into them.
#[derive(Default)]
struct Capture {
    buf: Vec<f32>,
    /// Samples of `buf` already handed to [`Tap::pull`].
    pulled: usize,
    /// Set by [`Tap::take`] until the live decoder has closed the stretch the
    /// take ended. A pull in that gap would read the *next* stretch's first
    /// samples into the stream being finalized.
    held: bool,
}

/// A handle on a recording's buffer, for the stop, the cut and the live decoder.
#[derive(Clone)]
pub struct Tap {
    capture: Arc<Mutex<Capture>>,
    pub channels: u16,
    pub rate: u32,
}

impl Tap {
    #[cfg(test)]
    pub(super) fn new(channels: u16, rate: u32) -> Self {
        Self { capture: Default::default(), channels, rate }
    }

    #[cfg(test)]
    pub(super) fn push(&self, samples: &[f32]) {
        self.capture.lock().unwrap().buf.extend_from_slice(samples);
    }

    /// Raw samples captured since the last pull. Empty while a take is held.
    pub fn pull(&self) -> Vec<f32> {
        let Ok(mut c) = self.capture.lock() else { return Vec::new() };
        if c.held {
            return Vec::new();
        }
        let new = c.buf[c.pulled..].to_vec();
        c.pulled = c.buf.len();
        new
    }

    /// Lets pulls read the next stretch.
    pub fn release(&self) {
        if let Ok(mut c) = self.capture.lock() {
            c.held = false;
        }
    }

    /// Empties the buffer: the stretch as 16kHz mono, `None` where it held
    /// only silence, and the raw samples no pull has read yet.
    pub fn take(&self) -> Result<(Option<Vec<f32>>, Vec<f32>)> {
        let mut c = self.capture.lock().map_err(|_| anyhow!("recording buffer was poisoned"))?;
        let captured = std::mem::take(&mut c.buf);
        let unpulled = captured[c.pulled.min(captured.len())..].to_vec();
        c.pulled = 0;
        c.held = true;
        drop(c);

        if captured.iter().all(|s| s.abs() < SILENCE_PEAK) {
            return Ok((None, unpulled));
        }

        Ok((Some(resample(to_mono(&captured, self.channels), self.rate)), unpulled))
    }
}

// cpal's `Stream` is `!Send` because some backends tie it to the thread that
// created it. Recording is owned by a `tokio::Mutex` in the manager and only
// ever touched from commands, never moved across a thread while live, so the
// bound is sound here — but it is a promise this module has to keep.
unsafe impl Send for Recording {}

impl Recording {
    /// Opens the device and starts filling a buffer.
    ///
    /// Errors on the stream are logged rather than raised: they arrive on the
    /// audio thread, long after this returns, and the only honest report is
    /// whatever samples were captured before it went wrong.
    pub fn start(preferred_device: Option<&str>) -> Result<Self> {
        let device = open_device(preferred_device)?;
        let config = device
            .default_input_config()
            .context("microphone offers no usable input format")?;

        let channels = config.channels();
        let rate = config.sample_rate().0;
        // Preallocated, and that is about the realtime callback rather than
        // speed. `extend` on a growing `Vec` reallocates by doubling, and each
        // one memcpys the whole buffer *on the audio thread* — at 48kHz stereo
        // the later copies run to tens of megabytes, which is a dropout, which
        // is a word the reader has to notice is missing. A minute of headroom
        // covers dictation; past it the doubling resumes, no worse than before.
        let tap = Tap {
            capture: Arc::new(Mutex::new(Capture {
                buf: Vec::with_capacity(rate as usize * channels as usize * PREALLOC_SECS),
                ..Default::default()
            })),
            channels,
            rate,
        };
        let peak = Arc::new(AtomicU32::new(0));

        let sink = Arc::clone(&tap.capture);
        let level = Arc::clone(&peak);
        let on_error = |e| eprintln!("[transcription capture err] {e}");

        // Only the sample *format* varies; the callback body is the same push in
        // every arm, so each converts to `f32` and appends.
        let stream = match config.sample_format() {
            cpal::SampleFormat::F32 => device.build_input_stream(
                &config.into(),
                move |data: &[f32], _: &_| append(&sink, &level, data.iter().copied()),
                on_error,
                None,
            ),
            cpal::SampleFormat::I16 => device.build_input_stream(
                &config.into(),
                move |data: &[i16], _: &_| {
                    append(
                        &sink,
                        &level,
                        data.iter().map(|s| *s as f32 / i16::MAX as f32),
                    )
                },
                on_error,
                None,
            ),
            cpal::SampleFormat::U16 => device.build_input_stream(
                &config.into(),
                move |data: &[u16], _: &_| {
                    append(
                        &sink,
                        &level,
                        data.iter()
                            .map(|s| (*s as f32 - u16::MAX as f32 / 2.0) / (u16::MAX as f32 / 2.0)),
                    )
                },
                on_error,
                None,
            ),
            other => return Err(anyhow!("unsupported sample format {other:?}")),
        }
        .context("could not open the microphone")?;

        stream.play().context("could not start recording")?;

        Ok(Self { stream, tap, peak })
    }

    pub fn tap(&self) -> Tap {
        self.tap.clone()
    }

    /// Loudest sample since the last call, as 0.0–1.0. Reading resets it, so
    /// successive calls describe successive windows rather than the whole
    /// recording's high-water mark — a meter that only ever rises is not a
    /// meter.
    pub fn level(&self) -> f32 {
        f32::from_bits(self.peak.swap(0, Ordering::Relaxed))
    }

    /// Stops the stream and hands back 16kHz mono.
    ///
    /// Answers `None` where the device fed nothing but zeros. That is the shape
    /// a **denied microphone permission** takes on macOS: the stream opens, the
    /// callbacks fire, and every sample is silence — so without this check the
    /// only symptom is a dictation that transcribes to nothing, which reads as
    /// the model being broken.
    ///
    /// The raw samples beside it are the ones the live decoder has not read yet.
    pub fn finish(self) -> Result<(Option<Vec<f32>>, Vec<f32>)> {
        drop(self.stream);
        self.tap.take()
    }

    /// What has been said so far, taken out of the buffer with the microphone
    /// left open, so the next stretch starts empty. The Notch cuts here to put
    /// a screenshot between two stretches of speech without losing a word to a
    /// stop and a start. Silence answers `None`, as [`Recording::finish`] does.
    pub fn cut(&self) -> Result<(Option<Vec<f32>>, Vec<f32>)> {
        self.tap.take()
    }
}

fn append(
    sink: &Arc<Mutex<Capture>>,
    level: &Arc<AtomicU32>,
    samples: impl Iterator<Item = f32> + Clone,
) {
    let loudest = samples
        .clone()
        .fold(0.0f32, |acc, s| acc.max(s.abs()))
        .to_bits();

    // Keep whichever is louder, so a quiet frame between two loud ones does not
    // blank the meter. `fetch_max` on the bits works because IEEE-754 positive
    // floats order the same as their bit patterns read as integers.
    level.fetch_max(loudest, Ordering::Relaxed);

    // The audio thread must never block or panic, so a poisoned lock drops the
    // frame rather than taking the process down with it.
    if let Ok(mut c) = sink.lock() {
        c.buf.extend(samples);
    }
}

/// Averages interleaved channels down to one.
///
/// Averaging rather than taking the first channel: on a stereo interface the mic
/// is often wired to one side only, and picking the wrong one records silence.
pub(super) fn to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }

    let n = channels as usize;
    samples
        .chunks_exact(n)
        .map(|frame| frame.iter().sum::<f32>() / n as f32)
        .collect()
}

/// Samples per VAD frame: earshot scores 16ms at a time.
const VAD_FRAME: usize = 256;
/// Voiced frames in a row before a run counts as speech (64ms), so a click or
/// a cough on its own keeps nothing.
const VAD_ONSET: usize = 4;
/// Frames kept either side of speech (~460ms), so a soft onset or a trailing
/// consonant the detector scored low still reaches the model. Onset and pad
/// follow Handy's timings.
const VAD_PAD: usize = 29;
const VAD_THRESHOLD: f32 = 0.5;

/// Drops the stretches where nobody is talking, so the model reads less audio.
///
/// Answers the input untouched where no speech is found: the detector missing
/// quiet speech must cost the old speed, never the reader's words.
pub(super) fn trim_silence(audio: Vec<f32>) -> Vec<f32> {
    let mut gate = Gate::default();
    let mut kept = gate.push(&audio);
    kept.extend(gate.finish());

    if kept.is_empty() {
        return audio;
    }
    kept
}

/// The silence trim, fed a piece at a time, so the live decoder and the batch
/// run cut the same audio: speech opens after [`VAD_ONSET`] voiced frames,
/// [`VAD_PAD`] frames before it come along, and [`VAD_PAD`] after it close it.
pub(super) struct Gate {
    detector: Box<earshot::Detector>,
    /// Samples short of a whole frame, carried to the next push.
    partial: Vec<f32>,
    /// Frames not let through yet, kept as lead-in for speech that may start.
    lead: std::collections::VecDeque<Vec<f32>>,
    /// Voiced frames in a row.
    run: usize,
    /// Frames still let through after the last speech.
    tail: usize,
}

impl Default for Gate {
    fn default() -> Self {
        Self {
            detector: earshot::Detector::default_boxed(),
            partial: Vec::new(),
            lead: Default::default(),
            run: 0,
            tail: 0,
        }
    }
}

impl Gate {
    /// The speech in `audio`, in order. Up to [`VAD_PAD`] frames lag behind,
    /// since a frame is only dropped once no speech follows it closely enough.
    pub(super) fn push(&mut self, audio: &[f32]) -> Vec<f32> {
        let mut out = Vec::new();
        self.partial.extend_from_slice(audio);
        let whole = self.partial.len() / VAD_FRAME * VAD_FRAME;
        let frames: Vec<f32> = self.partial.drain(..whole).collect();
        for frame in frames.chunks(VAD_FRAME) {
            self.frame(frame.to_vec(), &mut out);
        }
        out
    }

    /// The last partial frame, scored zero-padded and let through as captured.
    pub(super) fn finish(&mut self) -> Vec<f32> {
        let mut out = Vec::new();
        if !self.partial.is_empty() {
            let last = std::mem::take(&mut self.partial);
            self.frame(last, &mut out);
        }
        out
    }

    fn frame(&mut self, samples: Vec<f32>, out: &mut Vec<f32>) {
        // Clamped because a resampled full-scale signal rings past ±1, which
        // earshot forbids.
        let mut scored = [0.0f32; VAD_FRAME];
        for (f, s) in scored.iter_mut().zip(&samples) {
            *f = s.clamp(-1.0, 1.0);
        }
        let voiced = self.detector.predict_f32(&scored) >= VAD_THRESHOLD;
        self.run = if voiced { self.run + 1 } else { 0 };

        if self.run >= VAD_ONSET {
            out.extend(self.lead.drain(..).flatten());
            out.extend(samples);
            self.tail = VAD_PAD;
        } else if self.tail > 0 {
            out.extend(samples);
            self.tail -= 1;
        } else {
            // Lead-in reaches back VAD_PAD frames from the run's first frame,
            // and the run is ONSET - 1 frames old when it opens.
            self.lead.push_back(samples);
            if self.lead.len() > VAD_PAD + VAD_ONSET - 1 {
                self.lead.pop_front();
            }
        }
    }
}

/// Resamples to [`TARGET_RATE`], returning the input untouched if it is already
/// there or too short to filter.
pub(super) fn resample(samples: Vec<f32>, from_rate: u32) -> Vec<f32> {
    if from_rate == TARGET_RATE || samples.is_empty() {
        return samples;
    }
    let mut resampler = Resampler::new(from_rate);
    let mut out = resampler.push(&samples);
    out.extend(resampler.finish());
    out
}

/// [`resample`], fed a piece at a time. Its own carry-over rather than one
/// filter per piece, so the live decoder hears the same samples a batch run
/// over the whole recording would.
pub(super) struct Resampler {
    /// `None` at the target rate already, or where the filter would not build.
    inner: Option<SincFixedIn<f32>>,
    pending: Vec<f32>,
}

const RESAMPLE_CHUNK: usize = 1024;

impl Resampler {
    pub(super) fn new(from_rate: u32) -> Self {
        let params = SincInterpolationParameters {
            sinc_len: 256,
            f_cutoff: 0.95,
            interpolation: SincInterpolationType::Linear,
            oversampling_factor: 256,
            window: WindowFunction::BlackmanHarris2,
        };
        let ratio = TARGET_RATE as f64 / from_rate as f64;
        let inner = (from_rate != TARGET_RATE)
            .then(|| SincFixedIn::<f32>::new(ratio, 2.0, params, RESAMPLE_CHUNK, 1).ok())
            .flatten();
        Self { inner, pending: Vec::new() }
    }

    pub(super) fn push(&mut self, samples: &[f32]) -> Vec<f32> {
        let Some(inner) = &mut self.inner else { return samples.to_vec() };
        self.pending.extend_from_slice(samples);
        let whole = self.pending.len() / RESAMPLE_CHUNK * RESAMPLE_CHUNK;
        let blocks: Vec<f32> = self.pending.drain(..whole).collect();
        let mut out = Vec::new();
        for block in blocks.chunks(RESAMPLE_CHUNK) {
            Self::process(inner, block.to_vec(), &mut out);
        }
        out
    }

    /// A fixed-size resampler consumes whole chunks, so the tail is zero-padded
    /// to one full chunk rather than dropped — the last fraction of a second is
    /// usually the end of a word.
    pub(super) fn finish(&mut self) -> Vec<f32> {
        let mut out = Vec::new();
        if let Some(inner) = &mut self.inner {
            if !self.pending.is_empty() {
                let mut last = std::mem::take(&mut self.pending);
                last.resize(RESAMPLE_CHUNK, 0.0);
                Self::process(inner, last, &mut out);
            }
        }
        out
    }

    fn process(inner: &mut SincFixedIn<f32>, block: Vec<f32>, out: &mut Vec<f32>) {
        match inner.process(&[block], None) {
            Ok(mut done) if !done.is_empty() => out.append(&mut done[0]),
            Ok(_) => {}
            Err(e) => eprintln!("[transcription resample err] {e}"),
        }
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn mute_state_parses() {
        assert_eq!(parse_muted("true"), Some(true));
        assert_eq!(parse_muted("false\n"), Some(false));
    }

    /// What a machine with no output device answers. Reading it as `false` is
    /// what would leave the sound off after the recording ended.
    #[test]
    fn an_unreadable_output_reads_as_nothing() {
        assert_eq!(parse_muted("missing value"), None);
        assert_eq!(parse_muted(""), None);
    }

    /// "Hello there", 2.5s of nothing, "Goodbye". The pause goes, minus the
    /// pad either side, and both words stay.
    #[test]
    fn trim_cuts_the_pause_and_keeps_the_words() {
        let wav = include_bytes!("fixtures/pause.wav");
        let audio = super::super::recordings::decode(wav).unwrap();
        let secs = |n: usize| n as f32 / TARGET_RATE as f32;

        let energy = |a: &[f32]| a.iter().map(|s| s * s).sum::<f32>();
        let trimmed = trim_silence(audio.clone());
        let kept = secs(trimmed.len());

        assert!(kept < secs(audio.len()) - 1.0, "kept {kept}s of {}s", secs(audio.len()));
        // The pause is digital silence, so every bit of energy is speech:
        // dropping any word drops some of it.
        assert!(energy(&trimmed) > energy(&audio) * 0.999, "speech was cut");
    }

    /// The live decoder gates a piece at a time; it must keep exactly what the
    /// batch trim keeps, or the stream hears different audio than a retry.
    #[test]
    fn the_gate_in_pieces_keeps_what_the_trim_keeps() {
        let audio = super::super::recordings::decode(include_bytes!("fixtures/pause.wav")).unwrap();
        let mut gate = Gate::default();
        let mut pieced: Vec<f32> = audio.chunks(1000).flat_map(|c| gate.push(c)).collect();
        pieced.extend(gate.finish());

        assert_eq!(pieced, trim_silence(audio));
    }

    #[test]
    fn the_resampler_in_pieces_matches_one_pass() {
        let audio: Vec<f32> = (0..48_000 * 2).map(|i| (i as f32 / 37.0).sin() * 0.5).collect();
        let mut resampler = Resampler::new(48_000);
        let mut pieced: Vec<f32> = audio.chunks(777).flat_map(|c| resampler.push(c)).collect();
        pieced.extend(resampler.finish());

        assert_eq!(pieced, resample(audio, 48_000));
    }

    /// A take hands over only what no pull read, and holds pulls off until the
    /// stretch it ended is closed — or the next stretch leaks into it.
    #[test]
    fn a_take_hands_over_the_unpulled_tail_and_holds_pulls() {
        let tap = Tap::new(1, TARGET_RATE);
        tap.push(&[0.5; 10]);
        assert_eq!(tap.pull().len(), 10);
        tap.push(&[0.5; 4]);

        let (audio, unpulled) = tap.take().unwrap();
        assert_eq!(audio.unwrap().len(), 14);
        assert_eq!(unpulled.len(), 4);

        tap.push(&[0.5; 3]);
        assert!(tap.pull().is_empty(), "held until released");
        tap.release();
        assert_eq!(tap.pull().len(), 3);
    }

    /// Nothing the detector calls speech is no reason to send nothing.
    #[test]
    fn trim_keeps_everything_when_it_hears_no_speech() {
        let quiet = vec![0.0f32; TARGET_RATE as usize * 2];

        assert_eq!(trim_silence(quiet.clone()), quiet);
    }

    #[test]
    fn mono_passes_through() {
        let samples = vec![0.1, 0.2, 0.3];

        assert_eq!(to_mono(&samples, 1), samples);
    }

    #[test]
    fn stereo_averages_both_sides() {
        // One side silent is the case that makes averaging worth the arithmetic:
        // taking channel 0 alone would answer zeros here.
        let samples = vec![0.0, 1.0, 0.0, 0.5];

        assert_eq!(to_mono(&samples, 2), vec![0.5, 0.25]);
    }

    /// A trailing partial frame has no second channel to average with, so it is
    /// dropped rather than read past the end of the buffer.
    #[test]
    fn stereo_drops_a_torn_final_frame() {
        assert_eq!(to_mono(&[0.0, 1.0, 0.4], 2), vec![0.5]);
    }

    #[test]
    fn already_at_target_rate_is_untouched() {
        let samples = vec![0.1; 100];

        assert_eq!(resample(samples.clone(), TARGET_RATE), samples);
    }

    #[test]
    fn empty_input_resamples_to_empty() {
        assert!(resample(Vec::new(), 48_000).is_empty());
    }

    /// The check that separates "microphone denied" from "quiet room" — macOS
    /// answers a process with no permission by feeding it exactly this, so
    /// getting the threshold wrong makes the failure invisible again.
    #[test]
    fn digital_silence_is_recognised() {
        let silence = vec![0.0f32; 48_000];

        assert!(silence.iter().all(|s| s.abs() < SILENCE_PEAK));
    }

    /// A muted-but-live input carries dither just above zero, and must still
    /// read as silence rather than as speech.
    #[test]
    fn dither_still_reads_as_silence() {
        let dither: [f32; 4] = [0.0, 1e-6, -2e-6, 5e-7];

        assert!(dither.iter().all(|s| s.abs() < SILENCE_PEAK));
    }

    /// Speech must not be mistaken for silence. Quiet speech peaks far above
    /// the threshold, so the margin here is deliberately large.
    #[test]
    fn quiet_speech_is_not_silence() {
        let speech: [f32; 3] = [0.0, 0.01, -0.004];

        assert!(speech.iter().any(|s| s.abs() >= SILENCE_PEAK));
    }

    /// Downsampling 48k to 16k should land near a third of the samples. Loose
    /// bounds, since the filter's own delay moves the exact count.
    #[test]
    fn downsampling_lands_near_a_third() {
        let out = resample(vec![0.0; 48_000], 48_000);

        assert!(
            (12_000..=20_000).contains(&out.len()),
            "48k of silence became {} samples",
            out.len()
        );
    }
}
