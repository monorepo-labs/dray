import React from "react";
import ReactDOM from "react-dom/client";

import { Thumb } from "@/components/chat/ImageLightbox";
import VideoPlayer from "@/components/chat/VideoPlayer";
import { TooltipProvider } from "@/components/ui/tooltip";
import DemoThemeBar from "@/demo/ThemeBar";
import "../App.css";

/// Whether a recording paints its first frame before it plays, where the
/// stream starts at zero and where it starts late. `late-start.mp4` opens on
/// an empty edit to 0.095s, the shape of an iOS simulator recording, which the
/// old `#t=0.001` seek landed inside and painted nothing for in Safari and the
/// app. Judge it in Safari or the app: Chromium paints either way.

const CLIPS = [
  { name: "normal.mp4", note: "starts at 0" },
  { name: "late-start.mp4", note: "starts at 0.095s, like simctl" },
];

const src = (name: string) => `/demo/video-thumbs/${name}`;

function Demo() {
  return (
    <TooltipProvider>
      <div className="flex min-h-screen flex-col gap-6 bg-background p-6 text-chat text-foreground">
        <DemoThemeBar />
        {CLIPS.map((clip) => (
          <section key={clip.name} className="flex flex-col gap-2">
            <h2 className="font-medium">
              {clip.name} <span className="text-muted-foreground">— {clip.note}</span>
            </h2>
            <div className="flex flex-wrap items-start gap-6">
              <figure className="flex flex-col gap-1">
                <figcaption className="text-ui text-muted-foreground">Before: #t=0.001</figcaption>
                <video
                  src={`${src(clip.name)}#t=0.001`}
                  preload="metadata"
                  playsInline
                  className="rounded-xl border border-border"
                />
              </figure>
              <figure className="flex flex-col gap-1">
                <figcaption className="text-ui text-muted-foreground">VideoPlayer</figcaption>
                <VideoPlayer src={src(clip.name)} />
              </figure>
              <figure className="flex flex-col gap-1">
                <figcaption className="text-ui text-muted-foreground">Thumb</figcaption>
                <span className="size-20 overflow-hidden rounded-md border border-border">
                  <Thumb item={{ src: src(clip.name), name: clip.name, video: true }} className="size-full" />
                </span>
              </figure>
            </div>
          </section>
        ))}
      </div>
    </TooltipProvider>
  );
}

ReactDOM.createRoot(document.getElementById("root") as HTMLElement).render(
  <React.StrictMode>
    <Demo />
  </React.StrictMode>,
);
