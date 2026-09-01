import { useEffect, useRef, useState } from "react";

import { cn } from "@/lib/utils";

/// Bars drawn. Odd, so there is a true middle for the level to peak at.
const BARS = 9;

/// Height of the quietest bar, as a fraction. A bar that reaches zero reads as
/// a broken row rather than a quiet one, and the row has to look alive while
/// somebody is deciding what to say.
const FLOOR = 0.18;

/// Shape across the row, tallest in the middle.
///
/// A flat row of equal bars reads as a loading indicator; the taper is what
/// makes it read as sound. Computed once, since it never changes.
const SHAPE = Array.from({ length: BARS }, (_, i) => {
  const distance = Math.abs(i - (BARS - 1) / 2) / ((BARS - 1) / 2);

  return 1 - distance * 0.55;
});

/// A live level, smoothed and drawn as bars.
///
/// The input is one number — the loudest sample since the last poll — not a
/// spectrum, so this is deliberately not a frequency plot: it is the *envelope*,
/// spread across the row by a fixed shape. Handy draws a real FFT, which needs
/// the whole buffer on the frontend; the level alone crosses the bridge as a
/// single float 20 times a second and tells the reader the one thing they need,
/// which is that the microphone is hearing them.
export default function AudioVisualizer({
  level,
  className,
}: {
  level: number;
  className?: string;
}) {
  // Smoothed, because the raw peak jitters hard enough between polls to make
  // the row flicker. Fast attack and slow release: sound should reach the bars
  // at once and fall away, which is how a level meter reads as responsive.
  const [smoothed, setSmoothed] = useState(0);
  const raf = useRef<number | null>(null);

  useEffect(() => {
    const step = () => {
      setSmoothed((prev) => {
        const target = Math.min(1, level * 1.6);

        return target > prev ? target : prev + (target - prev) * 0.25;
      });

      raf.current = requestAnimationFrame(step);
    };

    raf.current = requestAnimationFrame(step);

    return () => {
      if (raf.current !== null) cancelAnimationFrame(raf.current);
    };
  }, [level]);

  return (
    <div
      className={cn("flex h-4 items-center gap-[2px]", className)}
      aria-hidden
    >
      {SHAPE.map((weight, i) => (
        <div
          key={i}
          className="w-[2px] rounded-full bg-current"
          style={{
            // Transitioned in CSS as well as smoothed in JS: the poll is 50ms
            // and the frame is 16ms, so without this the bars step visibly
            // between readings.
            height: `${(FLOOR + smoothed * weight * (1 - FLOOR)) * 100}%`,
            transition: "height 60ms linear",
          }}
        />
      ))}
    </div>
  );
}
