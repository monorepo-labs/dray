"use client";

import { useEffect, useRef, useState } from "react";

/// Draws a fixed-size window at whatever width the column has, by scaling
/// rather than reflowing. The drawing is the app at its real sizes — 13px
/// rows, a 40px titlebar — and letting those reflow to a phone would make
/// something that is no longer the app. So the window keeps its size and the
/// wrapper scales it down; the box reserves the scaled height so nothing
/// below it moves when the measurement lands.
export function ScaledWindow({
  width,
  height,
  children,
  className,
}: {
  width: number;
  height: number;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScale(Math.min(1, el.clientWidth / width));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width]);

  return (
    <div ref={ref} className={className} style={{ height: height * scale }}>
      <div
        style={{ width, height, transform: `scale(${scale})`, transformOrigin: "top left" }}
      >
        {children}
      </div>
    </div>
  );
}
