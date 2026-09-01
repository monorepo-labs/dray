import startUrl from "@/assets/dictate-start.wav";
import stopUrl from "@/assets/dictate-stop.wav";

/// The two ends of a dictation, as sound.
///
/// Handy's own marimba pair (MIT — see THIRD-PARTY-LICENSES.md), and taken
/// rather than synthesized because the shape of the pair is the useful part:
/// the second tone answers the first, so the two read as one thing opening and
/// closing rather than as two unrelated beeps.
///
/// **`stop` plays when the words land, not when the microphone closes.** The
/// gap between the two is the whole wait, so a tone at the top of it announces
/// the end of something that has not ended. It is also why there is no third
/// sound for the wait itself.
///
/// **Cancel is silent**, and that is not an omission — Handy ships no sound for
/// it, and the one thing a tone here could say is that something was captured,
/// which a cancel is the reader saying they want undone.
type DictationSound = "start" | "stop";

/// Fixed rather than a setting. Feedback for a press the reader just made
/// should sit under the room, not over it.
const VOLUME = 0.35;

const clips: Record<DictationSound, HTMLAudioElement | null> = {
  start: null,
  stop: null,
};

/// Plays one of the pair, and never lets a failure reach the caller.
///
/// The element is kept and rewound rather than rebuilt per press: a fresh
/// `Audio` decodes on first play, which puts the tone a beat behind the press
/// it is meant to confirm. `catch` is required, not defensive — `play()`
/// rejects under an autoplay policy, and dictation must not fall over because
/// the tone did.
export function playDictationSound(sound: DictationSound) {
  try {
    let clip = clips[sound];

    if (!clip) {
      clip = new Audio(sound === "start" ? startUrl : stopUrl);
      clip.volume = VOLUME;
      clips[sound] = clip;
    }

    // Pressing again before the tone finishes should restart it, not be
    // ignored — which is what `play()` on an already-playing element does.
    clip.currentTime = 0;
    void clip.play().catch(() => {});
  } catch {
    // No audio output, a codec the webview will not take, a headless test —
    // none of them are a reason not to record.
  }
}
