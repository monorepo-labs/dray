import { Maximize, Pause, Play } from "lucide-react";
import { useRef, useState } from "react";

import { cn } from "@/lib/utils";

/// A recording, played inline. Its own controls rather than the native ones:
/// WebKit's washes the whole frame grey on hover, from a shadow root nothing
/// here can style, and a video being checked for what changed on screen is
/// the last thing to draw over. Controls carry their own backing instead.
export default function VideoPlayer({ src }: { src: string }) {
  const video = useRef<HTMLVideoElement>(null);
  const [playing, setPlaying] = useState(false);
  const [time, setTime] = useState(0);
  const [duration, setDuration] = useState(0);

  const toggle = () => {
    const v = video.current;
    if (v) void (v.paused ? v.play() : v.pause());
  };
  // The element API where the webview allows it, WebKit's video-only one
  // where it refuses.
  const fullscreen = () => {
    const v = video.current as (HTMLVideoElement & { webkitEnterFullscreen?: () => void }) | null;
    v?.requestFullscreen().catch(() => v.webkitEnterFullscreen?.());
  };

  return (
    // A span, since it sits inside the paragraph that names the path.
    // `isolate`, or WebKit composites the video on a layer the radius does
    // not clip.
    <span className="group/video relative isolate mt-1.5 block w-fit max-w-full overflow-hidden rounded-xl border border-border">
      <video
        ref={video}
        // `#t` paints the first frame as a thumbnail; `metadata` alone paints
        // nothing, and `auto` downloads every recording in the transcript.
        src={`${src}#t=0.001`}
        preload="metadata"
        playsInline
        onClick={toggle}
        onPlay={() => setPlaying(true)}
        onPause={() => setPlaying(false)}
        onTimeUpdate={(e) => setTime(e.currentTarget.currentTime)}
        onLoadedMetadata={(e) => setDuration(e.currentTarget.duration)}
        className="block max-h-96 max-w-full cursor-pointer"
      />
      {!playing && (
        <button
          type="button"
          aria-label="Play"
          onClick={toggle}
          className="absolute top-1/2 left-1/2 flex size-12 -translate-1/2 items-center justify-center rounded-full bg-black/55 text-white backdrop-blur-sm"
        >
          <Play className="size-5 translate-x-px fill-current" />
        </button>
      )}
      <span
        className={cn(
          "absolute inset-x-2 bottom-2 flex items-center gap-2 rounded-lg bg-black/55 px-2 py-1 text-white backdrop-blur-sm transition-opacity",
          playing ? "opacity-0 group-hover/video:opacity-100" : "opacity-100",
        )}
      >
        <button type="button" aria-label={playing ? "Pause" : "Play"} onClick={toggle}>
          {playing ? <Pause className="size-4 fill-current" /> : <Play className="size-4 fill-current" />}
        </button>
        <input
          type="range"
          aria-label="Seek"
          min={0}
          max={duration || 0}
          step={0.01}
          value={time}
          onChange={(e) => {
            if (video.current) video.current.currentTime = Number(e.target.value);
          }}
          className="h-1 min-w-0 flex-1 cursor-pointer accent-white"
        />
        <span className="text-xs tabular-nums">
          {clock(time)} / {clock(duration)}
        </span>
        <button type="button" aria-label="Full screen" onClick={fullscreen}>
          <Maximize className="size-4" />
        </button>
      </span>
    </span>
  );
}

function clock(seconds: number): string {
  const s = Number.isFinite(seconds) ? Math.floor(seconds) : 0;
  return `${Math.floor(s / 60)}:${String(s % 60).padStart(2, "0")}`;
}
