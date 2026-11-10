//! A screenshot marked up before it joins the draft, and the ink drawn on the
//! live screen while dictating: the Mac island's `Capture`, `Marking` and
//! `Mark`. The model and the pixels live here; the overlays that draw them are
//! in `overlay.rs`.
//!
//! The screen is frozen for a screenshot rather than left live, as the Mac
//! leaves it: X11 has no capture that leaves out one's own windows, and with
//! a compositor the root window reads back the island's overlay too. Taking
//! the screen before the overlay shows, and drawing that still under it, makes
//! what is seen exactly what is taken, with or without a compositor.

use image::RgbaImage;
use std::path::{Path, PathBuf};

/// One pen stroke, in screen pixels.
#[derive(Clone, Debug, Default, PartialEq)]
pub struct Mark {
    pub id: u64,
    pub points: Vec<(f32, f32)>,
}

impl Mark {
    /// The area the stroke covers, its line's width included: x, y, w, h.
    pub fn bounds(&self) -> Option<(f32, f32, f32, f32)> {
        let xs = self.points.iter().map(|p| p.0);
        let ys = self.points.iter().map(|p| p.1);
        let (x0, x1) = (xs.clone().fold(f32::MAX, f32::min), xs.fold(f32::MIN, f32::max));
        let (y0, y1) = (ys.clone().fold(f32::MAX, f32::min), ys.fold(f32::MIN, f32::max));
        (x0 <= x1).then_some((x0 - 4.0, y0 - 4.0, x1 - x0 + 8.0, y1 - y0 + 8.0))
    }
}

/// The ink's width and colour, the Mac's `Strokes`: one red, 4pt, round.
pub const INK_WIDTH: f32 = 4.0;
pub const INK: [u8; 3] = [255, 59, 48];

/// A region on screen: x, y, width, height in pixels.
pub type Rect = (f32, f32, f32, f32);

/// What the screenshot overlay holds: the frozen screen, the region picked
/// off it, and the marks drawn on that region.
#[derive(Default)]
pub struct Marking {
    pub screen: Option<RgbaImage>,
    pub region: Option<Rect>,
    pub marks: Vec<Mark>,
    /// The marks before each draw, move or delete, for Ctrl+Z.
    pub history: Vec<Vec<Mark>>,
    /// Clicked or just moved; Delete removes it.
    pub selected: Option<usize>,
    next: u64,
}

impl Marking {
    pub fn new(screen: RgbaImage) -> Self {
        Self { screen: Some(screen), ..Default::default() }
    }

    /// The shot: this region of the frozen screen. Ink made on an earlier
    /// region belonged to that picture, so it goes with it.
    pub fn take(&mut self, r: Rect) {
        self.region = Some(r);
        self.marks.clear();
        self.history.clear();
        self.selected = None;
    }

    pub fn whole_screen(&mut self) {
        if let Some(s) = &self.screen {
            let (w, h) = s.dimensions();
            self.take((0.0, 0.0, w as f32, h as f32));
        }
    }

    pub fn checkpoint(&mut self) {
        self.history.push(self.marks.clone());
    }

    pub fn undo(&mut self) {
        if let Some(last) = self.history.pop() {
            self.marks = last;
            self.selected = None;
        }
    }

    pub fn delete_selected(&mut self) {
        let Some(i) = self.selected.filter(|i| *i < self.marks.len()) else { return };
        self.checkpoint();
        self.marks.remove(i);
        self.selected = None;
    }

    /// Starts a stroke at `p`.
    pub fn begin(&mut self, p: (f32, f32)) {
        self.next += 1;
        self.marks.push(Mark { id: self.next, points: vec![p] });
    }

    /// The topmost mark within reach of `p`, by any segment of its line.
    pub fn hit(&self, p: (f32, f32)) -> Option<usize> {
        hit(&self.marks, p)
    }

    /// The region with its marks, at the screen's own resolution.
    pub fn done(&self) -> Option<RgbaImage> {
        let (r, screen) = (self.region?, self.screen.as_ref()?);
        Some(inked(screen, &self.marks, r))
    }
}

/// The topmost mark within 10px of `p`.
pub fn hit(marks: &[Mark], p: (f32, f32)) -> Option<usize> {
    marks.iter().rposition(|m| {
        if m.points.len() == 1 {
            return dist(p, m.points[0]) <= 10.0;
        }
        m.points.windows(2).any(|w| segment_dist(p, w[0], w[1]) <= 10.0)
    })
}

fn dist(a: (f32, f32), b: (f32, f32)) -> f32 {
    ((a.0 - b.0).powi(2) + (a.1 - b.1).powi(2)).sqrt()
}

fn segment_dist(p: (f32, f32), a: (f32, f32), b: (f32, f32)) -> f32 {
    let d = (b.0 - a.0, b.1 - a.1);
    let len = (d.0 * d.0 + d.1 * d.1).max(0.0001);
    let t = (((p.0 - a.0) * d.0 + (p.1 - a.1) * d.1) / len).clamp(0.0, 1.0);
    dist(p, (a.0 + t * d.0, a.1 + t * d.1))
}

/// `still`'s `region` with `marks` drawn over it, marks in screen pixels like
/// the region. Each stroke is round-capped and round-joined, anti-aliased by
/// coverage, so it reads as the overlay drew it.
pub fn inked(still: &RgbaImage, marks: &[Mark], region: Rect) -> RgbaImage {
    let (x0, y0) = (region.0.max(0.0).round() as u32, region.1.max(0.0).round() as u32);
    let w = (region.2.round() as u32).min(still.width().saturating_sub(x0)).max(1);
    let h = (region.3.round() as u32).min(still.height().saturating_sub(y0)).max(1);
    let mut out = image::imageops::crop_imm(still, x0, y0, w, h).to_image();
    let radius = INK_WIDTH / 2.0;
    for mark in marks {
        let pts: Vec<(f32, f32)> = mark.points.iter().map(|p| (p.0 - x0 as f32, p.1 - y0 as f32)).collect();
        let segs: Vec<((f32, f32), (f32, f32))> = if pts.len() == 1 { vec![(pts[0], pts[0])] } else { pts.windows(2).map(|s| (s[0], s[1])).collect() };
        // A stroke's coverage is the nearest distance to any of its segments,
        // so the joins are round and overlaps never darken twice.
        let Some((bx, by, bw, bh)) = mark.bounds() else { continue };
        let (lx, ly) = ((bx - x0 as f32).floor().max(0.0) as u32, (by - y0 as f32).floor().max(0.0) as u32);
        let (hx, hy) = (((bx + bw - x0 as f32).ceil() as u32).min(w), ((by + bh - y0 as f32).ceil() as u32).min(h));
        for y in ly..hy {
            for x in lx..hx {
                let c = (x as f32 + 0.5, y as f32 + 0.5);
                let d = segs.iter().map(|(a, b)| segment_dist(c, *a, *b)).fold(f32::MAX, f32::min);
                let cover = (radius + 0.5 - d).clamp(0.0, 1.0);
                if cover > 0.0 {
                    let px = out.get_pixel_mut(x, y);
                    for i in 0..3 {
                        px[i] = (px[i] as f32 * (1.0 - cover) + INK[i] as f32 * cover).round() as u8;
                    }
                    px[3] = 255;
                }
            }
        }
    }
    out
}

/// PNG, unless that passes the API's 5MB image ceiling — over it Dray sends
/// the file as a path the model has to open — so a big region steps down
/// through JPEG qualities until it fits. Into a folder of the island's own,
/// swept of week-old captures on the way: a sent one is already copied into
/// the session's attachments.
pub fn write(image: &RgbaImage) -> std::io::Result<PathBuf> {
    use image::ImageEncoder;
    const CAP: usize = 5 * 1024 * 1024;
    let mut png = Vec::new();
    image::codecs::png::PngEncoder::new(&mut png)
        .write_image(image.as_raw(), image.width(), image.height(), image::ExtendedColorType::Rgba8)
        .map_err(std::io::Error::other)?;
    let (mut data, mut ext) = (png, "png");
    if data.len() > CAP {
        let rgb = image::DynamicImage::ImageRgba8(image.clone()).to_rgb8();
        for quality in [85, 70, 50, 30] {
            let mut jpg = Vec::new();
            image::codecs::jpeg::JpegEncoder::new_with_quality(&mut jpg, quality)
                .encode_image(&rgb)
                .map_err(std::io::Error::other)?;
            (data, ext) = (jpg, "jpg");
            if data.len() <= CAP {
                break;
            }
        }
    }
    let dir = folder();
    sweep(&dir);
    std::fs::create_dir_all(&dir)?;
    let name = format!("Screenshot {}.{ext}", &uuid::Uuid::new_v4().simple().to_string()[..8]);
    let path = dir.join(name);
    std::fs::write(&path, data)?;
    Ok(path)
}

fn folder() -> PathBuf {
    std::env::temp_dir().join(format!("dray-island-{}", whoami()))
}

/// The user's id, so two accounts on one machine never share the folder.
fn whoami() -> u32 {
    use std::os::unix::fs::MetadataExt;
    std::env::home_dir().and_then(|h| std::fs::metadata(h).ok()).map_or(0, |m| m.uid())
}

fn sweep(dir: &Path) {
    let Ok(entries) = std::fs::read_dir(dir) else { return };
    let week = std::time::Duration::from_secs(7 * 24 * 3600);
    for e in entries.flatten() {
        let old = e.metadata().and_then(|m| m.modified()).ok().and_then(|t| t.elapsed().ok()).is_some_and(|age| age > week);
        if old {
            let _ = std::fs::remove_file(e.path());
        }
    }
}

/// Whether a draft row's file is a picture, which the prompt names
/// `[Image N]` and the model gets as an image block.
pub fn is_image(path: &str) -> bool {
    let ext = Path::new(path).extension().and_then(|e| e.to_str()).unwrap_or_default().to_lowercase();
    matches!(ext.as_str(), "png" | "jpg" | "jpeg" | "gif" | "webp" | "heic" | "bmp" | "tiff")
}

/// The padding around a moment's marks when it is taken, so the image shows
/// what they point at: the Mac's `Annotation.padding`.
pub const MOMENT_PADDING: f32 = 160.0;

/// A moment's area: every mark's bounds, padded, kept on the screen.
pub fn moment_area(marks: &[Mark], screen: (u32, u32)) -> Option<Rect> {
    let (mut x0, mut y0, mut x1, mut y1) = (f32::MAX, f32::MAX, f32::MIN, f32::MIN);
    for (x, y, w, h) in marks.iter().filter_map(Mark::bounds) {
        (x0, y0, x1, y1) = (x0.min(x), y0.min(y), x1.max(x + w), y1.max(y + h));
    }
    if x0 > x1 {
        return None;
    }
    let p = MOMENT_PADDING;
    let (x0, y0) = ((x0 - p).max(0.0).floor(), (y0 - p).max(0.0).floor());
    let (x1, y1) = ((x1 + p).min(screen.0 as f32).ceil(), (y1 + p).min(screen.1 as f32).ceil());
    (x1 > x0 && y1 > y0).then_some((x0, y0, x1 - x0, y1 - y0))
}

#[cfg(test)]
mod tests {
    use super::*;
    use image::Rgba;

    fn mark(points: &[(f32, f32)]) -> Mark {
        Mark { id: 1, points: points.to_vec() }
    }

    #[test]
    fn a_click_near_a_line_hits_it_and_far_misses() {
        let marks = [mark(&[(0.0, 0.0), (100.0, 0.0)]), mark(&[(50.0, 50.0)])];
        assert_eq!(hit(&marks, (50.0, 8.0)), Some(0));
        assert_eq!(hit(&marks, (52.0, 52.0)), Some(1));
        assert_eq!(hit(&marks, (50.0, 25.0)), None);
    }

    #[test]
    fn undo_steps_back_through_draws_and_deletes() {
        let mut m = Marking::new(RgbaImage::new(10, 10));
        m.checkpoint();
        m.begin((1.0, 1.0));
        m.selected = Some(0);
        m.delete_selected();
        assert!(m.marks.is_empty());
        m.undo();
        assert_eq!(m.marks.len(), 1);
        m.undo();
        assert!(m.marks.is_empty());
    }

    #[test]
    fn ink_lands_where_drawn_and_nowhere_else() {
        let still = RgbaImage::from_pixel(100, 100, Rgba([0, 0, 0, 255]));
        let out = inked(&still, &[mark(&[(20.0, 50.0), (80.0, 50.0)])], (10.0, 10.0, 80.0, 80.0));
        assert_eq!(out.dimensions(), (80, 80));
        // Region-local: the line at y 50 lands on row 40.
        assert_eq!(out.get_pixel(30, 40).0[..3], INK);
        assert_eq!(out.get_pixel(30, 10).0[..3], [0, 0, 0]);
    }

    #[test]
    fn a_moment_is_padded_and_kept_on_screen() {
        let area = moment_area(&[mark(&[(100.0, 100.0), (120.0, 110.0)])], (1920, 1080)).unwrap();
        assert_eq!(area, (0.0, 0.0, 284.0, 274.0));
        assert!(moment_area(&[], (1920, 1080)).is_none());
    }

    #[test]
    fn writes_a_png_it_can_read_back() {
        let path = write(&RgbaImage::from_pixel(8, 8, Rgba([1, 2, 3, 255]))).unwrap();
        assert!(path.extension().unwrap() == "png");
        let back = image::open(&path).unwrap().to_rgba8();
        assert_eq!(back.get_pixel(0, 0).0, [1, 2, 3, 255]);
        let _ = std::fs::remove_file(path);
    }

    #[test]
    fn knows_a_picture_by_its_name() {
        assert!(is_image("/tmp/a.PNG") && is_image("x.jpeg"));
        assert!(!is_image("notes.txt"));
    }
}
