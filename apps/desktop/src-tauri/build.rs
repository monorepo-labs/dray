use std::{env, fs, path::Path};

fn main() {
    // `analytics.rs` reads this through `option_env!`, which is resolved at
    // compile time — without the declaration, a key exported after the first
    // build stays baked in as absent until something else forces a rebuild.
    println!("cargo:rerun-if-env-changed=POSTHOG_KEY");
    println!("cargo:rerun-if-env-changed=POSTHOG_HOST");

    // Before `tauri_build`, which checks that every bundled resource exists.
    transcribe_libs();

    #[cfg(feature = "desktop")]
    tauri_build::build()
}

/// Where the bundle puts the libraries, relative to the binary: Tauri installs
/// resources under `/usr/lib/<productName>/` beside `/usr/bin/<binary>`, in the
/// `.deb` and inside the AppImage alike. See `tauri.linux.conf.json`.
const BUNDLED_RPATH: &str = "$ORIGIN/../lib/Dray/transcribe";

/// Copies the shared libtranscribe and its backend modules (Linux's
/// `dynamic-backends` build, see Cargo.toml) to `transcribe-libs/`, a fixed
/// path the bundler can name, and points the binary at them.
///
/// A static build sets none of the `DEP_` keys and this does nothing.
fn transcribe_libs() {
    println!("cargo:rerun-if-env-changed=DEP_TRANSCRIBE_CPP_RUNTIME_DIR");
    println!("cargo:rerun-if-env-changed=DEP_TRANSCRIBE_CPP_MODULE_DIR");
    let Some(runtime) = env::var_os("DEP_TRANSCRIBE_CPP_RUNTIME_DIR") else {
        return;
    };

    let dest = Path::new(env!("CARGO_MANIFEST_DIR")).join("transcribe-libs");
    let _ = fs::remove_dir_all(&dest);
    fs::create_dir_all(&dest).expect("create transcribe-libs");

    let mut dirs = vec![runtime];
    dirs.extend(env::var_os("DEP_TRANSCRIBE_CPP_MODULE_DIR"));
    for dir in dirs {
        for entry in fs::read_dir(&dir).expect("read transcribe runtime dir") {
            let path = entry.expect("transcribe runtime entry").path();
            let name = path.file_name().unwrap().to_string_lossy().into_owned();
            if wanted(&path, &name) {
                // Follows the link, so the SONAME lands as a real file.
                fs::copy(&path, dest.join(&name)).expect("copy transcribe library");
            }
        }
    }

    // The bundle's place first; the copy beside the sources for `tauri dev`
    // and `cargo test`, which run the binary where cargo left it.
    println!("cargo:rustc-link-arg=-Wl,-rpath,{BUNDLED_RPATH}");
    println!("cargo:rustc-link-arg=-Wl,-rpath,{}", dest.display());
}

/// One file per library, under the name the loader asks for.
///
/// CMake lays each versioned library out as `libX.so -> libX.so.0 ->
/// libX.so.0.26.0`, and the loader asks for the middle name, the SONAME — the
/// one link pointing at a real file. Copying all three ships every library
/// three times over. A module is a bare `libggml-cpu-zen4.so`, no link at all.
fn wanted(path: &Path, name: &str) -> bool {
    let Ok(meta) = fs::symlink_metadata(path) else {
        return false;
    };
    if meta.file_type().is_symlink() {
        return fs::read_link(path)
            .map(|target| path.with_file_name(target))
            .and_then(fs::symlink_metadata)
            .is_ok_and(|m| m.file_type().is_file());
    }
    meta.is_file() && name.ends_with(".so")
}
