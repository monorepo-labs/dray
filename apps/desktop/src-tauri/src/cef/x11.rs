//! A tab's view on Linux: the X11 window CEF makes as a child of the main
//! window's, moved, shown and hidden here through Xlib. The Mac's `NSView`
//! calls in `cef.rs` have one counterpart each below.
//!
//! **X11 alone.** CEF's Linux windowed host parents into an X window id and
//! nothing else, which is why `main.rs` forces GDK onto X11 (XWayland on a
//! Wayland desktop) and Chromium is told `ozone-platform=x11` too.
//!
//! Every call goes through GDK's own Xlib connection inside an error trap.
//! A tab's window can be gone by the time a call lands — CEF destroys it on
//! close — and GDK's default handler answers an unexpected `BadWindow` by
//! ending the process.
//!
//! Main thread only, like every GTK call.

use super::APP;
use gtk::prelude::*;
use std::os::raw::{c_int, c_uint, c_ulong};
use tauri::Manager;
use x11::xlib;

/// Where tabs live: the main window's X window, and where its webview sits
/// inside it in X pixels.
struct Host {
    gdk: gdkx11::X11Display,
    display: *mut xlib::Display,
    window: xlib::Window,
    origin: (i32, i32),
    scale: f64,
}

fn host() -> Option<Host> {
    let window = APP.get()?.get_webview_window("main")?;
    let gtk_window = window.gtk_window().ok()?;
    let gdk_window = gtk_window.window()?;
    let gdk = gdk_window.display().downcast::<gdkx11::X11Display>().ok()?;
    let xwindow = gdk_window.downcast::<gdkx11::X11Window>().ok()?.xid();
    let display = unsafe { gdkx11::ffi::gdk_x11_display_get_xdisplay(gdk.as_ptr()) };
    // The webview fills the box tao puts in the window; with client-side
    // decorations the box is inset by the shadow, which this carries.
    let scale = gtk_window.scale_factor().max(1);
    let origin = window.default_vbox().map(|b| b.allocation()).map(|a| (a.x(), a.y())).unwrap_or((0, 0));
    Some(Host {
        gdk,
        display,
        window: xwindow,
        origin: (origin.0 * scale, origin.1 * scale),
        scale: scale as f64,
    })
}

/// Runs `f` on the display inside GDK's error trap, then flushes, so the
/// change reaches the server before Chromium's own connection acts on it.
fn with_display<T>(f: impl FnOnce(&Host) -> T) -> Option<T> {
    let host = host()?;
    host.gdk.error_trap_push();
    let out = f(&host);
    unsafe { xlib::XFlush(host.display) };
    host.gdk.error_trap_pop_ignored();
    Some(out)
}

/// The main window's X id, and a rect in window points turned into X pixels
/// inside it: `(parent, x, y, width, height)`.
pub(super) fn parent_and_rect(x: f64, y: f64, width: f64, height: f64) -> Option<(c_ulong, i32, i32, i32, i32)> {
    let host = host()?;
    let s = host.scale;
    Some((
        host.window,
        host.origin.0 + (x * s).round() as i32,
        host.origin.1 + (y * s).round() as i32,
        ((width * s).round() as i32).max(1),
        ((height * s).round() as i32).max(1),
    ))
}

/// Moves and sizes a tab's window to a rect in window points.
pub(super) fn place(view: usize, x: f64, y: f64, width: f64, height: f64) {
    with_display(|h| unsafe {
        let s = h.scale;
        xlib::XMoveResizeWindow(
            h.display,
            view as xlib::Window,
            h.origin.0 + (x * s).round() as c_int,
            h.origin.1 + (y * s).round() as c_int,
            ((width * s).round() as c_uint).max(1),
            ((height * s).round() as c_uint).max(1),
        );
    });
}

/// Moves a tab's window off-screen, keeping its size unless one is given in
/// X pixels: the Mac's park at x = -20000.
pub(super) fn park(view: usize, size: Option<(u32, u32)>) {
    with_display(|h| unsafe {
        match size {
            Some((w, hgt)) => {
                xlib::XMoveResizeWindow(h.display, view as xlib::Window, -20000, 0, w.max(1), hgt.max(1));
            }
            None => {
                xlib::XMoveWindow(h.display, view as xlib::Window, -20000, 0);
            }
        }
    });
}

/// The window's size in X pixels, `None` if it is gone.
pub(super) fn size(view: usize) -> Option<(u32, u32)> {
    attributes(view).map(|a| (a.width.max(0) as u32, a.height.max(0) as u32))
}

/// Whether the window is unmapped, which is the X11 reading of `isHidden`.
/// A window that is gone reads as hidden, so nothing tries to show it.
pub(super) fn is_hidden(view: usize) -> bool {
    attributes(view).map_or(true, |a| a.map_state == xlib::IsUnmapped)
}

fn attributes(view: usize) -> Option<xlib::XWindowAttributes> {
    with_display(|h| unsafe {
        let mut attrs: xlib::XWindowAttributes = std::mem::zeroed();
        (xlib::XGetWindowAttributes(h.display, view as xlib::Window, &mut attrs) != 0).then_some(attrs)
    })
    .flatten()
}

/// Maps or unmaps a tab's window. Unmapped, Chromium marks the widget
/// hidden and stops painting it, as it does for a hidden `NSView`.
pub(super) fn set_hidden(view: usize, hidden: bool) {
    with_display(|h| unsafe {
        if hidden {
            xlib::XUnmapWindow(h.display, view as xlib::Window);
        } else {
            xlib::XMapWindow(h.display, view as xlib::Window);
        }
    });
}

/// Whether X's input focus sits in `view` or a window under it — Chromium
/// focuses a child of the window CEF hands back, never that window itself.
pub(super) fn holds_focus(view: usize) -> bool {
    with_display(|h| unsafe {
        let mut focus: xlib::Window = 0;
        let mut revert: c_int = 0;
        xlib::XGetInputFocus(h.display, &mut focus, &mut revert);
        is_within(h.display, focus, view as xlib::Window)
    })
    .unwrap_or(false)
}

/// Walks `window`'s parents up to the root, looking for `ancestor`.
unsafe fn is_within(display: *mut xlib::Display, mut window: xlib::Window, ancestor: xlib::Window) -> bool {
    // `PointerRoot` and `None` are 1 and 0, neither a real window.
    for _ in 0..32 {
        if window <= 1 {
            return false;
        }
        if window == ancestor {
            return true;
        }
        let (mut root, mut parent) = (0, 0);
        let mut children: *mut xlib::Window = std::ptr::null_mut();
        let mut count: c_uint = 0;
        if xlib::XQueryTree(display, window, &mut root, &mut parent, &mut children, &mut count) == 0 {
            return false;
        }
        if !children.is_null() {
            xlib::XFree(children.cast());
        }
        if parent == root {
            return false;
        }
        window = parent;
    }
    false
}

/// Hands focus back to the main window before a tab's window that holds it
/// is hidden or destroyed. Focus left in an unmapped window reverts to its
/// parent's parent at best, and at worst to nothing, where no chord reaches
/// the webview until a click — the same trap `refocus_webview` closes on
/// the Mac. GTK keeps its own focus widget, the webview, under the toplevel,
/// so focusing the toplevel is enough.
pub(super) fn refocus_webview(view: usize) {
    if !holds_focus(view) {
        return;
    }
    with_display(|h| unsafe {
        xlib::XSetInputFocus(h.display, h.window, xlib::RevertToParent, xlib::CurrentTime);
    });
}

/// Destroys a tab's window. CEF reads the `DestroyNotify` as the browser's
/// window going, which is what lets `on_before_close` follow a `do_close`
/// answered `1` — the counterpart of the Mac's `removeFromSuperview`.
pub(super) fn destroy(view: usize) {
    refocus_webview(view);
    with_display(|h| unsafe {
        xlib::XDestroyWindow(h.display, view as xlib::Window);
    });
}
