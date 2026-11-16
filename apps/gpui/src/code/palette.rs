//! The colours code is drawn in: Pierre's light and dark themes, which the React
//! app's code theme `auto` resolves to on the Default palette, and the diff
//! chrome `@pierre/diffs` derives from them.
//!
//! Token colours are copied as hex from `@pierre/theme` 2.0.0's
//! `pierre-{light,dark}.json`. The diff tints follow the library's own
//! `color-mix()` rules in `style.js`, named beside each line so a library bump
//! can be checked against it. The other code themes in Settings are M5.

use gpui::Hsla;

use super::highlight::Token;
use crate::color::{Oklab, oklch};
use crate::theme::Mode;

#[derive(Clone, Debug)]
pub struct CodePalette {
    /// `editor.background`, which a diff and a `Read` keep. A markdown fence
    /// doesn't: App.css forces its body transparent.
    pub background: Hsla,
    pub foreground: Hsla,
    /// `--diffs-fg-number`: the foreground 65% into the background.
    pub line_number: Hsla,
    /// `gitDecoration.addedResourceForeground`, the library's addition base:
    /// numbers on an added line and the `+N` count.
    pub addition: Hsla,
    pub deletion: Hsla,
    /// A changed line's row, and its gutter (a touch fainter).
    pub addition_line: Hsla,
    pub deletion_line: Hsla,
    pub addition_gutter: Hsla,
    pub deletion_gutter: Hsla,
    /// The words that changed within a changed line.
    pub addition_emphasis: Hsla,
    pub deletion_emphasis: Hsla,
    /// `--diffs-bg-separator`, the "N unmodified lines" bar.
    pub separator: Hsla,
    /// `[data-streamdown=code-block]`'s `--border`.
    pub fence_border: Hsla,
    /// DiffView and CodeView's frame, `border-border/60`.
    pub frame_border: Hsla,
    tokens: [Hsla; Token::COUNT],
}

impl CodePalette {
    pub fn pierre(mode: Mode) -> CodePalette {
        let dark = mode == Mode::Dark;
        let pick = |light: u32, dark_hex: u32| hex(if dark { dark_hex } else { light });
        let bg = pick(0xffffff, 0x0a0a0a);
        let fg = pick(0x0a0a0a, 0xfafafa);
        let add = pick(0x18a46c, 0x07c480);
        let del = pick(0xd52c36, 0xff2e3f);
        // `--diffs-mixer`: black over light, white over dark.
        let mixer = pick(0x000000, 0xffffff);
        // `:where([data-background])`: lines mix 88%/80%, gutters 91%/85%.
        let (line_mix, gutter_mix) = if dark { (0.80, 0.85) } else { (0.88, 0.91) };
        // `--diffs-bg-{addition,deletion}-emphasis`: the base at .15 / .2.
        let emphasis = if dark { 0.2 } else { 0.15 };
        let border = if dark { oklch(1., 0., 0., 0.10) } else { oklch(0., 0., 0., 0.10) }.lab();

        let mut tokens = [fg.hsla(); Token::COUNT];
        let mut set = |token: Token, light: u32, dark_hex: u32| tokens[token as usize] = pick(light, dark_hex).hsla();
        // Each from the TextMate scope Shiki would have matched for the same text.
        set(Token::Comment, 0x737373, 0x737373); // comment
        set(Token::String, 0x199f43, 0x5ecc71); // string
        set(Token::Escape, 0x16a994, 0x61d5c0); // constant.character.escape
        set(Token::Regexp, 0x17a5af, 0x64d1db); // string.regexp
        set(Token::Number, 0x1ca1c7, 0x68cdf2); // constant.numeric, constant.language
        set(Token::Constant, 0xd5a910, 0xffd452); // constant
        set(Token::ConstantName, 0xd5901c, 0xffab16); // variable.other.constant
        set(Token::Keyword, 0xd32a61, 0xff678d); // keyword, storage
        set(Token::Function, 0x693acf, 0x9d6afb); // entity.name.function
        set(Token::Type, 0xa631be, 0xd568ea); // entity.name.type
        set(Token::Variable, 0xd47628, 0xffa359); // variable
        set(Token::VariableBuiltin, 0xd5901c, 0xffab16); // variable.language
        set(Token::Parameter, 0x636363, 0xa3a3a3); // variable.parameter
        set(Token::Property, 0xd47628, 0xffa359); // variable.other.property
        set(Token::Namespace, 0xd5901c, 0xffab16); // entity.name.namespace
        set(Token::Operator, 0x08c0ef, 0x08c0ef); // keyword.operator.{arithmetic,assignment,…}
        set(Token::Punctuation, 0x636363, 0x636363); // punctuation
        set(Token::Tag, 0xd5512f, 0xff855e); // entity.name.tag
        set(Token::Attribute, 0x18a46c, 0x60d199); // entity.other.attribute-name
        set(Token::Key, 0xd5512f, 0xff855e); // support.type.property-name.json

        CodePalette {
            background: bg.hsla(),
            foreground: fg.hsla(),
            line_number: fg.mix(0.65, bg).hsla(),
            addition: add.hsla(),
            deletion: del.hsla(),
            addition_line: bg.mix(line_mix, add).hsla(),
            deletion_line: bg.mix(line_mix, del).hsla(),
            addition_gutter: bg.mix(gutter_mix, add).hsla(),
            deletion_gutter: bg.mix(gutter_mix, del).hsla(),
            addition_emphasis: add.fade(emphasis).hsla(),
            deletion_emphasis: del.fade(emphasis).hsla(),
            separator: bg.mix(if dark { 0.85 } else { 0.96 }, mixer).hsla(),
            fence_border: border.hsla(),
            frame_border: border.fade(0.6).hsla(),
            tokens,
        }
    }

    pub fn token(&self, token: Token) -> Hsla {
        self.tokens[token as usize]
    }
}

/// `#rrggbb` into OKLab, so the library's mixes run in the same space as
/// App.css's. The library mixes `in lab` (CIELAB); OKLab is within a shade of
/// it at these small ratios.
fn hex(rgb: u32) -> Oklab {
    let channel = |shift: u32| {
        let c = ((rgb >> shift) & 0xff) as f32 / 255.;
        if c <= 0.040_45 { c / 12.92 } else { ((c + 0.055) / 1.055).powf(2.4) }
    };
    let (r, g, b) = (channel(16), channel(8), channel(0));
    let l = (0.412_221_46 * r + 0.536_332_55 * g + 0.051_445_995 * b).cbrt();
    let m = (0.211_903_5 * r + 0.680_699_5 * g + 0.107_396_96 * b).cbrt();
    let s = (0.088_302_46 * r + 0.281_718_85 * g + 0.629_978_7 * b).cbrt();
    Oklab {
        l: 0.210_454_26 * l + 0.793_617_8 * m - 0.004_072_047 * s,
        a: 1.977_998_5 * l - 2.428_592_2 * m + 0.450_593_7 * s,
        b: 0.025_904_037 * l + 0.782_771_77 * m - 0.808_675_77 * s,
        alpha: 1.,
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn hex_round_trips_through_oklab() {
        for value in [0x18a46c, 0xd32a61, 0x0a0a0a, 0xffffff] {
            let c = hex(value).rgba();
            let byte = |x: f32| (x * 255.).round() as u32;
            assert_eq!(byte(c.r) << 16 | byte(c.g) << 8 | byte(c.b), value);
        }
    }
}
