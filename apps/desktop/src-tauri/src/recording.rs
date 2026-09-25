//! A browser recording on disk: the page's JPEG frames streamed into a
//! Photo-JPEG QuickTime file, then handed to macOS's own `avconvert` for an
//! H.264 MP4 anything can play.
//!
//! Hand-muxed rather than encoded here, because the frames arrive already
//! compressed: the `.mov` is those bytes plus a table of where each starts
//! and how long it shows, so recording costs a file append per frame and no
//! encoder. `avconvert` is AVFoundation behind a command line and ships with
//! every Mac, which is what keeps this free of ffmpeg and of new crates.

use base64::Engine;
use std::fs::File;
use std::io::{self, Seek, SeekFrom, Write};
use std::path::{Path, PathBuf};
use std::sync::{mpsc, Mutex};
use std::thread::JoinHandle;
use std::time::{Duration, Instant};

/// Longest a frame is held for. The agent thinks for seconds between
/// actions and a frame identical to the last is never sent here, so a
/// real-time video is mostly a still page; capping each gap keeps the page's
/// own timing and drops the thinking.
const GAP_CAP: Duration = Duration::from_secs(1);
/// How long the last frame stays up, so the final state can be read before
/// the video ends.
const HOLD_LAST: Duration = Duration::from_millis(1500);
/// Sample offsets are `stco`'s 32 bits. ponytail: frames past this are
/// dropped; `co64` if recordings ever need to be longer than ~4GB of JPEG.
const MAX_BYTES: u64 = u32::MAX as u64 - (64 << 20);
const TIMESCALE: u32 = 1000;
/// Frames waiting for the writer. Each is ~100KB of base64, so this is a few
/// megabytes at most; a frame arriving to a full queue is dropped, since the
/// sender is CEF's UI thread and must never wait on a disk.
const QUEUE: usize = 64;

struct Frame {
    jpeg_base64: String,
    at: Instant,
}

struct Sample {
    offset: u32,
    size: u32,
    at: Instant,
}

/// A recording under way, ended by `finish` or `discard`.
pub struct Recorder {
    tx: mpsc::SyncSender<Frame>,
    /// The newest frame a full queue turned away, sent at `finish`: the page
    /// may stop painting right after it, and it is the final state the video
    /// exists to show. Cleared by any later frame that got through.
    dropped: Mutex<Option<Frame>>,
    thread: JoinHandle<Result<bool, String>>,
    mov: PathBuf,
}

impl Recorder {
    /// Starts writing `<stem>.mov` in `dir`; `finish` turns it into
    /// `<stem>.mp4` beside it.
    pub fn start(dir: &Path, stem: &str) -> Result<Recorder, String> {
        std::fs::create_dir_all(dir).map_err(|e| format!("could not create {}: {e}", dir.display()))?;
        let mov = dir.join(format!("{stem}.mov"));
        let file = File::create(&mov).map_err(|e| format!("could not create {}: {e}", mov.display()))?;
        let (tx, rx) = mpsc::sync_channel(QUEUE);
        let thread = std::thread::spawn(move || write(file, rx).map_err(|e| e.to_string()));
        Ok(Recorder { tx, dropped: Mutex::new(None), thread, mov })
    }

    /// One frame, stamped where it arrived. Never blocks: the
    /// capture loop must not wait on the writer, so a full queue sets the frame aside.
    pub fn frame(&self, jpeg_base64: String, at: Instant) {
        let mut dropped = self.dropped.lock().unwrap();
        *dropped = match self.tx.try_send(Frame { jpeg_base64, at }) {
            Err(mpsc::TrySendError::Full(frame)) => Some(frame),
            _ => None,
        };
    }

    /// Ends the recording without converting it and removes the `.mov`, for
    /// a session settled or deleted mid-recording. Blocking, like `finish`.
    pub fn discard(self) {
        let Recorder { tx, thread, mov, .. } = self;
        drop(tx);
        let _ = thread.join();
        let _ = std::fs::remove_file(&mov);
    }

    /// Closes the `.mov`, converts it and answers the `.mp4`'s path and
    /// whether frames were dropped at the size cap. The file is named after
    /// `name` where it slugs to anything, else after the start time.
    /// Blocking: the join and the conversion both take real time.
    pub fn finish(self, name: Option<&str>) -> Result<(PathBuf, bool), String> {
        let Recorder { tx, dropped, thread, mov } = self;
        // Blocking is fine here, off the UI thread: the writer drains the
        // queue and makes room.
        if let Some(last) = dropped.into_inner().unwrap() {
            let _ = tx.send(last);
        }
        drop(tx);
        let truncated = thread.join().map_err(|_| "the recording thread panicked".to_string())??;
        let mp4 = match name.map(slug).filter(|s| !s.is_empty()) {
            Some(stem) => unclaimed(mov.parent().unwrap_or(Path::new(".")), &stem),
            None => mov.with_extension("mp4"),
        };
        convert(&mov, &mp4)?;
        let _ = std::fs::remove_file(&mov);
        Ok((mp4, truncated))
    }
}

/// A name made safe to be a file's: lowercase letters and digits, every
/// other run of characters one hyphen, capped so a sentence stays a name.
/// Slashes and leading dots cannot survive it, so it never leaves the
/// directory or hides.
fn slug(name: &str) -> String {
    let mut out = String::new();
    for c in name.chars().flat_map(char::to_lowercase) {
        if c.is_ascii_alphanumeric() {
            out.push(c);
        } else if !out.is_empty() && !out.ends_with('-') {
            out.push('-');
        }
    }
    out.truncate(60);
    out.trim_end_matches('-').to_string()
}

/// `<stem>.mp4` in `dir`, or `<stem>-2.mp4` and upward where that is taken:
/// a second recording of the same feature must not overwrite the first.
fn unclaimed(dir: &Path, stem: &str) -> PathBuf {
    let mut path = dir.join(format!("{stem}.mp4"));
    let mut n = 2;
    while path.exists() {
        path = dir.join(format!("{stem}-{n}.mp4"));
        n += 1;
    }
    path
}

/// `avconvert` picks the container off the extension and the codec off the
/// preset: `.mp4` with `PresetHighestQuality` is H.264 at the source size.
/// Apple's Photo-JPEG decoder takes 4:2:0 frames, which is what Chromium
/// sends, and answers "Cannot Decode" for 4:4:4 — hence the fixtures' format.
fn convert(mov: &Path, mp4: &Path) -> Result<(), String> {
    let out = std::process::Command::new("/usr/bin/avconvert")
        .args(["--preset", "PresetHighestQuality", "--replace", "--source"])
        .arg(mov)
        .arg("--output")
        .arg(mp4)
        .output()
        .map_err(|e| format!("could not run avconvert: {e}"))?;
    if !out.status.success() {
        let said = String::from_utf8_lossy(&out.stderr);
        let said = said.trim();
        let said = if said.is_empty() { String::from_utf8_lossy(&out.stdout).trim().to_string() } else { said.into() };
        return Err(format!("avconvert could not encode the recording: {said}"));
    }
    Ok(())
}

/// The writer thread: frames go straight into `mdat` as they arrive, and the
/// index describing them is written once the channel closes.
fn write(mut file: File, rx: mpsc::Receiver<Frame>) -> io::Result<bool> {
    let ftyp = atom(b"ftyp", &[b"qt  ".as_slice(), &0x2005_0300u32.to_be_bytes(), b"qt  "].concat());
    file.write_all(&ftyp)?;
    let mdat_at = file.stream_position()?;
    file.write_all(&[0, 0, 0, 0])?;
    file.write_all(b"mdat")?;
    let mut samples: Vec<Sample> = Vec::new();
    let mut size: Option<(u16, u16)> = None;
    let mut truncated = false;
    for frame in rx {
        let Ok(jpeg) = base64::engine::general_purpose::STANDARD.decode(&frame.jpeg_base64) else { continue };
        let offset = file.stream_position()?;
        if offset + jpeg.len() as u64 > MAX_BYTES {
            truncated = true;
            continue;
        }
        if size.is_none() {
            size = jpeg_size(&jpeg);
        }
        file.write_all(&jpeg)?;
        samples.push(Sample { offset: offset as u32, size: jpeg.len() as u32, at: frame.at });
    }
    let Some((width, height)) = size.filter(|_| !samples.is_empty()) else {
        return Err(io::Error::other("no frames arrived: the page never painted while recording"));
    };
    let end = file.stream_position()?;
    file.seek(SeekFrom::Start(mdat_at))?;
    file.write_all(&((end - mdat_at) as u32).to_be_bytes())?;
    file.seek(SeekFrom::Start(end))?;
    let times: Vec<Instant> = samples.iter().map(|s| s.at).collect();
    file.write_all(&moov(&samples, &durations(&times), width, height))?;
    file.sync_all()?;
    Ok(truncated)
}

/// Each frame shows until the next arrives, capped at `GAP_CAP`, in
/// milliseconds; the last is held for `HOLD_LAST`. Never zero, since a
/// zero-length sample is one a player may skip.
fn durations(times: &[Instant]) -> Vec<u32> {
    let mut out: Vec<u32> = times
        .windows(2)
        .map(|w| (w[1] - w[0]).min(GAP_CAP).as_millis().max(1) as u32)
        .collect();
    if !times.is_empty() {
        out.push(HOLD_LAST.as_millis() as u32);
    }
    out
}

/// A JPEG's width and height, off its start-of-frame marker.
fn jpeg_size(jpeg: &[u8]) -> Option<(u16, u16)> {
    let mut i = 2;
    while i + 9 < jpeg.len() {
        if jpeg[i] != 0xFF {
            return None;
        }
        let marker = jpeg[i + 1];
        let len = u16::from_be_bytes([jpeg[i + 2], jpeg[i + 3]]) as usize;
        // SOF0–SOF15, less DHT (C4), JPG (C8) and DAC (CC), which share the range.
        if (0xC0..=0xCF).contains(&marker) && ![0xC4, 0xC8, 0xCC].contains(&marker) {
            let h = u16::from_be_bytes([jpeg[i + 5], jpeg[i + 6]]);
            let w = u16::from_be_bytes([jpeg[i + 7], jpeg[i + 8]]);
            return Some((w, h));
        }
        i += 2 + len;
    }
    None
}

fn atom(kind: &[u8; 4], body: &[u8]) -> Vec<u8> {
    let mut out = ((body.len() + 8) as u32).to_be_bytes().to_vec();
    out.extend_from_slice(kind);
    out.extend_from_slice(body);
    out
}

/// A version-0 full atom: one zero byte of version, three of flags.
fn full(kind: &[u8; 4], flags: u32, body: &[u8]) -> Vec<u8> {
    atom(kind, &[&flags.to_be_bytes()[..], body].concat())
}

const MATRIX: [u32; 9] = [0x0001_0000, 0, 0, 0, 0x0001_0000, 0, 0, 0, 0x4000_0000];

fn be(words: &[u32]) -> Vec<u8> {
    words.iter().flat_map(|w| w.to_be_bytes()).collect()
}

/// The movie's index: one video track, one sample per chunk, so every frame
/// carries its own offset and nothing needs grouping.
fn moov(samples: &[Sample], durations: &[u32], width: u16, height: u16) -> Vec<u8> {
    let total: u32 = durations.iter().sum();
    let n = samples.len() as u32;

    let mvhd = full(
        b"mvhd",
        0,
        &[
            be(&[0, 0, TIMESCALE, total, 0x0001_0000]),
            vec![0x01, 0x00],
            vec![0; 10],
            be(&MATRIX),
            vec![0; 24],
            be(&[2]),
        ]
        .concat(),
    );
    let tkhd = full(
        b"tkhd",
        0x3,
        &[
            be(&[0, 0, 1, 0, total, 0, 0]),
            vec![0; 8],
            be(&MATRIX),
            be(&[(width as u32) << 16, (height as u32) << 16]),
        ]
        .concat(),
    );
    let mdhd = full(b"mdhd", 0, &[be(&[0, 0, TIMESCALE, total]), vec![0x55, 0xC4, 0, 0]].concat());
    let hdlr = |kind: &[u8; 4], sub: &[u8; 4]| full(b"hdlr", 0, &[&kind[..], sub, &[0; 12], &[0]].concat());
    let vmhd = full(b"vmhd", 0x1, &[0; 8]);
    let dinf = atom(b"dinf", &full(b"dref", 0, &[be(&[1]), full(b"alis", 0x1, &[])].concat()));

    let mut compressor = [0u8; 32];
    compressor[0] = 10;
    compressor[1..11].copy_from_slice(b"Photo-JPEG");
    let entry = atom(
        b"jpeg",
        &[
            vec![0; 6],
            vec![0, 1],
            vec![0; 4],
            vec![0; 4],
            be(&[0, 0x200]),
            [width.to_be_bytes(), height.to_be_bytes()].concat(),
            be(&[72 << 16, 72 << 16, 0]),
            vec![0, 1],
            compressor.to_vec(),
            vec![0, 24, 0xFF, 0xFF],
        ]
        .concat(),
    );
    let stsd = full(b"stsd", 0, &[be(&[1]), entry].concat());
    let stts = full(
        b"stts",
        0,
        &[be(&[n]), durations.iter().flat_map(|d| be(&[1, *d])).collect()].concat(),
    );
    let stsc = full(b"stsc", 0, &be(&[1, 1, 1, 1]));
    let stsz = full(b"stsz", 0, &[be(&[0, n]), samples.iter().flat_map(|s| be(&[s.size])).collect()].concat());
    let stco = full(b"stco", 0, &[be(&[n]), samples.iter().flat_map(|s| be(&[s.offset])).collect()].concat());
    let stbl = atom(b"stbl", &[stsd, stts, stsc, stsz, stco].concat());

    let minf = atom(b"minf", &[vmhd, hdlr(b"dhlr", b"alis"), dinf, stbl].concat());
    let mdia = atom(b"mdia", &[mdhd, hdlr(b"mhlr", b"vide"), minf].concat());
    let trak = atom(b"trak", &[tkhd, mdia].concat());
    atom(b"moov", &[mvhd, trak].concat())
}

#[cfg(test)]
mod tests {
    use super::*;

    const FRAME1: &[u8] = include_bytes!("fixtures/recording/frame1.jpg");
    const FRAME2: &[u8] = include_bytes!("fixtures/recording/frame2.jpg");

    #[test]
    fn gaps_are_capped_and_the_last_frame_held() {
        let t = Instant::now();
        let times = [t, t + Duration::from_millis(40), t + Duration::from_secs(20), t + Duration::from_secs(20)];
        assert_eq!(durations(&times), vec![40, 1000, 1, 1500]);
        assert!(durations(&[]).is_empty());
    }

    #[test]
    fn reads_the_frame_size() {
        assert_eq!(jpeg_size(FRAME1), Some((160, 120)));
        assert_eq!(jpeg_size(b"not a jpeg at all"), None);
    }

    /// The whole path, `avconvert` included: a muxer that writes an index
    /// AVFoundation cannot read fails here rather than on the reader's screen.
    #[test]
    fn records_frames_into_a_playable_mp4() {
        let dir = std::env::temp_dir().join(format!("dray-recording-{}", std::process::id()));
        let recorder = Recorder::start(&dir, "test").unwrap();
        let t = Instant::now();
        let b64 = |b: &[u8]| base64::engine::general_purpose::STANDARD.encode(b);
        recorder.frame(b64(FRAME1), t);
        recorder.frame(b64(FRAME2), t + Duration::from_millis(500));
        let (mp4, truncated) = recorder.finish(None).unwrap();
        assert!(!truncated);
        assert_eq!(mp4, dir.join("test.mp4"));
        assert!(std::fs::metadata(&mp4).unwrap().len() > 0);
        assert!(!dir.join("test.mov").exists());

        // Named, twice: the second takes a number rather than the first's place.
        for expected in ["checkout-flow.mp4", "checkout-flow-2.mp4"] {
            let recorder = Recorder::start(&dir, "again").unwrap();
            recorder.frame(b64(FRAME1), t);
            let (mp4, _) = recorder.finish(Some("Checkout flow")).unwrap();
            assert_eq!(mp4, dir.join(expected));
        }
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn names_slug_safely() {
        assert_eq!(slug("Checkout flow: step 2!"), "checkout-flow-step-2");
        assert_eq!(slug("../../etc/passwd"), "etc-passwd");
        assert_eq!(slug(".hidden"), "hidden");
        assert_eq!(slug("日本"), "");
        assert!(slug(&"a ".repeat(100)).len() <= 60);
    }

    #[test]
    fn a_discarded_recording_leaves_no_file() {
        let dir = std::env::temp_dir().join(format!("dray-recording-discard-{}", std::process::id()));
        let recorder = Recorder::start(&dir, "gone").unwrap();
        recorder.frame(base64::engine::general_purpose::STANDARD.encode(FRAME1), Instant::now());
        recorder.discard();
        assert!(!dir.join("gone.mov").exists());
        let _ = std::fs::remove_dir_all(&dir);
    }

    #[test]
    fn a_recording_with_no_frames_says_so() {
        let dir = std::env::temp_dir().join(format!("dray-recording-empty-{}", std::process::id()));
        let err = Recorder::start(&dir, "empty").unwrap().finish(None).unwrap_err();
        assert!(err.contains("no frames"), "{err}");
        let _ = std::fs::remove_dir_all(&dir);
    }
}
