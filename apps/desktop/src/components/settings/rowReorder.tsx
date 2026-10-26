import { GripVertical } from "lucide-react";

import { useDragReorder } from "@/hooks/useDragReorder";
import { cn } from "@/lib/utils";

/// [useDragReorder] dressed as a settings list's rows, with arrow keys on the
/// grip. Shared by Spaces and Composer, so the two lists drag and look alike.
export function useRowReorder<T>(
  items: T[],
  keyOf: (item: T) => string,
  onMove: (item: T, delta: number, to: number) => Promise<void> | void,
) {
  const { list, shown, drag, start, commit, offset } = useDragReorder(items, keyOf, onMove);

  /// Spread onto each row; `layout` is the row's own padding and gap.
  const row = (i: number, layout: string) => ({
    onPointerDown: (e: React.PointerEvent<HTMLElement>) => start(e, i),
    style: { transform: offset(i) },
    className: cn(
      "flex cursor-grab touch-none items-center justify-between rounded-lg border bg-linear-to-b hover:from-card/15 hover:to-card/30",
      layout,
      // Only the rows making room glide; the one in hand tracks the pointer
      // exactly. No transition outside a drag, or the drop would animate rows
      // back from where they were drawn.
      drag && drag.from !== i && "transition-transform duration-150 ease-out",
      // Filled most while held, or it draws its text over the rows it passes.
      drag?.from === i &&
        "relative z-10 from-card/40 to-card/70 shadow-(--shadow-button) hover:from-card/40 hover:to-card/70",
    ),
  });

  /// Arrow keys on a row's grip, so the keyboard reaches what a drag does.
  const onGripKey = (e: React.KeyboardEvent, i: number) => {
    const delta = e.key === "ArrowUp" ? -1 : e.key === "ArrowDown" ? 1 : 0;
    if (!delta) return;
    e.preventDefault();
    if (!drag) commit(i, i + delta);
  };

  return { list, shown, row, onGripKey };
}

/// The handle drawn at the start of a draggable row.
export function Grip({
  label,
  onKeyDown,
}: {
  label: string;
  onKeyDown: (e: React.KeyboardEvent) => void;
}) {
  return (
    <button
      type="button"
      data-grip
      aria-label={label}
      onKeyDown={onKeyDown}
      className="flex h-7 w-4 shrink-0 cursor-grab touch-none items-center justify-center rounded-sm text-muted-foreground hover:text-foreground focus-visible:outline-2 focus-visible:outline-ring"
    >
      <GripVertical className="size-3.5" />
    </button>
  );
}
