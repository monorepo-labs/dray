"use client";

import { type ReactNode, type RefObject, useEffect, useRef, useState } from "react";
import { IslandOrb } from "@/components/home/IslandOrb";

/// True while the element is on screen.
function useInView(ref: RefObject<HTMLElement | null>) {
  const [inView, setInView] = useState(false);
  useEffect(() => {
    const io = new IntersectionObserver(([e]) => setInView(e.isIntersecting));
    if (ref.current) io.observe(ref.current);
    return () => io.disconnect();
  }, [ref]);
  return inView;
}

/// A card that sets `data-play` while on screen, which is what starts its CSS loops.
export function Play({ className, children }: { className?: string; children: ReactNode }) {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  return (
    <div ref={ref} className={className} data-play={inView ? "" : undefined}>
      {children}
    </div>
  );
}

const DRAFT = "add a retry test for the upload client";
// One loop, ms: rest, type, rest, press, Sent, back to the panel.
const TYPE_AT = 1000;
const PER_CHAR = 45;
const PRESS_AT = 3300;
const SENT_AT = 3450;
const BACK_AT = 4900;
const LOOP = 6400;

/// The Messages card's panel: a draft typed into the composer, sent, and the
/// island's Sent flash before the panel comes back.
export function MessagesPanel() {
  const ref = useRef<HTMLDivElement>(null);
  const inView = useInView(ref);
  const [t, setT] = useState(0);

  useEffect(() => {
    if (!inView || window.matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const start = performance.now();
    const id = setInterval(() => setT((performance.now() - start) % LOOP), 40);
    return () => {
      clearInterval(id);
      setT(0);
    };
  }, [inView]);

  const typed = Math.max(0, Math.min(DRAFT.length, Math.floor((t - TYPE_AT) / PER_CHAR)));
  const sent = t >= SENT_AT && t < BACK_AT;
  const pressed = t >= PRESS_AT && t < SENT_AT;
  // The panel clears behind the flash, as the real one does once it hides.
  const draft = t < SENT_AT ? DRAFT.slice(0, typed) : "";

  return (
    <div ref={ref} aria-hidden="true">
      <div
        className={`absolute bottom-[132px] left-1/2 flex w-[400px] max-w-[calc(100%-32px)] -translate-x-1/2 origin-bottom flex-col gap-3 rounded-[20px] bg-black px-4 py-3.5 shadow-[0_4px_12px_#00000059] transition-[opacity,scale] duration-250 ${sent ? "scale-95 opacity-0" : ""}`}
      >
        <div className="flex items-center gap-3">
          <div className="grow text-[13px] leading-4 font-semibold text-[#FFFFFFB3]">Retry uploads</div>
          <div className="text-[12px] leading-4 text-[#FFFFFF4D]">Esc</div>
        </div>
        <div className="flex flex-col gap-2">
          <div className="flex justify-end pl-16">
            <div className="rounded-xl bg-[#FFFFFF1A] px-2.5 py-1.5 text-[13px] leading-[18px] text-[#FFFFFFD9]">
              make uploads retry when the network drops
            </div>
          </div>
          <div className="text-[12px] leading-4 text-[#FFFFFF66]">8 tool calls</div>
          <div className="text-[13px] leading-[19px] text-[#FFFFFFF2]">
            Uploads now retry three times with backoff. Tests pass. The flaky one was a timeout in the mock, so I
            raised it to 2s.
          </div>
        </div>
        <div className="flex flex-col items-center gap-2.5 pt-1">
          <div className="relative size-[46px] shrink-0 overflow-clip rounded-full">
            <IslandOrb size={48} mode="idle" backdrop="#000000" className="absolute -top-px -left-px" />
          </div>
          <div className="flex items-center gap-2.5 self-stretch">
            <div className="min-w-0 grow truncate text-[13px] leading-[18px]">
              {draft ? (
                <span className="text-[#FFFFFFF2]">
                  {draft}
                  <span className="ml-px inline-block h-[15px] w-px translate-y-[3px] bg-white" />
                </span>
              ) : (
                <span className="text-[#FFFFFF4D]">⌃ to speak, ⏎ Send</span>
              )}
            </div>
            <svg width="18" height="18" viewBox="0 0 18 18" className="shrink-0">
              <path
                d="M2 6V4a2 2 0 0 1 2-2h2M12 2h2a2 2 0 0 1 2 2v2M16 12v2a2 2 0 0 1-2 2h-2M6 16H4a2 2 0 0 1-2-2v-2"
                fill="none"
                stroke="#FFFFFF99"
                strokeWidth="1.5"
                strokeLinecap="round"
              />
              <circle cx="9" cy="9" r="2.6" fill="none" stroke="#FFFFFF99" strokeWidth="1.5" />
            </svg>
            <svg
              width="22"
              height="22"
              viewBox="0 0 22 22"
              className={`shrink-0 transition-[scale] duration-100 ${pressed ? "scale-[0.85]" : ""}`}
            >
              <circle
                cx="11"
                cy="11"
                r="10"
                className="transition-[fill] duration-150"
                fill={draft ? "#FFFFFF" : "#FFFFFF59"}
              />
              <path
                d="M11 15.5V7M7.2 10.6 11 6.8l3.8 3.8"
                fill="none"
                stroke="#000000"
                strokeWidth="1.8"
                strokeLinecap="round"
                strokeLinejoin="round"
              />
            </svg>
          </div>
        </div>
      </div>
      <Flash label="Sent" className={`transition-[opacity,scale] duration-250 ${sent ? "" : "scale-90 opacity-0"}`} />
    </div>
  );
}

/// The island's confirmation once a card is answered: the card shrunk to a checkmark and what was done.
export function Flash({ label, className }: { label: string; className: string }) {
  return (
    <div
      className={`absolute bottom-[132px] left-1/2 flex -translate-x-1/2 origin-bottom items-center gap-1.5 rounded-[20px] bg-black px-4 py-3 text-[13px] leading-4 font-semibold text-white shadow-[0_4px_12px_#00000059] ${className}`}
    >
      <svg width="13" height="13" viewBox="0 0 13 13" className="shrink-0">
        <path
          d="M2.5 6.8 5.2 9.5 10.5 3.5"
          fill="none"
          stroke="currentColor"
          strokeWidth="1.8"
          strokeLinecap="round"
          strokeLinejoin="round"
        />
      </svg>
      {label}
    </div>
  );
}
