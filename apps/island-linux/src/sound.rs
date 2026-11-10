//! The island's two sounds, the files the Mac island plays: Dray's own
//! `notification.wav` for a new waiting card, and the island's `send.wav` as
//! the last card answered flashes. Each is handed to whichever of PipeWire's,
//! PulseAudio's or ALSA's players is installed, so the island links no audio
//! library.

use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

static NOTIFICATION: &[u8] = include_bytes!("../../desktop/public/notification.wav");
static SEND: &[u8] = include_bytes!("../../island/Island/send.wav");

/// Written once per run where only this user can reach it.
fn file(cell: &'static OnceLock<Option<PathBuf>>, name: &str, bytes: &[u8]) -> Option<&'static PathBuf> {
    cell.get_or_init(|| {
        let dir = std::env::var_os("XDG_RUNTIME_DIR").map(PathBuf::from).unwrap_or_else(std::env::temp_dir);
        let path = dir.join(format!("dray-island-{name}.wav"));
        std::fs::write(&path, bytes).ok().map(|()| path)
    })
    .as_ref()
}

pub fn chime() {
    static FILE: OnceLock<Option<PathBuf>> = OnceLock::new();
    play(file(&FILE, "notification", NOTIFICATION));
}

pub fn send() {
    static FILE: OnceLock<Option<PathBuf>> = OnceLock::new();
    play(file(&FILE, "send", SEND));
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
            if let Ok(mut child) = spawned {
                let _ = child.wait();
                return;
            }
        }
    });
}
