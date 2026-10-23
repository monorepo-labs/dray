import { CopyPlus } from "lucide-react";

import { ContextMenu, ContextMenuContent, ContextMenuItem } from "@/components/ui/context-menu";

/// A browser tab's right-click menu, shared by the panel's strip and the
/// titlebar row so the two offer the same thing. The tab inside wraps itself in
/// `ContextMenuTrigger`, which has to sit under a tooltip's trigger where there
/// is one, and a menu root cannot.
export default function TabMenu({
  onDuplicate,
  children,
}: {
  onDuplicate?: () => void;
  children: React.ReactNode;
}) {
  return (
    <ContextMenu>
      {children}
      {onDuplicate && (
        <ContextMenuContent className="w-40">
          <ContextMenuItem className="text-ui" onSelect={onDuplicate}>
            <CopyPlus />
            Duplicate tab
          </ContextMenuItem>
        </ContextMenuContent>
      )}
    </ContextMenu>
  );
}
