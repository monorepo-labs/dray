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
pub fn watch_taps(on_tap: impl Fn() + Send + 'static) {
    std::thread::Builder::new()
        .name("island-taps".into())
        .spawn(move || {
            if let Err(err) = run_taps(on_tap) {
                eprintln!("island: no modifier tap: {err}");
            }
        })
        .expect("tap thread");
}

fn run_taps(on_tap: impl Fn()) -> anyhow::Result<()> {
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
    let mask = XIEventMask::RAW_KEY_PRESS | XIEventMask::RAW_KEY_RELEASE | XIEventMask::RAW_BUTTON_PRESS;
    xinput::xi_select_events(&conn, root, &[xinput::EventMask { deviceid: ALL_MASTER, mask: vec![mask] }])?;
    conn.flush()?;
    let mut keysyms = Keysyms::read(&conn)?;
    let mut tap = Tap::default();
    // The prefs file is read only for a modifier, never for every key typed.
    let ours = |keysyms: &Keysyms, code: u32| keysyms.of(code).is_some_and(|sym| is_key(sym, None) && is_key(sym, Some(prefs::read().key)));
    loop {
        match conn.wait_for_event()? {
            Event::XinputRawKeyPress(e) => {
                let repeat = u32::from(e.flags) & u32::from(KeyEventFlags::KEY_REPEAT) != 0;
                tap.press(e.detail, ours(&keysyms, e.detail), repeat, Instant::now());
            }
            Event::XinputRawKeyRelease(e) => {
                if tap.release(e.detail, ours(&keysyms, e.detail), Instant::now()) {
                    on_tap();
                }
            }
            Event::XinputRawButtonPress(_) => tap.click(),
            Event::MappingNotify(_) => keysyms = Keysyms::read(&conn)?,
            _ => {}
        }
    }
}

/// A key held longer than this is taken to have been released unseen, so one
/// lost release can never stop every tap after it.
const STALE: Duration = Duration::from_secs(30);

/// One tap's progress: when the reader's key went down, and every key held,
/// so the key pressed while Shift is already down is a chord and no tap.
#[derive(Default)]
struct Tap {
    down: Option<Instant>,
    held: HashMap<u32, (bool, Instant)>,
}

impl Tap {
    fn press(&mut self, code: u32, ours: bool, repeat: bool, at: Instant) {
        if repeat {
            return;
        }
        self.held.retain(|_, (_, since)| at.duration_since(*since) < STALE);
        // Left then right of the same key keeps the first down's time.
        let alone = self.held.values().all(|(ours, _)| *ours);
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

    fn click(&mut self) {
        self.down = None;
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
        tap.click();
        assert!(!tap.release(CTRL, true, after(t, 100)));
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
