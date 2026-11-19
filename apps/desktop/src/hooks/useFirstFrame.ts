import { useCallback, useEffect, useRef, type SyntheticEvent } from "react";

import { showFirstFrame, type FirstFrame } from "@/lib/firstFrame";

/// `showFirstFrame` for a `<video>`: spread `onLoadedMetadata` onto it. Stops
/// on unmount, or a video mid-paint would play on detached.
export function useFirstFrame() {
  const paint = useRef<FirstFrame | null>(null);
  useEffect(() => () => paint.current?.stop(), []);
  const onLoadedMetadata = useCallback((e: SyntheticEvent<HTMLVideoElement>) => {
    paint.current?.stop();
    paint.current = showFirstFrame(e.currentTarget);
  }, []);
  return { onLoadedMetadata, paint };
}
