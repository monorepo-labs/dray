//! CEF's subprocess. Chromium runs its renderer, GPU and utility work in
//! child processes, and on macOS each is a separate app bundle beside the
//! framework — this binary, copied under five names. It loads the framework
//! from the bundle it sits in and hands control to CEF; nothing of Dray's
//! runs here.

fn main() {
    let args = cef::args::Args::new();
    // `true`: resolve the framework from a helper's place in the bundle
    // (`../../../Chromium Embedded Framework.framework`).
    let loader = cef::library_loader::LibraryLoader::new(
        &std::env::current_exe().expect("no current exe"),
        true,
    );
    assert!(loader.load(), "could not load the Chromium framework");
    let _ = cef::api_hash(cef::sys::CEF_API_VERSION_LAST, 0);
    let code = cef::execute_process(Some(args.as_main_args()), None::<&mut cef::App>, std::ptr::null_mut());
    std::process::exit(code);
}
