//! Fonts and icons, compiled into the binary.

use std::borrow::Cow;

use gpui::{App, AssetSource, SharedString};

pub struct Assets;

/// Every icon by the path `svg().path()` names it with.
const ICONS: &[(&str, &[u8])] = &[
    ("icons/arrow-down.svg", include_bytes!("../assets/icons/arrow-down.svg")),
    ("icons/arrow-up.svg", include_bytes!("../assets/icons/arrow-up.svg")),
    ("icons/check-check.svg", include_bytes!("../assets/icons/check-check.svg")),
    ("icons/circle-dashed.svg", include_bytes!("../assets/icons/circle-dashed.svg")),
    ("icons/circle-dot.svg", include_bytes!("../assets/icons/circle-dot.svg")),
    ("icons/cog-6-tooth.svg", include_bytes!("../assets/icons/cog-6-tooth.svg")),
    ("icons/panel-left.svg", include_bytes!("../assets/icons/panel-left.svg")),
    ("icons/plus.svg", include_bytes!("../assets/icons/plus.svg")),
    ("icons/search.svg", include_bytes!("../assets/icons/search.svg")),
];

impl AssetSource for Assets {
    fn load(&self, path: &str) -> anyhow::Result<Option<Cow<'static, [u8]>>> {
        Ok(ICONS.iter().find(|(p, _)| *p == path).map(|(_, bytes)| Cow::Borrowed(*bytes)))
    }

    fn list(&self, path: &str) -> anyhow::Result<Vec<SharedString>> {
        Ok(ICONS.iter().filter(|(p, _)| p.starts_with(path)).map(|(p, _)| SharedString::from(*p)).collect())
    }
}

/// Geist and Geist Mono, the app's two faces (App.css `--font-sans`/`--font-mono`).
/// Static cuts rather than the variable font the web app loads, so each weight
/// is a face of its own for GPUI's font matching to find.
pub fn load_fonts(cx: &App) {
    let fonts: Vec<Cow<'static, [u8]>> = vec![
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-Regular.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-Medium.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-SemiBold.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/Geist-Italic.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/GeistMono-Regular.ttf")),
        Cow::Borrowed(include_bytes!("../assets/fonts/GeistMono-Medium.ttf")),
    ];
    if let Err(e) = cx.text_system().add_fonts(fonts) {
        log::error!("could not load fonts: {e:#}");
    }
}

pub const SANS: &str = "Geist";
pub const MONO: &str = "Geist Mono";

/// What every `MONO` run sets: Geist Mono's `liga` eats the space before
/// `--` under GPUI's shaping, so `ls --all` drew `ls--all`.
pub fn mono_features() -> gpui::FontFeatures {
    gpui::FontFeatures(std::sync::Arc::new(vec![("liga".into(), 0)]))
}
