//! The modifier tap and the pen's Shift, read the same way off X11's raw
//! events and Windows' low-level hooks: each platform hands over key codes and
//! says which key is the reader's, and these decide.

use std::collections::HashMap;
use std::time::{Duration, Instant};

/// The Mac's window for a tap: down and up within it, nothing pressed between.
pub const TAP: Duration = Duration::from_millis(400);

/// What a key is to the pen: Shift arms it, any other modifier with Shift is
/// a chord and draws nothing.
#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Kind {
    Shift,
    Modifier,
    Other,
}

/// Whether Shift alone is held, which arms the pen while dictating: any
/// other modifier with it is a chord and draws nothing. Answers a change.
#[derive(Default)]
pub struct Pen {
    shift: HashMap<u32, ()>,
    others: HashMap<u32, ()>,
    armed: bool,
}

impl Pen {
    pub fn press(&mut self, code: u32, kind: Kind) -> Option<bool> {
        match kind {
            Kind::Shift => {
                self.shift.insert(code, ());
            }
            Kind::Modifier => {
                self.others.insert(code, ());
            }
            Kind::Other => {}
        }
        self.settle()
    }

    pub fn release(&mut self, code: u32) -> Option<bool> {
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
pub struct Tap {
    down: Option<Instant>,
    held: HashMap<u32, (bool, Instant)>,
    buttons: HashMap<u32, Instant>,
}

impl Tap {
    pub fn press(&mut self, code: u32, ours: bool, repeat: bool, at: Instant) {
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
    pub fn release(&mut self, code: u32, ours: bool, at: Instant) -> bool {
        self.held.remove(&code);
        if !ours {
            self.down = None;
            return false;
        }
        self.down.take().is_some_and(|down| at.duration_since(down) < TAP)
    }

    /// A press or release of a pointer button; a press rules the tap out.
    pub fn button(&mut self, button: u32, pressed: bool, at: Instant) {
        if pressed {
            self.down = None;
            self.buttons.insert(button, at);
        } else {
            self.buttons.remove(&button);
        }
    }
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
    fn shift_alone_arms_the_pen() {
        let mut pen = Pen::default();
        assert_eq!(pen.press(SHIFT, Kind::Shift), Some(true));
        assert_eq!(pen.press(CTRL, Kind::Modifier), Some(false));
        assert_eq!(pen.release(CTRL), Some(true));
        assert_eq!(pen.press(C, Kind::Other), None);
        assert_eq!(pen.release(SHIFT), Some(false));
    }
}
