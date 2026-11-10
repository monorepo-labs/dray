import { type ElementType, type ReactNode, useEffect, useRef, useState } from "react";
import { Dialog as DialogPrimitive } from "radix-ui";
import { getCurrentWindow } from "@tauri-apps/api/window";

import {
  type BreakClock,
  IDLE_MS,
  TICK_MS,
  advance,
  isBreakDue,
  setBreakDue,
  useBreakDue,
  useBreakSettings,
} from "@/lib/breaks";
import { BREAK_LINES } from "@/components/breakScenes";
import { isWindowFocused } from "@/lib/focus";
import { invoke } from "@/lib/transport";

// Module-level so Preview and dismissal both reach the one clock.
let clock: BreakClock = { used: 0, away: 0 };

/// Counts active use and raises the overlay once the reader's interval is up.
/// Active means something was pressed or moved anywhere on the Mac in the last
/// few minutes: the reader working in the island or another app is still at
/// the screen, and counting focused time alone reset the clock all day.
function useBreakClock() {
  const { on, minutes } = useBreakSettings();

  useEffect(() => {
    if (!on) {
      clock = { used: 0, away: 0 };
      return;
    }
    let last = Date.now();
    let lastInput = last;
    const touch = () => {
      lastInput = Date.now();
    };
    const events = ["keydown", "pointerdown", "pointermove", "wheel"] as const;
    for (const e of events) document.addEventListener(e, touch, { passive: true, capture: true });
    const id = setInterval(async () => {
      // The OS's idle time sees input everywhere; the listeners, which see this
      // window alone, are the fallback off macOS, where focus has to gate them.
      const idle = await invoke<number | null>("idle_seconds").catch(() => null);
      const now = Date.now();
      const active =
        idle === null ? isWindowFocused() && now - lastInput < IDLE_MS : idle * 1000 < IDLE_MS;
      clock = advance(clock, now - last, active);
      last = now;
      if (clock.used >= minutes * 60_000 && !isBreakDue()) {
        setBreakDue(true);
        void raiseWindow();
      }
    }, TICK_MS);
    return () => {
      clearInterval(id);
      for (const e of events) document.removeEventListener(e, touch, { capture: true });
    };
  }, [on, minutes]);
}

/// Brings the window forward so a break due while the reader is in another app
/// is seen, not drawn behind it.
async function raiseWindow() {
  try {
    const win = getCurrentWindow();
    await win.unminimize();
    await win.show();
    await win.setFocus();
  } catch {
    // Outside Tauri (`pnpm dev`, demos) there is no window to raise.
  }
}

/// The hourly break reminder: the whole window, a one-minute countdown, and one way
/// out. A Radix dialog so focus is trapped and the browser pane's native view
/// hides under it like under any other modal.
export default function BreakOverlay() {
  useBreakClock();
  const due = useBreakDue();

  const done = () => {
    clock = { used: 0, away: 0 };
    setBreakDue(false);
  };

  return (
    <DialogPrimitive.Root open={due} onOpenChange={(open) => !open && done()}>
      <DialogPrimitive.Portal>
        <DialogPrimitive.Overlay
          data-slot="dialog-overlay"
          className="fixed inset-0 z-50 bg-popover/95 data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        />
        <DialogPrimitive.Content
          data-slot="dialog-content"
          aria-describedby={undefined}
          onInteractOutside={(e) => e.preventDefault()}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-10 p-8 text-center outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        >
          <PickedCard />
          <Countdown />
          <button
            type="button"
            onClick={done}
            autoFocus
            className="rounded-sm text-sm text-muted-foreground underline underline-offset-4 outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring"
          >
            I'm back
          </button>
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

const any = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

/// Opens on a line picked at random, with one of the drawings made for it.
function PickedCard() {
  const [pick] = useState(() => {
    const line = any(BREAK_LINES);
    return { text: line.text, Scene: any(line.scenes).Scene };
  });
  return <BreakCard text={pick.text} Scene={pick.Scene} Title={DialogPrimitive.Title} />;
}

/// The reminder as a card in the site's language: striped, a drawing on top
/// and the line under it, on each palette's loudest colour (`--break-card` in
/// App.css), so drayhq.com's blue stays Dray's own theme's.
export function BreakCard({
  text,
  Scene,
  Title = "div",
}: {
  text: string;
  Scene: () => ReactNode;
  Title?: ElementType;
}) {
  const card = useRef<HTMLDivElement>(null);

  // Written straight to the element: a state update per pointer move would
  // re-render the overlay at the mouse's rate for a picture.
  const tilt = (e: React.PointerEvent) => {
    const el = card.current;
    if (!el || matchMedia("(prefers-reduced-motion: reduce)").matches) return;
    const r = el.getBoundingClientRect();
    const x = (e.clientX - r.left) / r.width;
    const y = (e.clientY - r.top) / r.height;
    el.style.transition = "transform 80ms ease-out";
    el.style.transform = `rotateX(${(0.5 - y) * 12}deg) rotateY(${(x - 0.5) * 12}deg)`;
  };
  const rest = () => {
    const el = card.current;
    if (!el) return;
    el.style.transition = "transform 600ms cubic-bezier(0.2, 0.8, 0.2, 1)";
    el.style.transform = "";
  };

  return (
    <div className="shrink-0 [perspective:900px]" onPointerMove={tilt} onPointerLeave={rest}>
      {/* 2px stripes every 6px, the site's own pitch. */}
      <div
        ref={card}
        className="w-72 overflow-hidden rounded-xl bg-(--break-card,var(--surface-card)) bg-[repeating-linear-gradient(90deg,var(--break-stripe,#00000012)_0_2px,transparent_2px_6px)] text-left text-(--break-ink,var(--foreground)) shadow-[0_0_0_1px_#0000000F,0_10px_24px_-12px_#00000040] [transform:rotateX(6deg)_rotateY(-8deg)_rotateZ(1deg)]"
      >
        <div className="flex h-36 items-end justify-center pt-4">
          <Scene />
        </div>
        <Title className="px-5 pt-4 pb-5 text-[22px] leading-[1.15] font-normal tracking-[-0.03em] text-balance">{text}</Title>
      </div>
    </div>
  );
}

const BREAK_MS = 60_000;

/// A suggested minute, one tick a second, counted from when the overlay opened. It asks for
/// nothing at zero: "I'm back" is still the only way out.
export function Countdown() {
  const [start] = useState(Date.now);
  const [now, setNow] = useState(start);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  const left = Math.max(0, Math.ceil((BREAK_MS - (now - start)) / 1000));
  return (
    <div aria-hidden className="flex flex-col items-center gap-3">
      <div className="flex h-12 gap-1">
        {Array.from({ length: 60 }, (_, i) => (
          <span key={i} className={`w-0.5 rounded-full transition-colors duration-500 ${i < left ? "bg-foreground/80" : "bg-foreground/10"}`} />
        ))}
      </div>
      <div className="font-mono text-xs text-muted-foreground tabular-nums">
        {Math.floor(left / 60)}:{String(left % 60).padStart(2, "0")}
      </div>
    </div>
  );
}
