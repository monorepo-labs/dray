/// The installer's channel resolver decides which binary every `dray update`
/// downloads, and it is shell, so it is checked here where release-cli's test
/// job already runs.
#[test]
fn installer_resolves_each_channel() {
    let dir = env!("CARGO_MANIFEST_DIR");
    let out = std::process::Command::new("sh")
        .arg(format!("{dir}/tests/install_resolver.sh"))
        .arg(format!("{dir}/../web/public/install.sh"))
        .output()
        .expect("sh runs");
    let text = String::from_utf8_lossy(&out.stdout);
    assert!(out.status.success(), "{text}{}", String::from_utf8_lossy(&out.stderr));
    assert_eq!(text.lines().filter(|l| l.starts_with("ok ")).count(), 12, "{text}");
}
