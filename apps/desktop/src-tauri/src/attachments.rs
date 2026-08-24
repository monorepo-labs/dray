//! What the composer's `+` button, its drop target, and its ⌘⌥O produce, and
//! how those reach the CLI.
//!
//! Two kinds travel two ways, and the split is the API's, not a preference.
//! An **image** the model can look at becomes a base64 `image` content block on
//! the same stdin line as the prompt. Anything else becomes an `@path` mention
//! appended to the prompt text — the CLI already parses those, reads the file
//! itself, and injects it before the model turn, so a 40MB CSV costs a path
//! rather than a context window. That means a non-image attachment needs no
//! wire surface at all: it is prompt text by the time it leaves here.
use anyhow::{Context, Result};
use base64::{engine::general_purpose::STANDARD, Engine};
use serde::{Deserialize, Serialize};
use std::path::{Path, PathBuf};
use tokio::fs;
use ts_rs::TS;
use uuid::Uuid;

use crate::{events::ImageRef, store::get_home_app_dir};

/// The four the Anthropic API accepts as an `image` block. An extension outside
/// this set is a file, whatever it depicts — an SVG or a HEIC screenshot is
/// handed over as a path instead of being sent as bytes the API would refuse.
const IMAGE_TYPES: &[(&str, &str)] = &[
    ("png", "image/png"),
    ("jpg", "image/jpeg"),
    ("jpeg", "image/jpeg"),
    ("gif", "image/gif"),
    ("webp", "image/webp"),
];

/// The API's per-image ceiling. Over it the send would be rejected outright, so
/// the file degrades to a mention here rather than failing the turn — the model
/// can still open it with a tool.
const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

/// One thing the user attached, as the composer needs to draw it.
#[derive(Debug, Clone, Serialize, Deserialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "camelCase")]
pub struct Attachment {
    /// Where it was picked from. This is the identity the composer dedupes on
    /// and the path the backend re-reads at send time — nothing but paths
    /// crosses back down, so a 4MB preview is never uploaded twice.
    pub path: String,
    pub name: String,
    /// Only meaningful for an image; `None` says nothing about the file beyond
    /// "not something we send as pixels".
    pub mime_type: Option<String>,
    pub size: u64,
    /// Whether this will travel as an image block. Decided by extension *and*
    /// size together, so the composer's thumbnail and the wire agree.
    pub is_image: bool,
    /// A `data:` URL for the composer's thumbnail, `None` for a file. Sent up
    /// once and held in frontend memory only — the persisted event points at a
    /// copy on disk instead, so the session log never carries image bytes.
    pub preview: Option<String>,
}

/// An image ready to go down the pipe, plus where it was archived so the
/// transcript can still show it after the original is moved or deleted.
pub struct PreparedImage {
    pub stored_path: String,
    pub mime_type: String,
    pub data: String,
}

/// The prompt as the CLI should see it, with everything attached folded in.
#[derive(Default)]
pub struct Prepared {
    /// The user's text with an `@path` mention appended per non-image
    /// attachment. This is what gets persisted as the user's own message, so
    /// the transcript shows the same mentions the model was given.
    pub text: String,
    pub images: Vec<PreparedImage>,
}

fn image_mime(path: &Path) -> Option<&'static str> {
    let ext = path.extension()?.to_str()?.to_ascii_lowercase();
    IMAGE_TYPES
        .iter()
        .find(|(e, _)| *e == ext)
        .map(|(_, mime)| *mime)
}

/// Reads one path into the shape the composer draws. Errors for a directory or
/// an unreadable path, which the command below drops rather than propagating —
/// dragging a folder in alongside two files should attach the two files.
async fn describe(path: &str) -> Result<Attachment> {
    let meta = fs::metadata(path).await.context("could not stat path")?;
    if meta.is_dir() {
        anyhow::bail!("{path} is a directory");
    }

    let size = meta.len();
    let buf = PathBuf::from(path);
    let name = buf
        .file_name()
        .map(|n| n.to_string_lossy().into_owned())
        .unwrap_or_else(|| path.to_string());

    let mime = image_mime(&buf);
    let is_image = mime.is_some() && size <= MAX_IMAGE_BYTES;

    // Read only for a thumbnail we will actually draw. The bytes are re-read at
    // send time; paying twice is cheaper than holding every attachment's data
    // in the frontend and shipping it back down.
    let preview = if is_image {
        let bytes = fs::read(path).await.context("could not read image")?;
        Some(format!(
            "data:{};base64,{}",
            mime.unwrap_or("image/png"),
            STANDARD.encode(&bytes)
        ))
    } else {
        None
    };

    Ok(Attachment {
        path: path.to_string(),
        name,
        mime_type: mime.map(str::to_string),
        size,
        is_image,
        preview,
    })
}

/// Describes every path that can be attached, silently skipping the rest.
pub async fn read_attachments(paths: Vec<String>) -> Vec<Attachment> {
    let mut out = Vec::with_capacity(paths.len());
    for path in paths {
        match describe(&path).await {
            Ok(a) => out.push(a),
            Err(e) => eprintln!("attachment skipped: {path}: {e}"),
        }
    }
    out
}

/// `~/.dray/attachments/<session-id>`, creating it if needed.
async fn attachments_dir(session_id: &str) -> Result<PathBuf> {
    let path = get_home_app_dir()
        .await?
        .join("attachments")
        .join(session_id);
    fs::create_dir_all(&path).await?;
    Ok(path)
}

/// Drops a session's archived images. Called when the session itself is
/// deleted; a missing directory is the ordinary case, not an error.
pub async fn delete_session_attachments(session_id: &str) -> Result<()> {
    let path = get_home_app_dir()
        .await?
        .join("attachments")
        .join(session_id);

    match fs::remove_dir_all(&path).await {
        Ok(()) => Ok(()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(()),
        Err(e) => Err(e).context("failed to delete session attachments"),
    }
}

/// Writes the pictures a tool handed back to disk, swapping each `data:` URL
/// for the path it landed at.
///
/// Same bargain the composer's own images make and for the same reason: the
/// session log is append-only and read whole on open, so bytes on the event are
/// paid again on every visit. The original is no substitute — a screenshot the
/// agent took lives in `/tmp` and is gone by the next boot — so this copies
/// rather than pointing at it.
///
/// Best-effort per image: one that cannot be decoded or written keeps its
/// `data:` URL, which still draws in the live transcript and costs the log entry
/// rather than the picture.
pub async fn archive_result_images(session_id: &str, images: &mut [ImageRef]) {
    if images.is_empty() {
        return;
    }

    for image in images.iter_mut() {
        let Some(url) = image.url.as_deref() else {
            continue;
        };
        let Some((mime, data)) = parse_data_url(url) else {
            continue;
        };
        let Ok(bytes) = STANDARD.decode(data) else {
            continue;
        };

        // Anything the API accepts is in this table; an unknown mime keeps the
        // bytes but not a claim about what they are.
        let ext = IMAGE_TYPES
            .iter()
            .find(|(_, m)| *m == mime)
            .map(|(e, _)| *e)
            .unwrap_or("png");

        let stored = match attachments_dir(session_id).await {
            Ok(dir) => dir.join(format!("{}.{ext}", Uuid::now_v7())),
            Err(e) => {
                eprintln!("tool image not archived: {e}");
                continue;
            }
        };

        match fs::write(&stored, &bytes).await {
            Ok(()) => {
                image.path = Some(stored.to_string_lossy().into_owned());
                image.url = None;
            }
            Err(e) => eprintln!("tool image not archived: {e}"),
        }
    }
}

/// Splits `data:<mime>;base64,<payload>`. Anything else is not ours to decode.
fn parse_data_url(url: &str) -> Option<(&str, &str)> {
    let rest = url.strip_prefix("data:")?;
    let (mime, payload) = rest.split_once(",")?;
    Some((mime.strip_suffix(";base64")?, payload))
}

/// Folds the attached paths into the prompt: images encoded and archived, files
/// appended as mentions.
///
/// An image is **copied** into the app's own directory before its path is
/// recorded. The transcript renders that copy, so a screenshot attached from
/// `~/Downloads` and deleted an hour later still draws — the alternative,
/// persisting the base64 on the event, would put megabytes into an append-only
/// log that is read whole every time the session is opened.
///
/// A file is *not* copied: its mention has to resolve for the model, and the
/// point of the path is that it names the real file in the real tree.
pub async fn prepare(session_id: &str, prompt: &str, paths: &[String]) -> Result<Prepared> {
    if paths.is_empty() {
        return Ok(Prepared {
            text: prompt.to_string(),
            images: Vec::new(),
        });
    }

    let mut images = Vec::new();
    let mut mentions = Vec::new();

    for path in paths {
        let Ok(attachment) = describe(path).await else {
            continue;
        };

        if !attachment.is_image {
            mentions.push(format!("@{path}"));
            continue;
        }

        let bytes = fs::read(path).await.context("could not read image")?;
        let ext = Path::new(path)
            .extension()
            .and_then(|e| e.to_str())
            .unwrap_or("png")
            .to_ascii_lowercase();
        let stored = attachments_dir(session_id)
            .await?
            .join(format!("{}.{ext}", Uuid::now_v7()));
        fs::write(&stored, &bytes).await?;

        images.push(PreparedImage {
            stored_path: stored.to_string_lossy().into_owned(),
            mime_type: attachment
                .mime_type
                .unwrap_or_else(|| "image/png".to_string()),
            data: STANDARD.encode(&bytes),
        });
    }

    // One newline, not two. This text is what the transcript renders, and it
    // renders `whitespace-pre-wrap` — a blank line here draws as a gap under the
    // message with no margin or padding anywhere that explains it.
    let text = match (prompt.trim().is_empty(), mentions.is_empty()) {
        (_, true) => prompt.to_string(),
        (true, false) => mentions.join(" "),
        (false, false) => format!("{prompt}\n{}", mentions.join(" ")),
    };

    Ok(Prepared { text, images })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// The mapper writes these and this reads them back, so the two halves of
    /// one round trip are pinned together. A `url` source — an API shape the CLI
    /// has never sent — must not be mistaken for one of ours and decoded.
    #[test]
    fn reads_back_the_data_urls_the_mapper_writes() {
        assert_eq!(
            parse_data_url("data:image/png;base64,iVBOR"),
            Some(("image/png", "iVBOR"))
        );
        assert_eq!(parse_data_url("data:image/png,iVBOR"), None);
        assert_eq!(parse_data_url("https://example.com/a.png"), None);
        assert_eq!(parse_data_url("data:image/png;base64"), None);
    }
}

/// Writes into the real `~/.dray/attachments`, so it's `#[ignore]`d:
/// `cargo test -- --ignored archives_an_image_result` when changing the archive
/// path or the `data:` URL the mapper mints.
#[cfg(test)]
mod archive_tests {
    use super::*;

    #[tokio::test]
    #[ignore]
    async fn archives_an_image_result() {
        // A 1x1 GIF, so the extension picked from the mime is visible in the
        // filename rather than defaulting to the same `png` either path gives.
        const GIF: &str = "R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7";
        let session = format!("test-{}", Uuid::now_v7());

        let mut images = vec![ImageRef {
            path: None,
            url: Some(format!("data:image/gif;base64,{GIF}")),
            mime_type: Some("image/gif".to_string()),
        }];
        archive_result_images(&session, &mut images).await;

        let stored = images[0].path.as_deref().expect("not archived");
        assert!(stored.ends_with(".gif"), "{stored} took the wrong extension");
        assert!(images[0].url.is_none(), "the bytes outlived the archive");
        assert_eq!(
            fs::read(stored).await.unwrap(),
            STANDARD.decode(GIF).unwrap()
        );

        delete_session_attachments(&session).await.unwrap();
    }
}
