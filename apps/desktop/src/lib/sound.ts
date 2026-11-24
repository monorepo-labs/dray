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

/// Onboarding's welcome: a rising four-note bell over a soft echo, made in
/// code so there is no file to keep in step with it.
export function playWelcome() {
  try {
    const ctx = new AudioContext();
    const out = ctx.createGain();
    out.gain.value = 0.16;
    // A short darkened echo is what makes four plain sines ring like a bell.
    const echo = ctx.createDelay();
    echo.delayTime.value = 0.19;
    const feedback = ctx.createGain();
    feedback.gain.value = 0.3;
    const tone = ctx.createBiquadFilter();
    tone.type = "lowpass";
    tone.frequency.value = 2400;
    echo.connect(tone).connect(feedback).connect(echo);
    tone.connect(out);
    out.connect(ctx.destination);

    const start = ctx.currentTime + 0.02;
    [392, 587.33, 783.99, 987.77].forEach((hz, i) => {
      const at = start + i * 0.085;
      for (const [mult, level] of [
        [1, 1],
        [2, 0.18],
        [3, 0.05],
      ]) {
        const osc = ctx.createOscillator();
        osc.frequency.value = hz * mult;
        const env = ctx.createGain();
        env.gain.setValueAtTime(0, at);
        env.gain.linearRampToValueAtTime(level * (1 - i * 0.12), at + 0.008);
        env.gain.exponentialRampToValueAtTime(0.0001, at + 1.6 - i * 0.15);
        osc.connect(env);
        env.connect(out);
        env.connect(echo);
        osc.start(at);
        osc.stop(at + 1.7);
      }
    });
    setTimeout(() => void ctx.close(), 3500);
  } catch {
    // No audio output.
  }
}
