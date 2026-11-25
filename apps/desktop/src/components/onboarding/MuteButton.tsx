import { setOnboardingMusicMuted, useOnboardingMusic } from "./welcomeSounds";

/// Mutes onboarding's song, at the titlebar row's right end. Faint until
/// pointed at, so it never competes with the page; gone once the song ends.
/// Drawn like Continue's arrow and the sign-in cards' icons: a bare 24-grid
/// stroke of 2 with square caps and sharp joins, no button chrome.
export default function MuteButton() {
  const { playing, muted } = useOnboardingMusic();
  if (!playing) return null;
  return (
    <button
      type="button"
      aria-label={muted ? "Unmute music" : "Mute music"}
      aria-pressed={muted}
      onClick={() => setOnboardingMusicMuted(!muted)}
      className="flex h-full shrink-0 items-center px-4 text-white opacity-20 transition-opacity hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none"
    >
      <svg width="20" height="20" viewBox="0 0 24 24" aria-hidden>
        <path
          d={muted ? "M3 9h4l5-4v14l-5-4H3ZM16 9l6 6M22 9l-6 6" : "M3 9h4l5-4v14l-5-4H3ZM16 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14"}
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="square"
        />
      </svg>
    </button>
  );
}
