//! Dray's desktop app on GPUI (#856). Milestone 1 is a client of the server
//! this Mac already runs; see apps/gpui/README.md.

mod assets;
mod chat;
// Not wired into the transcript yet; examples/code.rs draws it.
#[allow(dead_code)]
#[path = "code/code.rs"]
mod code;
mod color;
// Built apart and shown by examples/composer.rs; the Mac task wires it in (#856).
#[allow(dead_code)]
#[path = "composer/composer.rs"]
mod composer;
mod glass;
#[allow(dead_code)] // Until the transcript draws assistant text through it.
mod markdown;
#[allow(dead_code)] // Its pick events reach nothing yet; the window subscribes in a follow-up.
mod new_task;
mod cards;
mod chat_tokens;
mod permission_card;
mod question_card;
mod sessions;
mod sidebar;
mod slots;
mod store;
mod theme;
mod transcript;
mod tool_row;
mod tools;
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
