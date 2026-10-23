"use client";

import { type ReactNode, useEffect, useState } from "react";

/// A copy of the nav pinned to the top, shown only once the element named by
/// `after` has scrolled out of view. The hero keeps its own nav in place, so
/// this one never covers the first screen.
export function StickyNav({ after, children }: { after: string; children: ReactNode }) {
  const [shown, setShown] = useState(false);

  useEffect(() => {
    const target = document.getElementById(after);
    if (!target) return;
    const observer = new IntersectionObserver(([entry]) => setShown(!entry.isIntersecting));
    observer.observe(target);
    return () => observer.disconnect();
  }, [after]);

  return (
    <div
      inert={!shown}
      className={`fixed inset-x-0 top-0 z-50 bg-gradient-to-b from-black/20 to-transparent py-3 transition-transform duration-300 motion-reduce:transition-none ${shown ? "" : "-translate-y-full"}`}
    >
      {children}
    </div>
  );
}
