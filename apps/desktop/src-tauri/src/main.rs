// Prevents additional console window on Windows in release, DO NOT REMOVE!!
#![cfg_attr(not(debug_assertions), windows_subsystem = "windows")]

#[tokio::main]
async fn main() {
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
    ade_lib::run()
}
