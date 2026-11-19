import { useEffect, useRef } from "react";

import { isModClick } from "@/lib/platform";

/// How long the pointer rests on a row before its transcript is read ahead of
/// the click. Long enough that sweeping down a list reads nothing.
export const PREFETCH_HOVER_MS = 100;

/// How long a read outlives the pointer once the element was pressed. Opening
/// a task can wait on a lookup before it asks for the transcript, and the row
/// may leave the screen meanwhile; the open joins the read in that time and
/// keeps it, or the read is dropped as if never pressed.
const PRESSED_GRACE_MS = 3000;

type Prefetch = (sessionId: string) => () => void;

let prefetch: Prefetch | null = null;

/// Set by `App` to `useSessions`' `prefetchTranscript`, which every hover
/// shares, so a row deep in a panel needs no prop threaded down to it.
export function setTranscriptPrefetch(fn: Prefetch | null) {
  prefetch = fn;
}

/// Pointer handlers that read `sessionId`'s transcript once the pointer has
/// rested on the element, and drop the read when it leaves. With `mod`, ⌘ (Ctrl
/// off a Mac) must be held too, in either order — for a row whose plain click
/// does something else and whose ⌘-click opens the task. Letting go of ⌘
/// before the read starts stops it starting; once started, only leaving drops it.
export function useHoverPrefetch(sessionId: string | null | undefined, mod = false) {
  const timer = useRef<ReturnType<typeof setTimeout>>(undefined);
  const release = useRef<(() => void) | undefined>(undefined);
  const inside = useRef(false);
  const pressed = useRef(false);

  const disarm = () => {
    clearTimeout(timer.current);
    timer.current = undefined;
  };
  const stop = () => {
    disarm();
    const letGo = release.current;
    release.current = undefined;
    if (letGo && pressed.current) setTimeout(letGo, PRESSED_GRACE_MS);
    else letGo?.();
  };
  const arm = () => {
    if (!sessionId || timer.current !== undefined || release.current) return;
    timer.current = setTimeout(() => {
      timer.current = undefined;
      release.current = prefetch?.(sessionId);
    }, PREFETCH_HOVER_MS);
  };
  const armRef = useRef(arm);
  armRef.current = arm;

  useEffect(() => stop, [sessionId]);

  useEffect(() => {
    if (!mod) return;
    const onKey = (e: KeyboardEvent) => {
      if (!inside.current) return;
      if (isModClick(e)) armRef.current();
      else disarm();
    };
    window.addEventListener("keydown", onKey);
    window.addEventListener("keyup", onKey);
    return () => {
      window.removeEventListener("keydown", onKey);
      window.removeEventListener("keyup", onKey);
    };
  }, [mod]);

  return {
    onPointerEnter: (e: React.PointerEvent) => {
      inside.current = true;
      pressed.current = false;
      if (!mod || isModClick(e)) arm();
    },
    // ⌘ pressed while the window was not focused never reaches `keydown`, but
    // the next pointer move still carries it.
    onPointerMove: mod ? (e: React.PointerEvent) => isModClick(e) && arm() : undefined,
    onPointerDown: () => {
      pressed.current = true;
    },
    onPointerLeave: () => {
      inside.current = false;
      stop();
    },
  };
}
