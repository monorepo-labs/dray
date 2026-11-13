//! The Default palette ("Dray" in Settings), both modes, as App.css resolves it
//! on a windowed Mac — `[data-transparency]` and `[data-vibrancy]` both on.
//!
//! Only the tokens something here draws with. Each is written the way App.css
//! writes it, so the two can be compared line for line; ported themes, flat
//! fullscreen and the theme picker are milestone 5.

use gpui::{App, Global, Hsla, WindowAppearance};

use crate::color::{Oklab, oklch};

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum Mode {
    Dark,
    Light,
}

impl Mode {
    pub fn of(appearance: WindowAppearance) -> Mode {
        match appearance {
            WindowAppearance::Dark | WindowAppearance::VibrantDark => Mode::Dark,
            WindowAppearance::Light | WindowAppearance::VibrantLight => Mode::Light,
        }
    }
}

#[derive(Clone, Debug)]
pub struct Theme {
    pub mode: Mode,
    /// What `body` paints edge to edge: the backdrop at `--vibrancy-alpha`, the
    /// one hole in the window the desktop shows through.
    pub body: Hsla,
    /// `--surface-frame`: the titlebar strip, sidebar and the rim round the sheet.
    pub frame: Hsla,
    /// `--surface-sheet`, transparent on glass in both modes.
    pub sheet: Hsla,
    /// The 1px ring `--shadow-sheet` draws round the sheet.
    pub sheet_ring: Hsla,
    pub foreground: Hsla,
    /// `--sidebar-foreground/80`, an unselected row's title.
    pub sidebar_foreground: Hsla,
    pub muted_foreground: Hsla,
    /// `--muted` under glass (`--veil-strong`): keycaps and ghost hovers.
    pub muted: Hsla,
    /// The sidebar's keycap fill, which the frame overrides in light.
    pub sidebar_kbd: Hsla,
    /// `--sidebar-accent` as the frame resolves it: the selected row.
    pub sidebar_accent: Hsla,
    /// The same at `/50`, for hover.
    pub sidebar_accent_hover: Hsla,
    pub sidebar_border: Hsla,
    pub accent_command: Hsla,
    pub accent_add: Hsla,
    /// `--card` under glass (`--veil-card`): the user's bubble.
    pub card: Hsla,
    /// `--shadow-card`, which only light draws.
    pub card_shadow: bool,
    pub destructive: Hsla,
}

impl Global for Theme {}

impl Theme {
    pub fn get(cx: &App) -> &Theme {
        cx.global::<Theme>()
    }

    pub fn new(mode: Mode) -> Theme {
        match mode {
            Mode::Dark => Theme::dark(),
            Mode::Light => Theme::light(),
        }
    }

    fn dark() -> Theme {
        let background = oklch(0.145, 0., 0., 1.).lab();
        let foreground = oklch(0.985, 0., 0., 1.).lab();
        // `[data-mode="dark"]`'s veils; `--sidebar-accent` takes `--veil-selected`.
        let veil_selected = oklch(1., 0., 0., 0.115).lab();
        let veil_strong = oklch(1., 0., 0., 0.115).lab();
        Theme {
            mode: Mode::Dark,
            body: background.fade(0.80).hsla(),
            frame: oklch(0., 0., 0., 0.45).hsla(),
            sheet: Oklab::TRANSPARENT.hsla(),
            sheet_ring: oklch(1., 0., 0., 0.06).hsla(),
            foreground: foreground.hsla(),
            sidebar_foreground: foreground.fade(0.8).hsla(),
            muted_foreground: oklch(0.708, 0., 0., 1.).hsla(),
            muted: veil_strong.hsla(),
            sidebar_kbd: veil_strong.hsla(),
            sidebar_accent: veil_selected.hsla(),
            sidebar_accent_hover: veil_selected.fade(0.5).hsla(),
            sidebar_border: oklch(1., 0., 0., 0.08).hsla(),
            accent_command: oklch(0.82, 0.13, 90., 1.).hsla(),
            accent_add: oklch(0.7, 0.15, 163., 1.).hsla(),
            card: oklch(1., 0., 0., 0.055).hsla(),
            card_shadow: false,
            destructive: oklch(0.704, 0.191, 22.216, 1.).hsla(),
        }
    }

    fn light() -> Theme {
        let background = oklch(0.965, 0.012, 250., 1.).lab();
        let foreground = oklch(0.22, 0.01, 250., 1.).lab();
        let veil_strong = foreground.mix(0.115, Oklab::TRANSPARENT);
        // AppShell's frame sets its own `--sidebar-accent` in light.
        let frame_accent = foreground.mix(0.15, Oklab::TRANSPARENT);
        Theme {
            mode: Mode::Light,
            body: background.fade(0.60).hsla(),
            frame: oklch(0., 0., 0., 0.07).hsla(),
            sheet: Oklab::TRANSPARENT.hsla(),
            sheet_ring: oklch(0., 0., 0., 0.09).hsla(),
            foreground: foreground.hsla(),
            sidebar_foreground: foreground.fade(0.8).hsla(),
            muted_foreground: oklch(0.52, 0.01, 250., 1.).hsla(),
            muted: veil_strong.hsla(),
            // `not-dark:[&_[data-slot=kbd]]:bg-foreground/13` on the frame.
            sidebar_kbd: foreground.fade(0.13).hsla(),
            sidebar_accent: frame_accent.hsla(),
            sidebar_accent_hover: frame_accent.fade(0.5).hsla(),
            sidebar_border: oklch(0., 0., 0., 0.08).hsla(),
            accent_command: oklch(0.65, 0.14, 78., 1.).hsla(),
            accent_add: oklch(0.585, 0.174, 163., 1.).hsla(),
            card: oklch(0.99, 0.004, 250., 0.6).hsla(),
            card_shadow: true,
            destructive: oklch(0.55, 0.2, 25., 1.).hsla(),
        }
    }
}
