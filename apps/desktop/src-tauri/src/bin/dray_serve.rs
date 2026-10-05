//! `dray-serve [--port N]`: Dray's core with no window. See SERVE-PLAN.md.

const DEFAULT_PORT: u16 = 7317;

#[tokio::main]
async fn main() {
    let mut args = std::env::args().skip(1);
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

    ade_lib::analytics::install_panic_hook();
    if let Err(e) = ade_lib::serve::run(port).await {
        eprintln!("dray-serve: {e:#}");
        std::process::exit(1);
    }
}
