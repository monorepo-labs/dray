fn main() {
    // `analytics.rs` reads this through `option_env!`, which is resolved at
    // compile time — without the declaration, a key exported after the first
    // build stays baked in as absent until something else forces a rebuild.
    println!("cargo:rerun-if-env-changed=POSTHOG_KEY");
    println!("cargo:rerun-if-env-changed=POSTHOG_HOST");

    tauri_build::build()
}
