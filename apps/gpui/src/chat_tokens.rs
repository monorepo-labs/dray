//! The tokens tool rows and the two cards draw with that [theme](crate::theme)
//! does not carry yet: Default's palette on glass, written as App.css writes
//! it. Kept apart so this area adds a file rather than editing the shared one;
//! fold it into `Theme` once the areas land.

use gpui::{App, BoxShadow, Hsla, point, px};

use crate::color::{Oklab, oklch};
use crate::theme::{Mode, Theme};

#[derive(Clone, Debug)]
pub struct ChatTokens {
    pub foreground: Hsla,
    pub muted_foreground: Hsla,
    /// `--card` on glass: `--veil-card`.
    pub card: Hsla,
    pub border: Hsla,
    pub input: Hsla,
    /// `--surface-raised` on glass (`--veil-raised`): tool output boxes.
    pub surface_raised: Hsla,
    /// `--muted` on glass (`--veil-strong`): a checked choice, hovers.
    pub muted: Hsla,
    pub primary: Hsla,
    pub primary_foreground: Hsla,
    pub button_primary: Hsla,
    pub button_primary_foreground: Hsla,
    pub ring: Hsla,
    pub destructive: Hsla,
    pub accent_add: Hsla,
    pub shadow_card: Vec<BoxShadow>,
    pub shadow_button: Vec<BoxShadow>,
}

fn shadow(y: f32, blur: f32, color: Hsla) -> BoxShadow {
    BoxShadow { color, offset: point(px(0.), px(y)), blur_radius: px(blur), spread_radius: px(0.), inset: false }
}

impl ChatTokens {
    pub fn get(cx: &App) -> ChatTokens {
        ChatTokens::new(Theme::get(cx))
    }

    pub fn new(theme: &Theme) -> ChatTokens {
        match theme.mode {
            Mode::Dark => {
                let primary = oklch(0.922, 0., 0., 1.).hsla();
                let primary_foreground = oklch(0.205, 0., 0., 1.).hsla();
                ChatTokens {
                    foreground: theme.foreground,
                    muted_foreground: theme.muted_foreground,
                    card: oklch(1., 0., 0., 0.055).hsla(),
                    border: oklch(1., 0., 0., 0.10).hsla(),
                    input: oklch(1., 0., 0., 0.15).hsla(),
                    surface_raised: oklch(1., 0., 0., 0.04).hsla(),
                    muted: oklch(1., 0., 0., 0.115).hsla(),
                    primary,
                    primary_foreground,
                    button_primary: primary,
                    button_primary_foreground: primary_foreground,
                    ring: oklch(0.556, 0., 0., 1.).hsla(),
                    destructive: oklch(0.704, 0.191, 22.216, 1.).hsla(),
                    accent_add: theme.accent_add,
                    // `--shadow-card: none` in dark.
                    shadow_card: Vec::new(),
                    shadow_button: vec![shadow(1., 4., oklch(0., 0., 0., 0.45).hsla())],
                }
            }
            Mode::Light => {
                let foreground = oklch(0.22, 0.01, 250., 1.).lab();
                let surface_card = oklch(0.99, 0.004, 250., 1.);
                ChatTokens {
                    foreground: theme.foreground,
                    muted_foreground: theme.muted_foreground,
                    card: oklch(0.99, 0.004, 250., 0.60).hsla(),
                    border: oklch(0., 0., 0., 0.10).hsla(),
                    input: oklch(0., 0., 0., 0.14).hsla(),
                    surface_raised: foreground.mix(0.045, Oklab::TRANSPARENT).hsla(),
                    muted: foreground.mix(0.115, Oklab::TRANSPARENT).hsla(),
                    primary: oklch(0.65, 0.17, 250., 1.).hsla(),
                    primary_foreground: oklch(0.99, 0., 0., 1.).hsla(),
                    button_primary: oklch(0.28, 0.01, 250., 1.).hsla(),
                    button_primary_foreground: surface_card.hsla(),
                    ring: oklch(0.65, 0.17, 250., 1.).hsla(),
                    destructive: oklch(0.55, 0.2, 25., 1.).hsla(),
                    accent_add: theme.accent_add,
                    shadow_card: vec![
                        shadow(1., 1., oklch(0., 0., 1., 0.04).hsla()),
                        shadow(1., 1., oklch(0., 0., 0., 0.06).hsla()),
                        shadow(1., 4., oklch(0., 0., 0., 0.04).hsla()),
                    ],
                    shadow_button: vec![shadow(1., 3., oklch(0., 0., 0., 0.12).hsla())],
                }
            }
        }
    }
}

/// Font sizes from App.css's semantic scale, in pixels and line heights.
pub mod text {
    /// `text-chat`: 15px / 1.65.
    pub const CHAT: f32 = 15.;
    pub const CHAT_LEADING: f32 = 15. * 1.65;
    /// `text-tool`: 13px / 1.55.
    pub const TOOL: f32 = 13.;
    pub const TOOL_LEADING: f32 = 13. * 1.55;
    pub const MONO: &str = "Geist Mono";
}
