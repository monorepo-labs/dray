//! A tab's view on Linux: the X11 window CEF makes as a child of the main
//! window's, moved, shown and hidden here through Xlib. The Mac's `NSView`
//! calls in `cef.rs` have one counterpart each below.
//!
//! **X11 alone.** CEF's Linux windowed host parents into an X window id and
//! nothing else, which is why `main.rs` forces GDK onto X11 (XWayland on a
//! Wayland desktop) and Chromium is told `ozone-platform=x11` too.
//!
//! **Tabs live in a frame of ours, not in the main window itself.** tao gives
//! that window a 32-bit ARGB visual, transparent or not, and CEF creates its
//! window at the default depth with no colormap — which X refuses with
//! `BadMatch`, so CEF handed back the id of a window that never existed.
//! The frame is a 24-bit child of the main window with a colormap of its
//! own; it sits on the pane's rect and every tab fills it, while a tab not
//! on screen is parked off its edge as on the Mac.
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
use std::sync::atomic::{AtomicU64, Ordering};
use tauri::Manager;
use x11::xlib;

/// The frame every tab is parented into, made on first use and kept for the
/// app's life. 0 until then.
static FRAME: AtomicU64 = AtomicU64::new(0);

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

/// The frame tabs are made in, and a size in window points turned into X
/// pixels: `(frame, width, height)`.
pub(super) fn frame_and_size(width: f64, height: f64) -> Option<(c_ulong, i32, i32)> {
    let frame = with_display(frame)??;
    let s = host()?.scale;
    Some((frame, ((width * s).round() as i32).max(1), ((height * s).round() as i32).max(1)))
}

/// The frame, made now if it is not yet: 24-bit TrueColor, its own colormap
/// and border pixel (both required once the visual differs from the
/// parent's), no background so a tab switch paints nothing in between.
/// Mapped from the start and stowed off-screen until a tab is shown.
fn frame(h: &Host) -> Option<c_ulong> {
    let made = FRAME.load(Ordering::Relaxed);
    if made != 0 {
        return Some(made);
    }
    unsafe {
        let screen = xlib::XDefaultScreen(h.display);
        let mut info: xlib::XVisualInfo = std::mem::zeroed();
        if xlib::XMatchVisualInfo(h.display, screen, 24, xlib::TrueColor, &mut info) == 0 {
            return None;
        }
        let root = xlib::XRootWindow(h.display, screen);
        let mut attrs: xlib::XSetWindowAttributes = std::mem::zeroed();
        attrs.colormap = xlib::XCreateColormap(h.display, root, info.visual, xlib::AllocNone);
        attrs.border_pixel = 0;
        attrs.background_pixmap = 0;
        let frame = xlib::XCreateWindow(
            h.display,
            h.window,
            -20000,
            0,
            800,
            600,
            0,
            24,
            xlib::InputOutput as c_uint,
            info.visual,
            xlib::CWColormap | xlib::CWBorderPixel | xlib::CWBackPixmap,
            &mut attrs,
        );
        if frame == 0 {
            return None;
        }
        xlib::XMapWindow(h.display, frame);
        FRAME.store(frame, Ordering::Relaxed);
        Some(frame)
    }
}

/// Puts the frame on a rect in window points and fills it with the tab.
pub(super) fn place(view: usize, x: f64, y: f64, width: f64, height: f64) {
    with_display(|h| unsafe {
        let Some(frame) = frame(h) else { return };
        let s = h.scale;
        let (w, hgt) = (((width * s).round() as c_uint).max(1), ((height * s).round() as c_uint).max(1));
        xlib::XMoveResizeWindow(
            h.display,
            frame,
            h.origin.0 + (x * s).round() as c_int,
            h.origin.1 + (y * s).round() as c_int,
            w,
            hgt,
        );
        xlib::XMoveResizeWindow(h.display, view as xlib::Window, 0, 0, w, hgt);
    });
}

/// Takes the frame off the main window when no tab is on screen. Moved, not
/// unmapped, so a tab parked inside it for a recording stays viewable.
pub(super) fn stow() {
    with_display(|h| unsafe {
        let made = FRAME.load(Ordering::Relaxed);
        if made != 0 {
            xlib::XMoveWindow(h.display, made, -20000, 0);
        }
    });
}

/// Moves a tab's window off the frame's edge, keeping its size unless one is
/// given in X pixels: the Mac's park at x = -20000.
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

/// Where a mouse button went down, as far as keyboard focus cares.
pub(super) enum Pressed {
    /// On the page.
    Page,
    /// Somewhere else in the main window.
    App,
    /// In another app.
    Elsewhere,
}

/// Calls `on_press` on the main thread after every left, middle or right
/// button press anywhere on the display. Started once.
///
/// **This is click-to-focus, and nobody else provides it.** A tab's window
/// is a child of a foreign window, so a click on the page never moves X's
/// input focus — the window manager focuses top-level windows alone, and
/// Chromium asks it for nothing (watched: no `_NET_ACTIVE_WINDOW` on a
/// click). Keys then went on landing in the webview, and the reverse held
/// once the page had them: clicking the composer left them in the page.
/// CEF's own GTK sample moves focus from the host the same way. Raw XI2
/// events because they reach every client whoever holds the button's
/// selection — Chromium does, and only one client may — and grab nothing,
/// so a stalled main loop can never freeze the pointer.
pub(super) fn watch_presses(on_press: fn()) {
    std::thread::Builder::new()
        .name("cef-x11-presses".into())
        .spawn(move || unsafe {
            use x11::xinput2 as xi;
            // A connection of its own: GDK's belongs to the main thread.
            let display = xlib::XOpenDisplay(std::ptr::null());
            if display.is_null() {
                eprintln!("cef: no X display to watch clicks on");
                return;
            }
            let (mut opcode, mut event, mut error) = (0, 0, 0);
            if xlib::XQueryExtension(display, c"XInputExtension".as_ptr(), &mut opcode, &mut event, &mut error) == 0 {
                eprintln!("cef: no XInput2, so a click on the page will not take the keyboard");
                return;
            }
            let mut bits = [0u8; 4];
            bits[(xi::XI_RawButtonPress / 8) as usize] |= 1 << (xi::XI_RawButtonPress % 8);
            let mut mask = xi::XIEventMask {
                deviceid: xi::XIAllMasterDevices,
                mask_len: bits.len() as c_int,
                mask: bits.as_mut_ptr(),
            };
            xi::XISelectEvents(display, xlib::XDefaultRootWindow(display), &mut mask, 1);
            xlib::XFlush(display);
            loop {
                let mut ev: xlib::XEvent = std::mem::zeroed();
                xlib::XNextEvent(display, &mut ev);
                let mut cookie = ev.generic_event_cookie;
                if cookie.type_ != xlib::GenericEvent || cookie.extension != opcode {
                    continue;
                }
                if xlib::XGetEventData(display, &mut cookie) == 0 {
                    continue;
                }
                // 1–3 alone: 4–7 are the wheel, and scrolling over the page
                // must not take the keyboard from the composer.
                let pressed = cookie.evtype == xi::XI_RawButtonPress
                    && (1..=3).contains(&(*(cookie.data as *const xi::XIRawEvent)).detail);
                xlib::XFreeEventData(display, &mut cookie);
                if pressed {
                    let _ = super::on_main(on_press);
                }
            }
        })
        .expect("cef click thread");
}

/// What lies under the pointer now: walked down from the root to the
/// deepest window, then placed against the frame and the main window.
pub(super) fn under_pointer() -> Pressed {
    with_display(|h| unsafe {
        let frame = FRAME.load(Ordering::Relaxed);
        let mut window = xlib::XDefaultRootWindow(h.display);
        loop {
            let (mut root, mut child) = (0, 0);
            let (mut rx, mut ry, mut x, mut y, mut mask) = (0, 0, 0, 0, 0);
            if xlib::XQueryPointer(h.display, window, &mut root, &mut child, &mut rx, &mut ry, &mut x, &mut y, &mut mask) == 0
                || child == 0
            {
                break;
            }
            window = child;
        }
        if frame != 0 && is_within(h.display, window, frame) {
            Pressed::Page
        } else if is_within(h.display, window, h.window) {
            Pressed::App
        } else {
            Pressed::Elsewhere
        }
    })
    .unwrap_or(Pressed::Elsewhere)
}

/// Gives X's input focus to a tab's window. CEF reads the `FocusIn` and
/// passes it to Chromium's own window under it; the host's `set_focus`
/// alone moves nothing on X11.
pub(super) fn focus_page(view: usize) {
    with_display(|h| unsafe {
        xlib::XSetInputFocus(h.display, view as xlib::Window, xlib::RevertToParent, xlib::CurrentTime);
    });
}

/// Gives X's input focus to the main window, from wherever it is.
pub(super) fn focus_app() {
    with_display(|h| unsafe {
        xlib::XSetInputFocus(h.display, h.window, xlib::RevertToParent, xlib::CurrentTime);
    });
}
