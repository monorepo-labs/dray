"use client";

import createGlobe from "cobe";
import { useEffect, useRef } from "react";
import { COUNTRIES } from "@/lib/countries";

/// ISO alpha-2 code → regional-indicator pair, which every platform font
/// draws as the flag. Windows Chrome draws the two letters instead; accepted,
/// since the globe still says where and the dot underneath is unaffected.
function flag(code: string): string {
  return String.fromCodePoint(
    ...[...code].map((c) => 0x1f1e6 + c.charCodeAt(0) - 65),
  );
}

const anchorOf = (code: string) => `--cobe-${code.toLowerCase()}`;

/// The reach of the thing, as one flag per country on a globe you can spin.
///
/// It was a marquee of flag emoji, which was a joke about the logo strip every
/// landing page carries. The joke worked once; what it never did was answer
/// *where*, since a row you have to wait for shows six names at a time out of
/// thirty-one.
///
/// [cobe](https://cobe.vercel.app) draws it — 5kB, one WebGL call, no map
/// tiles and no network. A `"use client"` island for the obvious reason: it
/// wants a canvas and an animation frame, neither of which exist on the server.
///
/// **The flags are HTML, not markers.** cobe draws markers on the GPU and can
/// only draw dots, so each marker carries an `id` and cobe answers with a CSS
/// anchor at its projected position (`--cobe-<code>`) plus a variable that is
/// set only while the point faces the camera (`--cobe-visible-<code>`). The
/// flag is an ordinary span pinned to that anchor. All of which is cobe's own
/// documented route — the projection maths stays inside the library.
///
/// **Anchor positioning is young**, so `CSS.supports` decides at mount which
/// of the two is drawn: where it works the marker shrinks to nothing and the
/// flag stands in its place, and where it does not the flags never mount and
/// cobe's dots are the answer, exactly as before. Firefox is the browser that
/// gets dots today. Falling back *within* one page — flags piled in a corner
/// over a globe that still has its dots — is the thing being avoided.
export function UsedBy({ className }: { className?: string }) {
  const canvas = useRef<HTMLCanvasElement>(null);
  const anchored = useRef(false);

  useEffect(() => {
    const el = canvas.current;
    if (!el) return;

    // Read before the globe is built, since it decides the marker size, and
    // written to a ref so the flags render on the commit after this one.
    anchored.current = CSS.supports("anchor-name", "--a");

    // cobe takes its size once, at creation, and cannot be resized — so the
    // measured width is fed back in every frame instead, which is the
    // library's own answer to a responsive canvas.
    let width = 0;
    const measure = () => {
      width = el.offsetWidth;
    };
    measure();
    window.addEventListener("resize", measure);

    // Honoured once, at mount: a reader who turns the preference on mid-visit
    // is not worth a media-query listener here, and the globe is still the
    // whole picture standing still. Dragging is left alone either way — it is
    // motion the reader asked for by hand.
    const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
    let phi = 4.7; // Opens on Europe/Africa, the busiest face of this list.

    const globe = createGlobe(el, {
      devicePixelRatio: 2,
      width: width * 2,
      height: width * 2,
      phi,
      theta: 0.25,
      dark: 1,
      diffuse: 1.2,
      mapSamples: 16000,
      mapBrightness: 3,
      baseColor: [0.28, 0.28, 0.3],
      markerColor: [0.95, 0.76, 0.28],
      glowColor: [0.12, 0.12, 0.13],
      markers: COUNTRIES.map((c) => ({
        location: c.at,
        // Zero where a flag is about to cover it. The marker still has to
        // exist, because the anchor the flag hangs off is what it publishes.
        size: anchored.current ? 0 : 0.05,
        id: c.code.toLowerCase(),
      })),
    });

    // Drag to spin. `from` holds the pointer's x and the globe's angle at the
    // moment it went down, so the turn is measured against where the grab
    // started rather than accumulated frame by frame — the second drifts by a
    // pixel every time a move event is coalesced.
    let from: { x: number; phi: number } | null = null;
    const down = (e: PointerEvent) => {
      from = { x: e.clientX, phi };
      el.setPointerCapture(e.pointerId);
      el.style.cursor = "grabbing";
    };
    const move = (e: PointerEvent) => {
      // Divided by the globe's own width, so a drag across it is half a turn
      // whatever size the screen is.
      if (from) phi = from.phi + ((e.clientX - from.x) / width) * Math.PI;
    };
    const up = () => {
      from = null;
      el.style.cursor = "grab";
    };
    el.addEventListener("pointerdown", down);
    el.addEventListener("pointermove", move);
    el.addEventListener("pointerup", up);
    el.addEventListener("pointercancel", up);

    // cobe v2 runs no loop of its own — `update` is both the state write and
    // the draw, so the frames are ours to schedule. Which is what makes the
    // observer below cheap: not scheduling one *is* not drawing.
    let frame = 0;
    const draw = () => {
      if (!still && !from) phi += 0.0028;
      globe.update({ phi, width: width * 2, height: width * 2 });
      frame = requestAnimationFrame(draw);
    };

    // The globe sits at the foot of the page, so without this it spins a GPU
    // for the whole time somebody is reading the top of it and never looks
    // down. One frame is still drawn on the way out, or leaving mid-turn
    // freezes it on a half-lit edge with the flags stranded where they were.
    const watch = new IntersectionObserver(([entry]) => {
      cancelAnimationFrame(frame);
      if (entry.isIntersecting) draw();
      else globe.update({ phi, width: width * 2, height: width * 2 });
    });
    watch.observe(el);

    return () => {
      watch.disconnect();
      cancelAnimationFrame(frame);
      window.removeEventListener("resize", measure);
      el.removeEventListener("pointerdown", down);
      el.removeEventListener("pointermove", move);
      el.removeEventListener("pointerup", up);
      el.removeEventListener("pointercancel", up);
      globe.destroy();
    };
  }, []);

  return (
    <section className={`text-center ${className ?? ""}`}>
      <p className="font-mono text-xs tracking-wide text-muted-foreground uppercase">
        {/* The `+` is what keeps the line true between reads: the count is
            taken by hand and only ever goes up once this is live. */}
        Used by engineers in {COUNTRIES.length}+ countries
      </p>
      <div className="relative mx-auto mt-6 w-full max-w-xl">
        {/* `touch-pan-y` so a thumb dragging sideways spins the globe and a
            thumb dragging down still scrolls the page past it. `aspect-square`
            because cobe draws a circle into a square buffer; anything else
            crops it. */}
        <canvas
          ref={canvas}
          aria-hidden
          className="aspect-square w-full cursor-grab touch-pan-y"
        />
        {/* After the canvas in the DOM on purpose: an anchor has to precede
            what hangs off it, and cobe puts its anchors in a wrapper it
            inserts *before* the canvas.

            The flags are decoration — the line above is the claim, and it is
            what a screen reader gets, so the whole layer is hidden from one.
            `pointer-events-none` keeps every one of them out of the way of the
            drag underneath.

            `opacity` is cobe's own idiom and reads backwards until you know
            it: the variable exists only while the point faces the camera, and
            its value is deliberately not a number — so a visible flag makes
            the declaration invalid at computed-value time and opacity falls
            back to its initial 1, while a hidden one has no variable at all
            and takes the 0. */}
        <div aria-hidden className="pointer-events-none">
          {COUNTRIES.map((c) => (
            <span
              key={c.code}
              title={c.name}
              className="absolute text-base sm:text-xl"
              style={{
                positionAnchor: anchorOf(c.code),
                left: "anchor(center)",
                top: "anchor(center)",
                translate: "-50% -50%",
                opacity: `var(--cobe-visible-${c.code.toLowerCase()}, 0)`,
              } as React.CSSProperties}
            >
              {flag(c.code)}
            </span>
          ))}
        </div>
      </div>
    </section>
  );
}
