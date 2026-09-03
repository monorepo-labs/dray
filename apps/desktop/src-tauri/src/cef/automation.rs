//! Driving a session's tabs for `dray browser`: the agent's half of the
//! in-app browser, with agent-browser's verbs.
//!
//! No agent-browser and no debug port. CEF hands every browser its own
//! DevTools channel (`send_dev_tools_message` in, an observer out), so each
//! action is a few CDP calls on the session's active tab, and an agent can
//! reach no other session's pages because the session is the only address
//! there is. Pointer and key actions go through Chromium's real input path
//! (`Input.dispatch*`) rather than `element.click()`, so what the agent does
//! is what a person's click does; reads and locators are page JavaScript.

use super::*;
use base64::Engine;
use dray_proto::{BrowserAction, Get, Is, Locator};
use serde_json::{json, Value};
use std::sync::atomic::{AtomicI32, Ordering as AtomicOrdering};
use std::time::{Duration, Instant};
use tokio::sync::oneshot;

type Reply = Result<Value, String>;
/// Text for the agent, and the same answer as JSON.
type Answer = Result<(String, Value), String>;

static NEXT_ID: AtomicI32 = AtomicI32::new(1);
/// Replies land on the UI thread keyed by (browser, message id); the caller
/// waits on the other end of its channel.
static PENDING: Mutex<Option<HashMap<(i32, i32), oneshot::Sender<Reply>>>> = Mutex::new(None);
/// What each tab's page logged since `console`/`errors` last drained it.
static CONSOLE: Mutex<Option<HashMap<i32, Vec<(bool, String)>>>> = Mutex::new(None);

const TIMEOUT: Duration = Duration::from_secs(30);
const LOAD_TIMEOUT: Duration = Duration::from_secs(20);
/// Snapshots and page text are for a model to read; past this they cost more
/// than they say.
const MAX_TEXT: usize = 40_000;
const MAX_CONSOLE: usize = 200;

/// The pane's device presets, by name. Duplicated from `VIEWPORT_PRESETS`
/// in browser.ts, since the refusal for an unknown name has to come from
/// here; a test holds the two together.
const DEVICES: &[(&str, u32, u32)] = &[
    ("iPhone SE", 375, 667),
    ("iPhone 15", 393, 852),
    ("Pixel 8", 412, 915),
    ("iPad Mini", 768, 1024),
    ("iPad Air", 820, 1180),
    ("Laptop", 1280, 800),
    ("Desktop", 1440, 900),
];

wrap_dev_tools_message_observer! {
    struct DrayDevTools;

    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(
            &self,
            browser: Option<&mut Browser>,
            message_id: ::std::os::raw::c_int,
            success: ::std::os::raw::c_int,
            result: Option<&[u8]>,
        ) {
            let Some(id) = browser.map(|b| b.identifier()) else { return };
            let Some(tx) = PENDING.lock().unwrap().as_mut().and_then(|m| m.remove(&(id, message_id))) else {
                return;
            };
            let value = result
                .and_then(|bytes| serde_json::from_slice::<Value>(bytes).ok())
                .unwrap_or(Value::Null);
            let reply = if success != 0 {
                Ok(value)
            } else {
                Err(value
                    .get("message")
                    .and_then(Value::as_str)
                    .unwrap_or("the page refused the command")
                    .to_string())
            };
            let _ = tx.send(reply);
        }
    }
}

/// Attach the observer to a browser the moment it exists; the registration
/// lives on the tab and ends with it.
pub(super) fn observe(browser: &Browser) -> Option<Registration> {
    browser
        .host()
        .and_then(|host| host.add_dev_tools_message_observer(Some(&mut DrayDevTools::new())))
}

/// Called from `on_console_message` for every line a page logs.
pub(super) fn log(tab: i32, error: bool, text: String) {
    let mut guard = CONSOLE.lock().unwrap();
    let lines = guard.get_or_insert_with(HashMap::new).entry(tab).or_default();
    if lines.len() >= MAX_CONSOLE {
        lines.remove(0);
    }
    lines.push((error, text));
}

pub(super) fn forget(tab: i32) {
    if let Some(m) = CONSOLE.lock().unwrap().as_mut() {
        m.remove(&tab);
    }
}

/// One CDP call on one tab.
async fn cdp(tab: i32, method: &str, params: Value) -> Reply {
    let id = NEXT_ID.fetch_add(1, AtomicOrdering::Relaxed);
    let (tx, rx) = oneshot::channel();
    PENDING.lock().unwrap().get_or_insert_with(HashMap::new).insert((tab, id), tx);
    let message = json!({ "id": id, "method": method, "params": params }).to_string();
    on_main(move || {
        let sent = browser_of(tab)
            .and_then(|b| b.host())
            .map(|host| host.send_dev_tools_message(Some(message.as_bytes())) == 1)
            .unwrap_or(false);
        if !sent {
            if let Some(tx) = PENDING.lock().unwrap().as_mut().and_then(|m| m.remove(&(tab, id))) {
                let _ = tx.send(Err("that tab is gone".into()));
            }
        }
    })?;
    match tokio::time::timeout(TIMEOUT, rx).await {
        Ok(Ok(reply)) => reply,
        Ok(Err(_)) => Err("the tab closed before answering".into()),
        Err(_) => {
            if let Some(m) = PENDING.lock().unwrap().as_mut() {
                m.remove(&(tab, id));
            }
            Err(format!("{method} timed out after {}s", TIMEOUT.as_secs()))
        }
    }
}

/// Runs `expression` in the page and answers its value. A thrown error is
/// the error.
async fn eval(tab: i32, expression: &str) -> Reply {
    let reply = cdp(
        tab,
        "Runtime.evaluate",
        json!({ "expression": expression, "returnByValue": true, "awaitPromise": true }),
    )
    .await?;
    if let Some(exception) = reply.get("exceptionDetails") {
        let text = exception
            .pointer("/exception/description")
            .or_else(|| exception.get("text"))
            .and_then(Value::as_str)
            .unwrap_or("the script threw");
        return Err(text.lines().next().unwrap_or(text).to_string());
    }
    Ok(reply.pointer("/result/value").cloned().unwrap_or(Value::Null))
}

/// Runs `body` with `el` bound to the located element, or fails naming what
/// was looked for.
async fn with_element(tab: i32, at: &Locator, body: &str) -> Reply {
    let js = format!(
        "(() => {{ {HELPERS_JS} const el = __find({})[0]; if (!el) return {{ __missing: true }}; {body} }})()",
        serde_json::to_string(at).unwrap()
    );
    let value = eval(tab, &js).await?;
    if value.get("__missing").is_some() {
        return Err(format!("nothing matches {}", describe_locator(at)));
    }
    Ok(value)
}

fn describe_locator(at: &Locator) -> String {
    match at {
        Locator::Target { target } => target.clone(),
        Locator::Role { role, name: Some(n), .. } => format!("{role} \"{n}\""),
        Locator::Role { role, .. } => role.clone(),
        Locator::Text { text, .. } => format!("text \"{text}\""),
        Locator::Label { label, .. } => format!("label \"{label}\""),
        Locator::Placeholder { placeholder, .. } => format!("placeholder \"{placeholder}\""),
        Locator::Alt { alt, .. } => format!("alt \"{alt}\""),
        Locator::Title { title, .. } => format!("title \"{title}\""),
        Locator::TestId { id } => format!("testid {id}"),
        Locator::Nth { selector, index } => format!("{selector}[{index}]"),
    }
}

fn tab_state(tab: i32) -> Option<(String, String, bool)> {
    TABS.lock()
        .unwrap()
        .iter()
        .find(|t| t.id == tab)
        .map(|t| (t.url.clone(), t.title.clone(), t.loading))
}

/// Waits for the tab's load to settle. A navigation takes a moment to
/// start — a click's reply lands before the renderer has begun leaving the
/// page — so this first watches for loading to *begin*, up to a short
/// window, or "not loading" is answered before the previous page has even
/// been left and the next command reads the old URL.
async fn wait_loaded(tab: i32) {
    let start = Instant::now();
    let mut seen_loading = false;
    while start.elapsed() < LOAD_TIMEOUT {
        match tab_state(tab) {
            Some((_, _, true)) => seen_loading = true,
            Some(_) if seen_loading || start.elapsed() > Duration::from_millis(600) => return,
            Some(_) => {}
            None => return,
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

fn active_tab(session: &str) -> Result<i32, String> {
    active_id(session).ok_or_else(|| {
        "no tab is open in this session's browser; `dray browser open <url>` first".to_string()
    })
}

fn page(tab: i32) -> (String, Value) {
    match tab_state(tab) {
        Some((url, title, _)) => {
            let text = if title.is_empty() { url.clone() } else { format!("{title} — {url}") };
            (text, json!({ "url": url, "title": title }))
        }
        None => ("no tab".into(), json!({})),
    }
}

/// Waits for a tab that was not there when `before` was read.
async fn new_tab(session: &str, before: &[i32]) -> Result<i32, String> {
    let start = Instant::now();
    loop {
        if let Some(id) = tabs_of(session).iter().map(|t| t.id).find(|id| !before.contains(id)) {
            return Ok(id);
        }
        if start.elapsed() > LOAD_TIMEOUT {
            return Err("Chromium did not open a tab".into());
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
}

async fn mouse(tab: i32, kind: &str, x: f64, y: f64, extra: Value) -> Result<(), String> {
    let mut params = json!({ "type": kind, "x": x, "y": y });
    params.as_object_mut().unwrap().extend(extra.as_object().cloned().unwrap_or_default());
    cdp(tab, "Input.dispatchMouseEvent", params).await.map(|_| ())
}

/// The viewport centre of the element, scrolled into view first so a click
/// lands on it rather than on whatever covers an off-screen point.
async fn center(tab: i32, at: &Locator) -> Result<(f64, f64), String> {
    let point = with_element(
        tab,
        at,
        "el.scrollIntoView({ block: 'center', inline: 'center' }); \
         const r = el.getBoundingClientRect(); \
         return { x: r.left + r.width / 2, y: r.top + r.height / 2 };",
    )
    .await?;
    Ok((point["x"].as_f64().unwrap_or(0.0), point["y"].as_f64().unwrap_or(0.0)))
}

async fn click(tab: i32, at: &Locator, count: u32) -> Result<(), String> {
    let (x, y) = center(tab, at).await?;
    mouse(tab, "mouseMoved", x, y, json!({})).await?;
    for n in 1..=count {
        let button = json!({ "button": "left", "clickCount": n });
        mouse(tab, "mousePressed", x, y, button.clone()).await?;
        mouse(tab, "mouseReleased", x, y, button).await?;
    }
    Ok(())
}

async fn focus(tab: i32, at: &Locator, clear: bool) -> Result<(), String> {
    let body = format!(
        "el.focus(); if ({clear}) {{ \
           if (el.isContentEditable) el.textContent = ''; \
           else if ('value' in el) {{ el.value = ''; el.dispatchEvent(new Event('input', {{ bubbles: true }})); }} \
         }} return true;"
    );
    with_element(tab, at, &body).await.map(|_| ())
}

async fn set_checked(tab: i32, at: &Locator, on: bool) -> Result<(), String> {
    let now = with_element(tab, at, "return !!el.checked;").await?;
    if now == Value::Bool(on) {
        return Ok(());
    }
    click(tab, at, 1).await
}

/// The whole of `dray browser`: one action on the session's active tab.
///
/// An input verb first brings the tab's view out of hiding, off-screen —
/// see `reveal` — and the layout is put back after, whatever the outcome.
pub async fn run(session: &str, action: BrowserAction) -> Answer {
    let input = matches!(
        action,
        BrowserAction::Click { .. }
            | BrowserAction::DblClick { .. }
            | BrowserAction::Hover { .. }
            | BrowserAction::Type { .. }
            | BrowserAction::Fill { .. }
            | BrowserAction::Press { .. }
            | BrowserAction::Check { .. }
            | BrowserAction::Uncheck { .. }
    );
    let tab = active_id(session);
    if let (true, Some(tab)) = (input, tab) {
        on_main(move || reveal(tab))?;
        // The renderer learns it is visible a frame later.
        tokio::time::sleep(Duration::from_millis(80)).await;
    }
    let answer = perform(session, action).await;
    if input {
        let _ = on_main(apply_layout);
    }
    answer
}

async fn perform(session: &str, action: BrowserAction) -> Answer {
    let ok = |text: String| Ok((text, json!({ "ok": true })));
    let clear = matches!(action, BrowserAction::Fill { .. });
    match action {
        BrowserAction::Open { url } => {
            let tab = match active_id(session) {
                Some(tab) => {
                    browser_open(session.to_string(), url, false)?;
                    tab
                }
                None => {
                    let before: Vec<i32> = tabs_of(session).iter().map(|t| t.id).collect();
                    browser_open(session.to_string(), url, true)?;
                    new_tab(session, &before).await?
                }
            };
            wait_loaded(tab).await;
            Ok(page(tab))
        }
        BrowserAction::Back | BrowserAction::Forward | BrowserAction::Reload => {
            let tab = active_tab(session)?;
            let verb = match action {
                BrowserAction::Back => "back",
                BrowserAction::Forward => "forward",
                _ => "reload",
            };
            browser_nav(session.to_string(), verb.into())?;
            wait_loaded(tab).await;
            Ok(page(tab))
        }
        BrowserAction::Close => {
            let tab = active_tab(session)?;
            browser_close(session.to_string(), tab)?;
            ok(format!("closed tab {tab}"))
        }
        BrowserAction::Tabs => {
            let tabs = tabs_of(session);
            let text = if tabs.is_empty() {
                "no tabs".to_string()
            } else {
                tabs.iter()
                    .map(|t| format!("{} {}{}", t.id, if t.active { "* " } else { "  " }, page(t.id).0))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            let data = tabs
                .iter()
                .map(|t| json!({ "id": t.id, "active": t.active, "url": t.url, "title": t.title }))
                .collect();
            Ok((text, Value::Array(data)))
        }
        BrowserAction::TabNew { url } => {
            let before: Vec<i32> = tabs_of(session).iter().map(|t| t.id).collect();
            browser_open(session.to_string(), url.unwrap_or_else(|| "about:blank".into()), true)?;
            let tab = new_tab(session, &before).await?;
            wait_loaded(tab).await;
            let (text, mut data) = page(tab);
            data["id"] = json!(tab);
            Ok((format!("{tab} {text}"), data))
        }
        BrowserAction::TabSwitch { id } => {
            browser_activate(session.to_string(), id)?;
            Ok(page(id))
        }
        BrowserAction::TabClose { id } => {
            let id = match id {
                Some(id) => id,
                None => active_tab(session)?,
            };
            browser_close(session.to_string(), id)?;
            ok(format!("closed tab {id}"))
        }
        BrowserAction::Snapshot { interactive, compact, selector } => {
            let tab = active_tab(session)?;
            let opts = json!({ "interactive": interactive, "compact": compact, "selector": selector });
            let text = eval(tab, &format!("(() => {{ {HELPERS_JS} return __snapshot({opts}); }})()")).await?;
            let text = clip(text.as_str().unwrap_or(""));
            Ok((text.clone(), json!({ "snapshot": text })))
        }
        BrowserAction::Click { at } => {
            let tab = active_tab(session)?;
            click(tab, &at, 1).await?;
            wait_loaded(tab).await;
            ok(format!("clicked {}", describe_locator(&at)))
        }
        BrowserAction::DblClick { at } => {
            let tab = active_tab(session)?;
            click(tab, &at, 2).await?;
            ok(format!("double-clicked {}", describe_locator(&at)))
        }
        BrowserAction::Focus { at } => {
            focus(active_tab(session)?, &at, false).await?;
            ok(format!("focused {}", describe_locator(&at)))
        }
        BrowserAction::Hover { at } => {
            let tab = active_tab(session)?;
            let (x, y) = center(tab, &at).await?;
            mouse(tab, "mouseMoved", x, y, json!({})).await?;
            ok(format!("hovering {}", describe_locator(&at)))
        }
        BrowserAction::Type { at, text } | BrowserAction::Fill { at, text } => {
            let tab = active_tab(session)?;
            focus(tab, &at, clear).await?;
            cdp(tab, "Input.insertText", json!({ "text": text })).await?;
            ok(format!("{} {}", if clear { "filled" } else { "typed into" }, describe_locator(&at)))
        }
        BrowserAction::Press { key } => {
            let tab = active_tab(session)?;
            let (down, up) = key_events(&key)?;
            cdp(tab, "Input.dispatchKeyEvent", down).await?;
            cdp(tab, "Input.dispatchKeyEvent", up).await?;
            wait_loaded(tab).await;
            ok(format!("pressed {key}"))
        }
        BrowserAction::Check { at } => {
            set_checked(active_tab(session)?, &at, true).await?;
            ok(format!("checked {}", describe_locator(&at)))
        }
        BrowserAction::Uncheck { at } => {
            set_checked(active_tab(session)?, &at, false).await?;
            ok(format!("unchecked {}", describe_locator(&at)))
        }
        BrowserAction::Select { at, value } => {
            let tab = active_tab(session)?;
            let body = format!(
                "const want = {}; const opt = [...el.options || []].find(o => o.value === want || o.label.trim() === want); \
                 if (!opt) return {{ found: false }}; el.value = opt.value; \
                 el.dispatchEvent(new Event('input', {{ bubbles: true }})); el.dispatchEvent(new Event('change', {{ bubbles: true }})); \
                 return {{ found: true, value: opt.value }};",
                Value::String(value.clone())
            );
            let reply = with_element(tab, &at, &body).await?;
            if reply["found"] != Value::Bool(true) {
                return Err(format!("{} has no option {value:?}", describe_locator(&at)));
            }
            ok(format!("selected {value} in {}", describe_locator(&at)))
        }
        BrowserAction::Scroll { direction, amount } => {
            let tab = active_tab(session)?;
            let (dx, dy) = match direction.as_str() {
                "up" => (0.0, -amount),
                "down" => (0.0, amount),
                "left" => (-amount, 0.0),
                "right" => (amount, 0.0),
                other => return Err(format!("scroll up, down, left or right — not {other}")),
            };
            // `Input.dispatchMouseEvent` of `mouseWheel` never answers on a
            // page with nothing to scroll; the page's own API always does.
            eval(tab, &format!("window.scrollBy({dx}, {dy}); window.scrollY")).await?;
            ok(format!("scrolled {direction} {amount}"))
        }
        BrowserAction::ScrollIntoView { at } => {
            with_element(active_tab(session)?, &at, "el.scrollIntoView({ block: 'center' }); return true;").await?;
            ok(format!("scrolled to {}", describe_locator(&at)))
        }
        BrowserAction::Get { what, at } => {
            let tab = active_tab(session)?;
            let at = at.unwrap_or(Locator::Target { target: "html".into() });
            let value = match what {
                Get::Title => page(tab).1["title"].clone(),
                Get::Url => page(tab).1["url"].clone(),
                Get::Text => with_element(tab, &at, "return el.innerText ?? el.textContent ?? '';").await?,
                Get::Html => with_element(tab, &at, "return el.outerHTML;").await?,
                Get::Value => with_element(tab, &at, "return el.value ?? null;").await?,
                Get::Attr { name } => {
                    let body = format!("return el.getAttribute({});", Value::String(name));
                    with_element(tab, &at, &body).await?
                }
                Get::Box => {
                    with_element(
                        tab,
                        &at,
                        "const r = el.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height };",
                    )
                    .await?
                }
                Get::Count => {
                    let js = format!(
                        "(() => {{ {HELPERS_JS} return __find({}).length; }})()",
                        serde_json::to_string(&at).unwrap()
                    );
                    eval(tab, &js).await?
                }
            };
            let text = match &value {
                Value::String(s) => clip(s),
                Value::Null => "null".into(),
                other => other.to_string(),
            };
            Ok((text, json!({ "value": value })))
        }
        BrowserAction::Is { what, at } => {
            let tab = active_tab(session)?;
            let body = match what {
                Is::Visible => "return __visible(el);",
                Is::Enabled => "return !el.disabled && el.getAttribute('aria-disabled') !== 'true';",
                Is::Checked => "return !!el.checked || el.getAttribute('aria-checked') === 'true';",
            };
            let value = with_element(tab, &at, body).await.unwrap_or(Value::Bool(false));
            let yes = value == Value::Bool(true);
            Ok((yes.to_string(), json!({ "value": yes })))
        }
        BrowserAction::Wait { selector, ms, url, text, load } => {
            let tab = active_tab(session)?;
            if let Some(ms) = ms {
                tokio::time::sleep(Duration::from_millis(ms.min(60_000))).await;
                return ok(format!("waited {ms}ms"));
            }
            if let Some(state) = load {
                wait_loaded(tab).await;
                if state == "networkidle" {
                    tokio::time::sleep(Duration::from_millis(500)).await;
                }
                return ok(format!("{state}: {}", page(tab).0));
            }
            let (probe, what) = if let Some(sel) = selector {
                let at = serde_json::to_string(&Locator::Target { target: sel.clone() }).unwrap();
                (format!("(() => {{ {HELPERS_JS} return __find({at}).length > 0; }})()"), sel)
            } else if let Some(url) = url {
                (format!("location.href.includes({})", Value::String(url.clone())), url)
            } else if let Some(text) = text {
                (format!("(document.body?.innerText || '').includes({})", Value::String(text.clone())), text)
            } else {
                return Err("wait for what? a selector, --url, --text, --load or a number of ms".into());
            };
            let start = Instant::now();
            while start.elapsed() < LOAD_TIMEOUT {
                if eval(tab, &probe).await.unwrap_or(Value::Bool(false)) == Value::Bool(true) {
                    return ok(format!("{what} is there"));
                }
                tokio::time::sleep(Duration::from_millis(250)).await;
            }
            Err(format!("{what} did not appear within {}s", LOAD_TIMEOUT.as_secs()))
        }
        BrowserAction::Screenshot { path, full } => {
            let tab = active_tab(session)?;
            let mut params = json!({ "format": "png" });
            if full {
                let size = eval(tab, "({ w: document.documentElement.scrollWidth, h: document.documentElement.scrollHeight })").await?;
                params["captureBeyondViewport"] = json!(true);
                params["clip"] = json!({ "x": 0, "y": 0, "width": size["w"], "height": size["h"], "scale": 1 });
            }
            let reply = cdp(tab, "Page.captureScreenshot", params).await?;
            let data = reply["data"].as_str().ok_or("no image came back")?;
            let bytes = base64::engine::general_purpose::STANDARD
                .decode(data)
                .map_err(|e| format!("bad image data: {e}"))?;
            let path = match path {
                Some(p) => PathBuf::from(p),
                None => {
                    let dir = browser_dir().join("shots");
                    std::fs::create_dir_all(&dir).map_err(|e| e.to_string())?;
                    let stamp = std::time::SystemTime::now()
                        .duration_since(std::time::UNIX_EPOCH)
                        .map(|d| d.as_millis())
                        .unwrap_or(0);
                    dir.join(format!("{}-{stamp}.png", &session[..8.min(session.len())]))
                }
            };
            std::fs::write(&path, bytes).map_err(|e| format!("could not write {}: {e}", path.display()))?;
            let shown = path.display().to_string();
            Ok((shown.clone(), json!({ "path": shown })))
        }
        BrowserAction::Eval { js } => {
            let value = eval(active_tab(session)?, &js).await?;
            let text = match &value {
                Value::String(s) => s.clone(),
                Value::Null => "undefined".into(),
                other => serde_json::to_string_pretty(other).unwrap_or_default(),
            };
            Ok((text, json!({ "value": value })))
        }
        BrowserAction::Console | BrowserAction::Errors => {
            let tab = active_tab(session)?;
            let errors_only = matches!(action, BrowserAction::Errors);
            let lines: Vec<(bool, String)> = CONSOLE
                .lock()
                .unwrap()
                .as_mut()
                .and_then(|m| m.remove(&tab))
                .unwrap_or_default()
                .into_iter()
                .filter(|(error, _)| *error || !errors_only)
                .collect();
            let text = if lines.is_empty() {
                if errors_only { "no errors" } else { "nothing logged" }.to_string()
            } else {
                lines
                    .iter()
                    .map(|(e, t)| format!("{} {t}", if *e { "[error]" } else { "[log]" }))
                    .collect::<Vec<_>>()
                    .join("\n")
            };
            let data = lines
                .into_iter()
                .map(|(e, t)| json!({ "level": if e { "error" } else { "log" }, "text": t }))
                .collect();
            Ok((text, Value::Array(data)))
        }
        BrowserAction::SetViewport { width, height } => {
            active_tab(session)?;
            emit_viewport(session, "custom", width, height);
            ok(format!("viewport {width}×{height}"))
        }
        BrowserAction::SetDevice { name } => {
            active_tab(session)?;
            let (label, w, h) = DEVICES
                .iter()
                .find(|(n, _, _)| n.eq_ignore_ascii_case(&name))
                .ok_or_else(|| {
                    let names = DEVICES.iter().map(|d| d.0).collect::<Vec<_>>().join(", ");
                    format!("no device {name:?}; one of {names}")
                })?;
            emit_viewport(session, &label.to_lowercase().replace(' ', "-"), *w, *h);
            ok(format!("{label} {w}×{h}"))
        }
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ViewportEvent {
    session_id: String,
    preset: String,
    width: u32,
    height: u32,
}

/// The device bar is the pane's, so a size set from here rides an event
/// into the same store the bar writes.
fn emit_viewport(session: &str, preset: &str, width: u32, height: u32) {
    if let Some(app) = APP.get() {
        let _ = app.emit(
            "browser_viewport",
            ViewportEvent { session_id: session.into(), preset: preset.into(), width, height },
        );
    }
}

/// `keyDown`/`keyUp` for a key name with optional modifier prefixes. Named
/// keys carry their virtual key code, which is what a page's key handling
/// reads; a printable key carries its text, which is what an input reads.
fn key_events(spec: &str) -> Result<(Value, Value), String> {
    let mut modifiers = 0;
    let mut key = spec;
    while let Some((prefix, rest)) = key.split_once('+').filter(|(_, r)| !r.is_empty()) {
        modifiers |= match prefix.to_ascii_lowercase().as_str() {
            "alt" | "option" => 1,
            "ctrl" | "control" => 2,
            "meta" | "cmd" | "command" => 4,
            "shift" => 8,
            _ => return Err(format!("unknown modifier {prefix}")),
        };
        key = rest;
    }
    let (name, code, vk, text): (&str, String, i32, Option<String>) = match key {
        "Enter" | "Return" => ("Enter", "Enter".into(), 13, Some("\r".into())),
        "Tab" => ("Tab", "Tab".into(), 9, None),
        "Escape" | "Esc" => ("Escape", "Escape".into(), 27, None),
        "Backspace" => ("Backspace", "Backspace".into(), 8, None),
        "Delete" => ("Delete", "Delete".into(), 46, None),
        "Space" => (" ", "Space".into(), 32, Some(" ".into())),
        "ArrowUp" | "Up" => ("ArrowUp", "ArrowUp".into(), 38, None),
        "ArrowDown" | "Down" => ("ArrowDown", "ArrowDown".into(), 40, None),
        "ArrowLeft" | "Left" => ("ArrowLeft", "ArrowLeft".into(), 37, None),
        "ArrowRight" | "Right" => ("ArrowRight", "ArrowRight".into(), 39, None),
        "Home" => ("Home", "Home".into(), 36, None),
        "End" => ("End", "End".into(), 35, None),
        "PageUp" => ("PageUp", "PageUp".into(), 33, None),
        "PageDown" => ("PageDown", "PageDown".into(), 34, None),
        k if k.chars().count() == 1 => {
            let c = k.chars().next().unwrap();
            let code = if c.is_ascii_alphabetic() {
                format!("Key{}", c.to_ascii_uppercase())
            } else if c.is_ascii_digit() {
                format!("Digit{c}")
            } else {
                String::new()
            };
            let vk = c.to_ascii_uppercase() as i32;
            // A chord is a command, not text: ⌘A must select all, not type "a".
            let text = (modifiers & !8 == 0).then(|| c.to_string());
            (k, code, vk, text)
        }
        other => return Err(format!("unknown key {other}")),
    };
    let base = json!({ "key": name, "code": code, "windowsVirtualKeyCode": vk, "nativeVirtualKeyCode": vk, "modifiers": modifiers });
    let mut down = base.clone();
    down["type"] = json!(if text.is_some() { "keyDown" } else { "rawKeyDown" });
    if let Some(text) = text {
        // Both, as Puppeteer sends them: `text` alone types but does not
        // submit a form on Enter.
        down["text"] = json!(text);
        down["unmodifiedText"] = json!(text);
    }
    let mut up = base;
    up["type"] = json!("keyUp");
    Ok((down, up))
}

fn clip(text: &str) -> String {
    if text.len() <= MAX_TEXT {
        return text.to_string();
    }
    let cut = text.char_indices().map(|(i, _)| i).take_while(|&i| i <= MAX_TEXT).last().unwrap_or(0);
    format!("{}\n… [{} more characters]", &text[..cut], text.len() - cut)
}

/// Page-side helpers every script above opens with: what an element is
/// called and what it is, one locator over every `Locator` shape, and the
/// snapshot. One copy, so `find role button --name Submit` names exactly the
/// element `snapshot` would list as `button "Submit"`.
const HELPERS_JS: &str = r#"
  const __visible = (el) => {
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  };
  const __text = (s) => (s || '').trim().replace(/\s+/g, ' ');
  const __name = (el) => __text(el.getAttribute('aria-label')
    || (el.labels && el.labels[0] && el.labels[0].innerText)
    || el.getAttribute('placeholder') || el.getAttribute('title') || el.getAttribute('alt')
    || el.innerText || el.textContent || el.getAttribute('name')).slice(0, 80);
  const __role = (el) => {
    const r = el.getAttribute('role');
    if (r) return r;
    const t = el.tagName.toLowerCase();
    if (t === 'a') return el.hasAttribute('href') ? 'link' : 'generic';
    if (t === 'button' || (t === 'input' && /^(button|submit|reset)$/.test(el.type))) return 'button';
    if (t === 'input') return el.type === 'checkbox' ? 'checkbox' : el.type === 'radio' ? 'radio' : 'textbox';
    if (t === 'textarea') return 'textbox';
    if (t === 'select') return 'combobox';
    if (t === 'option') return 'option';
    if (t === 'img') return 'img';
    if (/^h[1-6]$/.test(t)) return 'heading';
    if (t === 'li') return 'listitem';
    if (t === 'ul' || t === 'ol') return 'list';
    if (t === 'nav') return 'navigation';
    if (t === 'main') return 'main';
    if (t === 'form') return 'form';
    if (t === 'table') return 'table';
    if (el.isContentEditable) return 'textbox';
    return 'generic';
  };
  const __match = (have, want, exact) => {
    have = __text(have); want = __text(want);
    return exact ? have === want : have.toLowerCase().includes(want.toLowerCase());
  };
  const __attrMatch = (attr, want, exact) => [...document.querySelectorAll('[' + attr + ']')]
    .filter(el => __visible(el) && __match(el.getAttribute(attr), want, exact));
  const __find = (loc) => {
    switch (loc.by) {
      case 'target': {
        const sel = loc.target.startsWith('@') ? '[data-dray-ref="' + loc.target.slice(1) + '"]' : loc.target;
        return [...document.querySelectorAll(sel)];
      }
      case 'nth': {
        const all = [...document.querySelectorAll(loc.selector)];
        const el = all[loc.index < 0 ? all.length + loc.index : loc.index];
        return el ? [el] : [];
      }
      case 'role':
        return [...document.querySelectorAll('*')].filter(el => __visible(el) && __role(el) === loc.role
          && (loc.name == null || __match(__name(el), loc.name, loc.exact)));
      case 'text': {
        const hits = [...document.querySelectorAll('body *')].filter(el => __visible(el)
          && el.children.length < 20 && __match(el.innerText, loc.text, loc.exact));
        // The deepest match is the element the words belong to, not its ancestors.
        return hits.filter(el => !hits.some(o => o !== el && el.contains(o)));
      }
      case 'label': {
        const byLabel = [...document.querySelectorAll('label')]
          .filter(l => __match(l.innerText, loc.label, loc.exact))
          .map(l => l.control || (l.htmlFor && document.getElementById(l.htmlFor)))
          .filter(Boolean);
        return byLabel.length ? byLabel : __attrMatch('aria-label', loc.label, loc.exact);
      }
      case 'placeholder': return __attrMatch('placeholder', loc.placeholder, loc.exact);
      case 'alt': return __attrMatch('alt', loc.alt, loc.exact);
      case 'title': return __attrMatch('title', loc.title, loc.exact);
      case 'test_id': return [...document.querySelectorAll('[data-testid="' + loc.id + '"], [data-test-id="' + loc.id + '"]')];
    }
    return [];
  };
  const __snapshot = (opts) => {
    document.querySelectorAll('[data-dray-ref]').forEach(el => el.removeAttribute('data-dray-ref'));
    const root = opts.selector ? document.querySelector(opts.selector) : document;
    if (!root) return 'nothing matches ' + opts.selector;
    const lines = [];
    let n = 0;
    const interactive = /^(link|button|textbox|checkbox|radio|combobox|option|tab|menuitem|switch|slider|searchbox)$/;
    for (const el of root.querySelectorAll('*')) {
      const r = __role(el);
      if (r === 'generic' || r === 'listitem' || r === 'list') continue;
      if (opts.interactive && !interactive.test(r)) continue;
      if (opts.compact && !(interactive.test(r) || r === 'heading')) continue;
      if (!__visible(el) || el.closest('[aria-hidden="true"]')) continue;
      if (n >= 400) { lines.push('… more elements not listed'); break; }
      const label = __name(el);
      if (!interactive.test(r)) { if (label) lines.push(r + ' "' + label + '"'); continue; }
      const ref = 'e' + (++n);
      el.setAttribute('data-dray-ref', ref);
      let line = '@' + ref + ' ' + r + ' "' + label + '"';
      if (r === 'link' && el.href) line += ' → ' + el.href;
      if ((r === 'textbox' || r === 'combobox') && 'value' in el && el.value) line += ' value="' + String(el.value).slice(0, 60) + '"';
      if (r === 'checkbox' || r === 'radio' || r === 'switch') line += (el.checked || el.getAttribute('aria-checked') === 'true') ? ' [checked]' : ' [ ]';
      if (el.disabled) line += ' [disabled]';
      lines.push(line);
    }
    return document.title + ' — ' + location.href + '\n' + lines.join('\n');
  };
"#;

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn locators_serialize_the_way_the_page_script_reads_them() {
        let js = serde_json::to_string(&Locator::Role { role: "button".into(), name: Some("Go".into()), exact: false }).unwrap();
        assert_eq!(js, r#"{"by":"role","role":"button","name":"Go","exact":false}"#);
        let js = serde_json::to_string(&Locator::TestId { id: "x".into() }).unwrap();
        assert!(js.contains(r#""by":"test_id""#), "the switch in HELPERS_JS spells it test_id");
    }

    #[test]
    fn chords_carry_no_text() {
        let (down, _) = key_events("Meta+a").unwrap();
        assert_eq!(down["modifiers"], 4);
        assert_eq!(down["type"], "rawKeyDown");
        let (down, _) = key_events("a").unwrap();
        assert_eq!(down["text"], "a");
        let (down, up) = key_events("Enter").unwrap();
        assert_eq!(down["windowsVirtualKeyCode"], 13);
        assert_eq!(up["type"], "keyUp");
    }

    #[test]
    fn devices_match_the_pane_presets() {
        let ts = include_str!("../../../src/lib/browser.ts");
        for (name, w, h) in DEVICES {
            assert!(
                ts.contains(&format!("label: \"{name}\", width: {w}, height: {h}")),
                "{name} drifted from VIEWPORT_PRESETS"
            );
        }
    }
}
