import startUrl from "@/assets/dictate-start.wav";
import stopUrl from "@/assets/dictate-stop.wav";

const clips = new Map<string, HTMLAudioElement>();

/// Plays a clip from the top, and never lets a failure reach the caller.
///
/// Elements are kept and rewound rather than rebuilt per play: a fresh `Audio`
/// decodes on first play, which puts the tone a beat behind what it confirms.
/// Rewinding also restarts a tone still playing, which `play()` alone ignores.
/// `catch` is required, not defensive — `play()` rejects under an autoplay
/// policy, and nothing here is a reason to stop what the sound announces.
function play(url: string, volume = 1) {
  try {
    let clip = clips.get(url);
    if (!clip) {
      clip = new Audio(url);
      clip.volume = volume;
      clips.set(url, clip);
    }
    clip.currentTime = 0;
    void clip.play().catch(() => {});
  } catch {
    // No audio output, a codec the webview will not take, a headless test.
  }
}

// Fetched and decoded while the app is idle instead of on the first settle.
for (const url of ["/celebration.wav", "/notification.wav"]) {
  const clip = new Audio(url);
  clip.preload = "auto";
  clips.set(url, clip);
}

export function playCelebration() {
  play("/celebration.wav");
}

/// The in-app half of a session handing itself back to the reader.
///
/// Paired with the sidebar glow rather than replacing it: the glow is at the
/// edge of vision and easy to miss while reading something else, and the sound
/// carries with the eyes anywhere on screen. Silent when the window is in the
/// background, since the desktop notification makes its own noise there.
export function playNotification() {
  play("/notification.wav");
}

/// The two ends of a dictation: Handy's own marimba pair (MIT, see
/// THIRD-PARTY-LICENSES.md), the second tone answering the first.
///
/// `stop` plays when the words land, not when the microphone closes — the gap
/// between the two is the whole wait. Cancel is silent, as in Handy. Volume is
/// fixed: feedback for a press should sit under the room, not over it.
export function playDictationSound(sound: "start" | "stop") {
  play(sound === "start" ? startUrl : stopUrl, 0.35);
}
