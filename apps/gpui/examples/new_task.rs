//! The new-task screen with fake data: three projects (one on two machines,
//! one on a server alone), both agents, a model list with efforts, and a dirty
//! branch list. The composer slot holds a stand-in. Every pick prints, so a
//! driven test can read it back.
//!
//! `cargo run --example new_task [-- --light] [-- --open model|project|server|branch]`

#![allow(dead_code)]

#[path = "../src/assets.rs"]
mod assets;
#[path = "../src/color.rs"]
mod color;
#[path = "../src/new_task.rs"]
mod new_task;
#[path = "../src/theme.rs"]
mod theme;

use dray_core::git::BranchList;
use dray_core::harness::Harness;
use dray_core::models::{Effort, Model, ModelId};
use dray_core::projects::Project;
use gpui::{
    App, Bounds, Context, IntoElement, Render, Window, WindowBounds, WindowOptions, div, prelude::*, px, rems, size,
};

use new_task::{Agent, Checkout, Menu, NewTask, NewTaskEvent};
use theme::{Mode, Theme};

fn project(path: &str, remote: Option<&str>, last: &str) -> Project {
    Project {
        path: path.into(),
        name: path.rsplit('/').next().unwrap().into(),
        space: None,
        remote: remote.map(Into::into),
        last_selected: last.into(),
    }
}

fn model(id: &str, label: &str, efforts: &[Effort], default: Option<Effort>) -> Model {
    Model {
        id: ModelId::new(id),
        label: label.into(),
        efforts: efforts.to_vec(),
        default_effort: default,
        arg: id.into(),
        provider: String::new(),
        accepts_images: true,
        secondary: false,
        supports_fast: false,
    }
}

fn claude_models() -> Vec<Model> {
    use Effort::*;
    vec![
        model("opus", "Opus 5.5", &[Low, Medium, High, Xhigh, Max], Some(High)),
        model("sonnet", "Sonnet 5.5", &[Low, Medium, High, Max], Some(Medium)),
        model("haiku", "Haiku 5.5", &[], None),
    ]
}

fn codex_models() -> Vec<Model> {
    use Effort::*;
    vec![
        model("gpt56_sol", "GPT-5.6 Sol", &[Low, Medium, High, Xhigh, Max, Ultra], Some(High)),
        model("gpt56_luna", "GPT-5.6 Luna", &[Low, Medium, High, Max], Some(Medium)),
    ]
}

fn branches() -> BranchList {
    BranchList {
        current: Some("main".into()),
        branches: ["main", "worktree-tidy-bronze-tundra", "gpui-rewrite"]
            .into_iter()
            .map(String::from)
            // `--many`: enough rows to need the menu's scroll.
            .chain(
                std::env::args()
                    .any(|a| a == "--many")
                    .then(|| (1..=40).map(|i| format!("feature-{i}")))
                    .into_iter()
                    .flatten(),
            )
            .collect(),
        default_base: Some("origin/main".into()),
        dirty: 2,
    }
}

/// Stands in for `slots::composer`: the bare new-task prompt line.
fn composer_stub(theme: &Theme) -> Option<gpui::AnyElement> {
    Some(
        div()
            .pt_3()
            .py_1()
            .text_size(px(15.))
            .line_height(rems(0.9375 * 1.5))
            .text_color(theme.muted_foreground)
            .child("Describe a task.")
            .into_any_element(),
    )
}

struct Demo {
    task: gpui::Entity<NewTask>,
    _sub: gpui::Subscription,
}

impl Render for Demo {
    fn render(&mut self, _: &mut Window, cx: &mut Context<Self>) -> impl IntoElement {
        let theme = Theme::get(cx);
        // A desktop stand-in under the body fill, since Linux has no glass.
        let backdrop: gpui::Hsla = match theme.mode {
            Mode::Dark => gpui::rgb(0x2a3340).into(),
            Mode::Light => gpui::rgb(0xc9d6e6).into(),
        };
        div()
            .size_full()
            .bg(backdrop)
            .font_family(assets::SANS)
            .child(div().size_full().bg(theme.body).children(new_task::element(theme)))
    }
}

fn main() {
    let args: Vec<String> = std::env::args().collect();
    let mode = if args.iter().any(|a| a == "--light") { Mode::Light } else { Mode::Dark };
    let open = args.iter().position(|a| a == "--open").and_then(|i| args.get(i + 1)).and_then(|m| match m.as_str() {
        "model" => Some(Menu::Model),
        "project" => Some(Menu::Project),
        "server" => Some(Menu::Server),
        "branch" => Some(Menu::Branch),
        _ => None,
    });
    let worktree = args.iter().any(|a| a == "--worktree");

    gpui_platform::application().with_assets(assets::Assets).run(move |cx: &mut App| {
        assets::load_fonts(cx);
        cx.set_global(Theme::new(mode));
        let bounds = Bounds::centered(None, size(px(1100.), px(720.)), cx);
        cx.open_window(
            WindowOptions { window_bounds: Some(WindowBounds::Windowed(bounds)), ..Default::default() },
            |_, cx| {
                cx.new(|cx| {
                    let task = new_task::install(Harness::ClaudeCode, cx);
                    task.update(cx, |t, cx| {
                        t.set_checkouts(
                            vec![
                                Checkout {
                                    project: project("/Users/me/dray", Some("github.com/monorepo-labs/dray"), "2"),
                                    server: None,
                                    connected: true,
                                },
                                Checkout {
                                    project: project("/home/me/dray", Some("github.com/monorepo-labs/dray"), "1"),
                                    server: Some("boat-7".into()),
                                    connected: true,
                                },
                                Checkout {
                                    project: project("/Users/me/site", None, "0"),
                                    server: None,
                                    connected: true,
                                },
                                Checkout {
                                    project: project("/srv/infra", None, "0"),
                                    server: Some("build-box".into()),
                                    connected: false,
                                },
                            ],
                            cx,
                        );
                        t.set_agents(
                            vec![
                                Agent { harness: Harness::ClaudeCode, available: true },
                                Agent { harness: Harness::Codex, available: false },
                            ],
                            cx,
                        );
                        t.set_models(claude_models(), cx);
                        t.restore(
                            Some("/Users/me/dray".into()),
                            ModelId::new("opus"),
                            Some(Effort::High),
                            worktree,
                            cx,
                        );
                        t.set_branches(Some(branches()), cx);
                        t.set_composer(composer_stub, cx);
                        t.open_menu(open, cx);
                    });
                    let sub = cx.subscribe(&task, |_, task, event: &NewTaskEvent, cx| {
                        println!("{event:?}");
                        // What the owner does on the wire, faked.
                        match event {
                            NewTaskEvent::PickHarness(h) => task.update(cx, |t, cx| {
                                t.set_models(if *h == Harness::Codex { codex_models() } else { claude_models() }, cx)
                            }),
                            NewTaskEvent::PickCheckout(_) => {
                                task.update(cx, |t, cx| t.set_branches(Some(branches()), cx))
                            }
                            _ => {}
                        }
                    });
                    Demo { task, _sub: sub }
                })
            },
        )
        .unwrap();
        cx.activate(true);
    });
}
