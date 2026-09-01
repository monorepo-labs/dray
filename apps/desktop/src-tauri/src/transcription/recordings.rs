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
///
/// **Both sides are canonicalized, and comparing the lexical parent is not
/// enough.** `..` is caught either way, but a symlink *inside* the directory
/// pointing anywhere on disk passes a lexical check while resolving somewhere
/// this has no business reading — and the contents would then be transcribed
/// into the reader's draft. Resolving first is what makes the boundary the
/// directory rather than the spelling of the path.
pub async fn read(path: &Path) -> Result<Vec<f32>> {
    let home = fs::canonicalize(dir().await?).await?;
    let real = fs::canonicalize(path)
        .await
        .with_context(|| format!("{} is not there any more", path.display()))?;

    // `is_file` as well as the parent: a directory or a device node under this
    // directory is not a recording, and reading one is not a thing to attempt.
    let ours = real.parent() == Some(home.as_path())
        && fs::metadata(&real).await.is_ok_and(|m| m.is_file());

    if !ours {
        bail!("{} is not a saved recording", path.display());
    }

    let bytes = fs::read(&real)
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
/// Run at startup as well as on write, and the startup half is the one that
/// makes the retention true rather than nearly true: pruning on write alone
/// leaves the *last* failed recording on disk forever, since the sweep that
/// would clear it only runs when another one is written. A reader who gives up
/// on dictation after one failure is exactly who keeps that file.
pub async fn prune() {
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
            // Clamped rather than refused, deliberately. A file shorter than
            // its header claims is one a killed process left half-written, and
            // this whole feature exists to get a reader's words back — most of
            // a dictation beats an error saying the file was untidy.
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

    /// Splices a chunk in ahead of `fmt `, so everything after it is found only
    /// if the walk advanced by the right amount.
    fn with_leading_chunk(id: &[u8; 4], body: &[u8], samples: &[f32]) -> Vec<u8> {
        let tail = encode(samples);
        let mut wav = tail[..12].to_vec();

        wav.extend(id);
        wav.extend((body.len() as u32).to_le_bytes());
        wav.extend(body);
        if body.len() % 2 == 1 {
            wav.push(0); // the pad byte, which the length does not count
        }
        wav.extend(&tail[12..]);

        // The size field counts everything after it, and the walk does not read
        // it — but a fixture that lies about its own length is one nobody can
        // trust a later failure against.
        let size = (wav.len() - 8) as u32;
        wav[4..8].copy_from_slice(&size.to_le_bytes());

        wav
    }

    /// The pad byte is the trap: an odd chunk length does not count it, so a
    /// walk that trusts the length alone lands one byte into every later chunk
    /// and finds no `data` at all.
    #[test]
    fn an_odd_length_chunk_does_not_shift_the_walk() {
        let samples = [0.5, -0.5, 0.25];

        let back = decode(&with_leading_chunk(b"JUNK", b"odd", &samples)).expect("decodes");

        assert_eq!(back.len(), samples.len());
        assert!((back[0] - 0.5).abs() < 1e-4);
    }

    /// The even case has no pad byte, so adding one would break it just as
    /// surely — both halves of the rule need a witness.
    #[test]
    fn an_even_length_chunk_does_not_shift_the_walk() {
        let samples = [0.5, -0.5];

        let back = decode(&with_leading_chunk(b"LIST", b"even", &samples)).expect("decodes");

        assert_eq!(back.len(), samples.len());
    }

    /// A file cut short mid-write answers with the audio that survived rather
    /// than an error. Pinned because it is a judgement, not an oversight: this
    /// feature exists to give a reader their words back, and most of a
    /// dictation beats a refusal.
    #[test]
    fn a_truncated_file_yields_what_is_there() {
        let mut wav = encode(&[0.5; 100]);
        wav.truncate(wav.len() - 100);

        assert_eq!(decode(&wav).expect("decodes").len(), 50);
    }

    /// A header naming a chunk longer than the file must not panic on the
    /// slice, which is the same clamp read from the other side.
    #[test]
    fn a_data_length_past_the_end_is_survivable() {
        let mut wav = encode(&[0.5; 4]);
        let len = wav.len();
        wav[len - 12..len - 8].copy_from_slice(&u32::MAX.to_le_bytes());

        assert_eq!(decode(&wav).expect("decodes").len(), 4);
    }
}
