//! Embedded Chromium: CEF browsers hosted as native views inside the main
//! window, one set of tabs per session.
//!
//! Three things had to be true for this to work at all, and each is a
//! function below: the framework loads from wherever the bundle (or the dev
//! layout) keeps it (`init`); Tao's `NSApplication` subclass gains the
//! `CefAppProtocol` methods Chromium calls on `NSApp` (`patch_nsapp`); and
//! CEF's message loop is pumped from the main thread without owning it
//! (`start_pump`), since Tao already runs the run loop.
//!
//! **One native view is ever visible: the presented session's active tab.**
//! The frontend says which session is presented and where (`browser_layout`),
//! from whichever pane is on screen — the Browser tab or the right panel's
//! Live slot — and every other tab's view is hidden. A tab is a CEF browser
//! and its id is CEF's own `identifier()`; a session's tabs share one
//! `RequestContext` with its own cache path, so cookies are the session's.

// Glob import on purpose: the `wrap_*!` macros name the `Impl*`/`Wrap*`
// traits unqualified, so this is the one place a glob is load-bearing.
use cef::args::Args;
use cef::*;
use objc2::runtime::{AnyClass, AnyObject, Bool, Sel};
use objc2::{msg_send, sel};
use objc2_app_kit::{NSApplication, NSEvent, NSView};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
use serde::Serialize;
use std::collections::{HashMap, HashSet};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::Duration;
use tauri::{AppHandle, Emitter, Manager};

#[path = "automation.rs"]
pub mod automation;

const FRAMEWORK: &str = "Chromium Embedded Framework.framework";
const HELPER: &str = "Dray Helper.app/Contents/MacOS/Dray Helper";
/// Fixed for now; a per-app free port and a per-session proxy come later.
const DEBUG_PORT: i32 = 9333;

static APP: OnceLock<AppHandle> = OnceLock::new();
/// Never held across a call into CEF. Every `ImplBrowser`/`ImplFrame` call
/// can fire a handler synchronously — `load_url` fires
/// `on_loading_state_change` before it returns — and that handler takes this
/// lock. Clone what the call needs out, drop the guard, then call.
static TABS: Mutex<Vec<Tab>> = Mutex::new(Vec::new());
/// Session → its active tab id.
static ACTIVE: Mutex<Option<HashMap<String, i32>>> = Mutex::new(None);
static CONTEXTS: Mutex<Option<HashMap<String, RequestContext>>> = Mutex::new(None);
/// Which session is on screen and where. `None` shows nothing.
static LAYOUT: Mutex<Option<(String, Layout)>> = Mutex::new(None);

struct Tab {
    id: i32,
    session: String,
    browser: Browser,
    /// Keeps `dray browser`'s DevTools observer attached for the tab's life.
    _devtools: Option<Registration>,
    /// The `NSView` CEF created, as a pointer. Main thread only.
    view: usize,
    url: String,
    title: String,
    favicon: String,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
    /// The main frame's last load failure, cleared when a new load starts.
    error: Option<String>,
    /// CEF's zoom level: 0 is 100%, each step is ×1.2.
    zoom: f64,
}

#[derive(Clone, Copy)]
struct Layout {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
    visible: bool,
}

/// One tab as the frontend sees it.
#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
pub struct TabInfo {
    pub id: i32,
    pub url: String,
    pub title: String,
    pub favicon: String,
    pub loading: bool,
    pub active: bool,
    pub can_go_back: bool,
    pub can_go_forward: bool,
    pub error: Option<String>,
    pub zoom: f64,
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct TabsEvent {
    session_id: String,
    tabs: Vec<TabInfo>,
}

// --- Setup -----------------------------------------------------------------

/// Where the helpers and the framework live. The helpers ship in the bundle's
/// `Contents/Frameworks`, or in the dev layout `scripts/cef-dev-bundle.sh`
/// assembles beside the debug binary, shaped like a bundle so CEF resolves
/// them the same way. The framework sits beside them only in dev, where that
/// script links it in; a release loads the one `chromium` downloaded.
struct Paths {
    framework: PathBuf,
    helpers: PathBuf,
    bundle: PathBuf,
}

fn paths() -> Option<Paths> {
    let exe = std::env::current_exe().ok()?;
    let exe_dir = exe.parent()?;
    let dev = exe_dir.join("cef/Dray.app");
    let bundle = if dev.join("Contents/Frameworks").is_dir() {
        dev
    } else {
        exe_dir.join("../..").canonicalize().ok()?
    };
    let helpers = bundle.join("Contents/Frameworks");
    let beside = helpers.join(FRAMEWORK);
    let framework = if beside.exists() { beside } else { crate::chromium::installed_framework()? };
    Some(Paths { framework, helpers, bundle })
}

/// A framework beside the helpers is the dev layout, and nothing to fetch.
fn dev_framework() -> Option<PathBuf> {
    paths().filter(|p| p.framework.starts_with(&p.helpers)).map(|p| p.framework)
}

fn browser_dir() -> PathBuf {
    dirs::home_dir().unwrap_or_default().join(".dray/browser")
}

/// Call once from Tauri's `setup`. Chromium itself is not started here: it
/// is several processes and a few hundred megabytes, so it waits for the
/// first tab (`ensure_started`) and a reader who never opens one pays nothing.
pub fn init(app: &AppHandle) {
    let _ = APP.set(app.clone());
    crate::chromium::start(app.clone(), dev_framework());
}

static STARTED: Mutex<Option<bool>> = Mutex::new(None);

/// Loads the framework and initializes CEF, once. Main thread. `false` means
/// it could not, and every later call answers the same without retrying —
/// CEF cannot be initialized twice in one process, failed or not.
fn ensure_started() -> bool {
    let mut started = STARTED.lock().unwrap();
    if let Some(ok) = *started {
        return ok;
    }
    let ok = start();
    *started = Some(ok);
    ok
}

fn start() -> bool {
    let Some(app) = APP.get() else { return false };
    // Held from finding the framework to loading it, so `chromium::remove`
    // cannot take it off disk in between and leave this process's one
    // chance at starting CEF spent on a path that is no longer there.
    let mut loaded = crate::chromium::load_guard();
    let Some(paths) = paths() else {
        eprintln!("cef: no Chromium framework found; browser disabled");
        return false;
    };
    let framework = paths.framework;
    let library = framework.join("Chromium Embedded Framework");
    let c_path = std::ffi::CString::new(library.as_os_str().as_encoded_bytes()).expect("path");
    if cef::load_library(Some(unsafe { &*c_path.as_ptr() })) != 1 {
        eprintln!("cef: could not load {}", library.display());
        return false;
    }
    *loaded = true;
    drop(loaded);
    let _ = api_hash(cef::sys::CEF_API_VERSION_LAST, 0);

    let args = Args::new();
    // Returns -1 for the browser process; helpers are a separate binary, so
    // this process is never anything else.
    let ret = execute_process(Some(args.as_main_args()), None::<&mut App>, std::ptr::null_mut());
    if ret >= 0 {
        eprintln!("cef: execute_process answered {ret} in the browser process");
        return false;
    }

    let mtm = MainThreadMarker::new().expect("cef::start off the main thread");
    unsafe { patch_nsapp(&NSApplication::sharedApplication(mtm)) };

    let settings = Settings {
        no_sandbox: 1,
        external_message_pump: 1,
        remote_debugging_port: DEBUG_PORT,
        browser_subprocess_path: path_str(&paths.helpers.join(HELPER)),
        framework_dir_path: path_str(&framework),
        main_bundle_path: path_str(&paths.bundle),
        // Every session's cache path must sit under this one; CEF refuses
        // otherwise.
        root_cache_path: path_str(&browser_dir()),
        cache_path: path_str(&browser_dir().join("default")),
        ..Default::default()
    };
    let mut cef_app = DrayApp::new();
    if initialize(Some(args.as_main_args()), Some(&settings), Some(&mut cef_app), std::ptr::null_mut()) != 1 {
        eprintln!("cef: initialize failed");
        return false;
    }
    start_pump(app.clone());
    eprintln!("cef: initialized, devtools on 127.0.0.1:{DEBUG_PORT}");
    true
}

fn path_str(path: &Path) -> CefString {
    CefString::from(path.to_string_lossy().as_ref())
}

fn on_main(f: impl FnOnce() + Send + 'static) -> Result<(), String> {
    let app = APP.get().ok_or("Chromium is not available in this build")?;
    app.run_on_main_thread(f).map_err(|e| e.to_string())
}

// --- NSApplication ---------------------------------------------------------

static HANDLING_SEND_EVENT: AtomicBool = AtomicBool::new(false);

extern "C" fn is_handling_send_event(_this: &AnyObject, _sel: Sel) -> Bool {
    Bool::new(HANDLING_SEND_EVENT.load(Ordering::Relaxed))
}

extern "C" fn set_handling_send_event(_this: &AnyObject, _sel: Sel, value: Bool) {
    HANDLING_SEND_EVENT.store(value.as_bool(), Ordering::Relaxed);
}

/// The swapped-in `sendEvent:`. Marks the flag around the original, which is
/// reachable under the selector this was registered as before the swap.
extern "C" fn dray_send_event(this: &AnyObject, _sel: Sel, event: &NSEvent) {
    let was = HANDLING_SEND_EVENT.swap(true, Ordering::Relaxed);
    let _: () = unsafe { msg_send![this, draySendEvent: event] };
    HANDLING_SEND_EVENT.store(was, Ordering::Relaxed);
}

/// Chromium calls `isHandlingSendEvent` / `setHandlingSendEvent:` on `NSApp`
/// and expects `sendEvent:` to keep that flag; cefsimple subclasses
/// `NSApplication` for it. Tao already subclassed it (`TaoApp`), and the
/// class is registered before anything here runs, so the methods are added
/// to that class at runtime and `sendEvent:` is swizzled to wrap Tao's.
unsafe fn patch_nsapp(app: &NSApplication) {
    use objc2::ffi::{
        class_addMethod, class_addProtocol, class_getInstanceMethod, method_exchangeImplementations,
        objc_getProtocol,
    };
    let cls: *const AnyClass = app.class();
    let cls = cls as *mut AnyClass;
    let add = |sel: Sel, imp: *const (), types: &std::ffi::CStr| {
        let imp: objc2::runtime::Imp = std::mem::transmute(imp);
        class_addMethod(cls, sel, imp, types.as_ptr());
    };
    add(sel!(isHandlingSendEvent), is_handling_send_event as *const (), c"B@:");
    add(sel!(setHandlingSendEvent:), set_handling_send_event as *const (), c"v@:B");
    add(sel!(draySendEvent:), dray_send_event as *const (), c"v@:@");
    let original = class_getInstanceMethod(cls, sel!(sendEvent:));
    let ours = class_getInstanceMethod(cls, sel!(draySendEvent:));
    if !original.is_null() && !ours.is_null() {
        method_exchangeImplementations(original as *mut _, ours as *mut _);
    }
    for name in [c"CrAppProtocol", c"CrAppControlProtocol", c"CefAppProtocol"] {
        let proto = objc_getProtocol(name.as_ptr());
        if !proto.is_null() {
            class_addProtocol(cls, proto);
        }
    }
}

// --- Message pump ----------------------------------------------------------

static PUMP: OnceLock<mpsc::Sender<i64>> = OnceLock::new();

/// CEF asks for work through `on_schedule_message_pump_work(delay)`; a thread
/// waits that long (capped) and runs `do_message_loop_work` on the main
/// thread. It also ticks on its own at ~30Hz.
// ponytail: a free-running 30Hz tick beside the scheduled one; the proper
// pump (tests_shared's timer with reentrancy guards) if CPU or latency shows.
fn start_pump(app: AppHandle) {
    let (tx, rx) = mpsc::channel::<i64>();
    let _ = PUMP.set(tx);
    std::thread::Builder::new()
        .name("cef-pump".into())
        .spawn(move || loop {
            let delay = match rx.recv_timeout(Duration::from_millis(33)) {
                Ok(delay) => delay.clamp(0, 33) as u64,
                Err(mpsc::RecvTimeoutError::Timeout) => 0,
                Err(mpsc::RecvTimeoutError::Disconnected) => return,
            };
            if delay > 0 {
                std::thread::sleep(Duration::from_millis(delay));
            }
            let _ = app.run_on_main_thread(do_message_loop_work);
        })
        .expect("cef pump thread");
}

wrap_app! {
    struct DrayApp;

    impl App {
        fn browser_process_handler(&self) -> Option<BrowserProcessHandler> {
            Some(DrayBrowserProcessHandler::new())
        }

        /// Dev builds are unsigned and rebuilt constantly, and macOS grants
        /// keychain access per code signature — so Chromium's cookie key in
        /// "Chromium Safe Storage" raised a password prompt on every launch.
        /// The mock keychain is what Chromium's own tests run with.
        fn on_before_command_line_processing(&self, process_type: Option<&CefString>, command_line: Option<&mut CommandLine>) {
            let is_browser = process_type.map(|p| p.to_string().is_empty()).unwrap_or(true);
            if cfg!(debug_assertions) && is_browser {
                if let Some(command_line) = command_line {
                    command_line.append_switch(Some(&CefString::from("use-mock-keychain")));
                }
            }
        }
    }
}

wrap_browser_process_handler! {
    struct DrayBrowserProcessHandler;

    impl BrowserProcessHandler {
        fn on_schedule_message_pump_work(&self, delay_ms: i64) {
            if let Some(tx) = PUMP.get() {
                let _ = tx.send(delay_ms);
            }
        }
    }
}

// --- Tabs ------------------------------------------------------------------

fn active_id(session: &str) -> Option<i32> {
    ACTIVE.lock().unwrap().as_ref()?.get(session).copied()
}

fn set_active(session: &str, id: Option<i32>) {
    let mut guard = ACTIVE.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    match id {
        Some(id) => {
            map.insert(session.to_string(), id);
        }
        None => {
            map.remove(session);
        }
    }
}

fn tabs_of(session: &str) -> Vec<TabInfo> {
    let active = active_id(session);
    TABS.lock()
        .unwrap()
        .iter()
        .filter(|t| t.session == session)
        .map(|t| TabInfo {
            id: t.id,
            url: t.url.clone(),
            title: t.title.clone(),
            favicon: t.favicon.clone(),
            loading: t.loading,
            active: active == Some(t.id),
            can_go_back: t.can_go_back,
            can_go_forward: t.can_go_forward,
            error: t.error.clone(),
            zoom: t.zoom,
        })
        .collect()
}

/// Tells the frontend a session's tabs changed. Every change goes through
/// here, so the frontend holds no state the backend doesn't.
fn publish(session: &str) {
    if let Some(app) = APP.get() {
        let _ = app.emit(
            "browser_tabs",
            TabsEvent { session_id: session.to_string(), tabs: tabs_of(session) },
        );
    }
}

fn session_of(id: i32) -> Option<String> {
    TABS.lock().unwrap().iter().find(|t| t.id == id).map(|t| t.session.clone())
}

/// A handle to call CEF on, with the lock already released.
fn browser_of(id: i32) -> Option<Browser> {
    TABS.lock().unwrap().iter().find(|t| t.id == id).map(|t| t.browser.clone())
}

fn context_for(session: &str) -> Option<RequestContext> {
    let mut guard = CONTEXTS.lock().unwrap();
    let map = guard.get_or_insert_with(HashMap::new);
    if let Some(ctx) = map.get(session) {
        return Some(ctx.clone());
    }
    // A direct child of `root_cache_path`, not deeper: Chromium refuses a
    // profile at `sessions/<id>` ("Cannot create profile at path") and the
    // tab then silently lands in the shared default profile.
    let settings = RequestContextSettings {
        cache_path: path_str(&browser_dir().join(session)),
        persist_session_cookies: 1,
        ..Default::default()
    };
    let ctx = request_context_create_context(Some(&settings), None)?;
    map.insert(session.to_string(), ctx.clone());
    Some(ctx)
}

/// A tab's view: a child of the main window, hidden until `apply_layout`
/// decides it is the one on screen. Main thread.
fn child_window_info() -> Result<WindowInfo, String> {
    let app = APP.get().ok_or("Chromium is not available in this build")?;
    let window = app.get_webview_window("main").ok_or("no main window")?;
    let parent = window.ns_view().map_err(|e| e.to_string())?;
    let layout = LAYOUT.lock().unwrap().as_ref().map(|(_, l)| *l);
    let bounds = layout
        .map(|l| Rect { x: l.x as i32, y: l.y as i32, width: l.width as i32, height: l.height as i32 })
        .unwrap_or(Rect { x: 0, y: 0, width: 800, height: 600 });
    let mut info = WindowInfo::default().set_as_child(parent, &bounds);
    info.hidden = 1;
    Ok(info)
}

/// Creates a browser for `session`. Its tab appears in `on_after_created`,
/// which is where CEF hands the browser back. Main thread.
fn create_tab(session: &str, url: &str, activate: bool) -> Result<(), String> {
    // Before `ensure_started`, which remembers a failure for the life of the
    // process: a tab asked for mid-download must wait, not write CEF off.
    if paths().is_none() {
        return Err(crate::chromium::not_ready_reason());
    }
    if !ensure_started() {
        return Err("Chromium could not start".into());
    }
    let info = child_window_info()?;
    let mut client = DrayClient::new(session.to_string(), activate);
    let mut context = context_for(session);
    let ok = browser_host_create_browser(
        Some(&info),
        Some(&mut client),
        Some(&CefString::from(url)),
        Some(&BrowserSettings::default()),
        None,
        context.as_mut(),
    );
    if ok == 1 {
        Ok(())
    } else {
        Err("could not create the browser".into())
    }
}

/// Moves the presented session's active tab onto the frontend's rect and
/// hides every other tab's view. AppKit's y runs up from the bottom and the
/// frontend's down from the top, so the rect is flipped against the parent's
/// height. Main thread only.
fn apply_layout() {
    let presented = LAYOUT.lock().unwrap().clone();
    let shown = presented
        .as_ref()
        .filter(|(_, l)| l.visible)
        .and_then(|(session, _)| active_id(session));
    let layout = presented.map(|(_, l)| l);
    let views: Vec<(i32, usize, Browser)> = TABS
        .lock()
        .unwrap()
        .iter()
        .filter(|t| t.view != 0)
        .map(|t| (t.id, t.view, t.browser.clone()))
        .collect();
    for (id, view, browser) in views {
        let view: &NSView = unsafe { &*(view as *const NSView) };
        let show = shown == Some(id);
        if show {
            if let (Some(layout), Some(parent)) = (layout, unsafe { view.superview() }) {
                let parent_height = parent.bounds().size.height;
                let frame = NSRect::new(
                    NSPoint::new(layout.x, parent_height - layout.y - layout.height),
                    NSSize::new(layout.width, layout.height),
                );
                view.setFrame(frame);
            }
            if let Some(host) = browser.host() {
                host.notify_move_or_resize_started();
            }
        }
        view.setHidden(!show);
    }
}

/// Unhides a tab's view off-screen, so Chromium treats it as visible and
/// delivers the input `dray browser` dispatches: a hidden `NSView` marks the
/// widget hidden, and a hidden widget drops mouse and key events (measured:
/// a page listener saw nothing). `apply_layout` puts it back.
fn reveal(id: i32) {
    let view = TABS.lock().unwrap().iter().find(|t| t.id == id).map(|t| t.view).unwrap_or(0);
    if view == 0 {
        return;
    }
    let view: &NSView = unsafe { &*(view as *const NSView) };
    if !view.isHidden() {
        return;
    }
    let size = view.frame().size;
    let size = if size.width < 1.0 || size.height < 1.0 { NSSize::new(800.0, 600.0) } else { size };
    view.setFrame(NSRect::new(NSPoint::new(-20000.0, 0.0), size));
    view.setHidden(false);
}

wrap_client! {
    struct DrayClient {
        session: String,
        activate: bool,
    }

    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(DrayLifeSpan::new(self.session.clone(), self.activate))
        }
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(DrayDisplay::new())
        }
        fn load_handler(&self) -> Option<LoadHandler> {
            Some(DrayLoad::new())
        }
        fn keyboard_handler(&self) -> Option<KeyboardHandler> {
            Some(DrayKeyboard::new())
        }
    }
}

wrap_life_span_handler! {
    struct DrayLifeSpan {
        session: String,
        activate: bool,
    }

    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            let Some(browser) = browser.cloned() else { return };
            let id = browser.identifier();
            let view = browser.host().map(|h| h.window_handle() as usize).unwrap_or(0);
            let url = browser.main_frame().map(|f| CefString::from(&f.url()).to_string()).unwrap_or_default();
            let devtools = automation::observe(&browser);
            let tab = Tab {
                id,
                session: self.session.clone(),
                browser,
                _devtools: devtools,
                view,
                url,
                title: String::new(),
                favicon: String::new(),
                loading: true,
                can_go_back: false,
                can_go_forward: false,
                error: None,
                zoom: 0.0,
            };
            // CEF can hand over a replacement browser under an id it has not
            // yet closed the old one for; a second entry would then go out
            // with the first's `on_before_close`, taking the live tab with
            // it. Replace in place, and `on_before_close` removes only the
            // instance it holds.
            let mut tabs = TABS.lock().unwrap();
            match tabs.iter_mut().find(|t| t.id == id) {
                Some(slot) => *slot = tab,
                None => tabs.push(tab),
            }
            drop(tabs);
            if self.activate || active_id(&self.session).is_none() {
                set_active(&self.session, Some(id));
            }
            apply_layout();
            publish(&self.session);
        }

        /// A `target=_blank` link or `window.open`: a new tab in the same
        /// session rather than the top-level window CEF would make. The
        /// popup itself is left to CEF — its window info and client are
        /// rewritten to ours and `0` returned — so `window.open` answers a
        /// real window with an opener, which OAuth and payment flows post
        /// back through. Making an unrelated tab here instead returned
        /// `null` to the page.
        fn on_before_popup(
            &self,
            _browser: Option<&mut Browser>,
            _frame: Option<&mut Frame>,
            _popup_id: ::std::os::raw::c_int,
            _target_url: Option<&CefString>,
            _target_frame_name: Option<&CefString>,
            _target_disposition: WindowOpenDisposition,
            _user_gesture: ::std::os::raw::c_int,
            _popup_features: Option<&PopupFeatures>,
            window_info: Option<&mut WindowInfo>,
            client: Option<&mut Option<Client>>,
            _settings: Option<&mut BrowserSettings>,
            _extra_info: Option<&mut Option<DictionaryValue>>,
            _no_javascript_access: Option<&mut ::std::os::raw::c_int>,
        ) -> ::std::os::raw::c_int {
            let (Some(window_info), Some(client)) = (window_info, client) else { return 1 };
            let Ok(info) = child_window_info() else { return 1 };
            *window_info = info;
            *client = Some(DrayClient::new(self.session.clone(), true));
            0
        }

        /// Handled here. Left to CEF, a close on a child view is delivered
        /// to the window holding it — Dray's main window — which raised the
        /// app's own quit prompt for every tab closed. Answering `1` alone is
        /// not enough either: CEF then waits for the view hierarchy to be
        /// torn down, so the tab's view is pulled out of the window here and
        /// `on_before_close` follows from that.
        fn do_close(&self, browser: Option<&mut Browser>) -> ::std::os::raw::c_int {
            let view = browser
                .and_then(|b| b.host())
                .map(|h| h.window_handle() as usize)
                .unwrap_or(0);
            if view != 0 {
                let view: &NSView = unsafe { &*(view as *const NSView) };
                view.removeFromSuperview();
            }
            1
        }

        fn on_before_close(&self, browser: Option<&mut Browser>) {
            let Some(mut closing) = browser.cloned() else { return };
            let id = closing.identifier();
            // Only the instance on record leaves; a replaced browser closing
            // late must not take its successor's entry. Compared with the
            // lock released, since `is_same` is a call into CEF.
            let stored = TABS.lock().unwrap().iter().find(|t| t.id == id).map(|t| t.browser.clone());
            let Some(stored) = stored else { return };
            if stored.is_same(Some(&mut closing)) == 0 {
                return;
            }
            automation::forget(id);
            disarm_picker(id);
            let session = self.session.clone();
            let remaining = {
                let mut tabs = TABS.lock().unwrap();
                tabs.retain(|t| t.id != id);
                tabs.iter().rev().find(|t| t.session == session).map(|t| t.id)
            };
            if active_id(&session) == Some(id) {
                set_active(&session, remaining);
            }
            // The profile is what keeps a closed session's memory around; the
            // next tab makes a fresh one on the same cache path.
            if remaining.is_none() {
                if let Some(map) = CONTEXTS.lock().unwrap().as_mut() {
                    map.remove(&session);
                }
            }
            apply_layout();
            publish(&session);
        }
    }
}

fn update_tab(id: i32, f: impl FnOnce(&mut Tab)) {
    let session = {
        let mut tabs = TABS.lock().unwrap();
        let Some(tab) = tabs.iter_mut().find(|t| t.id == id) else { return };
        f(tab);
        tab.session.clone()
    };
    publish(&session);
}

wrap_display_handler! {
    struct DrayDisplay;

    impl DisplayHandler {
        fn on_address_change(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, url: Option<&CefString>) {
            if !frame.map(|f| f.is_main() != 0).unwrap_or(false) {
                return;
            }
            let Some(id) = browser.map(|b| b.identifier()) else { return };
            let url = url.map(CefString::to_string).unwrap_or_default();
            update_tab(id, |t| t.url = url);
        }
        fn on_title_change(&self, browser: Option<&mut Browser>, title: Option<&CefString>) {
            let Some(id) = browser.map(|b| b.identifier()) else { return };
            let title = title.map(CefString::to_string).unwrap_or_default();
            update_tab(id, |t| t.title = title);
        }

        fn on_favicon_urlchange(&self, browser: Option<&mut Browser>, icon_urls: Option<&mut CefStringList>) {
            let Some(id) = browser.map(|b| b.identifier()) else { return };
            // A clone of the borrowed wrapper iterates and frees nothing on
            // drop; rebuilding one from a const pointer makes the crate's
            // `Borrowed` shape, which iterates as empty.
            let first = icon_urls.and_then(|list| list.clone().into_iter().next()).unwrap_or_default();
            update_tab(id, |t| t.favicon = first);
        }

        /// The element picker reports through the console — the one channel
        /// from page script back to here that needs no binding of its own.
        /// Its lines are swallowed; everything else passes through.
        fn on_console_message(
            &self,
            browser: Option<&mut Browser>,
            level: LogSeverity,
            message: Option<&CefString>,
            _source: Option<&CefString>,
            _line: ::std::os::raw::c_int,
        ) -> ::std::os::raw::c_int {
            let text = message.map(CefString::to_string).unwrap_or_default();
            let Some(rest) = text.strip_prefix(PICK_PREFIX) else {
                if let Some(id) = browser.as_ref().map(|b| b.identifier()) {
                    let error = sys::cef_log_severity_t::from(level) == sys::cef_log_severity_t::LOGSEVERITY_ERROR;
                    automation::log(id, error, text);
                }
                return 0;
            };
            let Some(id) = browser.map(|b| b.identifier()) else { return 1 };
            // Any page can log the prefix; only a tab whose picker this app
            // started is listened to, once, and only a payload of the shape
            // `PICK_JS` writes — `null` for a cancel. Parsed before the gate
            // is spent, so a malformed line costs nothing. A binding through
            // the render process would be the trusted channel; this is the
            // gate until there is one.
            let Ok(element) = serde_json::from_str::<Option<PickedElement>>(rest) else { return 1 };
            if !PICKING.lock().unwrap().get_or_insert_with(HashSet::new).remove(&id) {
                return 1;
            }
            let Some(session) = session_of(id) else { return 1 };
            if let Some(app) = APP.get() {
                let _ = app.emit("browser_pick", PickEvent { session_id: session, element });
            }
            1
        }
    }
}

const PICK_PREFIX: &str = "__dray_pick__";

/// Tabs whose picker is running. An entry is spent by the first pick line,
/// and dropped by a navigation or a close, since the script that would
/// write one is gone with the document.
static PICKING: Mutex<Option<HashSet<i32>>> = Mutex::new(None);

/// Disarms a tab's picker and tells the pane, so its button does not stay
/// pressed for a picker that no longer exists. From `on_load_start` on the
/// main frame and from `on_before_close`.
fn disarm_picker(id: i32) {
    let was = PICKING.lock().unwrap().as_mut().map(|s| s.remove(&id)).unwrap_or(false);
    if !was {
        return;
    }
    if let (Some(app), Some(session)) = (APP.get(), session_of(id)) {
        let _ = app.emit("browser_pick", PickEvent { session_id: session, element: None });
    }
}

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct PickEvent {
    session_id: String,
    /// `None` is a cancel.
    element: Option<PickedElement>,
}

/// What `PICK_JS` reports, typed so a page cannot hand the composer an
/// arbitrary object. Mirrors `PickedElement` in browser.ts.
#[derive(Clone, Serialize, serde::Deserialize)]
struct PickedElement {
    url: String,
    title: String,
    selector: String,
    tag: String,
    text: String,
    attrs: HashMap<String, String>,
    rect: PickRect,
    styles: PickStyles,
}

#[derive(Clone, Serialize, serde::Deserialize)]
struct PickRect {
    x: f64,
    y: f64,
    width: f64,
    height: f64,
}

#[derive(Clone, Serialize, serde::Deserialize)]
struct PickStyles {
    color: String,
    background: String,
    font: String,
}

/// Injected into the page to pick an element: a highlight follows the
/// pointer, a click reports the element under it and stops, Escape stops.
/// Everything it needs to say goes out through `console.log` with
/// `PICK_PREFIX`; see `on_console_message`. Re-running it replaces a live one.
const PICK_JS: &str = r#"(() => {
  if (window.__drayPick) window.__drayPick.stop();
  const box = document.createElement('div');
  box.style.cssText = 'position:fixed;pointer-events:none;z-index:2147483647;border:2px solid #f5c400;background:rgba(245,196,0,.12);border-radius:3px;transition:all 40ms;';
  document.documentElement.appendChild(box);
  const say = (v) => console.log('__dray_pick__' + (v ? JSON.stringify(v) : 'null'));
  const selectorOf = (el) => {
    const parts = [];
    for (let e = el, i = 0; e && e.nodeType === 1 && i < 5; e = e.parentElement, i++) {
      let s = e.tagName.toLowerCase();
      if (e.id) { parts.unshift(s + '#' + CSS.escape(e.id)); break; }
      const cls = [...e.classList].filter(c => !/^[a-z]+-\[|:/.test(c)).slice(0, 2);
      if (cls.length) s += '.' + cls.map(CSS.escape).join('.');
      const p = e.parentElement;
      if (p) {
        const same = [...p.children].filter(c => c.tagName === e.tagName);
        if (same.length > 1) s += ':nth-of-type(' + (same.indexOf(e) + 1) + ')';
      }
      parts.unshift(s);
    }
    return parts.join(' > ');
  };
  const at = (ev) => {
    const el = document.elementFromPoint(ev.clientX, ev.clientY);
    return el && el !== box ? el : null;
  };
  const move = (ev) => {
    const el = at(ev);
    if (!el) return;
    const r = el.getBoundingClientRect();
    box.style.left = r.left + 'px'; box.style.top = r.top + 'px';
    box.style.width = r.width + 'px'; box.style.height = r.height + 'px';
  };
  // The press is swallowed on both edges and the pick made on the click,
  // so the page never sees a click on the element that was picked.
  const block = (ev) => { ev.preventDefault(); ev.stopPropagation(); };
  const click = (ev) => {
    ev.preventDefault(); ev.stopPropagation();
    const el = at(ev);
    if (!el) return;
    const r = el.getBoundingClientRect();
    const cs = getComputedStyle(el);
    say({
      url: location.href,
      title: document.title,
      selector: selectorOf(el),
      tag: el.tagName.toLowerCase(),
      text: (el.innerText || el.textContent || '').trim().replace(/\s+/g, ' ').slice(0, 200),
      attrs: Object.fromEntries(['id','class','role','aria-label','name','href','src','type','placeholder'].filter(a => el.getAttribute(a)).map(a => [a, el.getAttribute(a).slice(0, 120)])),
      rect: { x: Math.round(r.left), y: Math.round(r.top), width: Math.round(r.width), height: Math.round(r.height) },
      styles: { color: cs.color, background: cs.backgroundColor, font: cs.fontSize + ' ' + cs.fontFamily.split(',')[0] },
    });
    stop();
  };
  const key = (ev) => { if (ev.key === 'Escape') { ev.preventDefault(); say(null); stop(); } };
  const opts = { capture: true };
  const stop = () => {
    document.removeEventListener('mousemove', move, opts);
    document.removeEventListener('click', click, opts);
    document.removeEventListener('mousedown', block, opts);
    document.removeEventListener('mouseup', block, opts);
    document.removeEventListener('keydown', key, opts);
    box.remove();
    delete window.__drayPick;
  };
  document.addEventListener('mousemove', move, opts);
  document.addEventListener('mousedown', block, opts);
  document.addEventListener('mouseup', block, opts);
  document.addEventListener('click', click, opts);
  document.addEventListener('keydown', key, opts);
  window.__drayPick = { stop };
})();"#;

wrap_load_handler! {
    struct DrayLoad;

    impl LoadHandler {
        fn on_loading_state_change(&self, browser: Option<&mut Browser>, is_loading: ::std::os::raw::c_int, can_go_back: ::std::os::raw::c_int, can_go_forward: ::std::os::raw::c_int) {
            let Some(id) = browser.map(|b| b.identifier()) else { return };
            update_tab(id, |t| {
                t.loading = is_loading != 0;
                t.can_go_back = can_go_back != 0;
                t.can_go_forward = can_go_forward != 0;
                if is_loading != 0 {
                    t.error = None;
                }
            });
        }

        /// The main frame leaving its document takes the picker's script
        /// with it. Judged here and not on the loading state, which reports
        /// the whole browser: an iframe loading would disarm a picker whose
        /// document is still there.
        fn on_load_start(&self, browser: Option<&mut Browser>, frame: Option<&mut Frame>, _transition_type: TransitionType) {
            if !frame.map(|f| f.is_main() != 0).unwrap_or(false) {
                return;
            }
            if let Some(id) = browser.map(|b| b.identifier()) {
                disarm_picker(id);
            }
        }

        /// Chromium draws its own error page; this only records the reason
        /// for the tab strip. An aborted load is a navigation away, not an
        /// error.
        fn on_load_error(
            &self,
            browser: Option<&mut Browser>,
            frame: Option<&mut Frame>,
            error_code: Errorcode,
            error_text: Option<&CefString>,
            _failed_url: Option<&CefString>,
        ) {
            if !frame.map(|f| f.is_main() != 0).unwrap_or(false) {
                return;
            }
            if sys::cef_errorcode_t::from(error_code) == sys::cef_errorcode_t::ERR_ABORTED {
                return;
            }
            let Some(id) = browser.map(|b| b.identifier()) else { return };
            let text = error_text.map(CefString::to_string).unwrap_or_default();
            update_tab(id, |t| t.error = Some(text));
        }
    }
}

/// Zoom on CEF's level scale, where 0 is 100% and a step is ×1.2. Written
/// back onto the tab, since `zoom_level()` is the only reading and it lives
/// on the host.
fn zoom(browser: &Browser, action: &str) {
    let Some(host) = browser.host() else { return };
    let level = match action {
        "in" => (host.zoom_level() + 1.0).min(7.0),
        "out" => (host.zoom_level() - 1.0).max(-5.0),
        _ => 0.0,
    };
    host.set_zoom_level(level);
    update_tab(browser.identifier(), |t| t.zoom = level);
}

/// DevTools in its own window: the default `WindowInfo` is a top-level one.
fn open_devtools(browser: &Browser) {
    if let Some(host) = browser.host() {
        host.show_dev_tools(
            Some(&WindowInfo::default()),
            None::<&mut Client>,
            Some(&BrowserSettings::default()),
            None,
        );
    }
}

/// ⌘-chords the page keeps: editing, find, reload. Zoom, hard reload and
/// DevTools are the browser's and handled below, since CEF implements none
/// of Chrome's accelerators itself. Every other ⌘-chord is the app's — ⌘1,
/// ⌘B, ⌘E, ⌘N — and is handed back to the webview, since with Chromium's view
/// focused a key never reaches the document `useHotkey` listens on.
const PAGE_CHORDS: &[char] = &['c', 'v', 'x', 'a', 'z', 'f', 'r', 'l'];

#[derive(Clone, Serialize)]
#[serde(rename_all = "camelCase")]
struct ForwardedKey {
    key: String,
    code: String,
    shift: bool,
    alt: bool,
    ctrl: bool,
}

wrap_keyboard_handler! {
    struct DrayKeyboard;

    impl KeyboardHandler {
        fn on_pre_key_event(
            &self,
            browser: Option<&mut Browser>,
            event: Option<&KeyEvent>,
            _os_event: *mut u8,
            _is_keyboard_shortcut: Option<&mut ::std::os::raw::c_int>,
        ) -> ::std::os::raw::c_int {
            let Some(event) = event else { return 0 };
            let raw_down = sys::cef_key_event_type_t::from(event.type_)
                == sys::cef_key_event_type_t::KEYEVENT_RAWKEYDOWN;
            let meta = event.modifiers & 128 != 0;
            if !raw_down || !meta {
                return 0;
            }
            let shift = event.modifiers & 2 != 0;
            let ctrl = event.modifiers & 4 != 0;
            let alt = event.modifiers & 8 != 0;
            let ch = char::from_u32(event.unmodified_character as u32)
                .unwrap_or('\0')
                .to_ascii_lowercase();
            if let Some(browser) = browser {
                let plain = !shift && !alt && !ctrl;
                match ch {
                    '=' | '+' if plain => return { zoom(browser, "in"); 1 },
                    '-' if plain => return { zoom(browser, "out"); 1 },
                    '0' if plain => return { zoom(browser, "reset"); 1 },
                    'r' if shift && !alt && !ctrl => return { browser.reload_ignore_cache(); 1 },
                    'i' if alt && !shift && !ctrl => return { open_devtools(browser); 1 },
                    _ => {}
                }
            }
            if !shift && !alt && !ctrl && PAGE_CHORDS.contains(&ch) {
                return 0;
            }
            let (key, code) = match event.windows_key_code {
                0x25 => ("ArrowLeft".into(), "ArrowLeft".into()),
                0x26 => ("ArrowUp".into(), "ArrowUp".into()),
                0x27 => ("ArrowRight".into(), "ArrowRight".into()),
                0x28 => ("ArrowDown".into(), "ArrowDown".into()),
                0x0D => ("Enter".into(), "Enter".into()),
                0x1B => ("Escape".into(), "Escape".into()),
                _ if ch.is_ascii_alphabetic() => (ch.to_string(), format!("Key{}", ch.to_ascii_uppercase())),
                _ if ch.is_ascii_digit() => (ch.to_string(), format!("Digit{ch}")),
                _ => {
                    let code = match ch {
                        '[' => "BracketLeft",
                        ']' => "BracketRight",
                        ',' => "Comma",
                        '.' => "Period",
                        '/' => "Slash",
                        _ => return 0,
                    };
                    (ch.to_string(), code.into())
                }
            };
            if let Some(app) = APP.get() {
                let _ = app.emit("cef_key", ForwardedKey { key, code, shift, alt, ctrl });
            }
            1
        }
    }
}

// --- Commands --------------------------------------------------------------

/// Which session is on screen and where, in CSS pixels from the window's
/// top-left. `visible: false` hides every tab.
#[tauri::command]
pub fn browser_layout(session_id: String, x: f64, y: f64, width: f64, height: f64, visible: bool) -> Result<(), String> {
    *LAYOUT.lock().unwrap() = Some((session_id, Layout { x, y, width, height, visible }));
    on_main(apply_layout)
}

/// Loads `url` in the session's active tab, or in a new one. A tab that
/// cannot be made is the caller's error, not a log line: the pane leaves
/// its pending tab standing otherwise, with nothing to say why.
#[tauri::command]
pub fn browser_open(session_id: String, url: String, new_tab: bool) -> Result<(), String> {
    let (tx, rx) = mpsc::channel();
    on_main(move || {
        if !new_tab {
            if let Some(frame) = active_id(&session_id).and_then(|id| browser_of(id)).and_then(|b| b.main_frame()) {
                frame.load_url(Some(&CefString::from(url.as_str())));
                let _ = tx.send(Ok(()));
                return;
            }
        }
        let _ = tx.send(create_tab(&session_id, &url, true));
    })?;
    rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "Chromium did not answer".to_string())?
}

#[tauri::command]
pub fn browser_tabs(session_id: String) -> Vec<TabInfo> {
    tabs_of(&session_id)
}

#[tauri::command]
pub fn browser_activate(session_id: String, id: i32) -> Result<(), String> {
    on_main(move || {
        if session_of(id).as_deref() != Some(session_id.as_str()) {
            return;
        }
        set_active(&session_id, Some(id));
        apply_layout();
        if let Some(host) = browser_of(id).and_then(|b| b.host()) {
            host.set_focus(1);
        }
        publish(&session_id);
    })
}

/// Closes one tab. The rest happens in `on_before_close`.
#[tauri::command]
pub fn browser_close(session_id: String, id: i32) -> Result<(), String> {
    on_main(move || {
        if session_of(id).as_deref() != Some(session_id.as_str()) {
            return;
        }
        if let Some(host) = browser_of(id).and_then(|b| b.host()) {
            host.close_browser(1);
        }
    })
}

/// Back, forward, reload or stop, on the active tab.
#[tauri::command]
pub fn browser_nav(session_id: String, action: String) -> Result<(), String> {
    on_main(move || {
        let Some(browser) = active_id(&session_id).and_then(browser_of) else { return };
        match action.as_str() {
            "back" => browser.go_back(),
            "forward" => browser.go_forward(),
            "stop" => browser.stop_load(),
            "hard_reload" => browser.reload_ignore_cache(),
            _ => browser.reload(),
        }
    })
}

/// `in`, `out` or `reset`, on the active tab.
#[tauri::command]
pub fn browser_zoom(session_id: String, action: String) -> Result<(), String> {
    on_main(move || {
        if let Some(browser) = active_id(&session_id).and_then(browser_of) {
            zoom(&browser, &action);
        }
    })
}

#[tauri::command]
pub fn browser_devtools(session_id: String) -> Result<(), String> {
    on_main(move || {
        if let Some(browser) = active_id(&session_id).and_then(browser_of) {
            open_devtools(&browser);
        }
    })
}

/// Starts or stops the element picker in the active tab. The pick itself
/// arrives as a `browser_pick` event.
#[tauri::command]
pub fn browser_pick(session_id: String, start: bool) -> Result<(), String> {
    on_main(move || {
        let Some(id) = active_id(&session_id) else { return };
        let Some(frame) = browser_of(id).and_then(|b| b.main_frame()) else { return };
        {
            let mut picking = PICKING.lock().unwrap();
            let set = picking.get_or_insert_with(HashSet::new);
            if start {
                set.insert(id);
            } else {
                set.remove(&id);
            }
        }
        let code = if start { PICK_JS } else { "window.__drayPick && window.__drayPick.stop()" };
        frame.execute_java_script(Some(&CefString::from(code)), None, 0);
    })
}

/// Closes every tab a session holds, for session delete.
pub fn close_session(session_id: &str) {
    let session_id = session_id.to_string();
    let _ = on_main(move || {
        let browsers: Vec<Browser> = TABS
            .lock()
            .unwrap()
            .iter()
            .filter(|t| t.session == session_id)
            .map(|t| t.browser.clone())
            .collect();
        for host in browsers.iter().filter_map(|b| b.host()) {
            host.close_browser(1);
        }
    });
}
