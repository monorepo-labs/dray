//! Falling back off IBus when it is asked for and nothing answers.
//!
//! With `GTK_IM_MODULE=ibus` and no daemon behind the address, GTK's IBus
//! module takes every key and hands back none, so the browser pane and the
//! webview both go deaf (#710). The simple input method is what GTK uses with
//! no input method at all: dead keys and compose still work, an IME does not —
//! and there is no IME to lose, since its daemon is the thing not answering.

use std::path::{Path, PathBuf};

/// The environment to start GTK with, empty unless IBus is wanted and its
/// socket refuses. Read once, before GTK or Chromium start.
pub fn fallback() -> Vec<(&'static str, &'static str)> {
    let gtk = std::env::var("GTK_IM_MODULE").unwrap_or_default();
    let xmodifiers = std::env::var("XMODIFIERS").unwrap_or_default();
    let via_xim = xmodifiers.contains("@im=ibus");
    // Unset, GTK takes the desktop's pick, and XMODIFIERS is what says it is IBus.
    let wanted = gtk == "ibus" || (gtk.is_empty() && via_xim);
    if !wanted || address().is_some_and(|a| reachable(&a)) {
        return Vec::new();
    }
    eprintln!("[ibus] no daemon answers; using GTK's simple input method");
    let mut env = vec![("GTK_IM_MODULE", "gtk-im-context-simple")];
    if via_xim {
        env.push(("XMODIFIERS", "@im=none"));
    }
    env
}

/// The bus address IBus's own client would use: `IBUS_ADDRESS`, else the
/// file the daemon wrote for this machine and display.
fn address() -> Option<String> {
    if let Some(address) = std::env::var("IBUS_ADDRESS").ok().filter(|a| !a.is_empty()) {
        return Some(address);
    }
    let file = match std::env::var_os("IBUS_ADDRESS_FILE") {
        Some(file) => PathBuf::from(file),
        None => config_dir()?.join("ibus/bus").join(socket_file(&machine_id()?)),
    };
    address_in(&std::fs::read_to_string(file).ok()?)
}

fn config_dir() -> Option<PathBuf> {
    match std::env::var_os("XDG_CONFIG_HOME").filter(|d| !d.is_empty()) {
        Some(dir) => Some(PathBuf::from(dir)),
        None => std::env::home_dir().map(|h| h.join(".config")),
    }
}

fn machine_id() -> Option<String> {
    ["/var/lib/dbus/machine-id", "/etc/machine-id"]
        .iter()
        .find_map(|p| std::fs::read_to_string(p).ok())
        .map(|id| id.trim().to_string())
}

/// The file's name, as `ibus_get_socket_path` makes it. IBus 1.5 reads
/// `WAYLAND_DISPLAY` before `DISPLAY`, so a GTK on XWayland still looks for
/// the Wayland one.
fn socket_file(machine_id: &str) -> String {
    match std::env::var("WAYLAND_DISPLAY").ok().filter(|d| !d.is_empty()) {
        Some(wayland) => format!("{machine_id}-unix-{wayland}"),
        None => x_socket_file(machine_id, &std::env::var("DISPLAY").unwrap_or_default()),
    }
}

/// `<machine-id>-<host>-<display number>`: `unix` for a local display, the
/// screen number dropped.
fn x_socket_file(machine_id: &str, display: &str) -> String {
    let (host, rest) = display.split_once(':').unwrap_or((display, ""));
    let host = if host.is_empty() { "unix" } else { host };
    let number = rest.split('.').next().filter(|n| !n.is_empty()).unwrap_or("0");
    format!("{machine_id}-{host}-{number}")
}

fn address_in(file: &str) -> Option<String> {
    file.lines()
        .find_map(|l| l.strip_prefix("IBUS_ADDRESS="))
        .map(str::to_string)
        .filter(|a| !a.is_empty())
}

/// Whether the address's socket takes a connection. A refusal is the case
/// seen: the file and the socket outlive a daemon that stopped answering.
fn reachable(address: &str) -> bool {
    use std::os::linux::net::SocketAddrExt;
    use std::os::unix::ffi::OsStringExt;
    use std::os::unix::net::{SocketAddr, UnixStream};

    let Some(params) = address.split(';').next().and_then(|a| a.strip_prefix("unix:")) else {
        // Not a unix socket; nothing here can judge it, so leave IBus be.
        return true;
    };
    for param in params.split(',') {
        if let Some(path) = param.strip_prefix("path=") {
            let path = std::ffi::OsString::from_vec(unescape(path));
            return UnixStream::connect(Path::new(&path)).is_ok();
        }
        if let Some(name) = param.strip_prefix("abstract=") {
            return SocketAddr::from_abstract_name(unescape(name))
                .and_then(|addr| UnixStream::connect_addr(&addr))
                .is_ok();
        }
    }
    true
}

/// A D-Bus address value's bytes: everything outside a small safe set travels
/// as `%XX`, so `/home/A B` arrives as `/home/A%20B`.
fn unescape(value: &str) -> Vec<u8> {
    let bytes = value.as_bytes();
    let mut out = Vec::with_capacity(bytes.len());
    let mut i = 0;
    while i < bytes.len() {
        let hex = bytes.get(i + 1..i + 3).and_then(|h| std::str::from_utf8(h).ok());
        match (bytes[i], hex.and_then(|h| u8::from_str_radix(h, 16).ok())) {
            (b'%', Some(byte)) => {
                out.push(byte);
                i += 3;
            }
            (byte, _) => {
                out.push(byte);
                i += 1;
            }
        }
    }
    out
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn names_the_socket_file_as_ibus_does() {
        assert_eq!(x_socket_file("abc", ":0"), "abc-unix-0");
        assert_eq!(x_socket_file("abc", ":1.0"), "abc-unix-1");
        assert_eq!(x_socket_file("abc", "box:10"), "abc-box-10");
        assert_eq!(x_socket_file("abc", ""), "abc-unix-0");
    }

    #[test]
    fn reads_the_address_out_of_the_file() {
        let file = "# comment\nIBUS_ADDRESS=unix:path=/tmp/x,guid=1\nIBUS_DAEMON_PID=7\n";
        assert_eq!(address_in(file).as_deref(), Some("unix:path=/tmp/x,guid=1"));
        assert_eq!(address_in("IBUS_ADDRESS=\n"), None);
    }

    #[test]
    fn a_socket_nobody_listens_on_is_unreachable() {
        let dir = std::env::temp_dir().join(format!("dray-ibus-{}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sock");
        let listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let address = format!("unix:path={},guid=1", path.display());
        assert!(reachable(&address));
        // The socket file stays behind when its listener goes, as IBus's does.
        drop(listener);
        assert!(!reachable(&address));
        let _ = std::fs::remove_dir_all(dir);
    }

    #[test]
    fn an_escaped_path_reaches_its_socket() {
        let dir = std::env::temp_dir().join(format!("dray ibus {}", std::process::id()));
        std::fs::create_dir_all(&dir).unwrap();
        let path = dir.join("sock");
        let _listener = std::os::unix::net::UnixListener::bind(&path).unwrap();
        let escaped = path.display().to_string().replace(' ', "%20");
        assert!(reachable(&format!("unix:path={escaped},guid=1")));
        assert_eq!(unescape("a%2Cb%zz%"), b"a,b%zz%");
        let _ = std::fs::remove_dir_all(dir);
    }
}
