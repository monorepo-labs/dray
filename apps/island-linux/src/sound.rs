//! The island's sounds, the files the Mac island plays: Dray's own
//! `notification.wav` for a new waiting card, the island's `send.wav` as a
//! send or the last answer flashes, and Dray's dictation tones. Each is handed to whichever of PipeWire's,
//! PulseAudio's or ALSA's players is installed, so the island links no audio
//! library.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

static NOTIFICATION: &[u8] = include_bytes!("../../desktop/public/notification.wav");
static SEND: &[u8] = include_bytes!("../../island/Island/send.wav");
static START: &[u8] = include_bytes!("../../desktop/src/assets/dictate-start.wav");
static STOP: &[u8] = include_bytes!("../../desktop/src/assets/dictate-stop.wav");

/// Written once per run, under a name of this process's own and only ever
/// created fresh: `create_new` refuses a path that exists, a planted symlink
/// included, which matters where there is no `XDG_RUNTIME_DIR` and the file
/// lands in the shared temp dir.
fn file(cell: &'static OnceLock<Option<PathBuf>>, name: &str, bytes: &[u8]) -> Option<&'static PathBuf> {
    use std::io::Write;
    use std::os::unix::fs::OpenOptionsExt;
    cell.get_or_init(|| {
        let dir = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let path = dir.join(format!("dray-island-{}-{name}.wav", std::process::id()));
        let mut file = std::fs::OpenOptions::new().write(true).create_new(true).mode(0o600).open(&path).ok()?;
        file.write_all(bytes).ok()?;
        Some(path)
    })
    .as_ref()
}

static CHIME: OnceLock<Option<PathBuf>> = OnceLock::new();
static SENT: OnceLock<Option<PathBuf>> = OnceLock::new();
static STARTED: OnceLock<Option<PathBuf>> = OnceLock::new();
static STOPPED: OnceLock<Option<PathBuf>> = OnceLock::new();

pub fn chime() {
    play(file(&CHIME, "notification", NOTIFICATION));
}

pub fn send() {
    play(file(&SENT, "send", SEND));
}

/// Dray's own dictation tones, so the island and the app dictate alike: the
/// microphone opened, and dictated words became a row.
pub fn dictation_started() {
    play(file(&STARTED, "dictate-start", START));
}

pub fn dictation_stopped() {
    play(file(&STOPPED, "dictate-stop", STOP));
}

/// Removes this run's files on the way out, since each run names its own.
pub fn forget() {
    for cell in [&CHIME, &SENT, &STARTED, &STOPPED] {
        if let Some(Some(path)) = cell.get() {
            let _ = std::fs::remove_file(path);
        }
    }
}

/// Plays without waiting; silence where no player is found.
fn play(path: Option<&'static PathBuf>) {
    let Some(path) = path else { return };
    std::thread::spawn(move || {
        for player in ["pw-play", "paplay", "aplay"] {
            let mut command = Command::new(player);
            if player == "aplay" {
                command.arg("-q");
            }
            let spawned = command.arg(path).stdin(Stdio::null()).stdout(Stdio::null()).stderr(Stdio::null()).spawn();
            // One that runs but fails — `pw-play` with only PulseAudio up —
            // gives way to the next.
            if let Ok(mut child) = spawned
                && child.wait().is_ok_and(|status| status.success())
            {
                return;
            }
        }
    });
}
