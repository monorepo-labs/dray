//! What the island needs from X beyond GPUI's window: the modifier tap, the
//! work area the panel sits inside, and keyboard focus for a window the
//! window manager does not manage.

use crate::prefs::{self, Key};
use std::collections::HashMap;
use std::sync::OnceLock;
use std::time::{Duration, Instant};
use x11rb::connection::Connection;
use x11rb::protocol::Event;
use x11rb::protocol::xinput::{self, KeyEventFlags, XIEventMask};
use x11rb::protocol::xproto::{AtomEnum, ConnectionExt as _, InputFocus};
use x11rb::rust_connection::RustConnection;

/// The Mac's window for a tap: down and up within it, nothing pressed between.
const TAP: Duration = Duration::from_millis(400);

/// XIAllMasterDevices: every keyboard and pointer the reader has, as one.
const ALL_MASTER: u16 = 1;

/// Watches for the reader's modifier tapped alone and calls `on_tap` from the
/// watch's own thread. Raw XI2 events on the root window, as #710's click
/// watch reads them: they reach every client whoever has focus, and grab
/// nothing, so no other app loses a key to the island. A key or a click
/// between down and up rules the tap out, which is what keeps Ctrl+C and a
/// Ctrl-click from opening the panel.
pub fn watch_taps(on_tap: impl Fn() + Send + 'static, on_capture: impl Fn() + Send + 'static, on_shift: impl Fn(bool) + Send + 'static) {
    std::thread::Builder::new()
        .name("island-taps".into())
        .spawn(move || {
            if let Err(err) = run_taps(on_tap, on_capture, on_shift) {
                eprintln!("island: no modifier tap: {err}");
            }
        })
        .expect("tap thread");
}

/// The screenshot key: Super+Shift+2, the Mac's ⌘⇧2 with ⌘ read as Super, as
/// the tap key's Command is. Grabbed for the island's life, as the Mac holds
/// its hot key, with Caps Lock and Num Lock either way.
fn grab_capture_key(conn: &RustConnection, root: u32, keysyms: &Keysyms) -> Option<u8> {
    use x11rb::protocol::xproto::{GrabMode, ModMask};
    let code = keysyms.code_of(0x32)?;
    for extra in [ModMask::from(0u16), ModMask::LOCK, ModMask::M2, ModMask::LOCK | ModMask::M2] {
        let mods = ModMask::M4 | ModMask::SHIFT | extra;
        let _ = conn.grab_key(false, root, mods, code, GrabMode::ASYNC, GrabMode::ASYNC);
    }
    Some(code)
}

fn run_taps(on_tap: impl Fn(), on_capture: impl Fn(), on_shift: impl Fn(bool)) -> anyhow::Result<()> {
    // A connection of its own: the loop below blocks on it.
    let (conn, screen) = x11rb::connect(None)?;
    let root = conn.setup().roots[screen].root;
    let version = xinput::xi_query_version(&conn, 2, 2)?.reply()?;
    anyhow::ensure!(
        (version.major_version, version.minor_version) >= (2, 1),
        "the X server speaks XInput {}.{}, and raw events need 2.1",
        version.major_version,
        version.minor_version
    );
    let mask = XIEventMask::RAW_KEY_PRESS
        | XIEventMask::RAW_KEY_RELEASE
        | XIEventMask::RAW_BUTTON_PRESS
        | XIEventMask::RAW_BUTTON_RELEASE;
    xinput::xi_select_events(&conn, root, &[xinput::EventMask { deviceid: ALL_MASTER, mask: vec![mask] }])?;
    conn.flush()?;
    let mut keysyms = Keysyms::read(&conn)?;
    let mut capture_code = grab_capture_key(&conn, root, &keysyms);
    conn.flush()?;
    let mut tap = Tap::default();
    let mut pen = Pen::default();
    // The prefs file is read only for a modifier, never for every key typed.
    let ours = |keysyms: &Keysyms, code: u32| keysyms.of(code).is_some_and(|sym| is_key(sym, None) && is_key(sym, Some(prefs::read().key)));
    loop {
        match conn.wait_for_event()? {
            Event::XinputRawKeyPress(e) => {
                let repeat = u32::from(e.flags) & u32::from(KeyEventFlags::KEY_REPEAT) != 0;
                tap.press(e.detail, ours(&keysyms, e.detail), repeat, Instant::now());
                if let Some(armed) = pen.press(e.detail, keysyms.of(e.detail)) {
                    on_shift(armed);
                }
            }
            Event::XinputRawKeyRelease(e) => {
                if tap.release(e.detail, ours(&keysyms, e.detail), Instant::now()) {
                    on_tap();
                }
                if let Some(armed) = pen.release(e.detail) {
                    on_shift(armed);
                }
            }
            // While our own grab holds the keyboard the server sends its
            // keys to us as core events and skips our raw listener, so the
            // chord's releases arrive here or never, and a Shift held stale
            // would stop every tap for half a minute.
            Event::KeyPress(e) => {
                let code = u32::from(e.detail);
                tap.press(code, ours(&keysyms, code), false, Instant::now());
                if let Some(armed) = pen.press(code, keysyms.of(code)) {
                    on_shift(armed);
                }
                if Some(e.detail) == capture_code {
                    on_capture();
                }
            }
            Event::KeyRelease(e) => {
                let code = u32::from(e.detail);
                if tap.release(code, ours(&keysyms, code), Instant::now()) {
                    on_tap();
                }
                if let Some(armed) = pen.release(code) {
                    on_shift(armed);
                }
            }
            Event::XinputRawButtonPress(e) => tap.button(e.detail, true, Instant::now()),
            Event::XinputRawButtonRelease(e) => tap.button(e.detail, false, Instant::now()),
            Event::MappingNotify(_) => {
                keysyms = Keysyms::read(&conn)?;
                capture_code = grab_capture_key(&conn, root, &keysyms);
                conn.flush()?;
            }
            _ => {}
        }
    }
}

/// Whether Shift alone is held, which arms the pen while dictating: any
/// other modifier with it is a chord and draws nothing. Answers a change.
#[derive(Default)]
struct Pen {
    shift: HashMap<u32, ()>,
    others: HashMap<u32, ()>,
    armed: bool,
}

impl Pen {
    fn press(&mut self, code: u32, sym: Option<u32>) -> Option<bool> {
        match sym {
            Some(0xffe1 | 0xffe2) => {
                self.shift.insert(code, ());
            }
            Some(s) if is_key(s, None) => {
                self.others.insert(code, ());
            }
            _ => {}
        }
        self.settle()
    }

    fn release(&mut self, code: u32) -> Option<bool> {
        self.shift.remove(&code);
        self.others.remove(&code);
        self.settle()
    }

    fn settle(&mut self) -> Option<bool> {
        let armed = !self.shift.is_empty() && self.others.is_empty();
        (armed != self.armed).then(|| {
            self.armed = armed;
            armed
        })
    }
}

/// A key held longer than this is taken to have been released unseen, so one
/// lost release can never stop every tap after it.
const STALE: Duration = Duration::from_secs(30);

/// One tap's progress: when the reader's key went down, and every key and
/// button held, so the key pressed while Shift or a drag is already down is a
/// chord and no tap.
#[derive(Default)]
struct Tap {
    down: Option<Instant>,
    held: HashMap<u32, (bool, Instant)>,
    buttons: HashMap<u32, Instant>,
}

impl Tap {
    fn press(&mut self, code: u32, ours: bool, repeat: bool, at: Instant) {
        if repeat {
            return;
        }
        self.held.retain(|_, (_, since)| at.duration_since(*since) < STALE);
        self.buttons.retain(|_, since| at.duration_since(*since) < STALE);
        // Left then right of the same key keeps the first down's time.
        let alone = self.buttons.is_empty() && self.held.values().all(|(ours, _)| *ours);
        self.held.insert(code, (ours, at));
        self.down = if ours && alone { self.down.or(Some(at)) } else { None };
    }

    /// Whether this release ends a tap.
    fn release(&mut self, code: u32, ours: bool, at: Instant) -> bool {
        self.held.remove(&code);
        if !ours {
            self.down = None;
            return false;
        }
        self.down.take().is_some_and(|down| at.duration_since(down) < TAP)
    }

    /// A press or release of a pointer button; a press rules the tap out.
    fn button(&mut self, button: u32, pressed: bool, at: Instant) {
        if pressed {
            self.down = None;
            self.buttons.insert(button, at);
        } else {
            self.buttons.remove(&button);
        }
    }
}

/// Left and right of each, as XKB names them. Alt's Shift level is Meta on
/// most layouts, which a bare tap never reaches. `None` asks for any of the three.
fn is_key(sym: u32, key: Option<Key>) -> bool {
    const CONTROL: [u32; 2] = [0xffe3, 0xffe4];
    const ALT: [u32; 2] = [0xffe9, 0xffea];
    const SUPER: [u32; 2] = [0xffeb, 0xffec];
    match key {
        Some(Key::Control) => CONTROL.contains(&sym),
        Some(Key::Option) => ALT.contains(&sym),
        Some(Key::Command) => SUPER.contains(&sym),
        None => [CONTROL, ALT, SUPER].iter().any(|syms| syms.contains(&sym)),
    }
}

/// The keyboard's first keysym per keycode, which is the unshifted one.
struct Keysyms {
    first: u8,
    per: u8,
    syms: Vec<u32>,
}

impl Keysyms {
    fn read(conn: &RustConnection) -> anyhow::Result<Self> {
        let setup = conn.setup();
        let (first, last) = (setup.min_keycode, setup.max_keycode);
        let reply = conn.get_keyboard_mapping(first, last - first + 1)?.reply()?;
        Ok(Self { first, per: reply.keysyms_per_keycode, syms: reply.keysyms })
    }

    /// The keycode whose unshifted keysym is `sym`.
    fn code_of(&self, sym: u32) -> Option<u8> {
        let per = self.per.max(1) as usize;
        self.syms.chunks(per).position(|c| c.first() == Some(&sym)).map(|i| self.first + i as u8)
    }

    fn of(&self, keycode: u32) -> Option<u32> {
        let index = (keycode.checked_sub(self.first as u32)? as usize) * self.per as usize;
        self.syms.get(index).copied()
    }
}

/// The main thread's connection, for the calls below.
fn conn() -> Option<&'static (RustConnection, usize)> {
    static CONN: OnceLock<Option<(RustConnection, usize)>> = OnceLock::new();
    CONN.get_or_init(|| x11rb::connect(None).ok()).as_ref()
}

/// The root window's work area in X pixels: the screen less the panels and
/// docks that reserve an edge. The whole screen where the window manager
/// publishes none.
pub fn work_area() -> Option<(i32, i32, i32, i32)> {
    let (conn, screen) = conn()?;
    let root = &conn.setup().roots[*screen];
    let whole = (0, 0, root.width_in_pixels as i32, root.height_in_pixels as i32);
    let atom = conn.intern_atom(true, b"_NET_WORKAREA").ok()?.reply().ok()?.atom;
    if atom == 0 {
        return Some(whole);
    }
    let reply = conn
        .get_property(false, root.root, atom, AtomEnum::CARDINAL, 0, 4)
        .ok()?
        .reply()
        .ok()?;
    match reply.value32().map(|v| v.collect::<Vec<_>>()) {
        Some(v) if v.len() == 4 => Some((v[0] as i32, v[1] as i32, v[2] as i32, v[3] as i32)),
        _ => Some(whole),
    }
}

/// The root window's width in X pixels, against which GPUI's logical
/// display width gives the scale.
pub fn screen_width() -> Option<i32> {
    let (conn, screen) = conn()?;
    Some(conn.setup().roots[*screen].width_in_pixels as i32)
}

/// Whether a compositor runs, which is what makes a window's clear pixels
/// clear: EWMH has it own the `_NET_WM_CM_S<screen>` selection. Without one
/// they draw black, so the island draws square and opaque instead.
pub fn compositing() -> bool {
    let Some((conn, screen)) = conn() else { return false };
    let name = format!("_NET_WM_CM_S{screen}");
    let Some(atom) = conn.intern_atom(false, name.as_bytes()).ok().and_then(|c| c.reply().ok()).map(|r| r.atom) else {
        return false;
    };
    conn.get_selection_owner(atom).ok().and_then(|c| c.reply().ok()).is_some_and(|r| r.owner != x11rb::NONE)
}

/// The screen's pixels in `rect` (X pixels), as RGBA, read off the root
/// window. With a compositor this is the composited screen, our own windows
/// included, so the island hides or clears them first where that matters.
pub fn capture(x: i32, y: i32, width: u32, height: u32) -> Option<image::RgbaImage> {
    use x11rb::protocol::xproto::ImageFormat;
    let (conn, screen) = conn()?;
    let root = &conn.setup().roots[*screen];
    let reply = conn
        .get_image(ImageFormat::Z_PIXMAP, root.root, x as i16, y as i16, width as u16, height as u16, !0)
        .ok()?
        .reply()
        .ok()?;
    // 24-bit depth arrives as 32 bits a pixel, BGRx, on every server we meet.
    if reply.data.len() < (width * height * 4) as usize {
        return None;
    }
    let rgba: Vec<u8> = reply.data.chunks_exact(4).take((width * height) as usize).flat_map(|p| [p[2], p[1], p[0], 255]).collect();
    image::RgbaImage::from_raw(width, height, rgba)
}

/// The root window's size in X pixels.
pub fn screen_size() -> Option<(u32, u32)> {
    let (conn, screen) = conn()?;
    let root = &conn.setup().roots[*screen];
    Some((root.width_in_pixels as u32, root.height_in_pixels as u32))
}

/// Lets the mouse through `window`, or stops letting it through: an empty
/// input region passes every click to whatever is beneath, so the page under
/// the ink still scrolls and clicks until the pen is armed.
pub fn pass_mouse(window: u32, through: bool) {
    use x11rb::protocol::shape::{self, SK, SO};
    use x11rb::protocol::xproto::{ClipOrdering, Rectangle};
    let Some((conn, _)) = conn() else { return };
    let region: &[Rectangle] = if through { &[] } else { &[Rectangle { x: 0, y: 0, width: u16::MAX, height: u16::MAX }] };
    let _ = shape::rectangles(conn, SO::SET, SK::INPUT, ClipOrdering::UNSORTED, window, 0, 0, region);
    let _ = conn.flush();
}

/// Takes a window of ours off the screen for a moment, as a read of the
/// screen must not see it, or puts it back.
pub fn unmap(window: u32) {
    let Some((conn, _)) = conn() else { return };
    let _ = conn.unmap_window(window);
    let _ = conn.flush();
}

pub fn map(window: u32) {
    let Some((conn, _)) = conn() else { return };
    let _ = conn.map_window(window);
    let _ = conn.flush();
}

/// Hands the keyboard back to `window`, whoever holds it now.
pub fn refocus(window: u32) {
    let Some((conn, _)) = conn() else { return };
    if window == x11rb::NONE || window == u32::from(InputFocus::POINTER_ROOT) {
        return;
    }
    let _ = conn.set_input_focus(InputFocus::PARENT, window, x11rb::CURRENT_TIME);
    let _ = conn.flush();
}

/// Whether Shift alone is down right now, read off the pointer's modifier
/// state: the pen may be armed before the microphone opened.
pub fn shift_alone() -> bool {
    use x11rb::protocol::xproto::KeyButMask;
    let Some((conn, screen)) = conn() else { return false };
    let root = conn.setup().roots[*screen].root;
    let Some(reply) = conn.query_pointer(root).ok().and_then(|c| c.reply().ok()) else { return false };
    let mods = u16::from(reply.mask);
    let shift = u16::from(KeyButMask::SHIFT);
    let others = u16::from(KeyButMask::CONTROL) | u16::from(KeyButMask::MOD1) | u16::from(KeyButMask::MOD4);
    mods & shift != 0 && mods & others == 0
}

/// Puts `window` over every other window of ours: the panel over a capture's
/// overlay, so dictation stays in sight and in reach.
pub fn raise(window: u32) {
    use x11rb::protocol::xproto::{ConfigureWindowAux, StackMode};
    let Some((conn, _)) = conn() else { return };
    let _ = conn.configure_window(window, &ConfigureWindowAux::new().stack_mode(StackMode::ABOVE));
    let _ = conn.flush();
}

/// Moves and sizes a window of ours in X pixels. GPUI has no move for a
/// window it made, and reads the `ConfigureNotify` this causes as its new
/// bounds; the panel is override-redirect, so nothing second-guesses it.
pub fn configure(window: u32, x: i32, y: i32, width: i32, height: i32) {
    use x11rb::protocol::xproto::ConfigureWindowAux;
    let Some((conn, _)) = conn() else { return };
    let aux = ConfigureWindowAux::new().x(x).y(y).width(width.max(1) as u32).height(height.max(1) as u32);
    let _ = conn.configure_window(window, &aux);
    let _ = conn.flush();
}

/// Whether Dray's own window is the one in front, which sounds its own
/// notice, so the island's chime would double it. Read off the window
/// manager's `_NET_ACTIVE_WINDOW` and that window's `WM_CLASS`.
pub fn dray_in_front() -> bool {
    let Some((conn, screen)) = conn() else { return false };
    let root = conn.setup().roots[*screen].root;
    let atom = |name: &[u8]| conn.intern_atom(true, name).ok()?.reply().ok().map(|r| r.atom).filter(|a| *a != 0);
    let Some(active) = atom(b"_NET_ACTIVE_WINDOW") else { return false };
    let Some(window) = conn
        .get_property(false, root, active, AtomEnum::WINDOW, 0, 1)
        .ok()
        .and_then(|c| c.reply().ok())
        .and_then(|r| r.value32()?.next())
        .filter(|w| *w != 0)
    else {
        return false;
    };
    let class = conn
        .get_property(false, window, AtomEnum::WM_CLASS, AtomEnum::STRING, 0, 64)
        .ok()
        .and_then(|c| c.reply().ok())
        .map(|r| String::from_utf8_lossy(&r.value).to_lowercase())
        .unwrap_or_default();
    is_dray_class(&class)
}

/// `WM_CLASS` is instance and class, NUL-separated; Tauri names both after
/// the binary, `dray`.
fn is_dray_class(class: &str) -> bool {
    class.split('\0').any(|part| part == "dray" || part == "dray dev")
}

/// The window holding the keyboard.
pub fn focus() -> Option<u32> {
    let (conn, _) = conn()?;
    Some(conn.get_input_focus().ok()?.reply().ok()?.focus)
}

/// Gives `window` the keyboard and answers whoever had it. The panel is
/// override-redirect, so no window manager will ever focus it, and
/// `_NET_ACTIVE_WINDOW` (what GPUI's `activate` sends) is ignored for it.
pub fn take_focus(window: u32) -> Option<u32> {
    let (conn, _) = conn()?;
    let before = conn.get_input_focus().ok()?.reply().ok()?.focus;
    conn.set_input_focus(InputFocus::PARENT, window, x11rb::CURRENT_TIME).ok()?;
    conn.flush().ok()?;
    Some(before)
}

/// Hands the keyboard back to the window that had it before the panel took
/// it — only while the panel still holds it: a reader who clicked into another
/// app meanwhile keeps that app. Where the old window has gone, X answers an
/// error and the window manager picks the focus on its own.
pub fn give_back(ours: u32, window: u32) {
    let Some((conn, _)) = conn() else { return };
    if window == x11rb::NONE || window == u32::from(InputFocus::POINTER_ROOT) {
        return;
    }
    let holding = conn
        .get_input_focus()
        .ok()
        .and_then(|cookie| cookie.reply().ok())
        .is_some_and(|reply| reply.focus == ours);
    if !holding {
        return;
    }
    let _ = conn.set_input_focus(InputFocus::PARENT, window, x11rb::CURRENT_TIME);
    let _ = conn.flush();
}

#[cfg(test)]
mod tests {
    use super::*;

    fn after(start: Instant, ms: u64) -> Instant {
        start + Duration::from_millis(ms)
    }

    const CTRL: u32 = 37;
    const SHIFT: u32 = 50;
    const C: u32 = 54;

    #[test]
    fn a_quick_bare_press_is_a_tap() {
        let (mut tap, t) = (Tap::default(), Instant::now());
        tap.press(CTRL, true, false, t);
        assert!(tap.release(CTRL, true, after(t, 120)));
    }

    #[test]
    fn a_hold_is_no_tap() {
        let (mut tap, t) = (Tap::default(), Instant::now());
        tap.press(CTRL, true, false, t);
        assert!(!tap.release(CTRL, true, after(t, 600)));
    }

    #[test]
    fn a_chord_is_no_tap() {
        let (mut tap, t) = (Tap::default(), Instant::now());
        tap.press(CTRL, true, false, t);
        tap.press(C, false, false, after(t, 50));
        tap.release(C, false, after(t, 80));
        assert!(!tap.release(CTRL, true, after(t, 100)));
    }

    #[test]
    fn a_key_already_held_makes_a_chord() {
        let (mut tap, t) = (Tap::default(), Instant::now());
        tap.press(SHIFT, false, false, t);
        tap.press(CTRL, true, false, after(t, 50));
        assert!(!tap.release(CTRL, true, after(t, 100)));
    }

    #[test]
    fn a_key_held_past_stale_is_forgotten() {
        let (mut tap, t) = (Tap::default(), Instant::now());
        tap.press(SHIFT, false, false, t);
        tap.press(CTRL, true, false, after(t, 31_000));
        assert!(tap.release(CTRL, true, after(t, 31_100)));
    }

    #[test]
    fn a_click_between_is_no_tap() {
        let (mut tap, t) = (Tap::default(), Instant::now());
        tap.press(CTRL, true, false, t);
        tap.button(1, true, after(t, 50));
        tap.button(1, false, after(t, 80));
        assert!(!tap.release(CTRL, true, after(t, 100)));
    }

    #[test]
    fn a_button_already_held_makes_a_chord() {
        let (mut tap, t) = (Tap::default(), Instant::now());
        tap.button(1, true, t);
        tap.press(CTRL, true, false, after(t, 50));
        assert!(!tap.release(CTRL, true, after(t, 100)));
        tap.button(1, false, after(t, 150));
        tap.press(CTRL, true, false, after(t, 200));
        assert!(tap.release(CTRL, true, after(t, 250)));
    }

    #[test]
    fn key_repeat_keeps_the_first_down() {
        let (mut tap, t) = (Tap::default(), Instant::now());
        tap.press(CTRL, true, false, t);
        tap.press(CTRL, true, true, after(t, 500));
        assert!(!tap.release(CTRL, true, after(t, 550)));
    }

    #[test]
    fn a_release_with_nothing_down_is_no_tap() {
        let mut tap = Tap::default();
        assert!(!tap.release(CTRL, true, Instant::now()));
    }

    #[test]
    fn each_pick_names_its_own_keys() {
        assert!(is_key(0xffe3, Some(Key::Control)));
        assert!(!is_key(0xffe3, Some(Key::Option)));
        assert!(is_key(0xffea, Some(Key::Option)));
        assert!(is_key(0xffec, Some(Key::Command)));
        assert!(is_key(0xffe9, None));
        assert!(!is_key(0x61, None));
    }
}
