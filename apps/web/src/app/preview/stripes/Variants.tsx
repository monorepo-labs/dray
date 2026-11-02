"use client";

import { useState, type CSSProperties } from "react";

const RULE = "border-white/20 light:border-black/15";
const PATTERN = "repeating-linear-gradient(90deg, currentColor 0 1px, transparent 1px 6px)";
/// Half the lines each: the first set at 0, 12, 24…, the second at 6, 18, 30…
const HALF = "repeating-linear-gradient(90deg, currentColor 0 1px, transparent 1px 12px)";
const LAYER = "pointer-events-none absolute inset-0 -z-10";
const LINES = Array.from({ length: 24 }, (_, i) => i);
const EASE = "ease-[cubic-bezier(0.22,1,0.36,1)]";

type Layer = (on: boolean) => React.ReactNode;

/// Every class is spelled out whole, since Tailwind only builds what it can
/// read in the source.
const VARIANTS: { name: string; note: string; layer: Layer }[] = [
  {
    name: "Fade",
    note: "The whole pattern fades in, 200ms.",
    layer: (on) => (
      <span
        style={{ backgroundImage: PATTERN }}
        className={`${LAYER} transition-opacity duration-200 ease-out ${on ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
      />
    ),
  },
  {
    name: "Wipe",
    note: "Revealed left to right by one soft edge, 500ms.",
    layer: (on) => (
      <span
        style={{ backgroundImage: PATTERN }}
        className={`${LAYER} transition-[clip-path] duration-500 ${EASE} ${
          on ? "[clip-path:inset(0_0_0_0)]" : "[clip-path:inset(0_100%_0_0)] group-hover:[clip-path:inset(0_0_0_0)]"
        }`}
      />
    ),
  },
  {
    name: "Centre out",
    note: "Opens from the middle to both edges, 400ms.",
    layer: (on) => (
      <span
        style={{ backgroundImage: PATTERN }}
        className={`${LAYER} transition-[clip-path] duration-400 ${EASE} ${
          on ? "[clip-path:inset(0_0_0_0)]" : "[clip-path:inset(0_50%_0_50%)] group-hover:[clip-path:inset(0_0_0_0)]"
        }`}
      />
    ),
  },
  {
    name: "Slide",
    note: "Fades in while drifting two lines sideways into place, 500ms.",
    layer: (on) => (
      <span
        style={{ backgroundImage: PATTERN }}
        className={`${LAYER} transition-[opacity,background-position] duration-500 ${EASE} ${
          on
            ? "[background-position-x:0px] opacity-100"
            : "[background-position-x:-12px] opacity-0 group-hover:[background-position-x:0px] group-hover:opacity-100"
        }`}
      />
    ),
  },
  {
    name: "Drop",
    note: "Every line grows down from the top together, 300ms.",
    layer: (on) => (
      <span
        style={{ backgroundImage: PATTERN }}
        className={`${LAYER} origin-top transition-transform duration-300 ${EASE} ${on ? "scale-y-100" : "scale-y-0 group-hover:scale-y-100"}`}
      />
    ),
  },
  {
    name: "Meet",
    note: "Half the lines grow from the top, half from the bottom, all at once, 400ms.",
    layer: (on) => (
      <>
        <span
          style={{ backgroundImage: HALF }}
          className={`${LAYER} origin-top transition-transform duration-400 ${EASE} ${on ? "scale-y-100" : "scale-y-0 group-hover:scale-y-100"}`}
        />
        <span
          style={{ backgroundImage: HALF, backgroundPosition: "6px 0" }}
          className={`${LAYER} origin-bottom transition-transform duration-400 ${EASE} ${on ? "scale-y-100" : "scale-y-0 group-hover:scale-y-100"}`}
        />
      </>
    ),
  },
  {
    name: "Ripple",
    note: "Lines fade in one after another, left to right, 15ms apart.",
    layer: (on) => (
      <span className={`${LAYER} overflow-hidden`}>
        {LINES.map((i) => (
          <span
            key={i}
            style={{ left: i * 6, transitionDelay: `${i * 15}ms` }}
            className={`absolute inset-y-0 w-px bg-current transition-opacity duration-300 ease-out ${on ? "opacity-100" : "opacity-0 group-hover:opacity-100"}`}
          />
        ))}
      </span>
    ),
  },
  {
    name: "Current",
    note: "What the page has now: neighbours grow from opposite edges in a jittered wave.",
    layer: (on) => (
      <span className={`${LAYER} overflow-hidden`}>
        {LINES.map((i) => (
          <span
            key={i}
            style={{ left: i * 6, transitionDelay: `${i * 4 + ((i * 37) % 5) * 12}ms` }}
            className={`absolute inset-y-0 w-px bg-current transition-transform duration-500 ${EASE} ${
              on ? "scale-y-100" : "scale-y-0 group-hover:scale-y-100"
            } ${i % 2 ? "origin-bottom" : "origin-top"}`}
          />
        ))}
      </span>
    ),
  },
  {
    name: "None",
    note: "Stripes appear at once.",
    layer: (on) => (
      <span style={{ backgroundImage: PATTERN }} className={`${LAYER} ${on ? "" : "opacity-0 group-hover:opacity-100"}`} />
    ),
  },
];

const STRENGTHS = [0.04, 0.08, 0.12];

/// Each animation on the real amount buttons, selected state included, with
/// the stripes' strength switchable since 4% is hard to judge.
export function Variants() {
  const [ink, setInk] = useState(0.04);
  const [picked, setPicked] = useState<Record<string, number>>({});

  return (
    <div style={{ "--ink": ink } as CSSProperties}>
      <div className="flex items-center gap-3">
        <span className="font-mono text-[11px] tracking-[0.06em] text-[#7C7C7C] uppercase">Stripe strength</span>
        <div className={`inline-flex border ${RULE}`}>
          {STRENGTHS.map((s, i) => (
            <button
              key={s}
              type="button"
              onClick={() => setInk(s)}
              className={`h-8 px-3 font-mono text-[11px] ${i ? `border-l ${RULE}` : ""} ${
                ink === s ? "bg-[#1612F8] text-white" : "text-[#A1A1A1] light:text-[#5C5C5C]"
              }`}
            >
              {Math.round(s * 100)}%
            </button>
          ))}
        </div>
      </div>

      <div className={`mt-8 divide-y border-y ${RULE} divide-white/20 light:divide-black/15`}>
        {VARIANTS.map((v) => (
          <div key={v.name} className="grid gap-4 py-6 sm:grid-cols-[1fr_416px] sm:items-center">
            <div>
              <p className="text-[16px] text-white light:text-[#0A0A0A]">{v.name}</p>
              <p className="mt-1 text-[14px] text-[#7C7C7C] light:text-[#8A8A8A]">{v.note}</p>
            </div>
            <div className="grid grid-cols-4 gap-2 bg-[#141414] p-3 light:bg-white">
              {[5, 10, 25, 50].map((a) => {
                const on = (picked[v.name] ?? 10) === a;
                return (
                  <button
                    key={a}
                    type="button"
                    onClick={() => setPicked((p) => ({ ...p, [v.name]: a }))}
                    className={`group relative isolate h-10 overflow-hidden border text-[15px] text-white tabular-nums transition-colors ${RULE} light:text-[#0A0A0A] ${
                      on ? "bg-white/10 light:bg-black/[0.06]" : ""
                    }`}
                  >
                    <span className="contents text-[rgb(255_255_255/var(--ink))] light:text-[rgb(0_0_0/var(--ink))]">
                      {v.layer(on)}
                    </span>
                    ${a}
                  </button>
                );
              })}
            </div>
          </div>
        ))}
      </div>
    </div>
  );
}
