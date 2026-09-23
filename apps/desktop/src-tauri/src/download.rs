//! Streaming a large file to disk, verified before anything believes it.
//!
//! Chromium and the transcription models share the shape: hundreds of
//! megabytes into a `.part`, hashed as it lands, size and sha256 checked
//! before the caller renames it into place, progress reported every few
//! megabytes. The failure both guard against is the quiet one — a truncated
//! file that loads far enough to produce garbage rather than an error.

use std::path::Path;

use anyhow::{bail, Context, Result};
use sha2::{Digest, Sha256};
use tokio::{
    fs,
    io::{AsyncWriteExt, BufWriter},
};

/// Raised when the reader called the download off. Carried as an error so the
/// `.part` cleanup and the cancelled state share one path out.
#[derive(Debug)]
pub struct Cancelled;

impl std::fmt::Display for Cancelled {
    fn fmt(&self, f: &mut std::fmt::Formatter<'_>) -> std::fmt::Result {
        write!(f, "download cancelled")
    }
}

impl std::error::Error for Cancelled {}

/// Streams `url` into `part`, refusing the result unless it is exactly `size`
/// bytes hashing to `sha256`.
///
/// `cancelled` is asked between chunks — the one point where giving up leaves
/// nothing half written that the caller has to reason about — and `true`
/// answers [`Cancelled`]. `on_progress` is called with the bytes received
/// roughly every 4MB: one event per chunk is thousands of round trips to the
/// webview for a bar that redraws at screen resolution.
pub async fn download_verified(
    url: &str,
    part: &Path,
    size: u64,
    sha256: &str,
    mut cancelled: impl FnMut() -> bool,
    mut on_progress: impl FnMut(u64),
) -> Result<()> {
    let mut response = reqwest::get(url)
        .await
        .context("could not reach the download server")?;
    if !response.status().is_success() {
        bail!("download failed with status {}", response.status());
    }

    let file = fs::File::create(part)
        .await
        .context("could not open the download file")?;
    let mut writer = BufWriter::new(file);
    let mut hasher = Sha256::new();
    let mut received = 0u64;
    let mut last_emit = 0u64;

    while let Some(chunk) = response.chunk().await.context("the download was interrupted")? {
        if cancelled() {
            return Err(Cancelled.into());
        }

        hasher.update(&chunk);
        writer
            .write_all(&chunk)
            .await
            .context("could not write the download to disk")?;
        received += chunk.len() as u64;

        if received - last_emit >= 4 << 20 {
            last_emit = received;
            on_progress(received);
        }
    }
    writer
        .flush()
        .await
        .context("could not finish writing the download")?;

    if received != size {
        bail!("downloaded {received} bytes where {size} were expected");
    }
    if format!("{:x}", hasher.finalize()) != sha256 {
        bail!("the download does not match its published checksum");
    }
    Ok(())
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The pinned hashes are compared against this spelling, so a hex that
    /// stopped zero-padding would fail every download silently.
    #[test]
    fn a_digest_prints_as_the_pinned_spelling() {
        let digest = format!("{:x}", Sha256::digest(b""));

        assert_eq!(
            digest,
            "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855"
        );
        assert_eq!(digest.len(), 64);
    }
}
