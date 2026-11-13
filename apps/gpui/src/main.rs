//! Dray's desktop app on GPUI (#856). Milestone 1 is a client of the server
//! this Mac already runs; see apps/gpui/README.md.

mod assets;
mod color;
mod glass;
#[allow(dead_code)] // Until the transcript draws assistant text through it.
mod markdown;
mod sessions;
mod sidebar;
mod store;
mod theme;
mod ui;
mod wire;
mod workspace;

fn main() {
    env_logger::Builder::from_env(env_logger::Env::default().default_filter_or("dray_gpui=info")).init();
    gpui_platform::application().with_assets(assets::Assets).run(|cx| {
        assets::load_fonts(cx);
        workspace::open(cx);
    });
}
