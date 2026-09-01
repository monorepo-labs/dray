//! Where a dictation's audio waits while the model runs.
//!
//! The samples used to be handed straight into the engine by value, so a run
//! that failed took them with it and the only cure was saying the whole thing
//! again. Ten minutes of speech is too much to lose to a model that could not
//! load, so every stop parks its audio here first and the file is deleted the
//! moment words come back.
//!
//! **16-bit PCM, not the captured `f32`.** Half the size for something that can
//! reach hundreds of megabytes over a long dictation, playable by anything the
//! reader might open it with, and the quantization sits ~96dB below anything a
//! speech model reads.

use std::path::{Path, PathBuf};
use std::time::{Duration, SystemTime};

use anyhow::{anyhow, bail, Context, Result};
use tokio::fs;
use uuid::Uuid;

use super::audio::TARGET_RATE;
use crate::store::get_home_app_dir;

/// How long a recording nobody came back for is kept.
///
/// Only failures ever reach this: a run that answers is deleted on the spot.
const RETAIN: Duration = Duration::from_secs(7 * 24 * 60 * 60);

const BITS: u16 = 16;
const CHANNELS: u16 = 1;
const HEADER_LEN: usize = 44;

/// `~/.dray/recordings/`, created on demand.
///
/// Beside the models and transcripts rather than in the OS temp directory,
/// which the system is entitled to empty without asking — the whole point of
/// the file is that it outlives the failure.
pub async fn dir() -> Result<PathBuf> {
    let dir = get_home_app_dir().await?.join("recordings");
    fs::create_dir_all(&dir)
        .await
        .context("could not create the recordings directory")?;

    Ok(dir)
}

/// Writes one recording and answers where it landed.
///
/// The name is a v7 uuid rather than a timestamp: two stops inside one second
/// would collide, and a collision here silently destroys the recording a reader
/// is on their way back to retry.
pub async fn save(samples: &[f32]) -> Result<PathBuf> {
    let path = dir().await?.join(format!("{}.wav", Uuid::now_v7()));

    fs::write(&path, encode(samples))
        .await
        .with_context(|| format!("could not write {}", path.display()))?;

    prune().await;

    Ok(path)
}

/// Reads one back, refusing any path outside [`dir`].
///
/// The path arrives from the frontend, so it is checked rather than trusted —
/// this command opens a file and hands its contents to a model, and the
/// directory is the only thing that says which files it may.
pub async fn read(path: &Path) -> Result<Vec<f32>> {
    let home = dir().await?;
    if path.parent() != Some(home.as_path()) {
        bail!("{} is not a saved recording", path.display());
    }

    let bytes = fs::read(path)
        .await
        .with_context(|| format!("could not read {}", path.display()))?;

    decode(&bytes)
}

/// Throws a recording away. Best effort: a file that will not delete is worth
/// no error, since the work it was insurance for has already succeeded.
pub async fn discard(path: &Path) {
    if let Err(e) = fs::remove_file(path).await {
        eprintln!("[recording cleanup err] {e}");
    }
}

/// Deletes recordings older than [`RETAIN`].
///
/// Run on write rather than at startup, since that is the one moment something
/// is definitely being added — and a reader who never dictates again should not
/// have the app tidying up behind them for nothing.
async fn prune() {
    let Ok(home) = dir().await else { return };
    let Ok(mut entries) = fs::read_dir(&home).await else {
        return;
    };

    while let Ok(Some(entry)) = entries.next_entry().await {
        let stale = entry
            .metadata()
            .await
            .and_then(|m| m.modified())
            .map(|t| SystemTime::now().duration_since(t).unwrap_or_default() > RETAIN)
            .unwrap_or(false);

        if stale {
            let _ = fs::remove_file(entry.path()).await;
        }
    }
}

/// Mono 16kHz `f32` to a WAV file.
fn encode(samples: &[f32]) -> Vec<u8> {
    let data_len = samples.len() * 2;
    let mut out = Vec::with_capacity(HEADER_LEN + data_len);

    let block_align = CHANNELS * BITS / 8;

    out.extend(b"RIFF");
    out.extend((36 + data_len as u32).to_le_bytes());
    out.extend(b"WAVEfmt ");
    out.extend(16u32.to_le_bytes());
    out.extend(1u16.to_le_bytes()); // PCM
    out.extend(CHANNELS.to_le_bytes());
    out.extend(TARGET_RATE.to_le_bytes());
    out.extend((TARGET_RATE * block_align as u32).to_le_bytes());
    out.extend(block_align.to_le_bytes());
    out.extend(BITS.to_le_bytes());
    out.extend(b"data");
    out.extend((data_len as u32).to_le_bytes());

    for s in samples {
        // Clamped before the cast: `as` saturates in Rust, but the multiply can
        // land on 32768.0 from a sample of exactly 1.0, and rounding a hair
        // past full scale is a click at the loudest moment of the recording.
        let scaled = (s.clamp(-1.0, 1.0) * i16::MAX as f32) as i16;
        out.extend(scaled.to_le_bytes());
    }

    out
}

/// The inverse, walking chunks rather than assuming a 44-byte header.
///
/// Only files this module wrote ever reach it, so the walk is cheap insurance
/// rather than generality — but a header read at the wrong offset yields audio
/// that transcribes to nonsense instead of failing, which is the shape of bug
/// worth spending fifteen lines to make impossible.
fn decode(bytes: &[u8]) -> Result<Vec<f32>> {
    if bytes.len() < 12 || &bytes[0..4] != b"RIFF" || &bytes[8..12] != b"WAVE" {
        bail!("not a WAV file");
    }

    let mut at = 12;
    while at + 8 <= bytes.len() {
        let id = &bytes[at..at + 4];
        let len = u32::from_le_bytes(bytes[at + 4..at + 8].try_into()?) as usize;
        let body = at + 8;

        if id == b"data" {
            let end = (body + len).min(bytes.len());
            return Ok(bytes[body..end]
                .chunks_exact(2)
                .map(|b| i16::from_le_bytes([b[0], b[1]]) as f32 / i16::MAX as f32)
                .collect());
        }

        // Chunks are word-aligned: an odd length carries a pad byte that is not
        // counted in it, and ignoring that walks every later chunk off by one.
        at = body + len + (len & 1);
    }

    Err(anyhow!("the WAV file carries no audio"))
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn round_trips_within_quantization() {
        let samples: Vec<f32> = (0..1000).map(|i| (i as f32 / 100.0).sin()).collect();

        let back = decode(&encode(&samples)).expect("decodes");

        assert_eq!(back.len(), samples.len());
        for (a, b) in samples.iter().zip(&back) {
            assert!((a - b).abs() < 1e-4, "{a} became {b}");
        }
    }

    #[test]
    fn header_names_the_rate_the_models_want() {
        let wav = encode(&[0.0; 8]);

        assert_eq!(&wav[0..4], b"RIFF");
        assert_eq!(&wav[8..12], b"WAVE");
        assert_eq!(u32::from_le_bytes(wav[24..28].try_into().unwrap()), TARGET_RATE);
        assert_eq!(u32::from_le_bytes(wav[4..8].try_into().unwrap()) as usize, wav.len() - 8);
    }

    /// Full scale must not wrap to the opposite rail, which is the loudest
    /// possible click in the middle of a word.
    #[test]
    fn full_scale_stays_positive() {
        let back = decode(&encode(&[1.0, -1.0, 2.0, -2.0])).expect("decodes");

        assert!(back[0] > 0.99 && back[2] > 0.99);
        assert!(back[1] < -0.99 && back[3] < -0.99);
    }

    #[test]
    fn a_file_with_no_data_chunk_is_an_error() {
        let mut wav = encode(&[0.1; 4]);
        wav[36..40].copy_from_slice(b"junk");

        assert!(decode(&wav).is_err());
    }

    #[test]
    fn rubbish_is_not_read_as_audio() {
        assert!(decode(b"not a wav at all").is_err());
    }
}
