//! `dray-serve [--port N | --version]`: Dray's core with no window. See
//! SERVE-PLAN.md. A Windows login `Run` command adds `--env K=V` and
//! `--log <file>` ([`dray_proto::login`]).

const DEFAULT_PORT: u16 = dray_proto::SERVE_PORT;

fn main() {
    // What `dray update` compares the installer's pick against, since beside
    // the Mac app the `dray` next to this one no longer says what it is.
    if std::env::args().nth(1).as_deref() == Some("--version") {
        println!("dray-serve {}", option_env!("DRAY_CLI_VERSION").unwrap_or("dev"));
        return;
    }
    // Before the runtime's threads, which must not see the environment move.
    let mut args = ade_lib::platform::apply_launch_args(std::env::args().skip(1).collect()).into_iter();
    let mut port = DEFAULT_PORT;
    while let Some(arg) = args.next() {
        match (arg.as_str(), args.next().map(|v| v.parse())) {
            ("--port", Some(Ok(p))) => port = p,
            _ => {
                eprintln!("usage: dray-serve [--port N]   (default {DEFAULT_PORT}; 0 picks one)");
                std::process::exit(2);
            }
        }
    }
    serve(port);
}

#[tokio::main]
async fn serve(port: u16) {
    ade_lib::analytics::install_panic_hook();
    if let Err(e) = ade_lib::serve::run(port).await {
        eprintln!("dray-serve: {e:#}");
        std::process::exit(1);
    }
}
