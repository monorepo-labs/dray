//! The window's glass (DESIGN.md, "Window is glass").
//!
//! GPUI's own `Blurred` background is an NSVisualEffectView with its tint and
//! saturation stripped, leaving bare blur. The web app sits on the `sidebar`
//! material whole (tauri.conf.json's `windowEffects`), and App.css's
//! `--vibrancy-alpha` was tuned over that, so a bare blur under the same alpha
//! reads as a different window. So the window opens `Transparent` and this
//! puts the material back, the way Tauri's window-vibrancy does: one effect
//! view under everything in the content view.

use gpui::Window;

#[cfg(target_os = "macos")]
pub fn apply(window: &Window) {
    use objc2::MainThreadMarker;
    use objc2_app_kit::{
        NSAutoresizingMaskOptions, NSView, NSVisualEffectBlendingMode, NSVisualEffectMaterial, NSVisualEffectState,
        NSVisualEffectView, NSWindowOrderingMode,
    };
    use raw_window_handle::{HasWindowHandle, RawWindowHandle};

    let Some(mtm) = MainThreadMarker::new() else { return };
    // The trait's method, not GPUI's inherent `window_handle`.
    let Ok(handle) = HasWindowHandle::window_handle(window) else {
        return;
    };
    let RawWindowHandle::AppKit(handle) = handle.as_raw() else {
        return;
    };
    // SAFETY: GPUI hands out its live NSView, on the main thread.
    let view: &NSView = unsafe { handle.ns_view.cast().as_ref() };
    let Some(content) = view.window().and_then(|w| w.contentView()) else {
        return;
    };

    let effect = NSVisualEffectView::initWithFrame(mtm.alloc(), content.bounds());
    effect.setMaterial(NSVisualEffectMaterial::Sidebar);
    effect.setBlendingMode(NSVisualEffectBlendingMode::BehindWindow);
    // `windowEffects.state: "followsWindowActiveState"`.
    effect.setState(NSVisualEffectState::FollowsWindowActiveState);
    effect.setAutoresizingMask(
        NSAutoresizingMaskOptions::ViewWidthSizable | NSAutoresizingMaskOptions::ViewHeightSizable,
    );
    content.addSubview_positioned_relativeTo(&effect, NSWindowOrderingMode::Below, None);
}

#[cfg(not(target_os = "macos"))]
pub fn apply(_: &Window) {}
