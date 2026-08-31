//! The disk half of the docs panel: read one markdown file, write it back.
//!
//! Both commands answer about a path the reader arrived at by clicking a link
//! in a transcript, so every refusal here reaches them as a sentence in the
//! panel rather than as a log line.

use serde::Serialize;
use tokio::fs;
use tokio::io::AsyncReadExt;
use ts_rs::TS;

/// Past this a doc is refused rather than read. It happens to match `git.rs`'s
/// own `MAX_BLOB`, and is kept separate because that one means "a blob whose
/// diff we will render" — this one means a document small enough to read and
/// edit in a third of a window.
const MAX_DOC: u64 = 1 << 20;

/// What a save did. `Stale` is not an error: the file moved under the reader,
/// so their text is still in the editor and theirs to force through.
#[derive(Debug, Clone, Copy, PartialEq, Eq, Serialize, TS)]
#[ts(export, export_to = "events.ts")]
#[serde(rename_all = "snake_case")]
pub enum SaveOutcome {
    Saved,
    Stale,
}

/// Reads one doc for the panel, or names why it can't.
///
/// The size is read before the body, so an oversized file is refused rather
/// than pulled into memory and then rejected — the same reading `git.rs`'s two
/// `cat-file` passes exist for. The read is capped as well as the metadata
/// check, because the two are separate calls and a file being appended to
/// between them would otherwise arrive at whatever length it had reached.
#[tauri::command]
pub async fn read_doc(path: String) -> Result<String, String> {
    let meta = fs::metadata(&path)
        .await
        .map_err(|_| "No file at this path.".to_string())?;
    if !meta.is_file() {
        return Err("Not a file — nothing to show here.".to_string());
    }
    if meta.len() > MAX_DOC {
        return Err(TOO_LARGE.to_string());
    }

    let bytes = read_capped(&path).await?;
    // Withheld rather than mangled: `from_utf8_lossy` would swap every invalid
    // byte for U+FFFD and draw a confident view of a file that never existed —
    // which the reader could then save back over the real one.
    String::from_utf8(bytes).map_err(|_| "Not UTF-8 text — nothing to show.".to_string())
}

/// Writes a doc back, refusing to clobber a file that changed underneath.
///
/// `expect` is the text the editor was opened on: it is re-read here and
/// compared, and a difference answers `Stale` with nothing written. `None` is
/// the reader's own force — they were shown the clash and chose to overwrite —
/// so it writes without comparing.
///
/// **The comparison is a check, not a lock, and cannot be made into one.** A
/// writer that lands between the read and the write is overwritten and this
/// still answers `Saved`. Nothing here closes that: POSIX has no conditional
/// write, and an advisory lock only binds writers who take it — the writer this
/// guards against is an agent's own CLI, which takes none. What the check does
/// buy is the case it was built for, where the file was rewritten at some point
/// while the editor sat open, which is a window of minutes rather than of the
/// microseconds between these two calls.
#[tauri::command]
pub async fn save_doc(
    path: String,
    text: String,
    expect: Option<String>,
) -> Result<SaveOutcome, String> {
    // Checked on the way in as well as on the way out, or a reader could paste
    // their way past the cap and save a file the panel then refuses to reopen.
    if text.len() as u64 > MAX_DOC {
        return Err(TOO_LARGE.to_string());
    }

    // `fs::write` creates what it can't find, so this check is the whole of
    // what keeps a mistyped path from quietly becoming a new file.
    let meta = fs::metadata(&path)
        .await
        .map_err(|_| "No file at this path.".to_string())?;
    if !meta.is_file() {
        return Err("Not a file — nothing to save over.".to_string());
    }

    if let Some(base) = expect {
        let current = read_capped(&path).await?;
        if current != base.as_bytes() {
            return Ok(SaveOutcome::Stale);
        }
    }

    fs::write(&path, text).await.map_err(|e| e.to_string())?;
    Ok(SaveOutcome::Saved)
}

/// One sentence for both directions: a file too large to open is also one too
/// large to write, and the reader meets the same limit either way.
const TOO_LARGE: &str = "File is too large to open here.";

/// Reads at most `MAX_DOC`, refusing anything longer rather than truncating it.
///
/// Reading one byte past the cap is what tells the two apart: a full buffer on
/// its own only says the file is *at least* this long.
async fn read_capped(path: &str) -> Result<Vec<u8>, String> {
    let file = fs::File::open(path).await.map_err(|e| e.to_string())?;
    let mut bytes = Vec::new();
    file.take(MAX_DOC + 1)
        .read_to_end(&mut bytes)
        .await
        .map_err(|e| e.to_string())?;

    if bytes.len() as u64 > MAX_DOC {
        return Err(TOO_LARGE.to_string());
    }
    Ok(bytes)
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::path::PathBuf;

    fn scratch() -> PathBuf {
        let dir = std::env::temp_dir().join(format!("dray-docs-{}", uuid::Uuid::now_v7()));
        std::fs::create_dir_all(&dir).unwrap();
        dir
    }

    fn at(dir: &PathBuf, name: &str) -> String {
        dir.join(name).to_str().unwrap().to_string()
    }

    #[tokio::test]
    async fn reads_back_what_it_saved() {
        let dir = scratch();
        let path = at(&dir, "notes.md");
        std::fs::write(&path, "# one\n").unwrap();

        assert_eq!(read_doc(path.clone()).await.unwrap(), "# one\n");
        let outcome = save_doc(path.clone(), "# two\n".into(), Some("# one\n".into()))
            .await
            .unwrap();
        assert_eq!(outcome, SaveOutcome::Saved);
        assert_eq!(read_doc(path).await.unwrap(), "# two\n");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The compare-and-swap is the point of the command: an outdated `expect`
    /// has to leave the other writer's bytes exactly as they are.
    #[tokio::test]
    async fn a_stale_save_writes_nothing() {
        let dir = scratch();
        let path = at(&dir, "notes.md");
        std::fs::write(&path, "# one\n").unwrap();
        std::fs::write(&path, "# theirs\n").unwrap();

        let outcome = save_doc(path.clone(), "# mine\n".into(), Some("# one\n".into()))
            .await
            .unwrap();
        assert_eq!(outcome, SaveOutcome::Stale);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# theirs\n");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn a_forced_save_lands_over_a_changed_file() {
        let dir = scratch();
        let path = at(&dir, "notes.md");
        std::fs::write(&path, "# theirs\n").unwrap();

        let outcome = save_doc(path.clone(), "# mine\n".into(), None).await.unwrap();
        assert_eq!(outcome, SaveOutcome::Saved);
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# mine\n");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn refuses_a_directory() {
        let dir = scratch();
        let path = dir.to_str().unwrap().to_string();

        assert!(read_doc(path).await.is_err());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn refuses_bytes_that_are_not_text() {
        let dir = scratch();
        let path = at(&dir, "shot.md");
        std::fs::write(&path, [0xff, 0xfe, 0x00]).unwrap();

        assert!(read_doc(path).await.is_err());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn refuses_a_file_over_the_cap() {
        let dir = scratch();
        let path = at(&dir, "huge.md");
        std::fs::write(&path, vec![b'a'; MAX_DOC as usize + 1]).unwrap();

        assert!(read_doc(path).await.is_err());

        std::fs::remove_dir_all(&dir).unwrap();
    }

    /// The cap has to hold on the way in too, or a reader could paste their way
    /// past it and save a file the panel then refuses to reopen.
    #[tokio::test]
    async fn refuses_to_save_past_the_cap() {
        let dir = scratch();
        let path = at(&dir, "notes.md");
        std::fs::write(&path, "# one\n").unwrap();

        let huge = "a".repeat(MAX_DOC as usize + 1);
        assert!(save_doc(path.clone(), huge, None).await.is_err());
        assert_eq!(std::fs::read_to_string(&path).unwrap(), "# one\n");

        std::fs::remove_dir_all(&dir).unwrap();
    }

    #[tokio::test]
    async fn never_creates_a_missing_file() {
        let dir = scratch();
        let path = at(&dir, "typo.md");

        assert!(save_doc(path.clone(), "# new\n".into(), None).await.is_err());
        assert!(!std::path::Path::new(&path).exists());

        std::fs::remove_dir_all(&dir).unwrap();
    }
}
