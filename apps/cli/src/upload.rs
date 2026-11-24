//! `dray upload`: put screenshots and recordings somewhere a PR body can show
//! them (#1477, #1479).
//!
//! GitHub takes uploads only through its web editor, so this sends each file
//! to Dray's upload Worker (`apps/upload-worker`), which checks the caller's
//! GitHub token and stores the file in R2. Through `curl`, as `dray update`
//! already is, so this binary links no HTTP stack.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use clap::Args;

const MB: u64 = 1024 * 1024;
/// The Worker's own caps, checked here first so a big file fails before it is
/// sent. The extension is only a guess at which; the Worker reads the bytes.
const MAX_IMAGE: u64 = 20 * MB;
const MAX_VIDEO: u64 = 100 * MB;

#[derive(Args)]
pub struct Upload {
    /// Files to upload: png, jpg, gif or webp up to 20 MB, or mp4, webm or
    /// mov up to 100 MB. Prints one markdown line per file, ready for a PR body.
    #[arg(required = true, value_name = "FILE")]
    files: Vec<PathBuf>,
}

/// Uploads every file in turn, printing a markdown line for each that lands.
/// One failing does not stop the rest; any failure makes the exit non-zero.
pub fn run(args: Upload) -> Result<(), String> {
    let token = github_token()?;
    let endpoint = format!("{}/", endpoint());
    let mut failed = 0;
    for file in &args.files {
        match upload(file, &token, &endpoint) {
            Ok(stored) => println!("{}", markdown(file, &stored)),
            Err(why) => {
                eprintln!("dray: {}: {why}", file.display());
                failed += 1;
            }
        }
    }
    match failed {
        0 => Ok(()),
        n => Err(format!("{n} of {} uploads failed", args.files.len())),
    }
}

/// upload.drayhq.com, or `DRAY_UPLOAD_URL` for a local `wrangler dev` or another deploy.
fn endpoint() -> String {
    std::env::var("DRAY_UPLOAD_URL")
        .ok()
        .filter(|s| !s.trim().is_empty())
        .unwrap_or_else(|| "https://upload.drayhq.com".into())
        .trim()
        .trim_end_matches('/')
        .into()
}

/// `GITHUB_TOKEN` when set, else what `gh` is signed in with.
fn github_token() -> Result<String, String> {
    if let Some(token) = std::env::var("GITHUB_TOKEN").ok().filter(|t| !t.trim().is_empty()) {
        return Ok(token.trim().into());
    }
    let out = Command::new("gh")
        .args(["auth", "token"])
        .stdin(Stdio::null())
        .stderr(Stdio::null())
        .output()
        .map_err(|_| "no GitHub token: set GITHUB_TOKEN, or install gh and run `gh auth login`".to_string())?;
    let token = String::from_utf8_lossy(&out.stdout).trim().to_string();
    if !out.status.success() || token.is_empty() {
        return Err("no GitHub token: run `gh auth login`, or set GITHUB_TOKEN".into());
    }
    Ok(token)
}

/// What the Worker stored: its public URL and the type it read off the bytes.
struct Stored {
    url: String,
    kind: String,
}

fn upload(file: &Path, token: &str, endpoint: &str) -> Result<Stored, String> {
    let size = std::fs::metadata(file).map_err(|e| e.to_string())?.len();
    let cap = if looks_like_image(file) { MAX_IMAGE } else { MAX_VIDEO };
    if size > cap {
        return Err(format!("{} is over the {} limit", megabytes(size), megabytes(cap)));
    }
    // The token goes in on stdin as curl config, never as an argument, where
    // any user on the machine could read it from the process list.
    let mut child = Command::new("curl")
        .args(["-sS", "-X", "POST", "-K", "-", "-H", "Content-Type: application/octet-stream", "-w", "\n%{http_code}"])
        .arg("--data-binary")
        .arg(format!("@{}", file.display()))
        .arg(endpoint)
        .stdin(Stdio::piped())
        .stdout(Stdio::piped())
        .stderr(Stdio::piped())
        .spawn()
        .map_err(|_| "curl is missing; install it and try again".to_string())?;
    let config = format!("header = \"Authorization: Bearer {token}\"\n");
    child.stdin.take().expect("piped").write_all(config.as_bytes()).map_err(|e| e.to_string())?;
    let out = child.wait_with_output().map_err(|e| e.to_string())?;
    if !out.status.success() {
        return Err(String::from_utf8_lossy(&out.stderr).trim().trim_start_matches("curl: ").to_string());
    }
    read_reply(&String::from_utf8_lossy(&out.stdout))
}

fn looks_like_image(file: &Path) -> bool {
    let ext = file.extension().map(|e| e.to_string_lossy().to_ascii_lowercase()).unwrap_or_default();
    matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp")
}

fn megabytes(bytes: u64) -> String {
    match bytes % MB {
        0 => format!("{} MB", bytes / MB),
        _ => format!("{:.1} MB", bytes as f64 / MB as f64),
    }
}

/// The URL out of curl's output, the body then `-w`'s status on its own line,
/// or the Worker's refusal said plainly.
fn read_reply(output: &str) -> Result<Stored, String> {
    let (body, status) = output.rsplit_once('\n').unwrap_or(("", output));
    let json: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    if status.trim() == "200" {
        if let Some(url) = json["url"].as_str() {
            return Ok(Stored { url: url.into(), kind: json["type"].as_str().unwrap_or_default().into() });
        }
    }
    Err(match (status.trim(), json["error"].as_str()) {
        ("401", Some("github_token_invalid")) => {
            "GitHub refused the token. Run `gh auth login`, or set GITHUB_TOKEN to a user's token".into()
        }
        ("401", _) => "the upload service wants a GitHub token".into(),
        ("413", _) => match json["max_bytes"].as_u64() {
            Some(max) => format!("over the {} limit for this kind of file", megabytes(max)),
            None => "too large".into(),
        },
        ("415", _) => "not a png, jpg, gif, webp, mp4, webm or mov file".into(),
        ("429", _) => "too many uploads; each GitHub user gets 30 an hour. Try again later".into(),
        ("503", _) => "uploads are not set up on this service".into(),
        (status, Some(error)) => format!("the upload service answered {status}: {error}"),
        (status, None) => format!("the upload service answered {status}"),
    })
}

/// An image line for an image. A video gets a plain link: GitHub plays video
/// only from its own uploads, and shows any other as a broken image.
fn markdown(file: &Path, stored: &Stored) -> String {
    let name = alt_text(file);
    if stored.kind.starts_with("video/") {
        format!("[{name}]({})", stored.url)
    } else {
        format!("![{name}]({})", stored.url)
    }
}

/// The file's name without its extension, with the brackets that would end
/// markdown's alt text taken out.
fn alt_text(file: &Path) -> String {
    let stem = file.file_stem().map(|s| s.to_string_lossy().into_owned()).unwrap_or_default();
    let alt: String = stem.chars().filter(|c| !matches!(c, '[' | ']' | '\n')).collect();
    if alt.is_empty() { "screenshot".into() } else { alt }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn reads_the_url_and_type_out_of_a_success() {
        let out = "{\"url\":\"https://img.drayhq.com/ab.png\",\"type\":\"image/png\",\"size\":3}\n200";
        let stored = read_reply(out).unwrap();
        assert_eq!(stored.url, "https://img.drayhq.com/ab.png");
        assert_eq!(stored.kind, "image/png");
    }

    #[test]
    fn says_each_refusal_plainly() {
        assert!(read_reply("{\"error\":\"github_token_invalid\"}\n401").err().unwrap().contains("gh auth login"));
        assert!(read_reply("{\"error\":\"not_accepted\"}\n415").err().unwrap().contains("mp4, webm or mov"));
        assert!(read_reply("{\"error\":\"slow_down\"}\n429").err().unwrap().contains("30 an hour"));
        assert_eq!(
            read_reply("{\"error\":\"too_large\",\"max_bytes\":20971520}\n413").err().unwrap(),
            "over the 20 MB limit for this kind of file"
        );
        assert_eq!(read_reply("<html>bad gateway</html>\n502").err().unwrap(), "the upload service answered 502");
        assert_eq!(
            read_reply("{\"error\":\"storage_failed\"}\n502").err().unwrap(),
            "the upload service answered 502: storage_failed"
        );
    }

    #[test]
    fn a_video_is_a_link_and_an_image_is_an_image() {
        let stored = |kind: &str| Stored { url: "https://x/k".into(), kind: kind.into() };
        assert_eq!(markdown(Path::new("demo.mp4"), &stored("video/mp4")), "[demo](https://x/k)");
        assert_eq!(markdown(Path::new("shot.png"), &stored("image/png")), "![shot](https://x/k)");
    }

    #[test]
    fn the_local_cap_follows_the_extension() {
        assert!(looks_like_image(Path::new("a.PNG")));
        assert!(looks_like_image(Path::new("a.jpeg")));
        assert!(!looks_like_image(Path::new("a.mov")));
        assert_eq!(megabytes(20 * MB), "20 MB");
        assert_eq!(megabytes(MB + MB / 2), "1.5 MB");
    }

    #[test]
    fn alt_text_is_the_name_without_brackets() {
        assert_eq!(alt_text(Path::new("/tmp/settings [dark].png")), "settings dark");
        assert_eq!(alt_text(Path::new("shot.png")), "shot");
        assert_eq!(alt_text(Path::new(".png")), ".png");
    }
}
