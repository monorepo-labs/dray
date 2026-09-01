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
    Resampler, SincFixedIn, SincInterpolationParameters, SincInterpolationType, WindowFunction,
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
    samples: Arc<Mutex<Vec<f32>>>,
    /// Loudest sample since the last read, reset by reading it.
    ///
    /// Written from the audio thread as an ordinary atomic rather than pushed
    /// through the sample buffer, so the meter costs the realtime callback one
    /// compare-and-swap and never a lock it could block on. `f32` has no atomic,
    /// so the bits ride a `u32`.
    peak: Arc<AtomicU32>,
    channels: u16,
    rate: u32,
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
        let samples = Arc::new(Mutex::new(Vec::<f32>::with_capacity(
            rate as usize * channels as usize * PREALLOC_SECS,
        )));
        let peak = Arc::new(AtomicU32::new(0));

        let sink = Arc::clone(&samples);
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

        Ok(Self {
            stream,
            samples,
            peak,
            channels,
            rate,
        })
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
    pub fn finish(self) -> Result<Option<Vec<f32>>> {
        drop(self.stream);

        let captured = self
            .samples
            .lock()
            .map_err(|_| anyhow!("recording buffer was poisoned"))?
            .clone();

        if captured.iter().all(|s| s.abs() < SILENCE_PEAK) {
            return Ok(None);
        }

        Ok(Some(resample(to_mono(&captured, self.channels), self.rate)))
    }
}

fn append(
    sink: &Arc<Mutex<Vec<f32>>>,
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
    if let Ok(mut buf) = sink.lock() {
        buf.extend(samples);
    }
}

/// Averages interleaved channels down to one.
///
/// Averaging rather than taking the first channel: on a stereo interface the mic
/// is often wired to one side only, and picking the wrong one records silence.
fn to_mono(samples: &[f32], channels: u16) -> Vec<f32> {
    if channels <= 1 {
        return samples.to_vec();
    }

    let n = channels as usize;
    samples
        .chunks_exact(n)
        .map(|frame| frame.iter().sum::<f32>() / n as f32)
        .collect()
}

/// Resamples to [`TARGET_RATE`], returning the input untouched if it is already
/// there or too short to filter.
fn resample(samples: Vec<f32>, from_rate: u32) -> Vec<f32> {
    if from_rate == TARGET_RATE || samples.is_empty() {
        return samples;
    }

    let params = SincInterpolationParameters {
        sinc_len: 256,
        f_cutoff: 0.95,
        interpolation: SincInterpolationType::Linear,
        oversampling_factor: 256,
        window: WindowFunction::BlackmanHarris2,
    };

    let ratio = TARGET_RATE as f64 / from_rate as f64;
    let chunk = 1024;

    let Ok(mut resampler) = SincFixedIn::<f32>::new(ratio, 2.0, params, chunk, 1) else {
        return samples;
    };

    let mut out = Vec::with_capacity((samples.len() as f64 * ratio) as usize);

    // A fixed-size resampler consumes whole chunks, so the tail is zero-padded
    // to one full chunk rather than dropped — the last fraction of a second is
    // usually the end of a word.
    for block in samples.chunks(chunk) {
        let mut padded = block.to_vec();
        padded.resize(chunk, 0.0);

        match resampler.process(&[padded], None) {
            Ok(mut done) if !done.is_empty() => out.append(&mut done[0]),
            Ok(_) => {}
            Err(e) => {
                eprintln!("[transcription resample err] {e}");
                return samples;
            }
        }
    }

    out
}

#[cfg(test)]
mod tests {
    use super::*;

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
