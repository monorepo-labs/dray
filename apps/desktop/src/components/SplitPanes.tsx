import { Folder, X } from "lucide-react";
import { Suspense, useEffect } from "react";

import { DropZone } from "@/components/SplitView";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setDropping } from "@/lib/browser";
import { closeSplit, usePaneHead, useSplitDrag, useSplitPanes } from "@/lib/splitPanes";
import type { TabKey } from "@/lib/tabOrder";

/// The tabs a session's row split out, each a column right of the main view
/// with its tab's own icon and title over it. Equal widths, like the split
/// view's columns; the drop that would make one too narrow is refused.
export default function SplitPanes({
  sessionId,
  body,
}: {
  /// The row's session, whose splits these are.
  sessionId: string | null;
  /// What a pane draws, by its tab's key.
  body: (key: TabKey) => React.ReactNode;
}) {
  const panes = useSplitPanes(sessionId);
  const drag = useSplitDrag();
  const hint = sessionId && drag?.sessionId === sessionId ? drag.label : null;
  useEffect(() => {
    setDropping(!!hint);
    return () => setDropping(false);
  }, [hint]);
  return (
    <>
      {sessionId &&
        panes.map((key) => (
          <div key={key} className="flex min-w-0 flex-1 flex-col border-l border-hairline-strong">
            <PaneHeader sessionId={sessionId} paneKey={key} onClose={() => closeSplit(sessionId, key)} />
            <div className="flex min-h-0 flex-1 flex-col">
              <Suspense fallback={null}>{body(key)}</Suspense>
            </div>
          </div>
        ))}
      {hint && (
        // The column the drop makes: the last of `panes.length + 2` equal ones.
        <div className="pointer-events-none absolute inset-y-0 right-0" style={{ width: `${100 / (panes.length + 2)}%` }}>
          <DropZone region="center" label={hint} />
        </div>
      )}
    </>
  );
}

function PaneHeader({ sessionId, paneKey, onClose }: { sessionId: string; paneKey: TabKey; onClose: () => void }) {
  const head = usePaneHead(sessionId, paneKey);
  // A Files pane stands for no tab of the row, so it names itself.
  const files = paneKey.startsWith("filepane:");
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-3 text-ui text-muted-foreground">
      {files ? <Folder className="size-3.5 shrink-0 fill-current" /> : head?.icon}
      <span className="min-w-0 truncate">{files ? "Files" : (head?.label ?? "")}</span>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button variant="ghost" size="icon-xs" className="ml-auto shrink-0" aria-label="Close pane" onClick={onClose}>
            <X />
          </Button>
        </TooltipTrigger>
        {/* Beside the button, never below it: a page's native view would draw over it there. */}
        <TooltipContent side="left">Back to the tab row</TooltipContent>
      </Tooltip>
    </div>
  );
}
