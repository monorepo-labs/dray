//! One line per event on stdout, logfmt: Railway keeps stdout, and a drop is
//! diagnosed afterwards by lining these lines up with a server's own log.

use std::fmt::Write;

pub fn line(event: &str, fields: &[(&str, String)]) {
    let mut out = format!("{} {event}", chrono::Utc::now().format("%Y-%m-%dT%H:%M:%S%.3fZ"));
    for (key, value) in fields {
        if value.is_empty() || value.contains([' ', '"', '=']) {
            let _ = write!(out, " {key}={value:?}");
        } else {
            let _ = write!(out, " {key}={value}");
        }
    }
    println!("{out}");
}

/// `log!("bridge.attach", id = id, peer = peer)`. Never pass a key or token.
#[macro_export]
macro_rules! log {
    ($event:expr $(, $key:ident = $value:expr)* $(,)?) => {
        $crate::log::line($event, &[$((stringify!($key), ($value).to_string())),*])
    };
}
