//! `dray upload`: put screenshots somewhere a PR body can show them (#1477).
//!
//! GitHub takes image uploads only through its web editor, so this sends each
//! file to drayhq.com's `/api/upload`, which checks the caller's GitHub token
//! and stores it in R2. Through `curl`, as `dray update` already is, so this
//! binary links no HTTP stack.

use std::io::Write;
use std::path::{Path, PathBuf};
use std::process::{Command, Stdio};

use clap::Args;

/// The site's own cap. Checked here first so a big file fails before it is sent.
const MAX_BYTES: u64 = 4 * 1024 * 1024;

#[derive(Args)]
pub struct Upload {
    /// Images to upload: png, jpg, gif or webp, 4 MB each at most. Prints one
    /// markdown image line per file, ready for a PR body.
    #[arg(required = true, value_name = "FILE")]
    files: Vec<PathBuf>,
}

/// Uploads every file in turn, printing a markdown line for each that lands.
/// One failing does not stop the rest; any failure makes the exit non-zero.
pub fn run(args: Upload) -> Result<(), String> {
    let token = github_token()?;
    let endpoint = format!("{}/api/upload", site());
    let mut failed = 0;
    for file in &args.files {
        match upload(file, &token, &endpoint) {
            Ok(url) => println!("![{}]({url})", alt_text(file)),
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

/// drayhq.com, or `DRAY_ACCOUNT_URL` for a local site, as the server's org link reads it.
fn site() -> String {
    std::env::var("DRAY_ACCOUNT_URL")
        .ok()
        .filter(|s| !s.is_empty())
        .unwrap_or_else(|| "https://www.drayhq.com".into())
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

fn upload(file: &Path, token: &str, endpoint: &str) -> Result<String, String> {
    let size = std::fs::metadata(file).map_err(|e| e.to_string())?.len();
    if size > MAX_BYTES {
        return Err(format!("{:.1} MB is over the 4 MB limit", size as f64 / 1048576.0));
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

/// The URL out of curl's output, the body then `-w`'s status on its own line,
/// or the site's refusal said plainly.
fn read_reply(output: &str) -> Result<String, String> {
    let (body, status) = output.rsplit_once('\n').unwrap_or(("", output));
    let json: serde_json::Value = serde_json::from_str(body).unwrap_or_default();
    if status.trim() == "200" {
        if let Some(url) = json["url"].as_str() {
            return Ok(url.into());
        }
    }
    Err(match (status.trim(), json["error"].as_str()) {
        ("401", Some("github_token_invalid")) => {
            "GitHub refused the token. Run `gh auth login`, or set GITHUB_TOKEN to a user's token".into()
        }
        ("401", _) => "the site wants a GitHub token".into(),
        ("413", _) => "over the 4 MB limit".into(),
        ("415", _) => "not a png, jpg, gif or webp image".into(),
        ("429", _) => "too many uploads; each GitHub user gets 30 an hour. Try again later".into(),
        ("503", _) => "uploads are not set up on this site".into(),
        (status, Some(error)) => format!("the site answered {status}: {error}"),
        (status, None) => format!("the site answered {status}"),
    })
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
    fn reads_the_url_out_of_a_success() {
        let out = "{\"url\":\"https://img.drayhq.com/ab.png\",\"type\":\"image/png\",\"size\":3}\n200";
        assert_eq!(read_reply(out).unwrap(), "https://img.drayhq.com/ab.png");
    }

    #[test]
    fn says_each_refusal_plainly() {
        assert!(read_reply("{\"error\":\"github_token_invalid\"}\n401").unwrap_err().contains("gh auth login"));
        assert!(read_reply("{\"error\":\"not_an_image\"}\n415").unwrap_err().contains("not a png"));
        assert!(read_reply("{\"error\":\"slow_down\"}\n429").unwrap_err().contains("30 an hour"));
        assert_eq!(read_reply("<html>bad gateway</html>\n502").unwrap_err(), "the site answered 502");
        assert_eq!(read_reply("{\"error\":\"storage_failed\"}\n502").unwrap_err(), "the site answered 502: storage_failed");
    }

    #[test]
    fn alt_text_is_the_name_without_brackets() {
        assert_eq!(alt_text(Path::new("/tmp/settings [dark].png")), "settings dark");
        assert_eq!(alt_text(Path::new("shot.png")), "shot");
        assert_eq!(alt_text(Path::new(".png")), ".png");
    }
}
