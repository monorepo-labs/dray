//! The tokens the composer draws with that theme.rs does not carry yet, written
//! as App.css writes them for the Default palette under glass. Kept here rather
//! than added to `Theme` so this module lands without touching shared files;
//! they move there once a second surface wants one.

use gpui::{BoxShadow, Hsla, point, px};

use crate::color::{Oklab, oklch};
use crate::theme::{Mode, Theme};

#[derive(Clone)]
pub struct Colors {
    pub background: Hsla,
    /// `--composer`, flat: App.css puts it on glass as `--veil-float` with a
    /// backdrop blur, and GPUI blurs no element's backdrop, so a veil here
    /// would let the transcript show through the prompt, unreadable. Same for `picker`.
    pub composer: Hsla,
    /// `--edge-surface`: a hairline in dark, transparent in light.
    pub edge_surface: Hsla,
    /// `--shadow-surface`: light only.
    pub shadow_surface: Option<Vec<BoxShadow>>,
    pub shadow_button: Vec<BoxShadow>,
    /// `--picker`, flat for the reason above (`--veil-panel` on glass).
    pub picker: Hsla,
    pub hairline_strong: Hsla,
    pub primary: Hsla,
    pub primary_foreground: Hsla,
    /// `--secondary`, the attachment tile's remove button.
    pub secondary: Hsla,
    pub border: Hsla,
    pub ghost_hover: Hsla,
    pub mention: Hsla,
    pub issue: Hsla,
    pub session: Hsla,
    pub selection: Hsla,
    pub command: Hsla,
}

impl Colors {
    pub fn new(theme: &Theme) -> Colors {
        match theme.mode {
            // `--chroma: 0` in Default dark collapses every calc().
            Mode::Dark => {
                let card = oklch(0.205, 0., 0., 1.).lab();
                Colors {
                    background: oklch(0.145, 0., 0., 1.).hsla(),
                    composer: card.hsla(),
                    edge_surface: oklch(1., 0., 0., 0.06).hsla(),
                    shadow_surface: None,
                    shadow_button: shadow(&[(1., 3., 0.45)]),
                    picker: card.hsla(),
                    hairline_strong: oklch(1., 0., 0., 0.08).hsla(),
                    primary: oklch(0.922, 0., 0., 1.).hsla(),
                    primary_foreground: card.hsla(),
                    secondary: oklch(0.269, 0., 0., 1.).hsla(),
                    border: oklch(1., 0., 0., 0.1).hsla(),
                    ghost_hover: theme.muted.opacity(0.5),
                    mention: oklch(0.82, 0.13, 230., 1.).hsla(),
                    issue: oklch(0.82, 0.13, 310., 1.).hsla(),
                    session: oklch(0.82, 0.13, 160., 1.).hsla(),
                    selection: oklch(1., 0., 0., 0.15).hsla(),
                    command: theme.accent_command,
                }
            }
            // Default light: hue 250, `--chroma` 0.03 (theme.rs's background).
            Mode::Light => {
                let c = 0.03;
                let card = oklch(1., c * 0.2, 250., 1.).lab();
                Colors {
                    background: oklch(0.965, c * 0.4, 250., 1.).hsla(),
                    composer: card.hsla(),
                    edge_surface: Oklab::TRANSPARENT.hsla(),
                    shadow_surface: Some(shadow(&[(1., 1., 0.08), (1., 1., 0.10), (1., 4., 0.08)])),
                    shadow_button: shadow(&[(1., 3., 0.12)]),
                    picker: card.hsla(),
                    hairline_strong: oklch(0., 0., 0., 0.13).hsla(),
                    primary: oklch(0.28, c * 0.5, 250., 1.).hsla(),
                    primary_foreground: oklch(0.99, c * 0.1, 250., 1.).hsla(),
                    secondary: card.hsla(),
                    border: oklch(0., 0., 0., 0.1).hsla(),
                    ghost_hover: theme.muted.opacity(0.5),
                    mention: oklch(0.55, 0.16, 245., 1.).hsla(),
                    issue: oklch(0.55, 0.16, 310., 1.).hsla(),
                    session: oklch(0.55, 0.16, 160., 1.).hsla(),
                    selection: oklch(0., 0., 0., 0.1).hsla(),
                    command: theme.accent_command,
                }
            }
        }
    }
}

/// `0 y blur black/alpha`, one per stop.
fn shadow(stops: &[(f32, f32, f32)]) -> Vec<BoxShadow> {
    stops
        .iter()
        .map(|&(y, blur, alpha)| BoxShadow {
            color: oklch(0., 0., 0., alpha).hsla(),
            offset: point(px(0.), px(y)),
            blur_radius: px(blur),
            spread_radius: px(0.),
            inset: false,
        })
        .collect()
}
