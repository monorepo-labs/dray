import { replayOnboardingMusic, setOnboardingMusicMuted, useOnboardingMusic } from "./welcomeSounds";

const SPEAKER = "M3 9h4l5-4v14l-5-4H3Z";
const ICONS = {
  on: `${SPEAKER}M16 8.5a5 5 0 0 1 0 7M19 5a10 10 0 0 1 0 14`,
  muted: `${SPEAKER}M16 9l6 6M22 9l-6 6`,
  again: "M4 12a8 8 0 1 0 8-8 8.7 8.7 0 0 0-6 2.45L4 8.5M4 4v4.5h4.5",
};

/// The song's control, at the titlebar row's right end: mute and unmute while
/// it plays, play again once it is over. Faint until pointed at, so it never
/// competes with the page; absent until the song has played this run. Drawn
/// like Continue's arrow and the sign-in cards' icons: a bare 24-grid stroke
/// of 2 with square caps and sharp joins, no button chrome.
export default function MuteButton() {
  const { played, playing, muted } = useOnboardingMusic();
  if (!played) return null;
  const shown = !playing ? "again" : muted ? "muted" : "on";
  const label = { on: "Mute music", muted: "Unmute music", again: "Play music again" }[shown];
  return (
    <button
      type="button"
      aria-label={label}
      aria-pressed={playing ? muted : undefined}
      onClick={() => (playing ? setOnboardingMusicMuted(!muted) : replayOnboardingMusic())}
      className="grid h-full shrink-0 place-items-center px-4 text-white opacity-20 transition-opacity duration-200 ease-out hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none motion-reduce:transition-none"
    >
      {/* Stacked and cross-faded, so a swap eases rather than cuts. */}
      {(Object.keys(ICONS) as (keyof typeof ICONS)[]).map((icon) => (
        <svg
          key={icon}
          width="20"
          height="20"
          viewBox="0 0 24 24"
          aria-hidden
          className={`col-start-1 row-start-1 transition-[opacity,scale] duration-200 ease-out motion-reduce:transition-none ${icon === shown ? "scale-100 opacity-100" : "scale-75 opacity-0"}`}
        >
          <path d={ICONS[icon]} fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="square" />
        </svg>
      ))}
    </button>
  );
}
