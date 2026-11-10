//! The dictation orb: the Mac island's `prism` shader (VoiceOrb.metal and
//! VoiceOrb.h), translated line for line and run on the CPU a frame at a time.
//! The orb is at most 80pt, a few thousand pixels, and this box has no GPU to
//! hand a shader to, so a CPU pass is the simplest faithful route.
//!
//! Expanded mode's `lens` (LensOrb.metal) is the same light in a ball that
//! refracts a capture of the screen behind it; with no capture — the Mac
//! without its Screen Recording grant — it is this orb exactly at its shipped
//! settings, which is what runs here. See PLAN.md for why there is no capture.
//!
//! Everything that moves is `OrbDriver` and `OrbClock` from VoiceOrb.swift:
//! the level eased twice, recording and transcribing eased in and out, and a
//! phase that runs faster while busy, so a change of state never jumps.

use std::time::Instant;

#[derive(Clone, Copy, Debug, Default, PartialEq)]
struct V2 {
    x: f32,
    y: f32,
}

fn v2(x: f32, y: f32) -> V2 {
    V2 { x, y }
}

impl std::ops::Add for V2 {
    type Output = V2;
    fn add(self, o: V2) -> V2 {
        v2(self.x + o.x, self.y + o.y)
    }
}

impl std::ops::Sub for V2 {
    type Output = V2;
    fn sub(self, o: V2) -> V2 {
        v2(self.x - o.x, self.y - o.y)
    }
}

impl std::ops::Mul<f32> for V2 {
    type Output = V2;
    fn mul(self, s: f32) -> V2 {
        v2(self.x * s, self.y * s)
    }
}

impl std::ops::Mul for V2 {
    type Output = V2;
    fn mul(self, o: V2) -> V2 {
        v2(self.x * o.x, self.y * o.y)
    }
}

type V3 = [f32; 3];

fn dot(a: V2, b: V2) -> f32 {
    a.x * b.x + a.y * b.y
}

fn length(a: V2) -> f32 {
    dot(a, a).sqrt()
}

fn normalize(a: V2) -> V2 {
    a * (1.0 / length(a))
}

fn fract(x: f32) -> f32 {
    x - x.floor()
}

fn saturate(x: f32) -> f32 {
    x.clamp(0.0, 1.0)
}

/// Metal's `smoothstep`, edges either way round, as the shader uses it.
fn smoothstep(e0: f32, e1: f32, x: f32) -> f32 {
    let t = saturate((x - e0) / (e1 - e0));
    t * t * (3.0 - 2.0 * t)
}

fn mix(a: f32, b: f32, t: f32) -> f32 {
    a + (b - a) * t
}

fn mix3(a: V3, b: V3, t: f32) -> V3 {
    [mix(a[0], b[0], t), mix(a[1], b[1], t), mix(a[2], b[2], t)]
}

fn add3(a: V3, b: V3) -> V3 {
    [a[0] + b[0], a[1] + b[1], a[2] + b[2]]
}

fn scale3(a: V3, s: f32) -> V3 {
    [a[0] * s, a[1] * s, a[2] * s]
}

fn hash21(p: V2) -> f32 {
    let mut p = v2(fract(p.x * 123.34), fract(p.y * 456.21));
    let d = dot(p, p + v2(45.32, 45.32));
    p = v2(p.x + d, p.y + d);
    fract(p.x * p.y)
}

fn noise(p: V2) -> f32 {
    let i = v2(p.x.floor(), p.y.floor());
    let f = v2(fract(p.x), fract(p.y));
    let u = f * f * (v2(3.0, 3.0) - f * 2.0);
    mix(
        mix(hash21(i), hash21(i + v2(1.0, 0.0)), u.x),
        mix(hash21(i + v2(0.0, 1.0)), hash21(i + v2(1.0, 1.0)), u.x),
        u.y,
    )
}

fn rot(p: V2, a: f32) -> V2 {
    let (s, c) = a.sin_cos();
    v2(c * p.x - s * p.y, s * p.x + c * p.y)
}

/// The palette as a loop, so any phase maps to a colour and nothing seams.
fn ramp(x: f32, c: &[V3; 4]) -> V3 {
    let s = fract(x) * 4.0;
    let f = smoothstep(0.0, 1.0, fract(s));
    if s < 1.0 {
        mix3(c[0], c[1], f)
    } else if s < 2.0 {
        mix3(c[1], c[2], f)
    } else if s < 3.0 {
        mix3(c[2], c[3], f)
    } else {
        mix3(c[3], c[0], f)
    }
}

fn bump(x: f32, c: f32, w: f32) -> f32 {
    let d = (x - c) / w;
    saturate(1.0 - d * d)
}

/// Light split by a prism, red at 0 to violet at 1.
fn spectral(x: f32) -> V3 {
    let c = [bump(x, 0.15, 0.32) + 0.35 * bump(x, 0.95, 0.12), bump(x, 0.42, 0.22), bump(x, 0.78, 0.25)];
    [c[0] * 0.85 + 0.12, c[1] * 0.85 + 0.12, c[2] * 0.85 + 0.12]
}

/// Across a split beam, 0 at the top to 1 at the bottom: the rainbow, or the
/// palette in order.
fn band(x: f32, prismatic: f32, c: &[V3; 4]) -> V3 {
    let r = ramp(x * 0.75, c);
    mix3([r[0] * 0.9 + 0.08, r[1] * 0.9 + 0.08, r[2] * 0.9 + 0.08], spectral(x), prismatic)
}

/// `PrismOrb.rainbow`: what the shader takes where `spectral` leaves it a palette to read.
pub const RAINBOW: [V3; 4] = [[1.0, 0.45, 0.25], [1.0, 0.85, 0.3], [0.3, 0.85, 1.0], [0.55, 0.4, 1.0]];

/// One frame's inputs, `ORB_ARGS` and the prism's own, every one already eased.
#[derive(Clone, Copy, Debug)]
pub struct Frame {
    /// The orb's size in points, which is what the shader reads as `size`.
    pub size: f32,
    pub t: f32,
    pub level: f32,
    pub energy: f32,
    pub rec: f32,
    pub work: f32,
    pub spin: f32,
    pub curl: f32,
}

impl Frame {
    pub fn at_rest(size: f32) -> Self {
        Self { size, t: 0.0, level: 0.0, energy: 0.0, rec: 0.0, work: 0.0, spin: 0.0, curl: 0.0 }
    }
}

/// `prism(pos, …)` at its shipped settings: clear glass (`milk` 0) split into
/// the true rainbow (`prismatic` 1). Answers premultiplied RGB and alpha.
pub fn prism(pos: (f32, f32), f: &Frame) -> [f32; 4] {
    let (milk, prismatic) = (0.0_f32, 1.0_f32);
    let c = &RAINBOW;
    let size = v2(f.size, f.size);
    let (t, level, energy, rec) = (f.t, f.level, f.energy, f.rec);
    // ORB_SETUP
    let uv = (v2(pos.0, pos.1) - size * 0.5) * (1.0 / (size.x * 0.5));
    let r = length(uv);
    let aa = 2.0 / size.x;

    let big_r = 0.95;
    let mask = 1.0 - smoothstep(big_r - aa * 2.0, big_r, r);
    if mask <= 0.0 {
        return [0.0; 4];
    }
    let dir = if r > 1e-4 { uv * (1.0 / r) } else { v2(1.0, 0.0) };

    let small = 1.0 - smoothstep(30.0, 46.0, size.x);
    let shade = mix(0.03 + 0.07 * small * (1.0 - 0.4 * (uv.y + 1.0)), 0.3 - 0.06 * uv.y, milk) * (1.0 + 0.2 * rec);
    let mut body: V3 = [shade; 3];
    let rim = smoothstep(0.7 - 0.12 * small, big_r, r);
    let lit = rim
        * (0.06 + 0.2 * milk + 0.28 * small)
        * mix(0.5 + saturate(dot(dir, normalize(v2(0.6, 0.7)))), 1.0, small);
    body = add3(body, [lit; 3]);
    body = add3(body, scale3(band(saturate((r - 0.8) / 0.14), prismatic, c), rim * saturate(-dir.x * 1.2) * 0.45 * (1.0 - small)));
    let glint = uv - v2(-0.42, -0.48);
    let g = (-dot(glint, glint) / 0.018).exp() * 0.7 * small;
    body = add3(body, [g; 3]);

    // The band's own coordinates: `x` along it, `d` across it, below positive.
    let bend = smoothstep(0.0, 1.0, f.curl);
    let ring = 0.78;
    let p = rot(uv, -f.spin);
    let mid = mix(0.06, ring, bend);
    let (mut x, mut d) = (p.x, p.y - mid);
    if bend > 1e-3 {
        let rho = ring / bend;
        let v = p - v2(0.0, mid - rho);
        x = rho * v.x.atan2(v.y);
        d = length(v) - rho;
    }
    // Travelling waves at a steady speed; the voice only swells them, through the slow `energy`.
    let wave = ((0.06 + 0.1 * energy + 0.03 * level) * (x * 2.4 - t * 2.1).sin()
        + (0.015 + 0.05 * energy) * (x * 4.1 - t * 3.0 + 1.0).sin())
        * (1.0 - 0.75 * bend);
    d -= wave;
    let width = (0.17 + 0.05 * energy + 0.02 * level) * (1.0 - 0.35 * bend) * (1.0 + 0.35 * small);
    let s = d / width;
    // `pow(v, 2.0)` in the shader; squared directly, since a power of a
    // negative base is undefined there and only the square is meant.
    let sq = |v: f32| v * v;
    let along = (-sq((x + 0.08) / (0.42 + 0.12 * energy))).exp();
    let shimmer = 0.8 + 0.4 * noise(v2(x * 4.0 + t * 0.6, t * 0.3));
    // Curled, it reads as a comet: brightest at the leading end, the -x one.
    let comet = mix(1.0, 0.35 + 1.1 * smoothstep(0.7, -0.5, x), bend);
    let power = (0.6 + 0.25 * rec + 0.4 * energy + 0.25 * level + 0.3 * bend) * shimmer * comet * (1.0 + 0.15 * small);

    let mut hues = band(saturate(0.45 + s * 0.42), prismatic, c);
    hues = mix3(hues, [saturate(hues[0] * 1.35 - 0.18), saturate(hues[1] * 1.35 - 0.18), saturate(hues[2] * 1.35 - 0.18)], small);
    let mut light = scale3(hues, (-s * s * 1.3).exp() * along * 1.3);
    let warm = v2(x + 0.06, d + 0.15);
    let warm_tint = mix3(scale3(mix3(c[0], c[1], 0.5), 0.55), [1.0, 0.7, 0.3], prismatic);
    light = add3(light, scale3(warm_tint, (-dot(warm, warm) / 0.08).exp() * (1.0 - 0.8 * bend) * (1.0 - 0.5 * small)));
    let fw = (aa * 0.9).max(0.022);
    let fy = d - 0.05 - 0.04 * (x * 3.2 + 0.8 - t * 2.1).sin() * (1.0 - 0.75 * bend);
    let reach = smoothstep(-0.6, -0.25, x) * smoothstep(0.75, 0.35, x);
    light = add3(light, scale3([1.0, 0.98, 0.95], (-fy * fy / (fw * fw)).exp() * reach * 1.4 * (1.0 - 0.45 * small)));
    let blue = mix3(c[3], [0.35, 0.4, 1.0], prismatic);
    light = add3(light, scale3(blue, (-sq((d - 0.2) / 0.12)).exp() * along * 0.35));

    // premul(body + light * power * mix(1, 0.85, milk), mask)
    let k = power * mix(1.0, 0.85, milk);
    let col = add3(body, scale3(light, k));
    [saturate(col[0]) * mask, saturate(col[1]) * mask, saturate(col[2]) * mask, mask]
}

/// The orb drawn at `pixels` square, the shader's `size` being `frame.size`:
/// a 48px slot showing the 80pt lens orb scaled down, as expanded mode's rest
/// does, samples the 80pt orb. BGRA, premultiplied, as GPUI's images are.
pub fn render(frame: &Frame, pixels: u32) -> Vec<u8> {
    let step = frame.size / pixels as f32;
    let mut out = vec![0u8; (pixels * pixels * 4) as usize];
    for j in 0..pixels {
        for i in 0..pixels {
            let c = prism(((i as f32 + 0.5) * step, (j as f32 + 0.5) * step), frame);
            let at = ((j * pixels + i) * 4) as usize;
            let byte = |v: f32| (v * 255.0 + 0.5) as u8;
            out[at] = byte(c[2]);
            out[at + 1] = byte(c[1]);
            out[at + 2] = byte(c[0]);
            out[at + 3] = byte(c[3]);
        }
    }
    out
}

/// Writes the orb at rest and at fixed levels, at 2x like a Retina capture,
/// over the panel's black: what the PR sets beside the Mac's frames. Each
/// still has every input pinned, so the two sides draw the same moment.
pub fn write_references(dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let shot = |name: &str, frame: Frame, scale: u32| -> std::io::Result<()> {
        let pixels = frame.size as u32 * scale;
        let bgra = render(&frame, pixels);
        // Premultiplied over black is the colour itself.
        let rgb: Vec<u8> = bgra.chunks_exact(4).flat_map(|p| [p[2], p[1], p[0]]).collect();
        let img = image::RgbImage::from_raw(pixels, pixels, rgb).expect("a square of pixels");
        img.save(dir.join(format!("{name}.png"))).map_err(std::io::Error::other)
    };
    for size in [80.0, 24.0] {
        let tag = size as u32;
        shot(&format!("orb{tag}-rest"), Frame::at_rest(size), 2)?;
        for level in [0.0_f32, 0.3, 0.6, 1.0] {
            let f = Frame { size, t: 2.0, level, energy: level, rec: 1.0, work: 0.0, spin: 0.0, curl: 0.0 };
            shot(&format!("orb{tag}-rec-{:03}", (level * 100.0) as u32), f, 2)?;
        }
        let f = Frame { size, t: 3.0, level: 0.0, energy: 0.0, rec: 0.0, work: 1.0, spin: 1.2, curl: 1.0 };
        shot(&format!("orb{tag}-transcribing"), f, 2)?;
    }
    Ok(())
}

/// Renders every row of the Mac reference's `uniforms.csv` (`stills/` or
/// `video/`) at `size`pt and `scale`, one PNG per row named by its first
/// column, so the port can be diffed against the Mac's frames exactly.
pub fn write_from_csv(csv: &std::path::Path, size: f32, scale: u32, dir: &std::path::Path) -> std::io::Result<()> {
    std::fs::create_dir_all(dir)?;
    let text = std::fs::read_to_string(csv)?;
    let mut lines = text.lines();
    let header: Vec<&str> = lines.next().unwrap_or_default().split(',').collect();
    let col = |name: &str| header.iter().position(|h| *h == name);
    let at = |row: &[&str], name: &str| col(name).and_then(|i| row.get(i)).and_then(|v| v.parse::<f32>().ok()).unwrap_or(0.0);
    for line in lines.filter(|l| !l.is_empty()) {
        let row: Vec<&str> = line.split(',').collect();
        let frame = Frame {
            size,
            t: at(&row, "t"),
            level: at(&row, "level"),
            energy: at(&row, "energy"),
            rec: at(&row, "rec"),
            work: at(&row, "work"),
            spin: at(&row, "spin"),
            curl: at(&row, "curl"),
        };
        let pixels = (size as u32) * scale;
        let rgb: Vec<u8> = render(&frame, pixels).chunks_exact(4).flat_map(|p| [p[2], p[1], p[0]]).collect();
        let img = image::RgbImage::from_raw(pixels, pixels, rgb).expect("a square of pixels");
        img.save(dir.join(format!("{}.png", row[0]))).map_err(std::io::Error::other)?;
    }
    Ok(())
}

/// A raw sample peak as 0…1 on a decibel scale: a quiet room (−50 dBFS)
/// reads as nothing and ordinary speech fills most of the range.
pub fn loudness(peak: f32) -> f32 {
    let db = 20.0 * (peak.max(1e-6)).log10();
    ((db + 50.0) / 32.0).clamp(0.0, 1.0)
}

/// Where a dictation is, which is what the orb draws.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub enum Dictation {
    #[default]
    Idle,
    Starting,
    Recording,
    Transcribing,
}

/// SwiftUI's `.spring(duration:)`, bounce 0: critically damped, its response
/// the duration.
#[derive(Default)]
struct Spring {
    x: f32,
    v: f32,
}

impl Spring {
    fn step(&mut self, target: f32, duration: f32, dt: f32) -> f32 {
        let w = 2.0 * std::f32::consts::PI / duration;
        let delta = self.x - target;
        let e = (-w * dt).exp();
        let x = target + (delta + (self.v + w * delta) * dt) * e;
        self.v = (self.v - w * (self.v + w * delta) * dt) * e;
        self.x = x;
        x
    }
}

/// SwiftUI's `.easeInOut(duration:)`, the cubic Bézier (0.42, 0, 0.58, 1),
/// restarted from wherever it stands when its target moves.
struct EaseInOut {
    from: f32,
    to: f32,
    started: f64,
    duration: f64,
}

impl EaseInOut {
    fn new(duration: f64) -> Self {
        Self { from: 0.0, to: 0.0, started: f64::MIN, duration }
    }

    fn value(&self, now: f64) -> f32 {
        let p = ((now - self.started) / self.duration).clamp(0.0, 1.0) as f32;
        self.from + (self.to - self.from) * bezier(p, 0.42, 0.58)
    }

    fn set(&mut self, target: f32, now: f64) -> f32 {
        if target != self.to {
            self.from = self.value(now);
            self.to = target;
            self.started = now;
        }
        self.value(now)
    }
}

/// y at x on the cubic Bézier from (0,0) to (1,1) with control x1, x2 and
/// y 0, 1 — the ease-in-out curve — by Newton's method on x.
fn bezier(x: f32, x1: f32, x2: f32) -> f32 {
    let curve = |t: f32, a: f32, b: f32| 3.0 * a * t * (1.0 - t).powi(2) + 3.0 * b * t * t * (1.0 - t) + t.powi(3);
    let slope = |t: f32, a: f32, b: f32| 3.0 * a * (1.0 - t).powi(2) + 6.0 * (b - a) * t * (1.0 - t) + 3.0 * (1.0 - b) * t * t;
    let mut t = x;
    for _ in 0..8 {
        let dx = curve(t, x1, x2) - x;
        let s = slope(t, x1, x2);
        if s.abs() < 1e-6 {
            break;
        }
        t = (t - dx / s).clamp(0.0, 1.0);
    }
    curve(t, 0.0, 1.0)
}

/// The orb's motion for the process: one clock, since every orb on screen
/// hears the same voice and a layout swap must not restart it. `OrbDriver`
/// plus `OrbClock`.
pub struct Motion {
    epoch: Instant,
    /// Seconds since `epoch`, in f64: an island up for days keeps millisecond steps.
    last: Option<f64>,
    phase: f64,
    spin: f64,
    curl: f64,
    level: Spring,
    energy: Spring,
    rec: EaseInOut,
    work: EaseInOut,
    /// When the orb last had a reason to move; idle past 3s it holds still.
    idle_since: Option<f64>,
}

impl Default for Motion {
    fn default() -> Self {
        Self {
            epoch: Instant::now(),
            last: None,
            phase: 0.0,
            spin: 0.0,
            curl: 0.0,
            level: Spring::default(),
            energy: Spring::default(),
            rec: EaseInOut::new(0.45),
            work: EaseInOut::new(0.45),
            idle_since: None,
        }
    }
}

impl Motion {
    /// The next frame for `state` and the latest polled `peak`, and whether
    /// the orb is still moving and wants another.
    pub fn frame(&mut self, size: f32, state: Dictation, peak: f32) -> (Frame, bool) {
        let now = self.epoch.elapsed().as_secs_f64();
        self.frame_at(now, size, state, peak)
    }

    /// `frame` at a given moment, `now` seconds since this motion began.
    fn frame_at(&mut self, now: f64, size: f32, state: Dictation, peak: f32) -> (Frame, bool) {
        let dt = self.last.map_or(0.0, |l| (now - l).clamp(0.0, 0.1)) as f32;
        let voice = if state == Dictation::Recording { loudness(peak) } else { 0.0 };
        let level = self.level.step(voice, 0.15, dt);
        let energy = self.energy.step(voice, 1.0, dt);
        let rec = self.rec.set(if matches!(state, Dictation::Starting | Dictation::Recording) { 1.0 } else { 0.0 }, now);
        let work = self.work.set(if state == Dictation::Transcribing { 1.0 } else { 0.0 }, now);
        let (t, spin, curl) = self.advance(now, 0.35 + 0.8 * rec + 0.6 * work + 0.3 * energy, state == Dictation::Transcribing);
        if state == Dictation::Idle {
            self.idle_since.get_or_insert(now);
        } else {
            self.idle_since = None;
        }
        // Idle long enough that the orbit has wound home and uncurled.
        let moving = self.idle_since.is_none_or(|since| now - since < 3.0);
        (Frame { size, t, level, energy, rec, work, spin, curl }, moving)
    }

    /// `OrbClock.advance`: the phase, the transcribing orbit's angle, and how
    /// far into orbiting the orb is. Once transcribing ends it finishes its
    /// lap, easing to a stop where it began, and only then uncurls.
    fn advance(&mut self, now: f64, rate: f32, working: bool) -> (f32, f32, f32) {
        use std::f64::consts::PI;
        if let Some(last) = self.last
            && now > last
        {
            let dt = (now - last).min(0.1);
            self.phase += dt * rate as f64;
            let winding = !working && self.spin > 0.0;
            self.curl += ((if working || winding { 1.0 } else { 0.0 }) - self.curl) * (1.0 - (-dt / 0.15).exp());
            if working {
                self.spin += dt * 2.6 * self.curl;
            } else if winding {
                let home = (self.spin / (2.0 * PI)).ceil() * 2.0 * PI;
                self.spin = home.min(self.spin + dt * (8.0 * (home - self.spin)).max(4.0));
                if self.spin >= home - 0.002 {
                    self.spin = 0.0;
                }
            }
        }
        if now > self.last.unwrap_or(0.0) {
            self.last = Some(now);
        }
        ((self.phase % 3600.0) as f32, (self.spin % (2.0 * PI)) as f32, self.curl as f32)
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn outside_the_ball_is_clear() {
        let f = Frame::at_rest(80.0);
        assert_eq!(prism((0.5, 0.5), &f), [0.0; 4]);
        let mid = prism((40.0, 40.0), &f);
        assert_eq!(mid[3], 1.0);
        assert!(mid.iter().all(|c| c.is_finite()));
    }

    #[test]
    fn loudness_reads_decibels() {
        assert_eq!(loudness(0.0), 0.0);
        assert!((loudness(0.01) - 0.3125).abs() < 1e-4);
        assert_eq!(loudness(1.0), 1.0);
    }

    #[test]
    fn ease_in_out_meets_its_ends() {
        assert_eq!(bezier(0.0, 0.42, 0.58), 0.0);
        assert!((bezier(1.0, 0.42, 0.58) - 1.0).abs() < 1e-5);
        assert!((bezier(0.5, 0.42, 0.58) - 0.5).abs() < 1e-3);
        assert!(bezier(0.2, 0.42, 0.58) < 0.2);
    }

    /// The Mac's own run (`apps/island/Lab/reference/video/uniforms.csv` on the
    /// `orb-reference` branch): its states and raw peaks drive this motion, and
    /// every eased input must land where the Mac's did, frame by frame. Its
    /// springs and ease are written out rather than SwiftUI's own, so a small
    /// tolerance; `t`, `spin` and `curl` are the shipped `OrbClock`.
    #[test]
    fn motion_follows_the_mac_frame_by_frame() {
        let csv = include_str!("fixtures/orb-uniforms.csv");
        let mut lines = csv.lines();
        let header: Vec<&str> = lines.next().unwrap().split(',').collect();
        let col = |n: &str| header.iter().position(|h| *h == n).unwrap();
        let mut m = Motion::default();
        let mut worst = [0.0_f32; 7];
        for line in lines {
            let row: Vec<&str> = line.split(',').collect();
            let num = |n: &str| row[col(n)].parse::<f32>().unwrap();
            let state = match row[col("state")] {
                "recording" => Dictation::Recording,
                "transcribing" => Dictation::Transcribing,
                "starting" => Dictation::Starting,
                _ => Dictation::Idle,
            };
            let (f, _) = m.frame_at(num("time") as f64, 24.0, state, num("raw_peak"));
            let ours = [f.level, f.energy, f.rec, f.work, f.t, f.spin, f.curl];
            for (i, name) in ["level", "energy", "rec", "work", "t", "spin", "curl"].iter().enumerate() {
                worst[i] = worst[i].max((ours[i] - num(name)).abs());
            }
        }
        // level, energy, rec, work, t, spin, curl
        // Measured: 0.011, 0.0017, 0.0001, 0.0001, 0.006 (the phase, integrated
        // over 12s from rates that differ by those eases), 0.0016, 0.0004.
        let allowed = [0.015, 0.005, 0.001, 0.001, 0.01, 0.005, 0.001];
        for (i, (w, a)) in worst.iter().zip(allowed).enumerate() {
            assert!(w <= &a, "input {i} strays by {w}, allowed {a}");
        }
    }

    #[test]
    fn the_orbit_winds_home_before_it_uncurls() {
        let mut m = Motion::default();
        let (mut now, dt) = (0.0_f64, 1.0 / 60.0);
        for _ in 0..60 {
            now += dt;
            m.advance(now, 1.0, true);
        }
        assert!(m.spin > 0.0 && m.curl > 0.9);
        for _ in 0..600 {
            now += dt;
            m.advance(now, 1.0, false);
        }
        assert_eq!(m.spin, 0.0);
        assert!(m.curl < 0.01);
    }
}
