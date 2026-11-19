//! Bots as the Mac island draws them (#917, #1069): a bot's chat shows its
//! face and name, and its "waiting on you" notice carries the tasks behind it.
//! The face is the app's own code, as on the Mac: the Mac island's
//! `botface.js` (Blobatar and `botAvatar.ts`, bundled by its `Faces/bundle.sh`)
//! run in QuickJS, its SVG drawn by GPUI.

use gpui::{App, ImageFormat, IntoElement, ParentElement, Styled, div, img, px};
use serde::Deserialize;
use std::cell::RefCell;
use std::collections::HashMap;
use std::sync::Arc;

/// A bot, as `list_bots` answers it. Its chat is any session whose `cwd` is `path`.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(default)]
pub struct Bot {
    pub id: String,
    pub name: String,
    pub path: String,
    /// Absent for a bot made before there was a pick, which draws the face its id seeds.
    pub avatar: Option<Avatar>,
}

/// A Blobatar face: a shape name and hue degrees.
#[derive(Clone, Debug, Default, Deserialize, PartialEq, serde::Serialize)]
#[serde(default)]
pub struct Avatar {
    pub shape: String,
    pub hue: f64,
}

/// One row of a bot's "Waiting on you" card, as the app hands it over with
/// the notice (`useStalledTasks`), the Mac island's `WaitingTask`.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct WaitingTask {
    pub id: String,
    pub title: String,
    pub project_path: String,
    pub modified: String,
    /// The line its bot wrote for the reader, where one was written since the task last moved.
    pub need: Option<String>,
    /// Its PR can land, so the card carries Merge.
    pub ready: bool,
    pub pr: Option<PrMark>,
}

/// One branch's pull request, as `pr_marks` answers it.
#[derive(Clone, Debug, Default, Deserialize, PartialEq)]
#[serde(rename_all = "camelCase", default)]
pub struct PrMark {
    pub number: u64,
    pub head_ref_name: String,
    pub is_draft: bool,
    pub state: String,
    pub checks_state: String,
}

/// The JS that draws a face, read by path from the Mac island so both draw
/// from one bundle.
const BOTFACE_JS: &str = include_str!("../../island/Island/botface.js");

thread_local! {
    /// QuickJS with `botface.js` loaded, made on the first face drawn.
    static JS: RefCell<Option<(rquickjs::Runtime, rquickjs::Context)>> = const { RefCell::new(None) };
    /// Faces drawn, by seed, pick and pixel size: one SVG per bot is enough,
    /// and GPUI keys its own raster cache on the bytes.
    static FACES: RefCell<HashMap<(String, String, u32), Option<Arc<gpui::Image>>>> = RefCell::new(HashMap::new());
}

/// Blobatar's SVG for `seed` with `avatar`, or the face the seed picks.
fn face_svg(seed: &str, avatar: Option<&Avatar>, size: u32) -> Option<String> {
    JS.with(|js| {
        let mut js = js.borrow_mut();
        if js.is_none() {
            let runtime = rquickjs::Runtime::new().ok()?;
            let context = rquickjs::Context::full(&runtime).ok()?;
            context.with(|ctx| ctx.eval::<(), _>(BOTFACE_JS)).ok()?;
            *js = Some((runtime, context));
        }
        let (_, context) = js.as_ref()?;
        // JSON is a JS literal, so neither argument can step out of its string.
        let call = format!(
            "botFace({}, {}, {size})",
            serde_json::to_string(seed).ok()?,
            serde_json::to_string(&avatar).ok()?
        );
        context.with(|ctx| ctx.eval::<String, _>(call)).ok()
    })
}

fn face_image(seed: &str, avatar: Option<&Avatar>, size: u32) -> Option<Arc<gpui::Image>> {
    let key = (seed.to_string(), serde_json::to_string(&avatar).unwrap_or_default(), size);
    FACES.with(|faces| {
        faces
            .borrow_mut()
            .entry(key)
            .or_insert_with(|| {
                let svg = face_svg(seed, avatar, size);
                if svg.is_none() {
                    eprintln!("[island] could not draw a face for {seed}");
                }
                svg.map(|svg| Arc::new(gpui::Image::from_bytes(ImageFormat::Svg, svg.into_bytes())))
            })
            .clone()
    })
}

/// A face `size` points square, drawn for the screen's scale. The shape sits
/// inside its box with room to spare, so it is drawn a little larger, as the
/// sidebar's is.
pub fn face(seed: &str, avatar: Option<&Avatar>, size: f32, cx: &App) -> gpui::AnyElement {
    let drawn = size * 1.18;
    let pixels = (drawn * crate::scale(cx)).ceil() as u32;
    let slot = div().flex_none().size(px(size)).flex().items_center().justify_center();
    match face_image(seed, avatar, pixels) {
        Some(image) => slot.child(img(image).flex_none().size(px(drawn))).into_any_element(),
        None => slot.into_any_element(),
    }
}

/// A bot's own face.
pub fn bot_face(bot: &Bot, size: f32, cx: &App) -> gpui::AnyElement {
    face(&bot.id, bot.avatar.as_ref(), size, cx)
}

/// A branch's pull request glyph, the desktop's `PrStateIcon` as the iOS
/// app's `PrGlyph` draws it: lucide's shapes in GitHub's colours, red while
/// checks fail on an open one.
pub fn pr_glyph(pr: &PrMark, size: f32, cx: &App) -> gpui::AnyElement {
    let merged = pr.state == "MERGED";
    let failing = !merged && pr.checks_state == "FAILING";
    let tone = if failing {
        "#ff453a"
    } else if merged {
        "#bf5af2"
    } else if pr.is_draft {
        "#8e8e93"
    } else {
        "#30d158"
    };
    let lines = if merged {
        "M6 21V9a9 9 0 0 0 9 9"
    } else if pr.is_draft {
        "M6 9v12M18 6v-1M18 11v-1"
    } else {
        "M6 9v12M13 6h3a2 2 0 0 1 2 2v7"
    };
    let pixels = (size * crate::scale(cx)).ceil() as u32;
    let svg = format!(
        r#"<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 24 24" width="{pixels}" height="{pixels}" fill="none" stroke="{tone}" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><circle cx="18" cy="18" r="3"/><circle cx="6" cy="6" r="3"/><path d="{lines}"/></svg>"#
    );
    let image = Arc::new(gpui::Image::from_bytes(ImageFormat::Svg, svg.into_bytes()));
    img(image).flex_none().size(px(size)).into_any_element()
}

/// Seconds since the epoch for an RFC3339 time, offset or `Z`, fraction or not.
pub fn parse_time(s: &str) -> Option<i64> {
    let b = s.as_bytes();
    let num = |from: usize, len: usize| -> Option<i64> { s.get(from..from + len)?.parse().ok() };
    if b.len() < 19 || b[4] != b'-' || b[10] != b'T' && b[10] != b' ' {
        return None;
    }
    let (y, m, d) = (num(0, 4)?, num(5, 2)?, num(8, 2)?);
    let (hh, mm, ss) = (num(11, 2)?, num(14, 2)?, num(17, 2)?);
    let mut rest = &s[19..];
    if let Some(frac) = rest.strip_prefix('.') {
        rest = frac.trim_start_matches(|c: char| c.is_ascii_digit());
    }
    let offset = match rest.as_bytes().first() {
        None | Some(b'Z' | b'z') => 0,
        Some(sign @ (b'+' | b'-')) => {
            let h: i64 = rest.get(1..3)?.parse().ok()?;
            let m: i64 = rest.get(4..6).or_else(|| rest.get(3..5))?.parse().ok()?;
            (h * 3600 + m * 60) * if *sign == b'+' { 1 } else { -1 }
        }
        _ => return None,
    };
    // Howard Hinnant's days-from-civil.
    let y = if m <= 2 { y - 1 } else { y };
    let era = y.div_euclid(400);
    let yoe = y - era * 400;
    let mp = (m + 9) % 12;
    let doy = (153 * mp + 2) / 5 + d - 1;
    let doe = yoe * 365 + yoe / 4 - yoe / 100 + doy;
    let days = era * 146_097 + doe - 719_468;
    Some(days * 86_400 + hh * 3600 + mm * 60 + ss - offset)
}

/// How long ago, as the sidebar says it: now, 4m, 1h, 3d.
pub fn short_age(modified: &str) -> Option<String> {
    let now = std::time::SystemTime::now().duration_since(std::time::UNIX_EPOCH).ok()?.as_secs() as i64;
    let s = (now - parse_time(modified)?).max(0);
    Some(match s {
        0..60 => "now".into(),
        60..3600 => format!("{}m", s / 60),
        3600..86_400 => format!("{}h", s / 3600),
        _ => format!("{}d", s / 86_400),
    })
}

/// What the pill says for one finished or waiting session: its rows counted
/// while it has them, so a merge here moves the count.
pub fn headline_one(note: Option<&str>, rows: usize) -> String {
    if rows > 0 { format!("{rows} {} waiting on you", if rows == 1 { "task" } else { "tasks" }) } else { note.unwrap_or("Done").to_string() }
}

/// The pill's own line: one item's, every bot's waiting tasks counted as one,
/// else how many updates. Each item is its note and how many rows it holds.
pub fn headline(items: &[(Option<&str>, usize)]) -> String {
    if let [(note, rows)] = items {
        return headline_one(*note, *rows);
    }
    if !items.is_empty() && items.iter().all(|(_, rows)| *rows > 0) {
        return format!("{} tasks waiting on you", items.iter().map(|(_, rows)| rows).sum::<usize>());
    }
    if items.iter().any(|(note, _)| note.is_some()) { format!("{} updates", items.len()) } else { format!("{} tasks done", items.len()) }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn a_face_is_the_apps_own_svg() {
        let picked = face_svg("bot-1", Some(&Avatar { shape: "cloud".into(), hue: 250. }), 64).expect("drawn");
        assert!(picked.starts_with("<svg") && picked.contains(r#"width="64""#));
        // No pick: the seed's own face, the same each time.
        let seeded = face_svg("task-1", None, 32).expect("drawn");
        assert_eq!(seeded, face_svg("task-1", None, 32).unwrap());
        assert_ne!(seeded, face_svg("task-2", None, 32).unwrap());
        // A seed carrying quotes stays a string.
        assert!(face_svg(r#"x"); throw 1; ("#, None, 16).is_some());
    }

    #[test]
    fn times_read_with_offset_or_zulu() {
        assert_eq!(parse_time("1970-01-01T00:00:00Z"), Some(0));
        assert_eq!(parse_time("1970-01-01T01:00:00.123+01:00"), Some(0));
        assert_eq!(parse_time("2026-11-19T10:00:00Z"), parse_time("2026-11-19T17:00:00+07:00"));
        assert_eq!(parse_time("not a time"), None);
    }

    #[test]
    fn headlines_follow_the_macs() {
        assert_eq!(headline(&[(None, 0)]), "Done");
        assert_eq!(headline(&[(Some("2 tasks waiting on you"), 0)]), "2 tasks waiting on you");
        assert_eq!(headline(&[(Some("2 tasks waiting on you"), 1)]), "1 task waiting on you");
        assert_eq!(headline(&[(Some("a"), 2), (Some("b"), 1)]), "3 tasks waiting on you");
        assert_eq!(headline(&[(Some("a"), 2), (None, 0)]), "2 updates");
        assert_eq!(headline(&[(None, 0), (None, 0)]), "2 tasks done");
    }

    #[test]
    fn waiting_rows_read_as_the_app_writes_them() {
        let rows: Vec<WaitingTask> = serde_json::from_str(
            r#"[{"id":"t1","title":"Fix it","projectPath":"/p","modified":"2026-11-19T10:00:00Z","need":null,"ready":true,
                 "pr":{"number":7,"headRefName":"b","isDraft":false,"state":"OPEN","checksState":"CLEAR","url":"u"}}]"#,
        )
        .unwrap();
        assert_eq!(rows[0].pr.as_ref().map(|p| p.number), Some(7));
        assert!(rows[0].ready && rows[0].need.is_none());
    }
}
