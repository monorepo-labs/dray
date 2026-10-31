"use client";

import { useEffect, useRef, useState, type ReactNode } from "react";

/// Sets `data-play` while on screen, which is what lets a drawing's
/// `motion.module.css` clock run; off screen it holds still.
export function PlayWhenVisible({ children, className }: { children: ReactNode; className?: string }) {
  const ref = useRef<HTMLDivElement>(null);
  const [play, setPlay] = useState(false);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    // Starts while still a little below the fold, so a fast scroll lands on a drawing already moving.
    const io = new IntersectionObserver(([entry]) => setPlay(entry.isIntersecting), {
      rootMargin: "0px 0px 15% 0px",
    });
    io.observe(el);
    return () => io.disconnect();
  }, []);

  return (
    <div ref={ref} data-play={play || undefined} className={className}>
      {children}
    </div>
  );
}
