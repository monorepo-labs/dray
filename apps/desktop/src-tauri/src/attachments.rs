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
use crate::harness::Harness;
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
pub(crate) const MAX_IMAGE_BYTES: u64 = 5 * 1024 * 1024;

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

pub(crate) fn image_mime(path: &Path) -> Option<&'static str> {
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
    let mut attachment = inspect(path).await?;

    // Read only for a thumbnail we will actually draw. The bytes are re-read at
    // send time; paying twice is cheaper than holding every attachment's data
    // in the frontend and shipping it back down.
    if attachment.is_image {
        let bytes = fs::read(path).await.context("could not read image")?;
        attachment.preview = Some(format!(
            "data:{};base64,{}",
            attachment.mime_type.as_deref().unwrap_or("image/png"),
            STANDARD.encode(&bytes)
        ));
    }

    Ok(attachment)
}

/// [`describe`] without the thumbnail: what a path is, read off its metadata
/// alone. What a send asks, since it reads an image's bytes itself and a
/// preview built first was the same file read and encoded twice.
async fn inspect(path: &str) -> Result<Attachment> {
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

    Ok(Attachment {
        path: path.to_string(),
        name,
        mime_type: mime.map(str::to_string),
        size,
        is_image,
        preview: None,
    })
}

/// Describes every path that can be attached, silently skipping the rest — a
/// folder dragged in alongside two files leaves the two files.
#[cfg_attr(feature = "desktop", tauri::command)]
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

/// What the clipboard holds, as far as the composer's paste is concerned.
#[derive(Debug, PartialEq)]
// Built from the Mac's pasteboard and the Linux app's GTK clipboard; a build
// with neither reads every paste as text.
#[cfg_attr(
    not(any(target_os = "macos", all(target_os = "linux", feature = "desktop"))),
    allow(dead_code)
)]
enum Pasted {
    Files(Vec<String>),
    Image(Vec<u8>),
    /// Text, or nothing at all — both are the webview's own paste to make.
    Text,
}

/// Paths for what a paste should pin to the tray: copied files as they are, or
/// a clipboard image written out as a PNG. Empty means the paste is text.
///
/// Read off `NSPasteboard` or GTK's clipboard rather than the webview's
/// `DataTransfer`, which hands a copied file over as bytes with no path, and a
/// non-image file has to travel as an `@path` mention naming the real one.
#[cfg_attr(feature = "desktop", tauri::command)]
pub async fn paste_attachments() -> Vec<String> {
    let pasted = read_pasteboard().await;

    match pasted {
        Pasted::Files(paths) => paths,
        Pasted::Image(png) => match write_pasted_image(&png).await {
            Ok(path) => vec![path],
            Err(e) => {
                eprintln!("pasted image not saved: {e:#}");
                Vec::new()
            }
        },
        Pasted::Text => Vec::new(),
    }
}

/// Files first, then text, then an image. Text outranks an image because a
/// spreadsheet or a Pages selection puts both on the clipboard, and pasting
/// cells as a picture of them is not what anybody meant.
#[cfg(target_os = "macos")]
async fn read_pasteboard() -> Pasted {
    tokio::task::spawn_blocking(|| {
        objc2::rc::autoreleasepool(|_| read_from(&objc2_app_kit::NSPasteboard::generalPasteboard()))
    })
    .await
    .unwrap_or(Pasted::Text)
}

/// [`read_pasteboard`] over any pasteboard, so a test can hand it a private one
/// rather than the reader's clipboard.
#[cfg(target_os = "macos")]
fn read_from(pb: &objc2_app_kit::NSPasteboard) -> Pasted {
    use objc2_app_kit::{
        NSBitmapImageFileType, NSBitmapImageRep, NSPasteboardTypeFileURL, NSPasteboardTypePNG,
        NSPasteboardTypeString, NSPasteboardTypeTIFF,
    };
    use objc2_foundation::{NSDictionary, NSURL};

    // SAFETY: AppKit's own constants, initialised before any code runs.
    let (file_url, png, tiff, string) = unsafe {
        (
            NSPasteboardTypeFileURL,
            NSPasteboardTypePNG,
            NSPasteboardTypeTIFF,
            NSPasteboardTypeString,
        )
    };

    // `filePathURL` because Finder can copy a file *reference* URL
    // (`file:///.file/id=…`), whose `path` is not the file's.
    let files: Vec<String> = pb
        .pasteboardItems()
        .map(|items| {
            items
                .iter()
                .filter_map(|item| {
                    let text = item.stringForType(file_url)?;
                    let url = NSURL::URLWithString(&text)?;
                    Some(url.filePathURL()?.path()?.to_string())
                })
                .collect()
        })
        .unwrap_or_default();
    if !files.is_empty() {
        return Pasted::Files(files);
    }
    if pb.stringForType(string).is_some() {
        return Pasted::Text;
    }
    if let Some(data) = pb.dataForType(png) {
        return Pasted::Image(data.to_vec());
    }
    // Preview and most native apps copy TIFF alone, which the API refuses.
    let converted = pb.dataForType(tiff).and_then(|data| {
        let rep = NSBitmapImageRep::imageRepWithData(&data)?;
        // SAFETY: an empty dictionary satisfies any key and value type.
        unsafe {
            rep.representationUsingType_properties(NSBitmapImageFileType::PNG, &NSDictionary::new())
        }
    });
    converted.map_or(Pasted::Text, |data| Pasted::Image(data.to_vec()))
}

/// The Mac's order over GTK's clipboard, which owns the X selection on the
/// connection the app already holds. A paste waits on another app answering,
/// so one that never does reads as text after [`gtk_clipboard::PASTE_WAIT`]
/// rather than holding the composer's text paste behind it.
#[cfg(all(target_os = "linux", feature = "desktop"))]
async fn read_pasteboard() -> Pasted {
    let (tx, rx) = tokio::sync::oneshot::channel();
    // GTK is main thread only, and the default context is the loop tao runs
    // there. Every read below is a callback, so that loop never blocks on one.
    gtk::glib::MainContext::default().invoke(move || gtk_clipboard::read(tx));
    let fetched = tokio::time::timeout(gtk_clipboard::PASTE_WAIT, rx)
        .await
        .ok()
        .and_then(Result::ok);
    match fetched {
        Some(gtk_clipboard::Fetched::Ready(pasted)) => pasted,
        // Decoding and encoding can take a while on a big image, and on the
        // main thread that would freeze the window for it.
        Some(gtk_clipboard::Fetched::Convert(bytes)) => {
            tokio::task::spawn_blocking(move || gtk_clipboard::to_png(&bytes))
                .await
                .ok()
                .flatten()
                .map_or(Pasted::Text, Pasted::Image)
        }
        None => Pasted::Text,
    }
}

#[cfg(not(any(target_os = "macos", all(target_os = "linux", feature = "desktop"))))]
async fn read_pasteboard() -> Pasted {
    Pasted::Text
}

#[cfg(all(target_os = "linux", feature = "desktop"))]
mod gtk_clipboard {
    use super::Pasted;
    use gtk::gdk;
    use tokio::sync::oneshot::Sender;

    pub(super) const PASTE_WAIT: std::time::Duration = std::time::Duration::from_secs(3);

    /// File managers put a file list on the clipboard as URIs: `text/uri-list`
    /// from most, `x-special/gnome-copied-files` from Nautilus and its forks,
    /// whose first line is `copy` or `cut`.
    const FILE_TARGETS: [&str; 2] = ["text/uri-list", "x-special/gnome-copied-files"];

    /// Formats gdk-pixbuf reads out of the box, tried before any other
    /// `image/*` an app might offer.
    const IMAGE_TARGETS: [&str; 5] = [
        "image/jpeg",
        "image/bmp",
        "image/tiff",
        "image/gif",
        "image/webp",
    ];

    /// What to fetch, decided from the target names alone.
    #[derive(Debug, PartialEq)]
    pub(super) enum Want {
        Files(&'static str),
        Text,
        Png,
        /// Any other `image/*`, by name, for [`to_png`] to convert.
        Image(String),
    }

    /// What the main thread hands back: an answer, or image bytes still to be
    /// converted off it.
    pub(super) enum Fetched {
        Ready(Pasted),
        Convert(Vec<u8>),
    }

    /// Files, then text, then an image: the Mac's order, for the Mac's reason.
    /// `None` is a clipboard holding nothing a paste could use.
    pub(super) fn choose(targets: &[String]) -> Option<Want> {
        let has = |name: &str| targets.iter().any(|t| t == name);
        if let Some(files) = FILE_TARGETS.into_iter().find(|t| has(t)) {
            return Some(Want::Files(files));
        }
        let text = targets.iter().any(|t| {
            matches!(
                t.as_str(),
                "UTF8_STRING" | "STRING" | "TEXT" | "COMPOUND_TEXT"
            ) || t.starts_with("text/plain")
        });
        if text {
            return Some(Want::Text);
        }
        if has("image/png") {
            return Some(Want::Png);
        }
        let image = IMAGE_TARGETS.into_iter().find(|t| has(t)).or_else(|| {
            targets
                .iter()
                .map(String::as_str)
                .find(|t| t.starts_with("image/"))
        });
        image.map(|t| Want::Image(t.to_string()))
    }

    /// The local paths in a file list, skipping the `copy`/`cut` line and any
    /// URI that names no local file — one on another host included, whose path
    /// could name a different file here.
    pub(super) fn paths(list: &str) -> Vec<String> {
        let here = gtk::glib::host_name();
        list.lines()
            .filter_map(|line| gtk::glib::filename_from_uri(line.trim()).ok())
            .filter(|(_, host)| {
                host.as_deref()
                    .is_none_or(|h| h == "localhost" || h == here.as_str())
            })
            .map(|(path, _)| path.to_string_lossy().into_owned())
            .collect()
    }

    /// Any image gdk-pixbuf can read, as PNG. Off the main thread: the loader
    /// and its pixbuf are made and dropped here, never shared with GTK.
    pub(super) fn to_png(bytes: &[u8]) -> Option<Vec<u8>> {
        use gtk::gdk_pixbuf::prelude::*;
        let loader = gtk::gdk_pixbuf::PixbufLoader::new();
        loader.write(bytes).ok()?;
        loader.close().ok()?;
        loader.pixbuf()?.save_to_bufferv("png", &[]).ok()
    }

    /// Asks for the clipboard's targets, then for the one [`choose`] picks,
    /// and sends what came back.
    pub(super) fn read(tx: Sender<Fetched>) {
        let clipboard = gtk::Clipboard::get(&gdk::SELECTION_CLIPBOARD);
        clipboard.request_contents(&gdk::Atom::intern("TARGETS"), move |clipboard, data| {
            let names: Vec<String> = data
                .targets()
                .unwrap_or_default()
                .iter()
                .map(|atom| atom.name().to_string())
                .collect();
            match choose(&names) {
                Some(Want::Files(target)) => {
                    clipboard.request_contents(&gdk::Atom::intern(target), move |_, data| {
                        let files = paths(&String::from_utf8_lossy(&data.data()));
                        // A list of web links alone is text to whoever copied it.
                        let _ = tx.send(Fetched::Ready(if files.is_empty() {
                            Pasted::Text
                        } else {
                            Pasted::Files(files)
                        }));
                    });
                }
                Some(Want::Png) => {
                    clipboard.request_contents(&gdk::Atom::intern("image/png"), move |_, data| {
                        let png = data.data();
                        let _ = tx.send(Fetched::Ready(if png.starts_with(b"\x89PNG") {
                            Pasted::Image(png)
                        } else {
                            Pasted::Text
                        }));
                    });
                }
                Some(Want::Image(target)) => {
                    clipboard.request_contents(&gdk::Atom::intern(&target), move |_, data| {
                        let _ = tx.send(Fetched::Convert(data.data()));
                    });
                }
                Some(Want::Text) | None => {
                    let _ = tx.send(Fetched::Ready(Pasted::Text));
                }
            }
        });
    }
}

/// How long a pasted image or an uploaded file outlives its arrival. The send
/// archives its own copy of an image, so this only has to cover a draft left
/// unsent — and, for an uploaded file, the turn that reads it.
const PASTE_RETAIN: std::time::Duration = std::time::Duration::from_secs(7 * 24 * 60 * 60);

/// Writes a pasted image where it can sit until the send copies it into the
/// session's own directory. A directory per paste, so the tray names every one
/// "Pasted image.png" and still dedupes nothing that was pasted twice.
///
/// Older pastes are swept here, on write, like the dictation recordings: a
/// send, a removed tile and a deleted session all leave the source behind.
async fn write_pasted_image(png: &[u8]) -> Result<String> {
    let root = std::env::temp_dir().join("dray-paste");
    sweep_stale(&root).await;

    let dir = root.join(Uuid::new_v4().to_string());
    fs::create_dir_all(&dir)
        .await
        .context("could not create paste directory")?;
    let path = dir.join("Pasted image.png");
    fs::write(&path, png)
        .await
        .context("could not write pasted image")?;
    Ok(path.to_string_lossy().into_owned())
}

/// `~/.dray/attachments/<session-id>`.
async fn attachments_path(session_id: &str) -> Result<PathBuf> {
    Ok(get_home_app_dir()
        .await?
        .join("attachments")
        .join(session_id))
}

/// [`attachments_path`], created if needed.
async fn attachments_dir(session_id: &str) -> Result<PathBuf> {
    let path = attachments_path(session_id).await?;
    fs::create_dir_all(&path).await?;
    Ok(path)
}

/// Removes every entry of `root` older than [`PASTE_RETAIN`].
async fn sweep_stale(root: &Path) {
    let Ok(mut entries) = fs::read_dir(root).await else {
        return;
    };
    while let Ok(Some(entry)) = entries.next_entry().await {
        let stale = entry
            .metadata()
            .await
            .and_then(|m| m.modified())
            .map(|t| t.elapsed().unwrap_or_default() > PASTE_RETAIN)
            .unwrap_or(false);
        if stale {
            let _ = fs::remove_dir_all(entry.path()).await;
        }
    }
}

/// The most a remote server takes per attachment. An upload rides the
/// reader's own uplink — 2.7MB/s measured over SSH to a VPS — so this is about
/// forty seconds of waiting.
pub const MAX_UPLOAD_BYTES: u64 = 100 * 1024 * 1024;

/// Where a file uploaded from another machine lands:
/// `attachments/uploads/<uuid>/<name>`, so it keeps its name. Uploaded at
/// attach time, before any session may exist, so it belongs to none — swept
/// like a pasted image instead, once a send has long since read it. The name
/// comes off the wire, so only its last component is kept.
pub async fn upload_path(name: &str) -> Result<PathBuf> {
    let name = Path::new(name).file_name().context("not a file name")?;
    let root = uploads_dir().await?;
    sweep_stale(&root).await;
    let dir = root.join(Uuid::now_v7().to_string());
    fs::create_dir_all(&dir).await?;
    Ok(dir.join(name))
}

/// `attachments/uploads`, the root every [`upload_path`] sits under.
pub async fn uploads_dir() -> Result<PathBuf> {
    Ok(get_home_app_dir().await?.join("attachments").join("uploads"))
}

/// Drops a session's archived images. Called when the session itself is
/// deleted; a missing directory is the ordinary case, not an error.
pub async fn delete_session_attachments(session_id: &str) -> Result<()> {
    let path = attachments_path(session_id).await?;

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
        // A picture named by path rather than carried as bytes — Codex's
        // `imageView` hands over the file it looked at. Copied for the same
        // reason the decoded ones are, plus one this side cannot ignore: the
        // asset protocol is scoped to `~/.dray/attachments`, so a row pointing
        // anywhere else does not merely go stale, it refuses to load at all.
        if image.url.is_none() {
            if let Some(src) = image.path.clone() {
                archive_image_file(session_id, &src, image).await;
            }
            continue;
        }

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

/// Copies a picture a tool named by path into the session's own directory.
///
/// Two things make this necessary rather than tidy. The file is the agent's to
/// delete — an `imageView` of a screenshot under `/tmp` outlives nothing — and
/// the asset protocol is scoped to `~/.dray/attachments`, so the transcript
/// cannot load a row pointing anywhere else even while the file is still there.
///
/// A path already inside that directory is left alone: replay runs this again
/// over its own output, and copying each time would grow a file per open.
/// Best-effort like its caller, and the failure is the honest one — the row
/// keeps the original path, which draws nothing but says where the picture was.
async fn archive_image_file(session_id: &str, src: &str, image: &mut ImageRef) {
    let Ok(dir) = attachments_dir(session_id).await else {
        return;
    };
    if std::path::Path::new(src).starts_with(&dir) {
        return;
    }

    let ext = std::path::Path::new(src)
        .extension()
        .and_then(|e| e.to_str())
        .unwrap_or("png");
    let stored = dir.join(format!("{}.{ext}", Uuid::now_v7()));

    match fs::copy(src, &stored).await {
        Ok(_) => image.path = Some(stored.to_string_lossy().into_owned()),
        Err(e) => eprintln!("tool image not archived: {e}"),
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
/// `harness` decides how a non-image attachment is named, and the difference is
/// whether the CLI has a parser for it. Claude Code expands `@/abs/path` into
/// the file's contents before the model turn, with no tool call on the wire —
/// which is what makes a 40MB CSV cost a path rather than a context window.
/// Neither other harness has such a parser, so the same string arrives as
/// literal punctuation the model has to guess the meaning of. Named in prose
/// there instead, which any model can read and act on with its own tools.
pub async fn prepare(
    session_id: &str,
    prompt: &str,
    paths: &[String],
    harness: Harness,
) -> Result<Prepared> {
    if paths.is_empty() {
        return Ok(Prepared {
            text: prompt.to_string(),
            images: Vec::new(),
        });
    }

    let mut images = Vec::new();
    let mut mentions = Vec::new();

    for path in paths {
        let Ok(attachment) = inspect(path).await else {
            continue;
        };

        if !attachment.is_image {
            mentions.push(if harness.caps().expands_at_mentions {
                format!("@{path}")
            } else {
                format!("Attached file: {path}")
            });
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
    // One line each where they are prose and one run where they are mentions:
    // `@a @b` reads as a list, `Attached file: /a Attached file: /b` does not.
    let joined = if harness.caps().expands_at_mentions {
        mentions.join(" ")
    } else {
        mentions.join("\n")
    };

    let text = match (prompt.trim().is_empty(), mentions.is_empty()) {
        (_, true) => prompt.to_string(),
        (true, false) => joined,
        (false, false) => format!("{prompt}\n{joined}"),
    };

    Ok(Prepared { text, images })
}

#[cfg(test)]
mod tests {
    use super::*;

    /// Files outrank text, text outranks an image, and TIFF comes back as PNG.
    /// On a private pasteboard, so running it leaves the clipboard alone.
    #[cfg(target_os = "macos")]
    #[test]
    fn a_paste_takes_files_then_text_then_an_image() {
        use objc2_app_kit::{
            NSBitmapImageRep, NSPasteboard, NSPasteboardTypeFileURL, NSPasteboardTypeString,
            NSPasteboardTypeTIFF,
        };
        use objc2_foundation::{NSData, NSString};

        const PNG_1PX: &str = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==";
        let png = NSData::with_bytes(&STANDARD.decode(PNG_1PX).unwrap());
        let tiff = NSBitmapImageRep::imageRepWithData(&png)
            .and_then(|rep| rep.TIFFRepresentation())
            .expect("tiff");

        let pb = NSPasteboard::pasteboardWithUniqueName();
        pb.clearContents();
        unsafe {
            pb.setData_forType(Some(&tiff), NSPasteboardTypeTIFF);
        }
        match read_from(&pb) {
            Pasted::Image(bytes) => assert!(bytes.starts_with(b"\x89PNG")),
            other => panic!("expected an image, got {other:?}"),
        }

        unsafe {
            pb.setString_forType(&NSString::from_str("a1\tb1"), NSPasteboardTypeString);
        }
        assert_eq!(read_from(&pb), Pasted::Text);

        unsafe {
            pb.setString_forType(&NSString::from_str("file:///tmp/a%20b.txt"), NSPasteboardTypeFileURL);
        }
        assert_eq!(read_from(&pb), Pasted::Files(vec!["/tmp/a b.txt".into()]));
    }

    /// The same order on GTK's targets. The first list is Nautilus 46's,
    /// captured; the rest are what Dolphin, a spreadsheet, a browser's Copy
    /// Image and a BMP-only copy offer.
    #[cfg(all(target_os = "linux", feature = "desktop"))]
    #[test]
    fn a_linux_paste_takes_files_then_text_then_an_image() {
        use gtk_clipboard::{choose, Want};
        let pick = |list: &str| choose(&list.split(' ').map(String::from).collect::<Vec<_>>());

        let nautilus = "SAVE_TARGETS TIMESTAMP TARGETS x-special/gnome-copied-files \
            application/vnd.portal.filetransfer application/vnd.portal.files text/uri-list \
            UTF8_STRING COMPOUND_TEXT TEXT STRING text/plain;charset=utf-8";
        assert_eq!(pick(nautilus), Some(Want::Files("text/uri-list")));
        assert_eq!(
            pick("x-special/gnome-copied-files UTF8_STRING"),
            Some(Want::Files("x-special/gnome-copied-files"))
        );
        assert_eq!(pick("text/plain;charset=utf-8 image/png"), Some(Want::Text));
        assert_eq!(pick("text/html image/png image/bmp"), Some(Want::Png));
        assert_eq!(
            pick("image/x-art image/bmp"),
            Some(Want::Image("image/bmp".into()))
        );
        assert_eq!(
            pick("image/x-art TARGETS"),
            Some(Want::Image("image/x-art".into()))
        );
        assert_eq!(pick("TARGETS TIMESTAMP"), None);
    }

    /// Nautilus's leading `copy`, a percent-escaped space, a web link, and a
    /// file on another machine whose path may well exist here too.
    #[cfg(all(target_os = "linux", feature = "desktop"))]
    #[test]
    fn reads_local_paths_out_of_a_copied_file_list() {
        let list = "copy\nfile:///tmp/a%20b.txt\r\nhttps://example.com/x\n\
            file://other-box/etc/hosts\nfile://localhost/home/me/c.png";
        assert_eq!(
            gtk_clipboard::paths(list),
            vec!["/tmp/a b.txt", "/home/me/c.png"]
        );
    }

    /// A BMP comes back as PNG, and bytes that are no image as nothing.
    #[cfg(all(target_os = "linux", feature = "desktop"))]
    #[test]
    fn converts_a_pasted_image_to_png() {
        let mut bmp = b"BM".to_vec();
        bmp.extend_from_slice(&58u32.to_le_bytes());
        bmp.extend_from_slice(&[0, 0, 0, 0, 54, 0, 0, 0, 40, 0, 0, 0]);
        bmp.extend_from_slice(&1i32.to_le_bytes());
        bmp.extend_from_slice(&1i32.to_le_bytes());
        bmp.extend_from_slice(&[1, 0, 24, 0]);
        bmp.extend_from_slice(&[0; 24]);
        bmp.extend_from_slice(&[0, 200, 255, 0]);

        let png = gtk_clipboard::to_png(&bmp).expect("png");
        assert!(png.starts_with(b"\x89PNG"));
        assert_eq!(gtk_clipboard::to_png(b"not an image"), None);
    }

    /// A file is named the way the CLI reading it can act on.
    ///
    /// Claude Code's own parser expands `@/abs/path` into the file's contents
    /// before the model turn, with no tool call on the wire — which is what
    /// makes a 40MB CSV cost a path rather than a context window. Neither other
    /// harness has such a parser, so the same string reaches the model as
    /// literal punctuation it has to guess the meaning of, and prose it can act
    /// on with its own tools is the honest substitute.
    ///
    /// Run against a temp file rather than a fixture: the branch is about the
    /// *text*, and a path that does not exist is skipped before it reaches it.
    #[tokio::test]
    async fn a_file_is_named_the_way_its_harness_can_read_it() {
        let dir = std::env::temp_dir().join(format!("dray-att-{}", Uuid::now_v7()));
        fs::create_dir_all(&dir).await.expect("temp dir");
        let file = dir.join("rows.csv");
        fs::write(&file, b"a,b\n1,2\n").await.expect("temp file");
        let path = file.to_string_lossy().into_owned();

        let claude = prepare("s", "look at this", &[path.clone()], Harness::ClaudeCode)
            .await
            .expect("prepared");
        assert_eq!(claude.text, format!("look at this\n@{path}"));

        for harness in [Harness::Pi, Harness::Codex] {
            let other = prepare("s", "look at this", &[path.clone()], harness)
                .await
                .expect("prepared");

            assert_eq!(
                other.text,
                format!("look at this\nAttached file: {path}"),
                "{harness:?} expands no mention, so punctuation says nothing"
            );
        }

        let _ = fs::remove_dir_all(&dir).await;
    }

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

    /// Codex names a picture by path instead of carrying its bytes, and the
    /// asset protocol is scoped to `~/.dray/attachments` — so a row left
    /// pointing at the original does not go stale later, it fails to load now.
    #[tokio::test]
    #[ignore]
    async fn archives_an_image_named_by_path() {
        let session = format!("test-{}", Uuid::now_v7());
        let src = std::env::temp_dir().join(format!("{}.png", Uuid::now_v7()));
        fs::write(&src, b"not really a png").await.unwrap();

        let mut images = vec![ImageRef {
            path: Some(src.to_string_lossy().into_owned()),
            url: None,
            mime_type: None,
        }];
        archive_result_images(&session, &mut images).await;

        let stored = images[0].path.as_deref().expect("not archived");
        assert_ne!(stored, src.to_string_lossy(), "the row kept the original");
        assert!(stored.ends_with(".png"), "{stored} lost its extension");
        assert_eq!(fs::read(stored).await.unwrap(), b"not really a png");

        // Replay runs this again over its own output. Copying each time would
        // grow one file per open.
        let once = stored.to_string();
        archive_result_images(&session, &mut images).await;
        assert_eq!(images[0].path.as_deref(), Some(once.as_str()));

        fs::remove_file(&src).await.ok();
        delete_session_attachments(&session).await.unwrap();
    }
}
