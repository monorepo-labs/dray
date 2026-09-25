import { useEffect, useState } from "react";

/// Drawn over the browser pane's still for as long as a recording runs. The
/// page is laid out at the recording's size, not the pane's, so the still is
/// the page as it was when recording began — without this it reads as a
/// browser that froze while the agent went on working in it.
export default function RecordingNotice() {
  return (
    <div className="absolute inset-0 flex flex-col items-center justify-center gap-1.5 bg-background/80">
      <div className="mb-1 flex items-center gap-2">
        {/* Heroicons' solid camera with a hole punched in its body for the
            record light — no set ships the pair as one glyph. */}
        <svg viewBox="0 0 24 24" className="size-6" aria-hidden>
          <path
            fillRule="evenodd"
            d="M4.5 4.5a3 3 0 0 0-3 3v9a3 3 0 0 0 3 3h8.25a3 3 0 0 0 3-3v-9a3 3 0 0 0-3-3H4.5ZM19.94 18.75l-2.69-2.69V7.94l2.69-2.69c.944-.945 2.56-.276 2.56 1.06v11.38c0 1.336-1.616 2.005-2.56 1.06ZM8.625 8.25a3.75 3.75 0 1 0 0 7.5a3.75 3.75 0 1 0 0-7.5Z"
            className="fill-muted-foreground"
          />
          <circle cx="8.625" cy="12" r="2.25" className="animate-rec-blink fill-destructive" />
        </svg>
        <Elapsed />
      </div>
      <div className="text-sm font-medium">Recording in progress</div>
      <p className="max-w-64 text-center text-xs text-muted-foreground">
        Live view is paused until recording stops.
      </p>
    </div>
  );
}

/// Time since the notice appeared. ponytail: counted from mount, so a pane
/// opened mid-recording starts at 0:00; carry the start on `browser_recording`
/// if that ever misleads anybody.
function Elapsed() {
  const [start] = useState(Date.now);
  const [now, setNow] = useState(start);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const s = Math.floor((now - start) / 1000);
  return (
    <span className="text-xs text-muted-foreground tabular-nums">
      {Math.floor(s / 60)}:{String(s % 60).padStart(2, "0")}
    </span>
  );
}
