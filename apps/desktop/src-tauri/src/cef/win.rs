//! A tab's view on Windows: the child `HWND` CEF makes inside the main
//! window, moved, shown and hidden here through user32. The Mac's `NSView`
//! calls in `cef.rs` have one counterpart each below.
//!
//! **Every tab is a direct child of the main window**, a sibling of wry's
//! WebView2 container and raised above it on every placement, so split panes
//! work as on the Mac: one window per pane. Coordinates arrive in CSS pixels
//! and leave in physical ones, scaled by the window's DPI.
//!
//! **Z-order alone does not put a tab on top.** WebView2 presents through
//! DirectComposition and painted over the sibling above it — measured: the
//! tab placed, visible and first in z-order, and the pane white. The webview's
//! windows take `WS_CLIPSIBLINGS` (`clip_webview`), which leaves the tab's
//! rect to the tab.
//!
//! **libcef.dll is delay-loaded** (`/DELAYLOAD` in build.rs). Linked
//! normally it is an import the loader resolves before `main`, and a machine
//! without the download could not start Dray at all. `load` maps it from
//! wherever it lives before the first `cef_*` call, and the delay-load helper
//! then finds it already in the process by name.
//!
//! Main thread only: CEF's UI thread is the main thread under the external
//! pump, and a window may only be destroyed by the thread that made it.

use super::APP;
use std::ffi::c_void;
use std::os::windows::ffi::OsStrExt;
use std::path::Path;
use tauri::Manager;
use windows_sys::Win32::Foundation::HWND;
use windows_sys::Win32::System::LibraryLoader::{LoadLibraryExW, LOAD_WITH_ALTERED_SEARCH_PATH};
use windows_sys::Win32::UI::Input::KeyboardAndMouse::{GetFocus, SetFocus};
use windows_sys::Win32::UI::WindowsAndMessaging::{
    DestroyWindow, FindWindowExW, GetWindow, GetWindowLongPtrW, IsChild, IsWindow, IsWindowVisible,
    SetWindowLongPtrW, SetWindowPos, ShowWindow, GWL_STYLE, GW_CHILD, GW_HWNDNEXT, HWND_TOP, SWP_FRAMECHANGED,
    SWP_NOACTIVATE, SWP_NOMOVE, SWP_NOSIZE, SWP_NOZORDER, SW_HIDE, SW_SHOWNA, WS_CLIPSIBLINGS,
};

/// Off the window's left edge, where the Mac parks a view.
const PARKED_X: i32 = -20000;

/// Maps libcef.dll from `dir`. `LOAD_WITH_ALTERED_SEARCH_PATH` finds its own
/// imports (`chrome_elf.dll`) beside it rather than beside Dray. Once per
/// process; the library is never freed.
pub fn load(dir: &Path) -> Result<(), String> {
    let path = dir.join("libcef.dll");
    let wide: Vec<u16> = path.as_os_str().encode_wide().chain(Some(0)).collect();
    let module = unsafe { LoadLibraryExW(wide.as_ptr(), std::ptr::null_mut(), LOAD_WITH_ALTERED_SEARCH_PATH) };
    if module.is_null() {
        return Err(format!("could not load {}: {}", path.display(), std::io::Error::last_os_error()));
    }
    Ok(())
}

fn hwnd(view: usize) -> HWND {
    view as *mut c_void
}

/// The main window's `HWND` and its scale factor.
fn host() -> Option<(HWND, f64)> {
    let window = APP.get()?.get_webview_window("main")?;
    let handle = window.hwnd().ok()?;
    Some((handle.0 as HWND, window.scale_factor().unwrap_or(1.0)))
}

fn px(points: f64, scale: f64) -> i32 {
    (points * scale).round() as i32
}

/// The window tabs are made in, and a size in CSS pixels turned into physical
/// ones: `(parent, width, height)`.
pub(super) fn parent_and_size(width: f64, height: f64) -> Option<(usize, i32, i32)> {
    let (parent, scale) = host()?;
    Some((parent as usize, px(width, scale).max(1), px(height, scale).max(1)))
}

/// Puts a tab's window on a rect in CSS pixels, above the webview.
pub(super) fn place(view: usize, x: f64, y: f64, width: f64, height: f64) {
    let Some((parent, s)) = host() else { return };
    clip_webview(parent);
    unsafe {
        SetWindowPos(hwnd(view), HWND_TOP, px(x, s), px(y, s), px(width, s).max(1), px(height, s).max(1), SWP_NOACTIVATE);
    }
}

/// Gives wry's container and the windows WebView2 made in it
/// `WS_CLIPSIBLINGS`, so a tab above them shows. A check per placement, since
/// WebView2 can make its window again.
fn clip_webview(parent: HWND) {
    let class: Vec<u16> = "WRY_WEBVIEW".encode_utf16().chain(Some(0)).collect();
    let container = unsafe { FindWindowExW(parent, std::ptr::null_mut(), class.as_ptr(), std::ptr::null()) };
    if container.is_null() {
        return;
    }
    let mut window = container;
    let mut child = unsafe { GetWindow(container, GW_CHILD) };
    loop {
        let style = unsafe { GetWindowLongPtrW(window, GWL_STYLE) };
        if style & WS_CLIPSIBLINGS as isize == 0 {
            unsafe {
                SetWindowLongPtrW(window, GWL_STYLE, style | WS_CLIPSIBLINGS as isize);
                SetWindowPos(
                    window,
                    std::ptr::null_mut(),
                    0,
                    0,
                    0,
                    0,
                    SWP_NOMOVE | SWP_NOSIZE | SWP_NOZORDER | SWP_NOACTIVATE | SWP_FRAMECHANGED,
                );
            }
        }
        if child.is_null() {
            break;
        }
        window = child;
        child = unsafe { GetWindow(child, GW_HWNDNEXT) };
    }
}

/// Moves a tab's window off the left edge, keeping its size unless one is
/// given in CSS pixels: the Mac's park at x = -20000.
pub(super) fn park(view: usize, size: Option<(u32, u32)>) {
    unsafe {
        match size {
            Some((w, h)) => {
                let s = host().map_or(1.0, |(_, s)| s);
                SetWindowPos(
                    hwnd(view),
                    std::ptr::null_mut(),
                    PARKED_X,
                    0,
                    px(w as f64, s).max(1),
                    px(h as f64, s).max(1),
                    SWP_NOACTIVATE | SWP_NOZORDER,
                );
            }
            None => {
                SetWindowPos(hwnd(view), std::ptr::null_mut(), PARKED_X, 0, 0, 0, SWP_NOACTIVATE | SWP_NOZORDER | SWP_NOSIZE);
            }
        }
    }
}

/// Whether the window is hidden. One that is gone reads as hidden, so
/// nothing tries to show it.
pub(super) fn is_hidden(view: usize) -> bool {
    unsafe { IsWindow(hwnd(view)) == 0 || IsWindowVisible(hwnd(view)) == 0 }
}

/// Shows or hides a tab's window, never activating it. Hidden, Chromium marks
/// the widget hidden and stops painting it, as it does for a hidden `NSView`.
pub(super) fn set_hidden(view: usize, hidden: bool) {
    unsafe { ShowWindow(hwnd(view), if hidden { SW_HIDE } else { SW_SHOWNA }) };
}

/// Whether keyboard focus sits in `view` or a window under it: Chromium
/// focuses a child of the window CEF hands back, never that window itself.
pub(super) fn holds_focus(view: usize) -> bool {
    let focus = unsafe { GetFocus() };
    !focus.is_null() && (focus == hwnd(view) || unsafe { IsChild(hwnd(view), focus) } != 0)
}

/// Hands focus back to the webview before a tab's window that holds it is
/// hidden or destroyed. Focus left in a hidden window stays there, where no
/// chord reaches the document until a click — the trap `refocus_webview`
/// closes on the Mac.
pub(super) fn refocus_webview(view: usize) {
    if !holds_focus(view) {
        return;
    }
    let Some(window) = APP.get().and_then(|app| app.get_webview_window("main")) else {
        if let Some((parent, _)) = host() {
            unsafe { SetFocus(parent) };
        }
        return;
    };
    // The webview's own focus, which WebView2 moves into its document; the
    // window's would raise the window and leave focus where it was.
    let _ = AsRef::<tauri::Webview>::as_ref(&window).set_focus();
}

/// Destroys a tab's window. CEF reads the window going as the browser's,
/// which is what lets `on_before_close` follow a `do_close` answered `1` —
/// the counterpart of the Mac's `removeFromSuperview`.
pub(super) fn destroy(view: usize) {
    refocus_webview(view);
    unsafe { DestroyWindow(hwnd(view)) };
}
