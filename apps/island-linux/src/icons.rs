//! The island's symbols, drawn after the Mac island's SF Symbols and SF Pro's
//! key glyphs. Set as text they came from whatever font the desktop had —
//! DejaVu's ⏎ and arrows are thin and sit off the line — so each is our own
//! small SVG, tinted like the text beside it and drawn by GPUI.

use gpui::{App, Hsla, ImageFormat, IntoElement, ParentElement, Styled, div, img, px};
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

#[derive(Clone, Copy, Debug, PartialEq, Eq, Hash)]
pub enum Icon {
    /// SF Pro's ⏎.
    Return,
    /// SF Pro's ↑↓, one mark.
    UpDown,
    /// `arrow.up.circle.fill`, the send button.
    Send,
    /// `camera.viewfinder`, the screenshot button.
    Camera,
    /// `magnifyingglass`, the switcher's search.
    Search,
}

impl Icon {
    /// The SVG's body in a 24-unit box, its strokes and fills in `c`.
    fn body(self, c: &str) -> String {
        let stroke = |w: f32| format!(r#"fill="none" stroke="{c}" stroke-width="{w}" stroke-linecap="round" stroke-linejoin="round""#);
        match self {
            Icon::Return => format!(r#"<path {} d="M20 3.5v9a3 3 0 0 1-3 3H4.5M9.5 10l-5 5.5 5 5.5"/>"#, stroke(2.6)),
            Icon::UpDown => format!(r#"<path {} d="M6.5 21V3.5M2 8l4.5-4.5L11 8M17.5 3v17.5M13 16l4.5 4.5L22 16"/>"#, stroke(2.4)),
            // The arrow is cut out of the disc, so the panel shows through it as on the Mac.
            Icon::Send => format!(
                r#"<mask id="m"><rect width="24" height="24" fill="white"/><path fill="none" stroke="black" stroke-width="1.75" stroke-linecap="round" stroke-linejoin="round" d="M12 17.25V7M7.5 11.25 12 6.75l4.5 4.5"/></mask><circle cx="12" cy="12" r="11.5" fill="{c}" mask="url(#m)"/>"#
            ),
            Icon::Camera => format!(
                r#"<g {}><path d="M2.75 8V5.5a2.75 2.75 0 0 1 2.75-2.75H8M16 2.75h2.5a2.75 2.75 0 0 1 2.75 2.75V8M21.25 16v2.5a2.75 2.75 0 0 1-2.75 2.75H16M8 21.25H5.5a2.75 2.75 0 0 1-2.75-2.75V16"/><path d="M8.5 9h1.25l.9-1.5h2.7l.9 1.5h1.25A1.5 1.5 0 0 1 17 10.5v4.5a1.5 1.5 0 0 1-1.5 1.5h-7A1.5 1.5 0 0 1 7 15v-4.5A1.5 1.5 0 0 1 8.5 9z"/><circle cx="12" cy="12.6" r="2.1"/></g>"#,
                stroke(1.6)
            ),
            Icon::Search => format!(r#"<g {}><circle cx="10.25" cy="10.25" r="6.5"/><path d="M15 15l5.25 5.25"/></g>"#, stroke(2.2)),
        }
    }
}

thread_local! {
    /// Drawn once per icon, pixel size and colour; GPUI keys its own raster
    /// cache on the bytes.
    static DRAWN: RefCell<HashMap<(Icon, u32, [u8; 4]), Arc<gpui::Image>>> = RefCell::new(HashMap::new());
}

/// An SVG as an image GPUI draws, for marks no font carries.
pub fn svg(svg: String) -> Arc<gpui::Image> {
    Arc::new(gpui::Image::from_bytes(ImageFormat::Svg, svg.into_bytes()))
}

/// `color` as SVG's `#rrggbb` and an opacity.
fn css(color: Hsla) -> ([u8; 4], String) {
    let rgba = gpui::Rgba::from(color);
    let byte = |v: f32| (v.clamp(0., 1.) * 255.).round() as u8;
    let bytes = [byte(rgba.r), byte(rgba.g), byte(rgba.b), byte(rgba.a)];
    (bytes, format!("#{:02x}{:02x}{:02x}", bytes[0], bytes[1], bytes[2]))
}

/// `icon`, `size` points square, in `color`, drawn for the screen's scale.
pub fn icon(icon: Icon, size: f32, color: Hsla, cx: &App) -> gpui::AnyElement {
    let pixels = (size * crate::scale(cx)).ceil() as u32;
    let (key, hex) = css(color);
    let image = DRAWN.with(|drawn| {
        drawn
            .borrow_mut()
            .entry((icon, pixels, key))
            .or_insert_with(|| {
                let alpha = key[3] as f32 / 255.;
                svg(format!(
                    r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="{pixels}" height="{pixels}" opacity="{alpha}">{}</svg>"#,
                    icon.body(&hex)
                ))
            })
            .clone()
    });
    img(image).flex_none().size(px(size)).into_any_element()
}

/// A line of text with the key glyphs in it — ⏎ and ↑↓ — drawn as icons,
/// so a hint reads as the Mac's does, in the text's colour and size.
pub fn line(text: &str, size: f32, color: Hsla, cx: &App) -> gpui::Div {
    let mut row = div().flex_none().flex().items_center().text_color(color);
    let mut run = String::new();
    let mut chars = text.chars().peekable();
    while let Some(c) = chars.next() {
        let mark = match c {
            '⏎' => Some(Icon::Return),
            '↑' if chars.peek() == Some(&'↓') => {
                chars.next();
                Some(Icon::UpDown)
            }
            _ => None,
        };
        match mark {
            Some(mark) => {
                if !run.is_empty() {
                    row = row.child(div().whitespace_nowrap().child(std::mem::take(&mut run)));
                }
                row = row.child(icon(mark, size, color, cx));
            }
            None => run.push(c),
        }
    }
    if !run.is_empty() {
        row = row.child(div().whitespace_nowrap().child(run));
    }
    row
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn every_icon_is_an_svg_usvg_reads() {
        let options = usvg::Options::default();
        for icon in [Icon::Return, Icon::UpDown, Icon::Send, Icon::Camera, Icon::Search] {
            let svg = format!(r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="24" height="24">{}</svg>"#, icon.body("#ffffff"));
            assert!(usvg::Tree::from_str(&svg, &options).is_ok(), "{icon:?}");
        }
    }

    #[test]
    fn colours_carry_their_opacity() {
        let (bytes, hex) = css(gpui::hsla(0., 0., 1., 0.3));
        assert_eq!((hex.as_str(), bytes[3]), ("#ffffff", 77));
    }
}
