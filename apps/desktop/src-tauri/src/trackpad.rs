//! Two-finger horizontal swipes, read off AppKit rather than the webview.
//!
//! A DOM `wheel` carries no gesture phase: nothing on it says a swipe began,
//! that the fingers lifted, or that an event is momentum coasting on after
//! them. Every rule built on guessing those from timing and speed misread
//! somewhere — a slow drag that wobbled read as a lift, a quick second swipe
//! read as the first one's coast (#445). `NSEvent` says all three outright.

use std::cell::Cell;
use std::ptr::NonNull;

use block2::RcBlock;
use objc2_app_kit::{NSEvent, NSEventMask, NSEventPhase};
use serde::Serialize;
use tauri::{AppHandle, Emitter};

#[derive(Clone, Copy, PartialEq)]
enum Axis {
    Idle,
    Undecided,
    X,
    Y,
}

thread_local! {
    // The monitor runs on the main thread alone.
    static AXIS: Cell<Axis> = const { Cell::new(Axis::Idle) };
}

#[derive(Clone, Serialize)]
struct Swipe {
    /// `began`, `changed`, `ended` or `cancelled`.
    phase: &'static str,
    /// The DOM's sign: positive is fingers moving left under natural scrolling.
    dx: f64,
}

/// Emits `trackpad_swipe` for every two-finger gesture whose first movement is
/// horizontal, fingers only: momentum is never sent, and a vertical scroll
/// sends nothing at all. Events pass on to the webview untouched.
pub fn watch(app: &AppHandle) {
    let app = app.clone();
    let block = RcBlock::new(move |event: NonNull<NSEvent>| -> *mut NSEvent {
        // SAFETY: AppKit hands the monitor a live event for the call.
        let e = unsafe { event.as_ref() };
        // A mouse wheel has no phase, and momentum comes with `phase` None.
        if e.hasPreciseScrollingDeltas() && e.momentumPhase() == NSEventPhase::None {
            on_scroll(&app, e.phase(), -e.scrollingDeltaX(), e.scrollingDeltaY());
        }
        event.as_ptr()
    });
    // SAFETY: called from `setup`, on the main thread.
    let monitor = unsafe {
        NSEvent::addLocalMonitorForEventsMatchingMask_handler(NSEventMask::ScrollWheel, &block)
    };
    // Lives as long as the app; nothing ever removes it.
    std::mem::forget(monitor);
}

fn on_scroll(app: &AppHandle, phase: NSEventPhase, dx: f64, dy: f64) {
    let send = |phase, dx| {
        let _ = app.emit("trackpad_swipe", Swipe { phase, dx });
    };
    AXIS.with(|axis| {
        if phase.contains(NSEventPhase::Began) {
            axis.set(Axis::Undecided);
        }
        if phase.contains(NSEventPhase::Changed) {
            // Locked on the first movement, so a vertical scroll drifting
            // sideways never becomes a swipe.
            if axis.get() == Axis::Undecided && (dx != 0.0 || dy != 0.0) {
                let x = dx.abs() > dy.abs();
                axis.set(if x { Axis::X } else { Axis::Y });
                if x {
                    send("began", 0.0);
                }
            }
            if axis.get() == Axis::X {
                send("changed", dx);
            }
        }
        if phase.intersects(NSEventPhase::Ended | NSEventPhase::Cancelled) {
            if axis.get() == Axis::X {
                let ended = phase.contains(NSEventPhase::Ended);
                send(if ended { "ended" } else { "cancelled" }, 0.0);
            }
            axis.set(Axis::Idle);
        }
    });
}
