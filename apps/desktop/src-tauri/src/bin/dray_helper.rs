//! CEF's subprocess. Chromium runs its renderer, GPU and utility work in
//! child processes, and on macOS each is a separate app bundle beside the
//! framework — this binary, copied under five names. It loads the framework
//! and hands control to CEF; nothing of Dray's runs here.

use std::path::PathBuf;

const FRAMEWORK: &str = "Chromium Embedded Framework.framework";

fn main() {
    let args = cef::args::Args::new();
    // CEF hands every child the browser's `framework_dir_path` as this
    // switch, and a release's framework lives in `~/.dray/cef`, not beside
    // the helper. The bundle-relative path is the dev layout's.
    let framework = std::env::args()
        .find_map(|a| a.strip_prefix("--framework-dir-path=").map(PathBuf::from))
        .unwrap_or_else(|| {
            let exe = std::env::current_exe().expect("no current exe");
            exe.parent().expect("no exe dir").join("../../..").join(FRAMEWORK)
        })
        .join("Chromium Embedded Framework");
    let c_path = std::ffi::CString::new(framework.as_os_str().as_encoded_bytes()).expect("path");
    assert!(
        cef::load_library(Some(unsafe { &*c_path.as_ptr() })) == 1,
        "could not load the Chromium framework at {}",
        framework.display()
    );
    let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
    let code = cef::execute_process(Some(args.as_main_args()), None::<&mut cef::App>, std::ptr::null_mut());
    std::process::exit(code);
}
