//! CSS colour, as App.css writes it: `oklch()` literals and `color-mix(in oklab, …)`.
//!
//! The tokens are copied from App.css in its own notation rather than as hex, so
//! a value here can be checked against the stylesheet by eye and a palette
//! change there ports as a copy. Converting by hand would lose that.

use gpui::{Hsla, Rgba};

/// A colour in OKLab with straight (unpremultiplied) alpha.
#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Oklab {
    pub l: f32,
    pub a: f32,
    pub b: f32,
    pub alpha: f32,
}

/// `oklch(l c h / alpha)`, hue in degrees.
pub const fn oklch(l: f32, c: f32, h: f32, alpha: f32) -> Oklch {
    Oklch { l, c, h, alpha }
}

#[derive(Clone, Copy, Debug, PartialEq)]
pub struct Oklch {
    pub l: f32,
    pub c: f32,
    pub h: f32,
    pub alpha: f32,
}

impl Oklch {
    pub fn lab(self) -> Oklab {
        let h = self.h.to_radians();
        Oklab { l: self.l, a: self.c * h.cos(), b: self.c * h.sin(), alpha: self.alpha }
    }

    pub fn hsla(self) -> Hsla {
        self.lab().hsla()
    }
}

impl Oklab {
    pub const TRANSPARENT: Oklab = Oklab { l: 0., a: 0., b: 0., alpha: 0. };

    /// `color-mix(in oklab, self p, other)`: premultiplied, as CSS mixes, so
    /// mixing toward `transparent` keeps the colour and scales its alpha.
    pub fn mix(self, p: f32, other: Oklab) -> Oklab {
        let q = 1. - p;
        let alpha = self.alpha * p + other.alpha * q;
        if alpha == 0. {
            return Oklab::TRANSPARENT;
        }
        let ch = |x: f32, y: f32| (x * self.alpha * p + y * other.alpha * q) / alpha;
        Oklab { l: ch(self.l, other.l), a: ch(self.a, other.a), b: ch(self.b, other.b), alpha }
    }

    /// The same colour at `alpha` times its own opacity — Tailwind's `/80`.
    pub fn fade(self, alpha: f32) -> Oklab {
        Oklab { alpha: self.alpha * alpha, ..self }
    }

    pub fn rgba(self) -> Rgba {
        let l_ = self.l + 0.396_337_78 * self.a + 0.215_803_76 * self.b;
        let m_ = self.l - 0.105_561_346 * self.a - 0.063_854_17 * self.b;
        let s_ = self.l - 0.089_484_18 * self.a - 1.291_485_5 * self.b;
        let (l, m, s) = (l_ * l_ * l_, m_ * m_ * m_, s_ * s_ * s_);
        let r = 4.076_741_7 * l - 3.307_711_6 * m + 0.230_969_94 * s;
        let g = -1.268_438 * l + 2.609_757_4 * m - 0.341_319_38 * s;
        let b = -0.004_196_086_3 * l - 0.703_418_6 * m + 1.707_614_7 * s;
        Rgba { r: encode(r), g: encode(g), b: encode(b), a: self.alpha.clamp(0., 1.) }
    }

    pub fn hsla(self) -> Hsla {
        self.rgba().into()
    }
}

impl From<Oklch> for Oklab {
    fn from(c: Oklch) -> Oklab {
        c.lab()
    }
}

/// Linear light to the sRGB transfer curve, clipped to the gamut as a browser
/// clips an `oklch()` that leaves it.
fn encode(x: f32) -> f32 {
    let x = x.clamp(0., 1.);
    if x <= 0.003_130_8 { 12.92 * x } else { 1.055 * x.powf(1. / 2.4) - 0.055 }
}

#[cfg(test)]
mod tests {
    use super::*;

    fn hex(c: Oklab) -> String {
        let c = c.rgba();
        let byte = |x: f32| (x * 255.).round() as u8;
        format!("#{:02x}{:02x}{:02x}", byte(c.r), byte(c.g), byte(c.b))
    }

    #[test]
    fn converts_greys_the_way_a_browser_does() {
        // shadcn's own hex for the neutral rungs Default dark is built on.
        assert_eq!(hex(oklch(0.145, 0., 0., 1.).lab()), "#0a0a0a");
        assert_eq!(hex(oklch(0.205, 0., 0., 1.).lab()), "#171717");
        assert_eq!(hex(oklch(0.985, 0., 0., 1.).lab()), "#fafafa");
    }

    #[test]
    fn mixing_toward_transparent_keeps_the_colour() {
        let card = oklch(0.205, 0., 0., 1.).lab();
        let veil = card.mix(0.62, Oklab::TRANSPARENT);
        assert_eq!(hex(veil), hex(card));
        assert!((veil.alpha - 0.62).abs() < 1e-6);
    }

    #[test]
    fn mixes_two_opaque_colours_in_oklab() {
        let fg = oklch(0.985, 0., 0., 1.).lab();
        let bg = oklch(0.145, 0., 0., 1.).lab();
        let selected = fg.mix(0.15, bg);
        assert!((selected.l - (0.985 * 0.15 + 0.145 * 0.85)).abs() < 1e-6);
    }
}
