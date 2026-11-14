import { X } from "lucide-react";
import { lazy, Suspense, useEffect } from "react";

import { DropZone } from "@/components/SplitView";
import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { setDropping } from "@/lib/browser";
import { useOpenFiles, useOpenFilesWatcher } from "@/hooks/useOpenFiles";
import { Sheet } from "@/components/layout/AppShell";
import { removeSplit, usePaneHead, useSplitDrag, useSplitGroups, useSplitPanes } from "@/lib/splitPanes";
import { cn } from "@/lib/utils";
import type { TabKey } from "@/lib/tabOrder";

const FileViewer = lazy(() => import("@/components/files/FileViewer"));

/// The panes of a session's split groups, each a card right of the main one
/// with its tab's own icon and title over it. Only the lit group's are drawn;
/// the rest hide rather than unmount, so a pane keeps its scroll. Equal
/// widths, and the drop that would make one too narrow is refused.
export default function SplitPanes({
  sessionId,
  body,
}: {
  /// The row's session, whose groups these are.
  sessionId: string | null;
  /// What a pane draws, by its tab's key; `shown` while its group is lit.
  body: (key: TabKey, shown: boolean) => React.ReactNode;
}) {
  const groups = useSplitGroups(sessionId);
  const lit = useSplitPanes(sessionId);
  const drag = useSplitDrag();
  const hint = sessionId && drag?.sessionId === sessionId ? drag.label : null;
  useEffect(() => {
    setDropping(!!hint);
    return () => setDropping(false);
  }, [hint]);
  return (
    <>
      {sessionId &&
        groups
          .flatMap((g) => g.slice(1))
          .map((key) => {
            const shown = lit.includes(key);
            return (
              <div key={key} className={cn("flex min-w-0 flex-1", !shown && "hidden")}>
                <div className="w-1.5 shrink-0 bg-surface-frame" />
                <Sheet className="flex-1">
                  <div className="flex min-w-0 flex-1 flex-col">
                    <PaneHeader sessionId={sessionId} paneKey={key} onClose={() => removeSplit(sessionId, key)} />
                    <div className="flex min-h-0 flex-1 flex-col">
                      <Suspense fallback={null}>{body(key, shown)}</Suspense>
                    </div>
                  </div>
                </Sheet>
              </div>
            );
          })}
      {hint && (
        // The column the drop makes: the last of `lit.length + 2` equal ones.
        <div
          className="pointer-events-none absolute inset-y-0 right-0 z-30"
          style={{ width: `${100 / (lit.length + 2)}%` }}
        >
          <DropZone region="center" label={hint} />
        </div>
      )}
    </>
  );
}

function PaneHeader({ sessionId, paneKey, onClose }: { sessionId: string; paneKey: TabKey; onClose: () => void }) {
  const head = usePaneHead(sessionId, paneKey);
  return (
    <div className="flex h-8 shrink-0 items-center gap-2 border-b border-hairline px-3 text-ui text-muted-foreground">
      {head?.icon}
      <span className="min-w-0 truncate">{head?.label ?? ""}</span>
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

/// One of the session's open files, read from its own store: the tab is only
/// left out of the row, so the file stays the session's. Watched under the
/// pane's own scope, since the Files view may not be mounted to watch it.
export function SplitFile({ sessionId, path }: { sessionId: string; path: string }) {
  const file = useOpenFiles(sessionId).open.find((f) => f.path === path) ?? null;
  useOpenFilesWatcher(sessionId, `filepane:${path}`, path);
  // Closed from elsewhere: nothing left to show.
  useEffect(() => {
    if (!file) removeSplit(sessionId, `file:${path}`);
  }, [file, sessionId, path]);
  return <FileViewer file={file} />;
}
