"use client";

import { useEffect, useRef, useState } from "react";
import { AppleGlyph } from "@/components/AppleGlyph";
import { GitHubGlyph } from "@/components/GitHubGlyph";
import { Wordmark } from "@/components/Wordmark";
import { HeroBackdrop } from "./HeroBackdrop";

const W = 1440;
const CELL =
  "flex h-full shrink-0 items-center justify-center gap-1.5 border-l border-white/20 font-mono text-[11px] leading-[14px] tracking-[0.06em] text-white uppercase";

/// This page's own hero, drawn at desktop size and scaled to whatever box holds
/// it: what the hero window's browser shows at localhost:3000. A skeleton
/// stands where the live window sits, or the picture would hold itself.
export function MiniHome() {
  const box = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(0);

  useEffect(() => {
    const el = box.current;
    if (!el) return;
    const ro = new ResizeObserver(([e]) => setScale(e.contentRect.width / W));
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  return (
    <div ref={box} aria-hidden className="absolute inset-0 overflow-hidden bg-black">
      <div className="relative h-[900px] origin-top-left font-inter" style={{ width: W, transform: `scale(${scale})` }}>
        <HeroBackdrop id="mini-hero" />
        <div className="relative mx-auto w-[960px]">
          <div className="flex h-10 items-start justify-between">
            <div className="flex h-10 w-[120px] items-center bg-black pl-4">
              <Wordmark className="h-[11px] w-auto text-white" />
            </div>
            <div className="flex h-10 border-r border-b border-white/20">
              <span className={`${CELL} w-[72px]`}>Docs</span>
              <span className={`${CELL} w-24`}>Sponsor</span>
              <span className={`${CELL} w-20`}>
                <GitHubGlyph className="size-3" />
                GitHub
              </span>
              <span className={`${CELL} w-[115px]`}>
                <AppleGlyph className="-mt-0.5 size-[11px]" />
                Download
              </span>
            </div>
          </div>

          <div className="ml-[102px] max-w-[756px] pt-[101px]">
            <div className="text-[46px] leading-[46px] tracking-[-0.03em] text-white">Run every agent harness in one app.</div>
            <div className="mt-8 flex items-start justify-between pr-5">
              <span className="inline-flex h-10 items-center gap-2 rounded-[6px] bg-white px-4 text-[14px] leading-5 font-medium text-[#0B0B0F]">
                <AppleGlyph className="-mt-0.5 size-4" />
                Download for macOS
              </span>
              <span className="text-[14px] leading-5 tracking-[-0.01em] text-white/30">Free and open source</span>
            </div>
          </div>

          <Skeleton />
        </div>
      </div>
    </div>
  );
}

/// A blank app window: chrome, a sidebar of rows, a chat column and a panel.
function Skeleton() {
  const bar = "rounded-full bg-white/[0.07]";
  return (
    <div className="mt-20 flex h-[600px] flex-col overflow-hidden rounded-[12px] border border-white/10 bg-[#0A0A0A] shadow-[0_2px_50px_12px_#0000004D]">
      <div className="flex h-10 shrink-0 items-center gap-2 px-4">
        {[0, 1, 2].map((i) => (
          <span key={i} className="size-3 rounded-full bg-white/10" />
        ))}
        <span className={`ml-6 h-5 w-40 ${bar}`} />
        <span className={`h-5 w-32 ${bar}`} />
      </div>
      <div className="flex min-h-0 flex-1 gap-2 px-2 pb-2">
        <div className="flex w-[200px] shrink-0 flex-col gap-4 p-4">
          {[70, 55, 62, 0, 80, 66, 74, 0, 58, 70].map((w, i) =>
            w ? <span key={i} className={`h-2.5 ${bar}`} style={{ width: `${w}%` }} /> : <span key={i} className="h-2" />,
          )}
        </div>
        <div className="flex flex-1 flex-col gap-4 rounded-[10px] bg-white/[0.03] p-8">
          {[86, 92, 60].map((w) => (
            <span key={w} className={`h-3 ${bar}`} style={{ width: `${w}%` }} />
          ))}
          <span className={`h-9 w-48 self-end rounded-[10px] bg-white/[0.07]`} />
          {[78, 50].map((w) => (
            <span key={w} className={`h-3 ${bar}`} style={{ width: `${w}%` }} />
          ))}
          <span className="mt-auto h-14 rounded-[12px] bg-white/[0.06]" />
        </div>
        <div className="flex w-[260px] shrink-0 flex-col gap-4 rounded-[10px] bg-white/[0.03] p-5">
          {[60, 85, 40, 0, 70, 70, 70].map((w, i) =>
            w ? <span key={i} className={`h-2.5 ${bar}`} style={{ width: `${w}%` }} /> : <span key={i} className="h-2" />,
          )}
        </div>
      </div>
    </div>
  );
}
