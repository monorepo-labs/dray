"use client";

import { useEffect, useRef, useState } from "react";

/// A drawing at a fixed size, scaled to the width it is given. The scenes
/// are laid out at one width so their animations move by known amounts;
/// this fits that width to whatever column it lands in and scales the
/// height with it, measured off the wrapper so a resize follows.
///
/// `minScale` is a floor: a full app window at a third of its size is a
/// texture, not a picture, so below the floor the drawing keeps that size
/// and the wrapper scrolls sideways instead. Cards leave it at zero — their
/// scene is one panel, which reads at any width a card can be. `startX` is
/// where that scroll opens, in the drawing's own pixels: a window whose
/// point is the chat should not open on its sidebar.
export function ScaledWindow({
  width,
  height,
  minScale = 0,
  startX = 0,
  children,
  className,
}: {
  width: number;
  height: number;
  minScale?: number;
  startX?: number;
  children: React.ReactNode;
  className?: string;
}) {
  const ref = useRef<HTMLDivElement>(null);
  const [scale, setScale] = useState(1);
  const scrolls = scale === minScale && minScale > 0;

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    const measure = () => setScale(Math.max(minScale, Math.min(1, el.clientWidth / width)));
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [width, minScale]);

  // Once, on becoming scrollable — after that the position is the reader's.
  useEffect(() => {
    if (scrolls && ref.current) ref.current.scrollLeft = startX * scale;
  }, [scrolls]);

  // Scrolling clips the drop shadow along with the overflow; the padding
  // gives it room and the negative margin hands that room back.
  return (
    <div ref={ref} className={`${scrolls ? "-mb-16 overflow-x-auto pb-16" : ""} ${className ?? ""}`}>
      <div style={{ width: width * scale, height: height * scale }}>
        <div style={{ width, height, transform: `scale(${scale})`, transformOrigin: "top left" }}>
          {children}
        </div>
      </div>
    </div>
  );
}
