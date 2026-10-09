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
//! under an id Dray mints, carried on its client, so the id outlives the
//! browser: a discarded tab (`sweep`) is a browser closed and made again. A
//! session's tabs share one `RequestContext` with its own cache path, so
//! cookies are the session's and survive a discard.

// Glob import on purpose: the `wrap_*!` macros name the `Impl*`/`Wrap*`
// traits unqualified, so this is the one place a glob is load-bearing.
use cef::args::Args;
use cef::*;
use objc2::runtime::{AnyClass, AnyObject, Bool, NSObjectProtocol, Sel};
use objc2::{msg_send, sel};
use objc2_app_kit::{NSApplication, NSEvent, NSView};
use objc2_foundation::{MainThreadMarker, NSPoint, NSRect, NSSize};
use serde::Serialize;
use std::collections::{HashMap, HashSet, VecDeque};
use std::path::{Path, PathBuf};
use std::sync::atomic::{AtomicBool, AtomicI32, AtomicU64, AtomicUsize, Ordering};
use std::sync::{mpsc, Mutex, OnceLock};
use std::time::{Duration, Instant};
use tauri::{AppHandle, Emitter, Manager};

#[path = "../browser/automation.rs"]
pub mod automation;

const FRAMEWORK: &str = "Chromium Embedded Framework.framework";
const HELPER: &str = "Dray Helper.app/Contents/MacOS/Dray Helper";

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
/// Tab ids. Not CEF's `identifier()`, which a woken tab would come back
/// under a new one of, renaming it under the strip and `dray browser tab`.
static NEXT_TAB: AtomicI32 = AtomicI32::new(1);

/// A tab not seen for this long gives its renderer back. Measured: one tab
/// on a page failing against a dead server reached 5.7GB in 20h.
const DISCARD_AFTER: Duration = Duration::from_secs(30 * 60);
const SWEEP_EVERY: Duration = Duration::from_secs(60);

/// The tabs shown most recently, newest first. Their views are parked
/// off-screen rather than hidden, because a hidden view drops its painted
/// frame and draws white until Chromium paints again — the flash on every tab
/// switch. Parked, the frame is still there and coming back is a move.
/// Capped, since a parked tab keeps running as if on screen.
static WARM: Mutex<VecDeque<i32>> = Mutex::new(VecDeque::new());
const WARM_TABS: usize = 4;

struct Tab {
    id: i32,
    session: String,
    /// `None` while discarded, or while a woken one is being made.
    browser: Option<Browser>,
    /// Keeps `dray browser`'s DevTools observer attached for the tab's life.
    _devtools: Option<Registration>,
    /// The `NSView` CEF created, as a pointer. Main thread only.
    view: usize,
    url: String,
    title: String,
    favicon: String,
    /// The colour at the top of the page, as `rgb(r, g, b)`, so the URL row
    /// can wear it. Kept across a navigation until the next page reports.
    background: Option<String>,
    loading: bool,
    can_go_back: bool,
    can_go_forward: bool,
    /// The main frame's last load failure, cleared when a new load starts.
    error: Option<String>,
    /// Last drawn on screen or acted on by `dray browser`.
    seen: Instant,
    /// Set by `sweep` before the close, cleared by `wake`. `on_before_close`
    /// reads it to keep the entry rather than drop it.
    discarded: bool,
    /// The tab whose `window.open` made this one. Neither half of a live
    /// pair is discarded: the popup posts back through `window.opener`.
    opener: Option<i32>,
    /// Woken and not yet finished loading, so a verb waits for the page
    /// even when the pane started the wake.
    waking: bool,
    /// Closed by the reader or the session going. A close landing while the
    /// tab is mid-discard or mid-wake has no browser to act on, so the
    /// callbacks read this instead: `on_before_close` drops the entry rather
    /// than keep a ghost, and `on_after_created` closes what it was handed.
    closing: bool,
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
    pub discarded: bool,
    pub background: Option<String>,
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

/// Dev builds get their own profile root, as they get their own socket:
/// Chromium holds a singleton lock on the root, so a dev build sharing the
/// release app's would fail to initialize and exit the process.
fn browser_dir() -> PathBuf {
    let dir = if tauri::is_dev() { ".dray/browser-dev" } else { ".dray/browser" };
    std::env::home_dir().unwrap_or_default().join(dir)
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
    // A missing framework is the one outcome not remembered: Remove can take
    // it between a caller's preflight and here, and a download can put it
    // back, so that is "not yet" rather than "never".
    let outcome = start();
    if outcome.is_some() {
        *started = outcome;
    }
    outcome.unwrap_or(false)
}

fn start() -> Option<bool> {
    let Some(app) = APP.get() else { return Some(false) };
    // Held from finding the framework to loading it, so `chromium::remove`
    // cannot take it off disk in between and leave this process's one
    // chance at starting CEF spent on a path that is no longer there.
    let mut loaded = crate::chromium::load_guard();
    let Some(paths) = paths() else {
        eprintln!("cef: no Chromium framework on disk yet");
        return None;
    };
    let framework = paths.framework;
    let library = framework.join("Chromium Embedded Framework");
    let c_path = std::ffi::CString::new(library.as_os_str().as_encoded_bytes()).expect("path");
    if cef::load_library(Some(unsafe { &*c_path.as_ptr() })) != 1 {
        eprintln!("cef: could not load {}", library.display());
        return Some(false);
    }
    *loaded = true;
    drop(loaded);
    let _ = api_hash(cef::sys::CEF_API_VERSION_LAST, 0);

    let args = Args::new();
    // Returns -1 for the browser process; helpers are a separate binary, so
    // this process is never anything else.
    let ret = keeping_signal(libc::SIGCHLD, || {
        execute_process(Some(args.as_main_args()), None::<&mut App>, std::ptr::null_mut())
    });
    if ret >= 0 {
        eprintln!("cef: execute_process answered {ret} in the browser process");
        return Some(false);
    }

    let mtm = MainThreadMarker::new().expect("cef::start off the main thread");
    unsafe { patch_nsapp(&NSApplication::sharedApplication(mtm)) };

    let settings = Settings {
        no_sandbox: 1,
        external_message_pump: 1,
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
    let ok = keeping_signal(libc::SIGCHLD, || {
        initialize(Some(args.as_main_args()), Some(&settings), Some(&mut cef_app), std::ptr::null_mut()) == 1
    });
    if !ok {
        eprintln!("cef: initialize failed");
        return Some(false);
    }
    start_pump(app.clone());
    let sweeper = app.clone();
    std::thread::Builder::new()
        .name("cef-sweep".into())
        .spawn(move || loop {
            std::thread::sleep(SWEEP_EVERY);
            let _ = sweeper.run_on_main_thread(sweep);
        })
        .expect("cef sweep thread");
    eprintln!("cef: initialized");
    Some(true)
}

fn path_str(path: &Path) -> CefString {
    CefString::from(path.to_string_lossy().as_ref())
}

/// Chromium's browser-process init resets SIGCHLD to `SIG_DFL`, which wipes
/// the handler tokio reaps children through: every later `git` spawn then
/// waits forever, and `send_msg` holds the sessions lock across one, so one
/// tab opened made every session unsendable and unstoppable until restart.
/// Chromium clears the thread's signal mask in the same breath, so that is
/// put back too. A child exiting *during* `f` raised its signal into
/// `SIG_DFL`, where it was discarded — and its waiter may be the one holding
/// the sessions lock, so waiting for the next spawn's signal is not enough.
/// A synthetic one after the restore makes every tokio waiter re-check now.
fn keeping_signal<T>(signal: libc::c_int, f: impl FnOnce() -> T) -> T {
    let mut saved: libc::sigaction = unsafe { std::mem::zeroed() };
    let mut mask: libc::sigset_t = unsafe { std::mem::zeroed() };
    unsafe {
        libc::sigaction(signal, std::ptr::null(), &mut saved);
        libc::pthread_sigmask(libc::SIG_SETMASK, std::ptr::null(), &mut mask);
    }
    let out = f();
    unsafe {
        libc::sigaction(signal, &saved, std::ptr::null_mut());
        libc::pthread_sigmask(libc::SIG_SETMASK, &mask, std::ptr::null_mut());
        // `raise`, not `kill(getpid())`: it targets this thread and lands
        // before returning, where a process-directed one may go to another
        // thread later.
        libc::raise(signal);
    }
    out
}

#[cfg(test)]
mod signal_tests {
    use super::keeping_signal;
    use std::sync::atomic::{AtomicUsize, Ordering};

    static DELIVERED: AtomicUsize = AtomicUsize::new(0);

    extern "C" fn count(_: libc::c_int) {
        DELIVERED.fetch_add(1, Ordering::SeqCst);
    }

    fn action_of(signal: libc::c_int) -> libc::sigaction {
        let mut current: libc::sigaction = unsafe { std::mem::zeroed() };
        unsafe { libc::sigaction(signal, std::ptr::null(), &mut current) };
        current
    }

    fn blocked(signal: libc::c_int) -> bool {
        let mut mask: libc::sigset_t = unsafe { std::mem::zeroed() };
        unsafe { libc::pthread_sigmask(libc::SIG_SETMASK, std::ptr::null(), &mut mask) };
        unsafe { libc::sigismember(&mask, signal) == 1 }
    }

    /// SIGUSR2, not SIGCHLD: tests share one process, and a window on the
    /// real signal could strand a git test's child exiting at that moment.
    #[test]
    fn a_handler_reset_inside_is_put_back_and_kicked() {
        let before = action_of(libc::SIGUSR2);
        let mut ours: libc::sigaction = unsafe { std::mem::zeroed() };
        ours.sa_sigaction = count as extern "C" fn(libc::c_int) as libc::sighandler_t;
        unsafe { libc::sigaction(libc::SIGUSR2, &ours, std::ptr::null_mut()) };

        keeping_signal(libc::SIGUSR2, || {
            // What Chromium does: disposition to default, mask cleared. The
            // mask here goes the other way to prove it is restored, not
            // merely left empty.
            let dfl: libc::sigaction = unsafe { std::mem::zeroed() };
            let mut set: libc::sigset_t = unsafe { std::mem::zeroed() };
            unsafe {
                libc::sigaction(libc::SIGUSR2, &dfl, std::ptr::null_mut());
                libc::sigemptyset(&mut set);
                libc::sigaddset(&mut set, libc::SIGUSR2);
                libc::pthread_sigmask(libc::SIG_BLOCK, &set, std::ptr::null_mut());
            }
            assert_eq!(action_of(libc::SIGUSR2).sa_sigaction, libc::SIG_DFL);
            assert!(blocked(libc::SIGUSR2));
        });

        assert_eq!(action_of(libc::SIGUSR2).sa_sigaction, ours.sa_sigaction);
        assert!(!blocked(libc::SIGUSR2));
        assert_eq!(DELIVERED.load(Ordering::SeqCst), 1, "the synthetic signal reached the restored handler");

        unsafe { libc::sigaction(libc::SIGUSR2, &before, std::ptr::null_mut()) };
    }
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

/// Browsers asked for and not yet handed back by `on_after_created`. Creating
/// one leaves work Chromium never asks for again — measured: without the
/// pump's safety net, not one tab opened — so the net runs while any is out.
/// Counted rather than timed, since a create under load has no upper bound.
static CREATING: AtomicUsize = AtomicUsize::new(0);

/// Counts a browser creation in, and wakes the pump in case it is asleep with
/// nothing alive.
fn creation_started() {
    CREATING.fetch_add(1, Ordering::SeqCst);
    if let Some(tx) = PUMP.get() {
        let _ = tx.send(0);
    }
}

/// Counts one out: handed back, or refused before it began.
fn creation_ended() {
    let _ = CREATING.fetch_update(Ordering::SeqCst, Ordering::SeqCst, |n| n.checked_sub(1));
}

/// CEF asks for work through `on_schedule_message_pump_work(delay)`. A thread
/// holds the latest request — each one replaces the last, as that callback's
/// contract says — and runs `do_message_loop_work` on the main thread when it
/// comes due.
///
/// While a browser is alive or being made it also runs one 33ms after the
/// last, which is cefclient's own safety net: a work call stops at its time
/// slice without asking again for what it left. With no browser nothing left
/// over is anything the reader could see, so the thread sleeps until CEF asks
/// — once every few seconds, measured idle. It used to tick at 30Hz from the
/// first tab to quit, tabs or none.
fn start_pump(app: AppHandle) {
    const NET: Duration = Duration::from_millis(33);
    let (tx, rx) = mpsc::channel::<i64>();
    let _ = PUMP.set(tx);
    std::thread::Builder::new()
        .name("cef-pump".into())
        .spawn(move || {
            let mut due: Option<Instant> = None;
            let mut ran = Instant::now();
            loop {
                let live = CREATING.load(Ordering::SeqCst) > 0
                    || TABS.lock().unwrap().iter().any(|t| t.browser.is_some());
                let net = live.then(|| ran + NET);
                let wake = match (due, net) {
                    (Some(a), Some(b)) => Some(a.min(b)),
                    (a, b) => a.or(b),
                };
                let asked = match wake {
                    Some(at) => rx.recv_timeout(at.saturating_duration_since(Instant::now())),
                    None => rx.recv().map_err(|_| mpsc::RecvTimeoutError::Disconnected),
                };
                match asked {
                    Ok(delay) => {
                        // A delayed request replaces the pending one; an
                        // immediate one runs now, before a later request can
                        // replace it — cefclient does the same.
                        due = (delay > 0).then(|| Instant::now() + Duration::from_millis(delay as u64));
                        if due.is_some() {
                            continue;
                        }
                    }
                    // The net firing first leaves a later request standing.
                    Err(mpsc::RecvTimeoutError::Timeout) => due = due.filter(|at| *at > Instant::now()),
                    Err(mpsc::RecvTimeoutError::Disconnected) => return,
                }
                ran = Instant::now();
                let _ = app.run_on_main_thread(do_message_loop_work);
            }
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
        ///
        /// Occluded windows are not backgrounded: Chromium stops painting a
        /// page whose window is covered, and a `dray browser record` then
        /// records nothing — measured, zero frames with Dray behind another
        /// app. Recording is done while the reader is elsewhere, so that is
        /// the case that matters. Only the presented tab is affected; the
        /// others are hidden views and stay throttled.
        fn on_before_command_line_processing(&self, process_type: Option<&CefString>, command_line: Option<&mut CommandLine>) {
            let is_browser = process_type.map(|p| p.to_string().is_empty()).unwrap_or(true);
            let Some(command_line) = command_line.filter(|_| is_browser) else { return };
            command_line.append_switch(Some(&CefString::from("disable-backgrounding-occluded-windows")));
            if cfg!(debug_assertions) {
                command_line.append_switch(Some(&CefString::from("use-mock-keychain")));
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
            discarded: t.discarded,
            background: t.background.clone(),
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

/// A handle to call CEF on, with the lock already released. None for a tab
/// being discarded, whose browser is on its way out.
fn browser_of(id: i32) -> Option<Browser> {
    TABS.lock().unwrap().iter().find(|t| t.id == id && !t.discarded).and_then(|t| t.browser.clone())
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

/// Creates a browser for `session`, as tab `tab` when waking a discarded
/// one. Its tab appears in `on_after_created`, which is where CEF hands the
/// browser back. Main thread.
fn create_tab(session: &str, url: &str, activate: bool, tab: Option<i32>) -> Result<(), String> {
    // Before `ensure_started`, which remembers a failure for the life of the
    // process: a tab asked for mid-download must wait, not write CEF off.
    if paths().is_none() {
        return Err(crate::chromium::not_ready_reason());
    }
    if !ensure_started() {
        // Not started and nothing remembered: the framework went missing under
        // us, and the reason is whatever `chromium` says now.
        if STARTED.lock().unwrap().is_none() {
            return Err(crate::chromium::not_ready_reason());
        }
        return Err("Chromium could not start".into());
    }
    let info = child_window_info()?;
    let tab = tab.unwrap_or_else(|| NEXT_TAB.fetch_add(1, Ordering::SeqCst));
    let mut client = DrayClient::new(session.to_string(), activate, tab, None);
    let mut context = context_for(session);
    creation_started();
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
        creation_ended();
        Err("could not create the browser".into())
    }
}

/// The tab on screen: the presented session's active tab, while the pane
/// is visible. The only tab the reader counts as seeing.
fn shown_tab() -> Option<i32> {
    let presented = LAYOUT.lock().unwrap().clone();
    presented.filter(|(_, l)| l.visible).and_then(|(session, _)| active_id(&session))
}

/// Moves the presented session's active tab onto the frontend's rect and
/// hides every other tab's view, waking that tab first if it was discarded.
/// AppKit's y runs up from the bottom and the frontend's down from the top,
/// so the rect is flipped against the parent's height. Main thread only.
fn apply_layout() {
    let shown = shown_tab();
    if let Some(id) = shown {
        touch(id);
        wake(id);
    }
    let layout = LAYOUT.lock().unwrap().as_ref().map(|(_, l)| *l);
    let views: Vec<(i32, usize, Browser)> = TABS
        .lock()
        .unwrap()
        .iter()
        .filter(|t| t.view != 0)
        .filter_map(|t| Some((t.id, t.view, t.browser.clone()?)))
        .collect();
    let warm: Vec<i32> = {
        let mut warm = WARM.lock().unwrap();
        warm.retain(|w| views.iter().any(|(id, ..)| id == w));
        if let Some(id) = shown {
            warm.retain(|&w| w != id);
            warm.push_front(id);
            warm.truncate(WARM_TABS);
        }
        warm.iter().copied().collect()
    };
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
            round_foot(view);
            if let Some(host) = browser.host() {
                host.notify_move_or_resize_started();
            }
        }
        let parked = if show { None } else { automation::parked(id) };
        if !show && !view.isHidden() {
            refocus_webview(view);
        }
        if let Some((w, h)) = parked {
            view.setFrame(NSRect::new(NSPoint::new(-20000.0, 0.0), NSSize::new(w as f64, h as f64)));
            view.setHidden(false);
        } else if !show && warm.contains(&id) {
            // At its own size, so coming back is a move and never a relayout.
            let size = view.frame().size;
            view.setFrame(NSRect::new(NSPoint::new(-20000.0, 0.0), size));
            view.setHidden(false);
        } else {
            view.setHidden(!show);
        }
    }
}

/// The page sits at the foot of a rounded sheet, and being a native view it
/// draws over the DOM's own corners, which no CSS clip reaches. Its layer
/// takes the sheet's radius on the two bottom corners; the top sits under the
/// URL row and stays square.
fn round_foot(view: &NSView) {
    /// `kCALayerMinXMinYCorner | kCALayerMaxXMinYCorner`: the bottom two,
    /// since an `NSView`'s layer has its origin at the bottom.
    const BOTTOM: usize = 1 | 2;
    view.setWantsLayer(true);
    unsafe {
        let layer: *mut AnyObject = msg_send![view, layer];
        if layer.is_null() {
            return;
        }
        let _: () = msg_send![layer, setCornerRadius: 8.0f64];
        let _: () = msg_send![layer, setMaskedCorners: BOTTOM];
        let _: () = msg_send![layer, setMasksToBounds: Bool::YES];
    }
}

/// Marks a tab seen now.
fn touch(id: i32) {
    if let Some(t) = TABS.lock().unwrap().iter_mut().find(|t| t.id == id) {
        t.seen = Instant::now();
    }
}

/// Whether a tab is discarded and waiting to be woken. False while one is
/// still closing, so nothing wakes a browser that has not gone yet.
fn is_ghost(id: i32) -> bool {
    TABS.lock().unwrap().iter().any(|t| t.id == id && t.discarded && t.browser.is_none())
}

/// Makes a discarded tab's browser again on the URL it was left at, under
/// the same id. Its history and page state are gone, as in Chrome. Main
/// thread; a no-op on any other tab.
fn wake(id: i32) {
    let target = {
        let mut tabs = TABS.lock().unwrap();
        let Some(t) = tabs.iter_mut().find(|t| t.id == id && t.discarded && t.browser.is_none()) else { return };
        t.discarded = false;
        t.waking = true;
        t.loading = true;
        t.seen = Instant::now();
        (t.session.clone(), t.url.clone())
    };
    let (session, url) = target;
    let url = if url.is_empty() { "about:blank".to_string() } else { url };
    if let Err(e) = create_tab(&session, &url, false, Some(id)) {
        update_tab(id, |t| {
            t.discarded = true;
            t.waking = false;
            t.loading = false;
            t.error = Some(e);
        });
        return;
    }
    publish(&session);
}

/// Discards every tab not seen for `DISCARD_AFTER`: its browser is closed
/// and its entry kept, so the strip still draws it and opening it again
/// (`wake`) loads the URL afresh. CEF has no discard of its own — Chrome's
/// lives above the layer CEF exposes — so this is a close. Skipped: the tab
/// on screen, one still loading, one recording, picking, being driven or
/// mid-screenshot, and either half of a live popup pair. Main thread.
fn sweep() {
    if let Some(id) = shown_tab() {
        touch(id);
    }
    if automation::capturing() {
        return;
    }
    let candidates: Vec<(i32, String)> = {
        let tabs = TABS.lock().unwrap();
        // A pair is live while both halves are: a popup outliving its opener
        // is an ordinary tab, and an opener outliving its popup too.
        let ids: HashSet<i32> = tabs.iter().map(|t| t.id).collect();
        let openers: HashSet<i32> = tabs.iter().filter_map(|t| t.opener).collect();
        tabs.iter()
            .filter(|t| t.browser.is_some() && !t.discarded && !t.loading && !t.closing)
            .filter(|t| t.seen.elapsed() >= DISCARD_AFTER)
            .filter(|t| t.opener.map_or(true, |o| !ids.contains(&o)) && !openers.contains(&t.id))
            .map(|t| (t.id, t.session.clone()))
            .collect()
    };
    let picking = PICKING.lock().unwrap().clone().unwrap_or_default();
    let candidates: Vec<i32> = candidates
        .into_iter()
        .filter(|(id, session)| {
            !picking.contains(id) && automation::parked(*id).is_none() && !automation::driving(session)
        })
        .map(|(id, _)| id)
        .collect();
    let browsers: Vec<(i32, Browser)> = {
        let mut tabs = TABS.lock().unwrap();
        tabs.iter_mut()
            .filter(|t| candidates.contains(&t.id))
            .filter_map(|t| {
                t.discarded = true;
                Some((t.id, t.browser.clone()?))
            })
            .collect()
    };
    for (id, browser) in browsers {
        eprintln!("cef: discarding tab {id}, unseen for {}m", DISCARD_AFTER.as_secs() / 60);
        if let Some(host) = browser.host() {
            host.close_browser(1);
        }
    }
}

/// Hands focus back to the webview before a tab's view that holds it is
/// hidden. Hiding leaves the first responder inside the hidden view, and a
/// hidden widget drops every key — so ⌘E closed the panel and could not
/// reopen it until a click landed on the chat.
///
/// Only when the responder is inside *this* view: a `reveal`ed off-screen
/// tab being put back must not take focus off the presented page.
fn refocus_webview(from: &NSView) {
    let Some(window) = from.window() else { return };
    let holds = window
        .firstResponder()
        .and_then(|r| r.downcast_ref::<NSView>().map(|v| v.isDescendantOf(from)))
        .unwrap_or(false);
    if !holds {
        return;
    }
    let Some(parent) = (unsafe { from.superview() }) else { return };
    // By kind, not name: wry subclasses it as `WryWebView`.
    let Some(wk) = AnyClass::get(c"WKWebView") else { return };
    let subviews = parent.subviews();
    if let Some(webview) = subviews.iter().find(|v| v.isKindOfClass(wk)) {
        window.makeFirstResponder(Some(&**webview));
    }
}

/// Whether the first responder sits inside one of the session's tab views.
/// Main thread only.
fn browser_holds_focus(session: &str) -> bool {
    let views: Vec<usize> =
        TABS.lock().unwrap().iter().filter(|t| t.session == session && t.view != 0).map(|t| t.view).collect();
    views.into_iter().any(|view| {
        let view: &NSView = unsafe { &*(view as *const NSView) };
        view.window()
            .and_then(|w| w.firstResponder())
            .and_then(|r| r.downcast_ref::<NSView>().map(|v| v.isDescendantOf(view)))
            .unwrap_or(false)
    })
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
        tab: i32,
        opener: Option<i32>,
    }

    impl Client {
        fn life_span_handler(&self) -> Option<LifeSpanHandler> {
            Some(DrayLifeSpan::new(self.session.clone(), self.activate, self.tab, self.opener))
        }
        fn display_handler(&self) -> Option<DisplayHandler> {
            Some(DrayDisplay::new(self.tab))
        }
        fn load_handler(&self) -> Option<LoadHandler> {
            Some(DrayLoad::new(self.tab))
        }
        fn keyboard_handler(&self) -> Option<KeyboardHandler> {
            Some(DrayKeyboard::new())
        }
        fn focus_handler(&self) -> Option<FocusHandler> {
            Some(DrayFocus::new(self.session.clone()))
        }
    }
}

wrap_focus_handler! {
    struct DrayFocus {
        session: String,
    }

    impl FocusHandler {
        /// A load `dray browser` starts asks for focus, and granting it took
        /// the reader's keys out of the composer — into a hidden view, where
        /// they went nowhere. Navigation alone: the reader picking a tab asks
        /// as `SYSTEM`, and a load the page starts itself asks nothing
        /// (measured: a link click and `back` never reach here).
        fn on_set_focus(&self, _browser: Option<&mut Browser>, source: FocusSource) -> ::std::os::raw::c_int {
            (source == FocusSource::NAVIGATION && automation::driving(&self.session)) as ::std::os::raw::c_int
        }
    }
}

wrap_life_span_handler! {
    struct DrayLifeSpan {
        session: String,
        activate: bool,
        tab: i32,
        opener: Option<i32>,
    }

    impl LifeSpanHandler {
        fn on_after_created(&self, browser: Option<&mut Browser>) {
            let Some(browser) = browser.cloned() else { return };
            let id = self.tab;
            let view = browser.host().map(|h| h.window_handle() as usize).unwrap_or(0);
            let devtools = observe(&browser, id);
            // A woken tab already has its entry, and keeps its title and
            // favicon until the page says otherwise. Filled in place, never
            // pushed beside it, and `on_before_close` removes only the
            // browser instance it holds.
            let mut tabs = TABS.lock().unwrap();
            let doomed = match tabs.iter_mut().find(|t| t.id == id) {
                Some(slot) => {
                    slot.browser = Some(browser.clone());
                    slot._devtools = devtools;
                    slot.view = view;
                    slot.discarded = false;
                    slot.closing.then_some(browser)
                }
                None => {
                    let url = browser.main_frame().map(|f| CefString::from(&f.url()).to_string()).unwrap_or_default();
                    tabs.push(Tab {
                        id,
                        session: self.session.clone(),
                        browser: Some(browser),
                        _devtools: devtools,
                        view,
                        url,
                        title: String::new(),
                        favicon: String::new(),
                        background: None,
                        loading: true,
                        can_go_back: false,
                        can_go_forward: false,
                        error: None,
                        seen: Instant::now(),
                        discarded: false,
                        opener: self.opener,
                        waking: false,
                        closing: false,
                    });
                    None
                }
            };
            drop(tabs);
            // After the tab is in `TABS`, so the pump's net never lapses between.
            creation_ended();
            // Closed while it was being woken.
            if let Some(host) = doomed.and_then(|b| b.host()) {
                host.close_browser(1);
                return;
            }
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
            let tab = NEXT_TAB.fetch_add(1, Ordering::SeqCst);
            *client = Some(DrayClient::new(self.session.clone(), true, tab, Some(self.tab)));
            creation_started();
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
            let id = self.tab;
            // Only the instance on record leaves; a browser closing late must
            // not take its successor's entry. Compared with the lock
            // released, since `is_same` is a call into CEF.
            let stored = TABS.lock().unwrap().iter().find(|t| t.id == id).and_then(|t| t.browser.clone());
            let Some(stored) = stored else { return };
            if stored.is_same(Some(&mut closing)) == 0 {
                return;
            }
            automation::forget(id);
            disarm_picker(id);
            let session = self.session.clone();
            // A discarded tab keeps its entry; only the browser goes.
            let ghost = {
                let mut tabs = TABS.lock().unwrap();
                match tabs.iter_mut().find(|t| t.id == id && t.discarded && !t.closing) {
                    Some(t) => {
                        t.browser = None;
                        t._devtools = None;
                        t.view = 0;
                        t.loading = false;
                        true
                    }
                    None => false,
                }
            };
            if ghost {
                settle(&session);
            } else {
                remove_tab(&session, id);
            }
        }
    }
}

/// Takes a tab's entry out, for a close. The active tab passes to the last
/// one left.
fn remove_tab(session: &str, id: i32) {
    let remaining = {
        let mut tabs = TABS.lock().unwrap();
        tabs.retain(|t| t.id != id);
        tabs.iter().rev().find(|t| t.session == session).map(|t| t.id)
    };
    if active_id(session) == Some(id) {
        set_active(session, remaining);
    }
    settle(session);
}

/// After a tab's browser went: drops the session's profile once no tab of
/// it has a browser alive or coming, then redraws. The profile is what keeps
/// a closed session's memory around; the next tab makes a fresh one on the
/// same cache path, so cookies outlive it.
fn settle(session: &str) {
    let alive = TABS.lock().unwrap().iter().any(|t| t.session == session && (!t.discarded || t.browser.is_some()));
    if !alive {
        if let Some(map) = CONTEXTS.lock().unwrap().as_mut() {
            map.remove(session);
        }
    }
    apply_layout();
    publish(session);
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

/// The first entry of a list CEF lent a callback. Rebuilt from the `*mut` so
/// it is the crate's `BorrowedMut` shape, which iterates and frees nothing on
/// drop. `clone()` goes through `*const` into `Borrowed`, which copies the
/// zero-sized opaque struct and iterates as empty — every tab drew the globe.
fn first_string(list: &mut CefStringList) -> Option<String> {
    CefStringList::from(<*mut sys::_cef_string_list_t>::from(list)).into_iter().next()
}

#[cfg(test)]
mod string_list_tests {
    use super::*;

    /// Needs the framework loaded, found the way the build found it: `CEF_PATH`.
    fn load_framework() {
        use std::os::unix::ffi::OsStrExt;
        let dir = sys::get_cef_dir().expect("CEF not found").join(sys::FRAMEWORK_PATH);
        let path = std::ffi::CString::new(dir.canonicalize().unwrap().as_os_str().as_bytes()).unwrap();
        assert_eq!(unsafe { sys::cef_load_library(path.as_ptr().cast()) }, 1);
    }

    #[test]
    fn a_lent_list_reads_its_first_entry() {
        load_framework();
        let mut list = CefStringList::new();
        list.append("https://example.com/favicon.ico");
        list.append("https://example.com/icon.png");
        assert_eq!(first_string(&mut list).as_deref(), Some("https://example.com/favicon.ico"));
        // Still owned by `list`: the borrowed rebuild must not have freed it.
        assert_eq!(list.into_iter().count(), 2);
    }
}

wrap_display_handler! {
    struct DrayDisplay {
        tab: i32,
    }

    impl DisplayHandler {
        fn on_address_change(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, url: Option<&CefString>) {
            if !frame.map(|f| f.is_main() != 0).unwrap_or(false) {
                return;
            }
            let url = url.map(CefString::to_string).unwrap_or_default();
            update_tab(self.tab, |t| t.url = url);
        }
        fn on_title_change(&self, _browser: Option<&mut Browser>, title: Option<&CefString>) {
            let title = title.map(CefString::to_string).unwrap_or_default();
            update_tab(self.tab, |t| t.title = title);
        }

        fn on_favicon_urlchange(&self, _browser: Option<&mut Browser>, icon_urls: Option<&mut CefStringList>) {
            let first = icon_urls.and_then(first_string).unwrap_or_default();
            update_tab(self.tab, |t| t.favicon = first);
        }

        /// The element picker reports through the console — the one channel
        /// from page script back to here that needs no binding of its own.
        /// Its lines are swallowed; everything else passes through.
        fn on_console_message(
            &self,
            _browser: Option<&mut Browser>,
            level: LogSeverity,
            message: Option<&CefString>,
            _source: Option<&CefString>,
            _line: ::std::os::raw::c_int,
        ) -> ::std::os::raw::c_int {
            let text = message.map(CefString::to_string).unwrap_or_default();
            // Any page can log this too, and all it can do is colour its own
            // tab's URL row: three bytes, rebuilt here, never its own string.
            if let Some(rest) = text.strip_prefix(BG_PREFIX) {
                if let Ok([r, g, b]) = serde_json::from_str::<[u8; 3]>(rest) {
                    update_tab(self.tab, |t| t.background = Some(format!("rgb({r}, {g}, {b})")));
                }
                return 1;
            }
            let Some(rest) = text.strip_prefix(PICK_PREFIX) else {
                let error = sys::cef_log_severity_t::from(level) == sys::cef_log_severity_t::LOGSEVERITY_ERROR;
                automation::log(self.tab, error, text);
                return 0;
            };
            let id = self.tab;
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

const BG_PREFIX: &str = "__dray_bg__";

/// Reports the colour under the top edge of the page: the first opaque
/// background walking up from the element there, else the canvas default.
/// A 1px canvas normalises whatever CSS colour syntax the page used to rgb.
///
/// Installed once per document and re-read whenever the page could have
/// changed it: the system scheme flipping (a site following the app's light
/// or dark) or a class or style landing on `<html>`/`<body>` (a site's own
/// theme toggle). Only a changed answer is logged.
const BG_JS: &str = r#"(() => {
  if (window.__drayBg) return window.__drayBg();
  const c = document.createElement("canvas");
  c.width = c.height = 1;
  const x = c.getContext("2d", { willReadFrequently: true });
  const rgb = (v) => {
    x.clearRect(0, 0, 1, 1);
    x.fillStyle = "rgba(0,0,0,0)";
    x.fillStyle = v;
    x.fillRect(0, 0, 1, 1);
    const d = x.getImageData(0, 0, 1, 1).data;
    return d[3] > 200 ? [d[0], d[1], d[2]] : null;
  };
  const scheme = matchMedia("(prefers-color-scheme: dark)");
  let last = "";
  const report = () => {
    let found = null;
    for (let el = document.elementFromPoint(innerWidth / 2, 1); el && !found; el = el.parentElement)
      found = rgb(getComputedStyle(el).backgroundColor);
    const dark = scheme.matches && /dark/.test(getComputedStyle(document.documentElement).colorScheme);
    const next = JSON.stringify(found || (dark ? [18, 18, 18] : [255, 255, 255]));
    if (next === last) return;
    last = next;
    console.log("__dray_bg__" + next);
  };
  // Pages restyle a beat after the signal, and often through a transition.
  let timer = 0;
  const soon = () => {
    clearTimeout(timer);
    timer = setTimeout(report, 300);
  };
  scheme.addEventListener("change", soon);
  const watch = new MutationObserver(soon);
  const opts = { attributes: true, attributeFilter: ["class", "style", "data-theme", "data-mode"] };
  watch.observe(document.documentElement, opts);
  if (document.body) watch.observe(document.body, opts);
  window.__drayBg = report;
  report();
})();"#;

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
    struct DrayLoad {
        tab: i32,
    }

    impl LoadHandler {
        fn on_loading_state_change(&self, _browser: Option<&mut Browser>, is_loading: ::std::os::raw::c_int, can_go_back: ::std::os::raw::c_int, can_go_forward: ::std::os::raw::c_int) {
            update_tab(self.tab, |t| {
                t.loading = is_loading != 0;
                t.waking &= is_loading != 0;
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
        fn on_load_end(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, _http_status_code: ::std::os::raw::c_int) {
            let Some(frame) = frame.filter(|f| f.is_main() != 0) else { return };
            frame.execute_java_script(Some(&CefString::from(BG_JS)), None, 0);
        }

        fn on_load_start(&self, _browser: Option<&mut Browser>, frame: Option<&mut Frame>, _transition_type: TransitionType) {
            if !frame.map(|f| f.is_main() != 0).unwrap_or(false) {
                return;
            }
            disarm_picker(self.tab);
        }

        /// Chromium draws its own error page; this only records the reason
        /// for the tab strip. An aborted load is a navigation away, not an
        /// error.
        fn on_load_error(
            &self,
            _browser: Option<&mut Browser>,
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
            let text = error_text.map(CefString::to_string).unwrap_or_default();
            update_tab(self.tab, |t| t.error = Some(text));
        }
    }
}

/// Zoom on CEF's level scale, where 0 is 100% and a step is ×1.2.
fn zoom(browser: &Browser, action: &str) {
    let Some(host) = browser.host() else { return };
    let level = match action {
        "in" => (host.zoom_level() + 1.0).min(7.0),
        "out" => (host.zoom_level() - 1.0).max(-5.0),
        _ => 0.0,
    };
    host.set_zoom_level(level);
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

/// ⌘-chords the page keeps: editing, find, the location bar. Zoom, reload and
/// DevTools are the browser's and handled below, since CEF implements none
/// of Chrome's accelerators itself. Every other ⌘-chord is the app's — ⌘1,
/// ⌘B, ⌘E, ⌘N — and is handed back to the webview, since with Chromium's view
/// focused a key never reaches the document `useHotkey` listens on.
const PAGE_CHORDS: &[char] = &['c', 'v', 'x', 'a', 'z', 'f', 'l'];

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
                    'r' if plain => return { browser.reload(); 1 },
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
                        '[' | '{' => "BracketLeft",
                        ']' | '}' => "BracketRight",
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

// --- What `dray browser` reads ---------------------------------------------
//
// `automation.rs` reaches its tabs through these and nothing else; the
// headless backend answers the same names. See HEADLESS-PLAN.md.

wrap_dev_tools_message_observer! {
    struct DrayDevTools {
        tab: i32,
    }

    impl DevToolsMessageObserver {
        fn on_dev_tools_method_result(
            &self,
            _browser: Option<&mut Browser>,
            message_id: ::std::os::raw::c_int,
            success: ::std::os::raw::c_int,
            result: Option<&[u8]>,
        ) {
            let value = result
                .and_then(|bytes| serde_json::from_slice::<serde_json::Value>(bytes).ok())
                .unwrap_or(serde_json::Value::Null);
            let reply = if success != 0 {
                Ok(value)
            } else {
                Err(value
                    .get("message")
                    .and_then(serde_json::Value::as_str)
                    .unwrap_or("the page refused the command")
                    .to_string())
            };
            automation::answer(self.tab, message_id, reply);
        }
    }
}

/// Attach the observer to a browser the moment it exists; the registration
/// lives on the tab and ends with it.
fn observe(browser: &Browser, tab: i32) -> Option<Registration> {
    browser
        .host()
        .and_then(|host| host.add_dev_tools_message_observer(Some(&mut DrayDevTools::new(tab))))
}

/// CEF hands every browser its own DevTools channel; the reply comes back
/// through `DrayDevTools`.
fn send_cdp(tab: i32, id: i32, message: serde_json::Value) -> Result<(), String> {
    let message = message.to_string();
    on_main(move || {
        let sent = browser_of(tab)
            .and_then(|b| b.host())
            .map(|host| host.send_dev_tools_message(Some(message.as_bytes())) == 1)
            .unwrap_or(false);
        if !sent {
            automation::answer(tab, id, Err("that tab is gone".into()));
        }
    })
}

fn tab_state(tab: i32) -> Option<(String, String, bool)> {
    TABS.lock()
        .unwrap()
        .iter()
        .find(|t| t.id == tab)
        .map(|t| (t.url.clone(), t.title.clone(), t.loading))
}

/// Wakes a discarded tab and waits for its page, so a verb aimed at it acts
/// on a live one. The wake is asked for again each round: a tab still
/// closing when the verb arrived is not a ghost yet, and `wake` skips it.
async fn awake(tab: i32) -> Result<(), String> {
    let waking = TABS.lock().unwrap().iter().any(|t| t.id == tab && t.waking);
    if browser_of(tab).is_some() && !waking {
        return Ok(());
    }
    let start = Instant::now();
    while browser_of(tab).is_none() {
        if session_of(tab).is_none() {
            return Err(format!("tab {tab} closed"));
        }
        if start.elapsed() > automation::LOAD_TIMEOUT {
            return Err("Chromium did not reopen the discarded tab".into());
        }
        if is_ghost(tab) {
            on_main(move || wake(tab))?;
        }
        tokio::time::sleep(Duration::from_millis(50)).await;
    }
    automation::wait_loaded(tab).await
}

async fn open_url(session: &str, url: String, new_tab: bool) -> Result<(), String> {
    browser_open(session.to_string(), url, new_tab)
}

async fn nav(session: &str, verb: &str) -> Result<(), String> {
    browser_nav(session.to_string(), verb.to_string())
}

async fn close_tab(session: &str, id: i32) -> Result<(), String> {
    browser_close(session.to_string(), id)
}

async fn activate_tab(session: &str, id: i32) -> Result<(), String> {
    activate(session.to_string(), id, false)
}

/// Waited on, so a busy main thread cannot leave the zoom queued behind an
/// answer that already said it landed.
async fn set_zoom(tab: i32, percent: u32) -> Result<(), String> {
    let level = (percent as f64 / 100.0).ln() / 1.2f64.ln();
    let (tx, rx) = tokio::sync::oneshot::channel();
    on_main(move || {
        let host = browser_of(tab).and_then(|b| b.host());
        if let Some(host) = &host {
            host.set_zoom_level(level);
        }
        let _ = tx.send(host.is_some());
    })?;
    if !rx.await.unwrap_or(false) {
        return Err("that tab is gone".into());
    }
    Ok(())
}

/// Brings a tab's view out of hiding for an input verb; see `reveal`.
async fn reveal_for_input(tab: i32) -> Result<(), String> {
    on_main(move || reveal(tab))?;
    // The renderer learns it is visible a frame later.
    tokio::time::sleep(Duration::from_millis(80)).await;
    Ok(())
}

fn relayout() -> Result<(), String> {
    on_main(apply_layout)
}

fn emit(event: &str, payload: serde_json::Value) {
    if let Some(app) = APP.get() {
        let _ = app.emit(event, payload);
    }
}

/// The pane saying it has the page covered, so the reflow the capture needs
/// happens behind a still rather than on screen. Waited on rather than
/// guessed at: the cover is a page snapshot, an image decode and a layout
/// call, which is a few hundred milliseconds on a good day and not a number
/// worth hardcoding.
///
/// **An ack names the shot it is for, and a bare `Notify` was not enough.**
/// One shot can be acked twice — the pane answers at once when it has
/// nothing to cover, and the hide it asked for answers again when it lands
/// — so the extra notification sat as a stored permit and released the
/// *next* shot before its own still was painted, showing exactly the reflow
/// this hides. `SHUTTER_ACK` carries how far the pane has got, the `Notify`
/// only wakes the waiter to look, and a shot sleeps until the number
/// reaches its own. A late ack from a finished shot is then a number too
/// small to release anything.
static SHUTTER_READY: tokio::sync::Notify = tokio::sync::Notify::const_new();
/// The newest shot's number, minted per capture.
static SHUTTER_SHOT: AtomicU64 = AtomicU64::new(0);
/// The newest shot the pane has answered for. Monotonic, so a repeated ack
/// for one shot is the same answer twice rather than a second one.
static SHUTTER_ACK: AtomicU64 = AtomicU64::new(0);
/// True from the shutter opening until the override goes on — the window in
/// which the page still reads the way the reader sees it, and the one thing
/// that lets the pane's cover picture past `CAPTURING`.
static SHUTTER_OPEN: AtomicBool = AtomicBool::new(false);
/// How long to wait for that. A pane with no browser on screen answers at
/// once; this is for one that never answers at all, where giving up and
/// shooting anyway is exactly what the verb did before it covered anything.
const SHUTTER: Duration = Duration::from_millis(700);

/// Opens the pane's shutter and waits until the page is covered, answering
/// the shot's number.
async fn cover(session: &str) -> u64 {
    // Numbered before the event goes out, so an ack cannot name a shot that
    // does not exist yet; `await_shutter` reads the mark before it waits, so
    // one arriving early is not missed either.
    let shot = SHUTTER_SHOT.fetch_add(1, Ordering::AcqRel) + 1;
    SHUTTER_OPEN.store(true, Ordering::Release);
    automation::emit_shooting(session, true, shot);
    await_shutter(shot).await;
    // The hide has run, but a hidden view leaves the window on its next frame
    // — so the page is given one before it is asked to reflow into a widget
    // that may still be composited.
    tokio::time::sleep(automation::SETTLE).await;
    // Closed before the override, never after: past here the page stops being
    // the one on screen, so a cover taken from it would be a picture of the
    // very reflow being hidden.
    SHUTTER_OPEN.store(false, Ordering::Release);
    shot
}

/// Hands the view back once the page has repainted at the pane's size. It
/// has not painted it yet when the override comes off, and handing the view
/// over inside that window puts the capture's layout on screen for a frame —
/// the reflow, arriving at the end. The still is holding the pane meanwhile,
/// so this costs nothing anybody can see.
async fn uncover(session: &str, shot: u64) {
    tokio::time::sleep(automation::SETTLE).await;
    automation::emit_shooting(session, false, shot);
}

/// Lets the shot numbered `shot` through. See `browser_shutter_ready`.
/// `fetch_max`, so an ack that arrives after a later shot has been answered
/// for cannot walk the mark backwards, and `notify_waiters` rather than
/// `notify_one`, which would leave a permit behind for a shot nobody has
/// taken yet — the bug this numbering exists to close.
fn shutter_ready(shot: u64) {
    SHUTTER_ACK.fetch_max(shot, Ordering::Release);
    SHUTTER_READY.notify_waiters();
}

/// Waits until the pane has answered for `shot`, or `SHUTTER` passes. The
/// registration is re-made around every check, or an ack landing between
/// reading the mark and awaiting would be missed and the shot would sit out
/// the whole timeout.
async fn await_shutter(shot: u64) {
    let _ = tokio::time::timeout(SHUTTER, async {
        loop {
            let mut waiting = Box::pin(SHUTTER_READY.notified());
            waiting.as_mut().enable();
            if SHUTTER_ACK.load(Ordering::Acquire) >= shot {
                return;
            }
            waiting.await;
        }
    })
    .await;
}

// --- Commands --------------------------------------------------------------

/// Which session is on screen and where, in CSS pixels from the window's
/// top-left. `visible: false` hides every tab.
#[tauri::command]
pub fn browser_layout(session_id: String, x: f64, y: f64, width: f64, height: f64, visible: bool) -> Result<(), String> {
    *LAYOUT.lock().unwrap() = Some((session_id, Layout { x, y, width, height, visible }));
    on_main(apply_layout)
}

/// The pane reporting that the page is covered and shot `shot` may proceed
/// — the still is painted and the view is off screen, or there was nothing
/// of this session's page on screen to cover. Answering late is safe,
/// answering twice is safe, and answering never costs that shot its
/// timeout and nothing else; `shot` is what buys all three.
///
/// **Queued on the main thread, and that is the whole of it being true.**
/// `browser_layout` hands `apply_layout` to `run_on_main_thread` and returns
/// at once, so the pane's own "the hide landed" is really "the hide was
/// asked for" — it acked, the override went on, and the reader watched the
/// page reflow in a view still on screen. The main thread runs what it is
/// given in order, so arriving *here* means that hide has actually run.
#[tauri::command]
pub fn browser_shutter_ready(shot: u64) {
    let _ = on_main(move || shutter_ready(shot));
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
        let _ = tx.send(create_tab(&session_id, &url, true, None));
    })?;
    rx.recv_timeout(Duration::from_secs(10)).map_err(|_| "Chromium did not answer".to_string())?
}

#[tauri::command]
pub fn browser_tabs(session_id: String) -> Vec<TabInfo> {
    tabs_of(&session_id)
}

#[tauri::command]
pub fn browser_activate(session_id: String, id: i32) -> Result<(), String> {
    activate(session_id, id, true)
}

/// Makes `id` the session's active tab. `focus` is the reader's pick: an
/// agent's `tab <id>` must not take keys out of the composer, but focus
/// follows the switch where the reader was already typing in a page.
pub(crate) fn activate(session_id: String, id: i32, focus: bool) -> Result<(), String> {
    on_main(move || {
        if session_of(id).as_deref() != Some(session_id.as_str()) {
            return;
        }
        let focus = focus || browser_holds_focus(&session_id);
        set_active(&session_id, Some(id));
        apply_layout();
        if let Some(host) = browser_of(id).and_then(|b| b.host()).filter(|_| focus) {
            host.set_focus(1);
        }
        publish(&session_id);
    })
}

/// Moves a tab to place `to` among its session's tabs, for drag-to-reorder,
/// and answers with the new order. Off the main thread, since it touches no
/// browser; `dray browser`'s tab list follows, both reading this order.
#[tauri::command]
pub fn browser_move(session_id: String, id: i32, to: usize) -> Vec<TabInfo> {
    {
        let mut tabs = TABS.lock().unwrap();
        if let Some(from) = tabs.iter().position(|t| t.id == id && t.session == session_id) {
            move_among(&mut tabs, from, to, |t| t.session == session_id);
        }
    }
    // One snapshot for both the event and the reply, so the two never disagree
    // about the order.
    let tabs = tabs_of(&session_id);
    if let Some(app) = APP.get() {
        let _ = app.emit(
            "browser_tabs",
            TabsEvent { session_id: session_id.clone(), tabs: tabs.clone() },
        );
    }
    tabs
}

/// Moves `v[from]` to place `to` among the items `mine` picks, leaving every
/// other item where it is — `TABS` holds every session's tabs in one list.
fn move_among<T>(v: &mut Vec<T>, from: usize, to: usize, mine: impl Fn(&T) -> bool) {
    let item = v.remove(from);
    let places: Vec<usize> = (0..v.len()).filter(|&i| mine(&v[i])).collect();
    let at = match places.get(to) {
        Some(&i) => i,
        None => places.last().map_or(from, |&i| i + 1),
    };
    v.insert(at, item);
}

#[cfg(test)]
mod tests {
    use super::move_among;

    #[test]
    fn moves_within_one_session_only() {
        // a/b are two sessions interleaved in one list.
        let mut v = vec!["a1", "b1", "a2", "b2", "a3"];
        let a = |t: &&str| t.starts_with('a');
        move_among(&mut v, 0, 2, a);
        assert_eq!(v, ["b1", "a2", "b2", "a3", "a1"]);
        move_among(&mut v, 4, 0, a);
        assert_eq!(v, ["b1", "a1", "a2", "b2", "a3"]);
        move_among(&mut v, 1, 1, a);
        assert_eq!(v, ["b1", "a2", "b2", "a1", "a3"]);
        let mut solo = vec!["a1"];
        move_among(&mut solo, 0, 0, a);
        assert_eq!(solo, ["a1"]);
    }
}

/// Closes one tab. The rest happens in `on_before_close`, or here for a
/// discarded tab, which has no browser to close.
#[tauri::command]
pub fn browser_close(session_id: String, id: i32) -> Result<(), String> {
    on_main(move || {
        if session_of(id).as_deref() != Some(session_id.as_str()) {
            return;
        }
        let ghost = {
            let mut tabs = TABS.lock().unwrap();
            let Some(t) = tabs.iter_mut().find(|t| t.id == id) else { return };
            t.closing = true;
            t.discarded && t.browser.is_none()
        };
        if ghost {
            remove_tab(&session_id, id);
        } else if let Some(host) = browser_of(id).and_then(|b| b.host()) {
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
    automation::drop_recording(session_id);
    let session_id = session_id.to_string();
    let _ = on_main(move || {
        let browsers: Vec<Browser> = {
            let mut tabs = TABS.lock().unwrap();
            // Discarded tabs have no browser to close and go now; one mid-wake
            // is closed by `on_after_created` on seeing `closing`.
            for t in tabs.iter_mut().filter(|t| t.session == session_id) {
                t.closing = true;
            }
            tabs.retain(|t| t.session != session_id || !t.discarded || t.browser.is_some());
            tabs.iter().filter(|t| t.session == session_id).filter_map(|t| t.browser.clone()).collect()
        };
        if browsers.is_empty() {
            set_active(&session_id, None);
            publish(&session_id);
        }
        for host in browsers.iter().filter_map(|b| b.host()) {
            host.close_browser(1);
        }
    });
}

/// The active tab as the pane sees it, for drawing in its place while the
/// native view is hidden under a modal. No metrics override: the picture
/// must match the widget's own size, or it is drawn stretched. The view
/// hides only once this lands, so the whole cost is a modal opening late
/// over the page: one CSS pixel per image pixel (a quarter of retina) and
/// a fast JPEG, since the picture lives as long as a menu is open. An
/// agent's sized screenshot holding `CAPTURING` would hand back a
/// phone-wide page, so this waits for it — briefly, since the pane gives
/// up on the answer at 400ms and a full-page capture can run for seconds;
/// past that the pane hides over nothing, as it did before. The tab is read
/// after the wait, so the picture is of the tab up when it is taken.
#[tauri::command]
pub async fn browser_snapshot(session_id: String) -> Result<String, String> {
    // Not while the shutter is open, and that exception is the whole reason
    // a shot can be covered by the page rather than by a blank. The lock is
    // held for the length of a shot, so a cover asked for inside one would
    // be refused — and the cover is what the shot hides behind. Safe
    // precisely there: the shutter opens *before* the override goes on, so
    // the page this reads is the one the reader is looking at.
    let _held = if SHUTTER_OPEN.load(Ordering::Acquire) {
        None
    } else {
        Some(
            tokio::time::timeout(Duration::from_millis(300), automation::CAPTURING.lock())
                .await
                .map_err(|_| "a screenshot is in progress")?,
        )
    };
    let tab = automation::active_tab(&session_id)?;
    // `innerWidth`, not the layout viewport's `clientWidth`: that one stops
    // at the scrollbar, and a picture a scrollbar short of the view is
    // stretched across it. The clip is in page coordinates, hence the
    // scroll offset from the metrics.
    let size = automation::eval(tab, "({ w: innerWidth, h: innerHeight })").await?;
    let metrics = automation::cdp(tab, "Page.getLayoutMetrics", serde_json::json!({})).await?;
    let vp = &metrics["cssVisualViewport"];
    let clip = serde_json::json!({
        "x": vp["pageX"], "y": vp["pageY"],
        "width": size["w"], "height": size["h"],
        "scale": 1,
    });
    let params = serde_json::json!({ "format": "jpeg", "quality": 60, "optimizeForSpeed": true, "clip": clip });
    let reply = automation::cdp(tab, "Page.captureScreenshot", params).await?;
    let data = reply["data"].as_str().ok_or("no image came back")?;
    Ok(format!("data:image/jpeg;base64,{data}"))
}

