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
import { BREAK_CARDS, StillScenes } from "@/components/breakScenes";
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
      // window alone, are the fallback where the OS cannot say (Windows, Linux
      // without X11 or libXss), and focus has to gate them there.
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
  const content = useRef<HTMLDivElement>(null);
  const openedAt = useRef(0);
  useEffect(() => {
    if (due) openedAt.current = Date.now();
  }, [due]);

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
          // Escape is the same way out as the button, so it waits out the same lock.
          onEscapeKeyDown={(e) => Date.now() - openedAt.current < LOCK_MS && e.preventDefault()}
          // Focus the dialog itself, not "I'm back": a key pressed mid-thought
          // as the overlay landed would otherwise end the break unseen.
          ref={content}
          onOpenAutoFocus={(e) => {
            e.preventDefault();
            content.current?.focus();
          }}
          className="fixed inset-0 z-50 flex flex-col items-center justify-center gap-10 p-8 text-center outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        >
          <PickedCard />
          <Countdown />
          <BackButton onClick={done} />
        </DialogPrimitive.Content>
      </DialogPrimitive.Portal>
    </DialogPrimitive.Root>
  );
}

const any = <T,>(list: T[]) => list[Math.floor(Math.random() * list.length)];

/// Opens on a card picked at random from those left on in Settings, or from
/// all of them if a stale setting leaves none.
function PickedCard() {
  const { off } = useBreakSettings();
  const [pick] = useState(() => {
    const on = BREAK_CARDS.filter((c) => !off.includes(c.name));
    return any(on.length ? on : BREAK_CARDS);
  });
  return <BreakCard text={pick.text} Scene={pick.Scene} Title={DialogPrimitive.Title} />;
}

const LOCK_MS = 30_000;

/// The way out, held shut for the break's first 30 seconds, so the break is at
/// least half taken before it can be skipped. The minute's own countdown above
/// says time is running; a second number here read as a timer to wait out.
function BackButton({ onClick }: { onClick: () => void }) {
  const left = useSecondsLeft(LOCK_MS);
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={left > 0}
      className="rounded-sm text-sm text-muted-foreground underline underline-offset-4 outline-none enabled:hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-40"
    >
      I'm back
    </button>
  );
}

// 2px stripes every 6px, the site's own pitch.
const FACE =
  "overflow-hidden bg-(--break-card,var(--surface-card)) bg-[repeating-linear-gradient(90deg,var(--break-stripe,#00000012)_0_2px,transparent_2px_6px)] text-left text-(--break-ink,var(--foreground))";

/// A card shrunk for Settings' picker: flat, its drawing held still until the
/// pointer is over it.
export function BreakTile({ text, Scene }: { text: string; Scene: () => ReactNode }) {
  const [playing, setPlaying] = useState(false);
  return (
    <div
      className={`${FACE} h-full rounded-lg shadow-[0_0_0_1px_#0000000F]`}
      onPointerEnter={() => setPlaying(true)}
      onPointerLeave={() => setPlaying(false)}
    >
      <div className="flex h-20 items-end justify-center pt-2 [&_svg]:h-18">
        <StillScenes.Provider value={!playing}>
          <Scene />
        </StillScenes.Provider>
      </div>
      <p className="px-3 pt-2 pb-3 text-[13px] leading-[1.2] tracking-[-0.02em] text-balance">{text}</p>
    </div>
  );
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
      <div
        ref={card}
        className={`${FACE} w-72 rounded-xl shadow-[0_0_0_1px_#0000000F,0_10px_24px_-12px_#00000040] [transform:rotateX(6deg)_rotateY(-8deg)_rotateZ(1deg)]`}
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

/// Whole seconds left of `ms`, counted from mount and ticking once a second.
function useSecondsLeft(ms: number) {
  const [start] = useState(Date.now);
  const [now, setNow] = useState(start);
  useEffect(() => {
    const id = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(id);
  }, []);
  return Math.max(0, Math.ceil((ms - (now - start)) / 1000));
}

/// A suggested minute, one tick a second, counted from when the overlay opened. It asks for
/// nothing at zero: "I'm back" is still the only way out.
export function Countdown() {
  const left = useSecondsLeft(BREAK_MS);
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
