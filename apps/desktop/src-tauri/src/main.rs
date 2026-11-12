// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

fn main() {
    // Chromium's renderer, GPU and zygote processes on Linux: this binary
    // again, run with `--type=`. Before tokio, since the zygote forks every
    // renderer and refuses to with other threads alive.
    #[cfg(all(feature = "cef", target_os = "linux"))]
    if let Some(code) = ade_lib::cef::subprocess() {
        std::process::exit(code);
    }
    // Inside an AppImage, before anything is spawned and before tokio's
    // threads: the runtime's fds stay out of every child, Chromium's included.
    // Not in the `--type=` runs above, whose fds Chromium arranges itself.
    #[cfg(target_os = "linux")]
    {
        ade_lib::serve::appimage_cloexec();
        // The headless server needs none of what AppRun added for GTK, and
        // every agent it starts would otherwise inherit the bundle's
        // libraries. The app keeps it, and so do its Chromium processes,
        // which run the same bundle.
        if std::env::args().nth(1).as_deref() == Some("--serve") {
            for (key, value) in ade_lib::serve::appimage_env_undo() {
                match value {
                    Some(value) => std::env::set_var(key, value),
                    None => std::env::remove_var(key),
                }
            }
        } else {
            // Before GTK reads it, and before Chromium inherits it.
            for (key, value) in ade_lib::ibus::fallback() {
                std::env::set_var(key, value);
            }
        }
    }
    run()
}

#[tokio::main]
async fn run() {
    // The Mac's background server: this same binary, run by launchd with no
    // window. Read before Tauri is touched, so no `NSApplication` exists and
    // macOS never counts it as the app running. See MAC-SERVER-PLAN.md.
    if std::env::args().nth(1).as_deref() == Some("--serve") {
        ade_lib::analytics::install_panic_hook();
        if let Err(e) = ade_lib::serve::run_mac().await {
            eprintln!("dray --serve: {e:#}");
            std::process::exit(1);
        }
        return;
    }
    // X11 even on a Wayland desktop, through XWayland: the embedded browser
    // needs a window id to parent its view into, which Wayland never hands out.
    // Only where an X display exists and the reader picked no backend, or a
    // desktop without XWayland could not open the window at all. Set before
    // GTK starts, since GTK reads it once at init.
    #[cfg(target_os = "linux")]
    if std::env::var_os("DISPLAY").is_some() && std::env::var_os("GDK_BACKEND").is_none() {
        std::env::set_var("GDK_BACKEND", "x11");
    }
    #[cfg(target_os = "linux")]
    ade_lib::transcription::audio::adopt_pulse_server();
    ade_lib::run()
}
