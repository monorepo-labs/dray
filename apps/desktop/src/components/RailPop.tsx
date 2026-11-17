import { Popover as PopoverPrimitive } from "radix-ui";
import { useSyncExternalStore, type ReactElement, type ReactNode } from "react";
import { createPortal } from "react-dom";

import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { channel } from "@/lib/channel";

// The rail's foot, while the sidebar is the icon rail. Module-level because the
// cards that land there are mounted by `App`, beside the sidebar, not in it.
let slot: HTMLElement | null = null;
const slotChanged = channel<void>();

/// The ref for the rail's foot: set while the rail is drawn, null otherwise.
export function setRailSlot(el: HTMLElement | null) {
  slot = el;
  slotChanged.emit();
}

/// Where a floating card goes while the sidebar is the rail, or null.
export function useRailSlot(): HTMLElement | null {
  return useSyncExternalStore(slotChanged.subscribe, () => slot);
}

/// A floating card's place while the sidebar is the icon rail: a button in the
/// rail's foot that opens the card beside it. Pinned bottom-left the card would
/// sit over the chat, since the rail is narrower than any card.
export function RailPop({
  slot,
  label,
  trigger,
  children,
}: {
  slot: HTMLElement;
  label: ReactNode;
  trigger: ReactElement;
  children: ReactNode;
}) {
  return createPortal(
    <PopoverPrimitive.Root>
      <Tooltip>
        <TooltipTrigger asChild>
          <PopoverPrimitive.Trigger asChild>{trigger}</PopoverPrimitive.Trigger>
        </TooltipTrigger>
        <TooltipContent side="right">{label}</TooltipContent>
      </Tooltip>
      <PopoverPrimitive.Portal>
        <PopoverPrimitive.Content
          side="right"
          align="end"
          sideOffset={8}
          className="z-50 outline-none data-open:animate-in data-open:fade-in-0 data-closed:animate-out data-closed:fade-out-0"
        >
          {children}
        </PopoverPrimitive.Content>
      </PopoverPrimitive.Portal>
    </PopoverPrimitive.Root>,
    slot,
  );
}
