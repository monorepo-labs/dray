/// How long a seek may take to put a frame on screen before the video is
/// played to one instead.
export const SEEK_GRACE_MS = 300;

/// The most it plays for a frame, so a video whose frames never reach the
/// screen (a hidden pane) stops instead of loading on.
export const PLAY_CAP_MS = 2000;

/// Past the start, so the seek is a real one rather than a no-op at zero.
const NUDGE = 0.001;

/// A thumbnail being painted, for a player that has to tell its own playback
/// apart from the user's.
export type FirstFrame = {
  /// True until a frame has landed or `stop` ran.
  active: () => boolean;
  /// Stops painting, pausing and unmuting a video it had playing.
  stop: () => void;
};

/// Puts a paused video's first frame on screen without loading the rest. Call
/// on `loadedmetadata`.
///
/// `preload="metadata"` alone paints nothing in WebKit, and a seek just past
/// zero paints nothing either where the stream starts later — an iOS simulator
/// recording's first frame is at ~0.095s, behind an empty edit WebKit lands
/// in. Nothing in the element says where the first frame is, so it seeks,
/// waits for a frame, and where none comes plays muted until one does.
///
/// A play or pause it did not make is the user's, through native controls,
/// and ends it there.
export function showFirstFrame(video: HTMLVideoElement): FirstFrame {
  const start = video.seekable.length > 0 ? video.seekable.start(0) : 0;
  if (typeof video.requestVideoFrameCallback !== "function") {
    video.currentTime = start + NUDGE;
    return { active: () => false, stop: () => {} };
  }

  let done = false;
  let played = false;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const muted = video.muted;

  const stop = () => {
    if (done) return;
    done = true;
    clearTimeout(timer);
    video.removeEventListener("seeked", onSeeked);
    video.removeEventListener("play", onPlay);
    video.removeEventListener("pause", onPause);
    video.cancelVideoFrameCallback(frame);
    if (played) {
      video.pause();
      video.muted = muted;
    }
  };
  const frame = video.requestVideoFrameCallback(stop);
  const onSeeked = () => {
    timer = setTimeout(() => {
      played = true;
      video.muted = true;
      video.play().catch(stop);
      timer = setTimeout(stop, PLAY_CAP_MS);
    }, SEEK_GRACE_MS);
  };
  // Its own pause only ever comes from `stop`, after `done` is set.
  const onPlay = () => {
    if (!played) stop();
  };
  const onPause = () => {
    if (played) stop();
  };

  video.addEventListener("seeked", onSeeked, { once: true });
  video.addEventListener("play", onPlay);
  video.addEventListener("pause", onPause);
  video.currentTime = start + NUDGE;
  return { active: () => !done, stop };
}
