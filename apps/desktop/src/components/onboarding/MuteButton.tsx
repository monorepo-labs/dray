import { Volume2, VolumeX } from "lucide-react";

import { setOnboardingMusicMuted, useOnboardingMusic } from "./welcomeSounds";

/// Mutes onboarding's song, at the titlebar row's right end. Faint until
/// pointed at, so it never competes with the page; gone once the song ends.
export default function MuteButton() {
  const { playing, muted } = useOnboardingMusic();
  if (!playing) return null;
  const Icon = muted ? VolumeX : Volume2;
  return (
    <button
      type="button"
      aria-label={muted ? "Unmute music" : "Mute music"}
      aria-pressed={muted}
      onClick={() => setOnboardingMusicMuted(!muted)}
      className="mr-3 flex size-7 shrink-0 items-center justify-center rounded-md text-white opacity-20 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-white/60"
    >
      <Icon className="size-4" />
    </button>
  );
}
