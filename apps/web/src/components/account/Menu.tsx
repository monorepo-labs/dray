"use client";

import { type ReactNode, useEffect, useRef, useState } from "react";

/// A nav cell that opens a panel under it. Closes on a click outside, on
/// Escape, and on any click inside, since every item navigates or acts.
export function Menu({
  label,
  trigger,
  className,
  children,
}: {
  label: string;
  trigger: ReactNode;
  className: string;
  children: ReactNode;
}) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => {
      if (!root.current?.contains(e.target as Node)) setOpen(false);
    };
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={root} className="relative h-full">
      <button
        type="button"
        aria-label={label}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        className={`${className} flex cursor-pointer`}
      >
        {trigger}
      </button>
      {open && (
        <div
          onClick={() => setOpen(false)}
          className="absolute top-full right-0 z-10 mt-px min-w-[240px] border border-white/20 bg-black py-1 light:border-black/15 light:bg-white"
        >
          {children}
        </div>
      )}
    </div>
  );
}

export const MENU_ITEM =
  "flex w-full cursor-pointer items-center justify-between gap-3 px-4 py-2 text-left text-[14px] transition-colors hover:bg-white/10 light:hover:bg-black/5";
