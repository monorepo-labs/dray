import { useEffect, useRef } from "react";
import { listen } from "@/lib/transport";

/// Finger travel, in scroll pixels, before a swipe takes its one step. Short
/// nudges measured at 17–29 and the shortest deliberate flick at about 40.
export const SWIPE_DISTANCE = 30;

/// Whether a swipe starting over `el` belongs to something that scrolls
/// sideways — a diff with long lines, a wide table — rather than to the swipe.
function scrollsSideways(el: Element | null, stop: Element) {
  for (; el && el !== stop; el = el.parentElement) {
    if (el.scrollWidth <= el.clientWidth) continue;
    const { overflowX } = getComputedStyle(el);
    if (overflowX === "auto" || overflowX === "scroll") return true;
  }
  return false;
}

type Swipe = { phase: "began" | "changed" | "ended" | "cancelled"; dx: number };

/// Calls `onStep` once per horizontal trackpad swipe over `target`, as soon as
/// the fingers have travelled far enough. Read
/// off AppKit by `trackpad.rs`, which reports where a swipe begins and ends
/// rather than leaving it to be guessed from wheel timing. Positive is fingers
/// moving left, the way a page moves forward under natural scrolling.
export function useSwipe(target: React.RefObject<HTMLElement | null>, onStep: (delta: -1 | 1) => void) {
  const step = useRef(onStep);
  step.current = onStep;

  useEffect(() => {
    // `null` is a swipe this target does not own: it began elsewhere, over a
    // sideways scroller, or has already stepped.
    let travel: number | null = null;
    const unlisten = listen<Swipe>("trackpad_swipe", ({ payload }) => {
      if (payload.phase === "began") {
        // Read once: a swipe belongs to where the pointer was when it started,
        // and the pointer does not move while two fingers scroll.
        const el = target.current;
        const under = [...document.querySelectorAll(":hover")].pop() ?? null;
        travel = el?.matches(":hover") && !scrollsSideways(under, el) ? 0 : null;
        return;
      }
      if (travel === null) return;
      if (payload.phase !== "changed") {
        travel = null;
        return;
      }
      travel += payload.dx;
      if (Math.abs(travel) < SWIPE_DISTANCE) return;
      const delta = travel > 0 ? 1 : -1;
      travel = null;
      step.current(delta);
    });
    return () => {
      unlisten.then((off) => off());
    };
  }, [target]);
}
