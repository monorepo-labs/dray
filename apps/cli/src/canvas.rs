//! `dray canvas`: the task's design canvas, as the agent sees it.
//!
//! The canvas is one file in the checkout, `.dray/canvas.json`, which the app's
//! Canvas tab reads and writes too. Edited here directly rather than over the
//! socket: the agent always runs in the checkout it describes, and a file in the
//! tree travels with the branch. Kept as untyped JSON so a field this build
//! cannot spell survives a round trip.

use std::path::{Path, PathBuf};

use clap::{Args, Subcommand};
use serde_json::{json, Map, Value};

/// The Vite plugin `setup` writes into the project.
const VITE_PLUGIN: &str = include_str!("../canvas/vite-plugin.mjs");
const FILE: &str = ".dray/canvas.json";
const PLUGIN_FILE: &str = ".dray/canvas/vite-plugin.mjs";
/// Room left between frames placed side by side.
const GAP: f64 = 80.0;

/// `dray canvas --help`, which is where an agent without the newest skill learns the rules.
pub const ABOUT: &str = "This task's design canvas: pages of live frames from the project's own dev server, \
shown in the task's Canvas tab. React on Vite.

Once per project: `dray canvas setup`, add the import it prints to vite.config, and start the dev \
server in the background from the checkout. The tab finds it.

Variations are new components, never edits to the original: asked for 3 variations of a component, \
write 3 components in src/canvas/ that import the project's own components and tokens, then add one \
frame each with `dray canvas add --component src/canvas/X.tsx#X --page <page> --name <what sets it apart>`. \
--page makes the page if missing. Delete nothing and take nothing off the canvas unless the user asks.

A message may carry an element picked on the canvas: its source as file:line, its components and its \
computed styles. Change the code there; the frame reloads on its own. State lives in .dray/canvas.json.";

#[derive(Subcommand)]
pub enum CanvasCommand {
    /// Write the dev-only Vite plugin frames need into this project, and say
    /// how to wire it into vite.config.
    Setup,
    /// List pages and their frames.
    Ls(LsArgs),
    /// Add a frame: a route of the dev server, or one component alone.
    Add(AddArgs),
    /// Move a frame to another page.
    Move(MoveArgs),
    /// Rename a frame.
    Rename(RenameArgs),
    /// Take a frame off the canvas. Its code is left alone.
    Rm(FrameArg),
    /// Pages: new, rename, move.
    #[command(subcommand)]
    Page(PageCommand),
    /// Set the dev server's address, where the app cannot find it on its own.
    Url { url: String },
}

#[derive(Subcommand)]
pub enum PageCommand {
    /// Add a page.
    New { name: String },
    /// Rename a page.
    Rename { page: String, name: String },
    /// Put a page at a position in the list, 1 being first.
    Move { page: String, position: usize },
}

#[derive(Args)]
pub struct LsArgs {
    #[arg(long)]
    json: bool,
}

#[derive(Args)]
pub struct AddArgs {
    /// A route of the dev server, like /pricing.
    #[arg(long, conflicts_with = "component", required_unless_present = "component")]
    route: Option<String>,
    /// One component alone: its file and export, like src/PricingCard.tsx#PricingCard.
    #[arg(long, value_name = "FILE#EXPORT")]
    component: Option<String>,
    /// The component's props, as a JSON object.
    #[arg(long, value_name = "JSON")]
    props: Option<String>,
    /// The page to add it to, made if missing. Defaults to the first page.
    #[arg(long)]
    page: Option<String>,
    /// The frame's name. Defaults to the route or the export.
    #[arg(long)]
    name: Option<String>,
    /// Width in CSS pixels. Defaults to 1280 for a route, 400 for a component.
    #[arg(long)]
    width: Option<f64>,
}

#[derive(Args)]
pub struct MoveArgs {
    /// The frame's id or name.
    frame: String,
    /// The page to move it to, made if missing.
    #[arg(long)]
    page: String,
}

#[derive(Args)]
pub struct RenameArgs {
    frame: String,
    name: String,
}

#[derive(Args)]
pub struct FrameArg {
    frame: String,
}

pub fn run(command: CanvasCommand) -> Result<(), String> {
    let root = checkout_root(&std::env::current_dir().map_err(|e| e.to_string())?)
        .ok_or("not inside a git checkout: run this from the task's worktree")?;
    if let CanvasCommand::Setup = command {
        return setup(&root);
    }
    let path = root.join(FILE);
    let mut doc = load(&path)?;
    let said = match command {
        CanvasCommand::Setup => unreachable!(),
        CanvasCommand::Ls(args) => return ls(&doc, args.json),
        CanvasCommand::Add(args) => add(&mut doc, args)?,
        CanvasCommand::Move(args) => {
            let frame = take_frame(&mut doc, &args.frame)?;
            let name = frame["name"].as_str().unwrap_or("").to_string();
            let page = page_index(&mut doc, &args.page, true)?;
            let frames = frames_mut(&mut doc, page);
            let mut frame = frame;
            place_after(frames, &mut frame);
            frames.push(frame);
            format!("Moved \"{name}\" to {}", page_name(&doc, page))
        }
        CanvasCommand::Rename(args) => {
            let frame = find_frame(&mut doc, &args.frame)?;
            frame["name"] = json!(args.name);
            format!("Renamed it \"{}\"", args.name)
        }
        CanvasCommand::Rm(args) => {
            let frame = take_frame(&mut doc, &args.frame)?;
            format!("Took \"{}\" off the canvas; its code is untouched", frame["name"].as_str().unwrap_or(""))
        }
        CanvasCommand::Page(PageCommand::New { name }) => {
            if find_page(&doc, &name).is_some() {
                return Err(format!("a page named \"{name}\" already exists"));
            }
            pages_mut(&mut doc).push(new_page(&name));
            format!("Added page \"{name}\"")
        }
        CanvasCommand::Page(PageCommand::Rename { page, name }) => {
            let at = page_index(&mut doc, &page, false)?;
            pages_mut(&mut doc)[at]["name"] = json!(name);
            format!("Renamed page to \"{name}\"")
        }
        CanvasCommand::Page(PageCommand::Move { page, position }) => {
            let at = page_index(&mut doc, &page, false)?;
            let pages = pages_mut(&mut doc);
            let moved = pages.remove(at);
            let to = position.max(1).min(pages.len() + 1) - 1;
            pages.insert(to, moved);
            format!("Moved page to position {}", to + 1)
        }
        CanvasCommand::Url { url } => {
            doc["url"] = json!(url.trim_end_matches('/'));
            format!("Frames load from {}", url.trim_end_matches('/'))
        }
    };
    save(&path, &doc)?;
    println!("{said}");
    Ok(())
}

/// The nearest directory holding `.git`, a folder or a worktree's file alike.
fn checkout_root(from: &Path) -> Option<PathBuf> {
    from.ancestors().find(|dir| dir.join(".git").exists()).map(Path::to_path_buf)
}

fn setup(root: &Path) -> Result<(), String> {
    let plugin = root.join(PLUGIN_FILE);
    std::fs::create_dir_all(plugin.parent().unwrap()).map_err(|e| e.to_string())?;
    std::fs::write(&plugin, VITE_PLUGIN).map_err(|e| e.to_string())?;
    let path = root.join(FILE);
    if !path.exists() {
        save(&path, &load(&path)?)?;
    }
    let config = ["vite.config.ts", "vite.config.js", "vite.config.mts", "vite.config.mjs"]
        .into_iter()
        .find(|f| root.join(f).exists());
    let wired = config
        .and_then(|f| std::fs::read_to_string(root.join(f)).ok())
        .is_some_and(|text| text.contains("vite-plugin.mjs"));
    println!("Wrote {PLUGIN_FILE}.");
    if wired {
        println!("{} already loads it.", config.unwrap());
    } else {
        println!(
            "Wire it into {}, first in the list:\n\n  import drayCanvas from \"./{PLUGIN_FILE}\";\n  plugins: [drayCanvas(), react(), ...]\n\n\
             It runs on the dev server only. It stamps JSX with its source line and serves\n\
             /__dray/frame for component frames. A component frame loads src/index.css (or\n\
             globals.css); pass drayCanvas({{ styles: [\"src/app.css\"] }}) for another.",
            config.unwrap_or("vite.config.ts")
        );
    }
    Ok(())
}

fn load(path: &Path) -> Result<Value, String> {
    let mut doc = match std::fs::read_to_string(path) {
        Ok(text) => serde_json::from_str::<Value>(&text).map_err(|e| format!("{}: {e}", path.display()))?,
        Err(e) if e.kind() == std::io::ErrorKind::NotFound => json!({}),
        Err(e) => return Err(e.to_string()),
    };
    if !doc.is_object() {
        return Err(format!("{} is not a JSON object", path.display()));
    }
    doc["version"] = json!(1);
    if !doc["pages"].is_array() || doc["pages"].as_array().unwrap().is_empty() {
        doc["pages"] = json!([new_page("Page 1")]);
    }
    Ok(doc)
}

fn save(path: &Path, doc: &Value) -> Result<(), String> {
    std::fs::create_dir_all(path.parent().unwrap()).map_err(|e| e.to_string())?;
    // Through a temp file and a rename, so the app polling it never reads half.
    let tmp = path.with_extension("json.tmp");
    let text = serde_json::to_string_pretty(doc).map_err(|e| e.to_string())? + "\n";
    std::fs::write(&tmp, text).map_err(|e| e.to_string())?;
    std::fs::rename(&tmp, path).map_err(|e| e.to_string())
}

fn ls(doc: &Value, json: bool) -> Result<(), String> {
    if json {
        println!("{}", serde_json::to_string_pretty(doc).map_err(|e| e.to_string())?);
        return Ok(());
    }
    if let Some(url) = doc["url"].as_str() {
        println!("Dev server: {url}");
    }
    for page in doc["pages"].as_array().into_iter().flatten() {
        println!("{}", page["name"].as_str().unwrap_or("Untitled"));
        let frames = page["frames"].as_array().cloned().unwrap_or_default();
        if frames.is_empty() {
            println!("  (no frames)");
        }
        for frame in frames {
            let what = frame["route"]
                .as_str()
                .map(str::to_string)
                .or_else(|| frame["component"].as_str().map(str::to_string))
                .unwrap_or_default();
            println!(
                "  {}  {}  {what}",
                frame["id"].as_str().unwrap_or(""),
                frame["name"].as_str().unwrap_or(""),
            );
        }
    }
    Ok(())
}

fn add(doc: &mut Value, args: AddArgs) -> Result<String, String> {
    let mut frame = Map::new();
    let id = new_id("f");
    frame.insert("id".into(), json!(id));
    let (name, width) = if let Some(route) = &args.route {
        let route = if route.starts_with('/') { route.clone() } else { format!("/{route}") };
        frame.insert("route".into(), json!(route));
        (route, 1280.0)
    } else {
        let spec = args.component.as_deref().unwrap();
        let (file, export) = spec.split_once('#').unwrap_or((spec, "default"));
        if file.is_empty() || export.is_empty() {
            return Err("--component takes FILE#EXPORT, like src/PricingCard.tsx#PricingCard".into());
        }
        frame.insert("component".into(), json!(format!("{}#{export}", file.trim_start_matches("./"))));
        (export.to_string(), 400.0)
    };
    if let Some(props) = &args.props {
        let value: Value = serde_json::from_str(props).map_err(|e| format!("--props is not JSON: {e}"))?;
        if !value.is_object() {
            return Err("--props takes a JSON object".into());
        }
        frame.insert("props".into(), value);
    }
    let name = args.name.unwrap_or(name);
    frame.insert("name".into(), json!(name));
    frame.insert("width".into(), json!(args.width.unwrap_or(width)));
    let page = match &args.page {
        Some(page) => page_index(doc, page, true)?,
        None => 0,
    };
    let mut frame = Value::Object(frame);
    let frames = frames_mut(doc, page);
    place_after(frames, &mut frame);
    frames.push(frame);
    Ok(format!("Added \"{name}\" to {} as {id}", page_name(doc, page)))
}

/// Puts `frame` to the right of the page's rightmost frame, tops aligned.
fn place_after(frames: &[Value], frame: &mut Value) {
    let right = frames
        .iter()
        .map(|f| f["x"].as_f64().unwrap_or(0.0) + f["width"].as_f64().unwrap_or(0.0))
        .fold(None, |max: Option<f64>, r| Some(max.map_or(r, |m| m.max(r))));
    let top = frames.iter().filter_map(|f| f["y"].as_f64()).reduce(f64::min);
    frame["x"] = json!(right.map_or(0.0, |r| r + GAP));
    frame["y"] = json!(top.unwrap_or(0.0));
}

fn new_page(name: &str) -> Value {
    json!({ "id": new_id("p"), "name": name, "frames": [] })
}

/// Short and unlikely to collide within one canvas; nothing needs more.
fn new_id(prefix: &str) -> String {
    let nanos = std::time::SystemTime::now()
        .duration_since(std::time::UNIX_EPOCH)
        .map(|d| d.as_nanos())
        .unwrap_or(0);
    let mixed = (nanos ^ ((std::process::id() as u128) << 40)).wrapping_mul(0x9E37_79B9_7F4A_7C15);
    format!("{prefix}-{:06x}", (mixed >> 64) as u32 & 0xff_ffff)
}

fn pages_mut(doc: &mut Value) -> &mut Vec<Value> {
    doc["pages"].as_array_mut().expect("load makes pages an array")
}

fn frames_mut(doc: &mut Value, page: usize) -> &mut Vec<Value> {
    let page = &mut pages_mut(doc)[page];
    if !page["frames"].is_array() {
        page["frames"] = json!([]);
    }
    page["frames"].as_array_mut().unwrap()
}

fn page_name(doc: &Value, page: usize) -> String {
    doc["pages"][page]["name"].as_str().unwrap_or("Untitled").to_string()
}

/// A page by id, or by name in any case.
fn find_page(doc: &Value, key: &str) -> Option<usize> {
    let pages = doc["pages"].as_array()?;
    pages
        .iter()
        .position(|p| p["id"].as_str() == Some(key))
        .or_else(|| pages.iter().position(|p| p["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(key))))
}

fn page_index(doc: &mut Value, key: &str, create: bool) -> Result<usize, String> {
    if let Some(at) = find_page(doc, key) {
        return Ok(at);
    }
    if !create {
        return Err(format!("no page \"{key}\""));
    }
    let pages = pages_mut(doc);
    pages.push(new_page(key));
    Ok(pages.len() - 1)
}

/// Where a frame is, by id or by a name only one frame carries.
fn locate_frame(doc: &Value, key: &str) -> Result<(usize, usize), String> {
    let mut by_name = Vec::new();
    for (p, page) in doc["pages"].as_array().into_iter().flatten().enumerate() {
        for (f, frame) in page["frames"].as_array().into_iter().flatten().enumerate() {
            if frame["id"].as_str() == Some(key) {
                return Ok((p, f));
            }
            if frame["name"].as_str().is_some_and(|n| n.eq_ignore_ascii_case(key)) {
                by_name.push((p, f));
            }
        }
    }
    match by_name.as_slice() {
        [one] => Ok(*one),
        [] => Err(format!("no frame \"{key}\"; `dray canvas ls` lists them")),
        _ => Err(format!("several frames are named \"{key}\"; name one by its id")),
    }
}

fn find_frame<'a>(doc: &'a mut Value, key: &str) -> Result<&'a mut Value, String> {
    let (p, f) = locate_frame(doc, key)?;
    Ok(&mut frames_mut(doc, p)[f])
}

fn take_frame(doc: &mut Value, key: &str) -> Result<Value, String> {
    let (p, f) = locate_frame(doc, key)?;
    Ok(frames_mut(doc, p).remove(f))
}

#[cfg(test)]
mod tests {
    use super::*;

    fn doc() -> Value {
        let dir = std::env::temp_dir().join(format!("dray-canvas-test-{}", new_id("t")));
        load(&dir.join(FILE)).unwrap()
    }

    fn add_args(route: Option<&str>, component: Option<&str>, page: Option<&str>) -> AddArgs {
        AddArgs {
            route: route.map(str::to_string),
            component: component.map(str::to_string),
            props: None,
            page: page.map(str::to_string),
            name: None,
            width: None,
        }
    }

    #[test]
    fn a_fresh_canvas_has_one_page() {
        let doc = doc();
        assert_eq!(doc["pages"].as_array().unwrap().len(), 1);
        assert_eq!(doc["pages"][0]["name"], "Page 1");
    }

    #[test]
    fn frames_land_side_by_side_on_a_page_made_for_them() {
        let mut doc = doc();
        add(&mut doc, add_args(None, Some("src/A.tsx#A"), Some("Explorations"))).unwrap();
        add(&mut doc, add_args(None, Some("src/B.tsx#B"), Some("explorations"))).unwrap();
        let page = &doc["pages"][1];
        assert_eq!(page["name"], "Explorations");
        let frames = page["frames"].as_array().unwrap();
        assert_eq!(frames.len(), 2);
        assert_eq!(frames[0]["x"], 0.0);
        assert_eq!(frames[1]["x"], 400.0 + GAP);
        assert_eq!(frames[1]["component"], "src/B.tsx#B");
        assert_eq!(frames[1]["name"], "B");
    }

    #[test]
    fn a_route_gets_its_slash_and_a_page_width() {
        let mut doc = doc();
        add(&mut doc, add_args(Some("pricing"), None, None)).unwrap();
        let frame = &doc["pages"][0]["frames"][0];
        assert_eq!(frame["route"], "/pricing");
        assert_eq!(frame["width"], 1280.0);
    }

    #[test]
    fn a_frame_is_found_by_a_unique_name_and_moved() {
        let mut doc = doc();
        add(&mut doc, add_args(Some("/"), None, None)).unwrap();
        let frame = take_frame(&mut doc, "/").unwrap();
        assert_eq!(frame["route"], "/");
        assert!(doc["pages"][0]["frames"].as_array().unwrap().is_empty());
        assert!(take_frame(&mut doc, "/").is_err());
    }
}
