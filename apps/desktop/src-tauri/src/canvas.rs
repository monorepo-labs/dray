//! The disk half of the Canvas tab: one JSON file in the task's checkout,
//! `.dray/canvas.json`, which `dray canvas` writes too. The shape is the
//! frontend's (`lib/canvas.ts`) and the CLI's; Rust carries it as text.

use std::path::{Path, PathBuf};

/// Past this the file is not a canvas anyone drew by hand or with the CLI.
const MAX: u64 = 1 << 20;

fn file(cwd: &str) -> PathBuf {
    Path::new(cwd).join(".dray").join("canvas.json")
}

/// The canvas file's text, or `None` where the task has none yet.
pub async fn canvas_load(cwd: String) -> Result<Option<String>, String> {
    let path = file(&cwd);
    match tokio::fs::metadata(&path).await {
        Ok(meta) if meta.len() > MAX => Err("The canvas file is too large to open.".into()),
        Ok(_) => tokio::fs::read_to_string(&path).await.map(Some).map_err(|e| e.to_string()),
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => Ok(None),
        Err(e) => Err(e.to_string()),
    }
}

/// Writes the canvas whole, through a temp file and a rename so the CLI and a
/// poll never read half of it.
pub async fn canvas_save(cwd: String, text: String) -> Result<(), String> {
    if text.len() as u64 > MAX {
        return Err("The canvas is too large to save.".into());
    }
    if !Path::new(&cwd).is_dir() {
        return Err("The task's folder is gone.".into());
    }
    let path = file(&cwd);
    tokio::fs::create_dir_all(path.parent().unwrap()).await.map_err(|e| e.to_string())?;
    let tmp = path.with_extension("json.app-tmp");
    tokio::fs::write(&tmp, text).await.map_err(|e| e.to_string())?;
    tokio::fs::rename(&tmp, &path).await.map_err(|e| e.to_string())
}

#[cfg(test)]
mod tests {
    use super::*;

    #[tokio::test]
    async fn a_missing_canvas_reads_as_none_and_a_saved_one_reads_back() {
        let dir = std::env::temp_dir().join(format!("dray-canvas-{}", uuid::Uuid::new_v4()));
        std::fs::create_dir_all(&dir).unwrap();
        let cwd = dir.to_string_lossy().to_string();
        assert_eq!(canvas_load(cwd.clone()).await.unwrap(), None);
        canvas_save(cwd.clone(), "{\"pages\":[]}".into()).await.unwrap();
        assert_eq!(canvas_load(cwd.clone()).await.unwrap().as_deref(), Some("{\"pages\":[]}"));
        std::fs::remove_dir_all(dir).unwrap();
    }
}
