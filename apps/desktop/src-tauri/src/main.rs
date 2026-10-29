// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tokio::main]
async fn main() {
    // The Mac's background server: this same binary, run by launchd with no
    // window. Read before Tauri is touched, so no `NSApplication` exists and
    // macOS never counts it as the app running. See MAC-SERVER-PLAN.md.
    if std::env::args().nth(1).as_deref() == Some("--serve") {
        // Headless, so it needs none of what AppRun added for GTK, and every
        // agent it starts would otherwise inherit the bundle's libraries.
        #[cfg(target_os = "linux")]
        for (key, value) in ade_lib::serve::appimage_env_undo() {
            match value {
                Some(value) => std::env::set_var(key, value),
                None => std::env::remove_var(key),
            }
        }
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
    ade_lib::run()
}
