//! Starting a server at login on Windows, where launchd and systemd's place is
//! taken by the user's `Run` key: per user, needs no admin, and runs each
//! command once the user signs in. Here because the app and the CLI both
//! write one, and this is the crate they share.
//!
//! A `Run` command carries no environment and no log of its own, so the
//! servers take `--env K=V` and `--log <file>` instead; [`command_line`]
//! spells them.

/// `HKCU\` + this: the key Windows reads at every sign-in.
pub const RUN_KEY: &str = r"Software\Microsoft\Windows\CurrentVersion\Run";

/// The value the Dray app writes, for its own binary run with `--serve`.
pub const APP_VALUE: &str = "Dray";

/// The value `dray server start` writes, for a `dray-serve` with no app.
pub const CLI_VALUE: &str = "Dray server";

/// One command line, each argument quoted the way `CommandLineToArgvW` reads
/// it back: in quotes where it holds a space, a tab or a quote, with a quote
/// and the backslashes before one, or before the closing quote, escaped.
pub fn command_line(args: &[&str]) -> String {
    args.iter()
        .map(|arg| {
            if !arg.is_empty() && !arg.contains([' ', '\t', '"']) {
                return arg.to_string();
            }
            let mut out = String::from('"');
            let mut slashes = 0;
            for c in arg.chars() {
                match c {
                    '\\' => slashes += 1,
                    '"' => {
                        out.push_str(&"\\".repeat(slashes * 2 + 1));
                        out.push('"');
                        slashes = 0;
                    }
                    _ => {
                        out.push_str(&"\\".repeat(slashes));
                        out.push(c);
                        slashes = 0;
                    }
                }
            }
            out.push_str(&"\\".repeat(slashes * 2));
            out.push('"');
            out
        })
        .collect::<Vec<_>>()
        .join(" ")
}

/// The flags [`command_line`] writes after the binary, back out of a server's
/// own arguments: `--env K=V` pairs, for the two variables a server keeps from
/// where it was set up, and `--log <file>`. Everything else is returned for
/// the server to read as before. A pair naming any other variable is dropped,
/// so a hand-edited `Run` value cannot set `PATH` or the like.
pub fn take_launch_args(args: Vec<String>) -> (Vec<(String, String)>, Option<String>, Vec<String>) {
    let (mut env, mut log, mut rest) = (Vec::new(), None, Vec::new());
    let mut it = args.into_iter();
    while let Some(arg) = it.next() {
        match arg.as_str() {
            "--env" => {
                if let Some((k, v)) = it.next().as_deref().and_then(|pair| pair.split_once('=')) {
                    if matches!(k, "DRAY_HOME" | "DRAY_NO_ANALYTICS") {
                        env.push((k.to_string(), v.to_string()));
                    }
                }
            }
            "--log" => log = it.next(),
            _ => rest.push(arg),
        }
    }
    (env, log, rest)
}

#[cfg(windows)]
mod registry {
    use std::io;
    use windows_sys::Win32::System::Registry::{
        RegDeleteKeyValueW, RegGetValueW, RegSetKeyValueW, HKEY_CURRENT_USER, REG_SZ, RRF_RT_REG_SZ,
    };

    fn wide(s: &str) -> Vec<u16> {
        s.encode_utf16().chain(Some(0)).collect()
    }

    /// The command under `name`, if any.
    pub fn read(name: &str) -> Option<String> {
        let (key, value) = (wide(super::RUN_KEY), wide(name));
        let mut len = 0u32;
        // SAFETY: sizes first, then a buffer of exactly that many bytes.
        unsafe {
            let sized = RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), std::ptr::null_mut(), &mut len);
            if sized != 0 || len == 0 {
                return None;
            }
            let mut buf = vec![0u16; (len as usize).div_ceil(2)];
            let got = RegGetValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr(), RRF_RT_REG_SZ, std::ptr::null_mut(), buf.as_mut_ptr().cast(), &mut len);
            if got != 0 {
                return None;
            }
            let end = buf.iter().position(|&c| c == 0).unwrap_or(buf.len());
            Some(String::from_utf16_lossy(&buf[..end]))
        }
    }

    /// Sets `name` to `command`, the key made where it is missing.
    pub fn write(name: &str, command: &str) -> io::Result<()> {
        let (key, value, data) = (wide(super::RUN_KEY), wide(name), wide(command));
        // SAFETY: NUL-terminated wide strings, `data`'s length in bytes.
        let status = unsafe {
            RegSetKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr(), REG_SZ, data.as_ptr().cast(), (data.len() * 2) as u32)
        };
        if status == 0 { Ok(()) } else { Err(io::Error::from_raw_os_error(status as i32)) }
    }

    /// Removes `name`; one already gone is no error.
    pub fn remove(name: &str) -> io::Result<()> {
        let (key, value) = (wide(super::RUN_KEY), wide(name));
        // SAFETY: NUL-terminated wide strings.
        let status = unsafe { RegDeleteKeyValueW(HKEY_CURRENT_USER, key.as_ptr(), value.as_ptr()) };
        match status {
            0 | 2 => Ok(()), // ERROR_FILE_NOT_FOUND
            _ => Err(io::Error::from_raw_os_error(status as i32)),
        }
    }
}

#[cfg(windows)]
pub use registry::{read, remove, write};

#[cfg(test)]
mod tests {
    use super::*;

    /// What the app writes, read back as Windows splits it.
    #[test]
    fn a_command_line_quotes_what_it_must() {
        let line = command_line(&[r"C:\Program Files\Dray\dray-app.exe", "--serve", "--log", r"C:\Users\A B\.dray\server.log", "--env", "DRAY_NO_ANALYTICS=1"]);
        assert_eq!(
            line,
            r#""C:\Program Files\Dray\dray-app.exe" --serve --log "C:\Users\A B\.dray\server.log" --env DRAY_NO_ANALYTICS=1"#
        );
        assert_eq!(command_line(&[r#"a "b""#, r"c d\"]), r#""a \"b\"" "c d\\""#);
    }

    #[test]
    fn launch_args_come_off_and_the_rest_stays() {
        let args = ["--env", "DRAY_HOME=C:\\h", "--port", "0", "--log", "C:\\l", "--env", "PATH=x"]
            .map(String::from)
            .to_vec();
        let (env, log, rest) = take_launch_args(args);
        assert_eq!(env, [("DRAY_HOME".to_string(), "C:\\h".to_string())]);
        assert_eq!(log.as_deref(), Some("C:\\l"));
        assert_eq!(rest, ["--port", "0"]);
    }
}
