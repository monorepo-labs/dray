import { SwatchIcon } from "@heroicons/react/16/solid";
import { X } from "lucide-react";

import { sides, unpinCanvasPick, useCanvasPicks } from "@/lib/canvas";
import { cn } from "@/lib/utils";

/// Elements picked on the Canvas tab, pinned to this composer like files. A
/// send writes each out as a block under the prompt (`withCanvasPicks`).
export default function CanvasPickTray({ sessionId }: { sessionId: string | null }) {
  const picks = useCanvasPicks(sessionId);
  if (!sessionId || picks.length === 0) return null;
  return (
    <ul className="flex flex-wrap gap-2">
      {picks.map((pick) => {
        const el = pick.element;
        const where = el.source?.split(":").slice(0, 2).join(":") ?? "no source line";
        const comp = el.components.at(-1);
        return (
          <li key={pick.key} className="group relative">
            <div className="flex h-14 max-w-72 items-center gap-2.5 rounded-lg border border-hairline-strong bg-card px-2.5">
              <SwatchIcon className="size-4 shrink-0 text-[#0d99ff]" />
              <div className="flex min-w-0 flex-col">
                <span className="truncate text-ui">
                  <span className="font-mono text-[12px]">&lt;{el.tag}&gt;</span>
                  {comp && <span className="text-muted-foreground"> in {comp}</span>}
                </span>
                <span className="truncate font-mono text-[11px] text-muted-foreground" title={where}>
                  {where.split("/").pop()} · p {sides(el.styles.padding)} · {el.styles.fontSize}
                </span>
              </div>
            </div>
            <button
              type="button"
              onClick={() => unpinCanvasPick(sessionId, pick.key)}
              aria-label={`Remove <${el.tag}> from the message`}
              className={cn(
                "absolute -top-1.5 -right-1.5 rounded-full border border-border bg-secondary p-0.5 text-secondary-foreground opacity-0 transition-opacity",
                "group-hover:opacity-100 focus-visible:opacity-100 focus-visible:outline-none",
              )}
            >
              <X className="size-3" strokeWidth={2.5} />
            </button>
          </li>
        );
      })}
    </ul>
  );
}
