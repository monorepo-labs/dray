import { useEffect, useRef } from "react";
import { Popover as PopoverPrimitive } from "radix-ui";

import { Button } from "@/components/ui/button";

/// Shown when a branch is picked while the tree has uncommitted changes. Both
/// actions run the same checkout; `stash` only decides whether the changes are
/// shelved first or carried across.
///
/// Neither is safe enough to pick automatically — carrying changes fails when
/// the file differs across branches, and stashing hides work the user can see
/// right now — so the choice is theirs and git's error is reported as-is.
///
/// A popover rather than a centered dialog: it opens over the branch picker the
/// user just clicked, so the answer is where their cursor already is. Rendered
/// as a child of the picker's own wrapper, which is what it anchors to.
export default function BranchSwitchDialog({
  target,
  dirty,
  onConfirm,
  onCancel,
}: {
  /// The branch being switched to; null closes the popover.
  target: string | null;
  dirty: number;
  onConfirm: (stash: boolean) => void;
  onCancel: () => void;
}) {
  // False for the tick the popover opens in, so the dropdown's own teardown
  // can't be mistaken for a click-away.
  const armed = useRef(false);

  useEffect(() => {
    if (target === null) {
      armed.current = false;
      return;
    }

    const id = setTimeout(() => {
      armed.current = true;
    });
    return () => clearTimeout(id);
  }, [target]);

  return (
    <PopoverPrimitive.Root
      open={target !== null}
      onOpenChange={(open) => !open && onCancel()}
    >
      {/* Zero-size and pinned to the wrapper's start edge: the anchor decides
          where the popover sits, and must not take part in the toolbar's flex
          layout or it would shift the controls around it. */}
      <PopoverPrimitive.Anchor className="absolute inset-y-0 left-0 w-0" />

      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="top"
          align="start"
          sideOffset={8}
          // The click that picks a branch also closes the dropdown, and Radix
          // then restores focus to its trigger — both land in the tick this
          // popover mounts in and would dismiss it instantly. Focus is refused
          // outright (the dropdown's trigger legitimately wants it back), while
          // outside *clicks* are only swallowed for that first tick, so
          // click-away still closes this normally.
          onOpenAutoFocus={(e) => e.preventDefault()}
          onCloseAutoFocus={(e) => e.preventDefault()}
          onFocusOutside={(e) => e.preventDefault()}
          onInteractOutside={(e) => {
            if (!armed.current) e.preventDefault();
          }}
          className="z-50 flex w-72 flex-col gap-3 rounded-xl border border-border bg-popover p-3 text-popover-foreground shadow-lg data-open:animate-in data-open:fade-in-0 data-open:zoom-in-95 data-closed:animate-out data-closed:fade-out-0 data-closed:zoom-out-95"
        >
          <div className="flex flex-col gap-0.5">
            <p className="text-ui font-medium">
              {dirty} uncommitted {dirty === 1 ? "file" : "files"}
            </p>
            <p className="text-ui text-muted-foreground">
              Switching to <span className="text-foreground">{target}</span>.
            </p>
          </div>

          {/* Each line answers the only question that matters — where do my
              changes end up — rather than describing what git does. */}
          <div className="flex flex-col gap-1 text-ui text-muted-foreground">
            <p>
              <span className="text-foreground">Bring</span> — they move to{" "}
              {target} with you
            </p>
            <p>
              <span className="text-foreground">Stash</span> — they stay here,
              saved for later
            </p>
          </div>

          {/* Stacked, not a row: three labels don't fit across a popover this
              narrow, and truncating the verbs is what the copy above exists to
              avoid. Weight descends with how recoverable each choice is —
              stashing keeps the work retrievable whatever happens next, so it
              leads and is the only filled button. */}
          <div className="flex flex-col gap-1.5">
            <Button
              type="button"
              size="sm"
              className="w-full text-ui"
              onClick={() => onConfirm(true)}
            >
              Stash changes
            </Button>
            <Button
              type="button"
              variant="outline"
              size="sm"
              className="w-full text-ui"
              onClick={() => onConfirm(false)}
            >
              Bring changes
            </Button>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="w-full text-ui text-muted-foreground"
              onClick={onCancel}
            >
              Cancel
            </Button>
          </div>
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>
  );
}
