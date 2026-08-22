import { useEffect, useRef } from "react";

const WINDOW_MS = 400;

/// Fires on two `key` presses within WINDOW_MS with no other key in between —
/// a chord-less shortcut for modifier keys like Shift, which `useHotkey` can't
/// express since it always pairs a key with Cmd/Ctrl.
export function useDoubleTap(key: string, handler: () => void) {
  const handlerRef = useRef(handler);
  handlerRef.current = handler;

  const lastTapRef = useRef(0);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.repeat) return;

      if (e.key !== key) {
        lastTapRef.current = 0;
        return;
      }

      const now = e.timeStamp;
      if (now - lastTapRef.current < WINDOW_MS) {
        lastTapRef.current = 0;
        handlerRef.current();
      } else {
        lastTapRef.current = now;
      }
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, [key]);
}
