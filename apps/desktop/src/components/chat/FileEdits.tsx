import { useState } from "react";
import { ChevronRight } from "lucide-react";

import { shortenPath } from "@/lib/tools";
import { cn } from "@/lib/utils";
import type { FileEdit } from "@/types/events";

/// Colors a unified diff by line prefix. Hunk headers first — `---`/`+++` would
/// otherwise read as a deletion and an addition.
function diffLineClass(line: string): string {
  if (line.startsWith("@@")) return "text-accent-thinking";
  if (line.startsWith("+++") || line.startsWith("---")) return "text-muted-foreground/60";
  if (line.startsWith("+")) return "text-emerald-400";
  if (line.startsWith("-")) return "text-destructive";
  return "text-muted-foreground";
}

/// Codex reports edits first-class; Claude Code does not, so its edits arrive as
/// ordinary `file_edit` tool calls and this renders only for Codex sessions.
export default function FileEdits({ edits }: { edits: FileEdit[] }) {
  if (!edits.length) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {edits.map((edit) => (
        <FileEditRow key={`${edit.path}-${edit.change}`} edit={edit} />
      ))}
    </div>
  );
}

function FileEditRow({ edit }: { edit: FileEdit }) {
  const [open, setOpen] = useState(false);

  const lines = edit.unifiedDiff?.split("\n") ?? [];

  return (
    <div className="group/edit flex flex-col gap-1.5">
      <button
        type="button"
        disabled={!lines.length}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 text-left text-chat"
      >
        <span
          className="min-w-0 max-w-fit truncate font-mono text-foreground/80"
          title={edit.path}
        >
          {shortenPath(edit.path)}
        </span>

        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-all",
            open ? "rotate-90 opacity-100" : "opacity-0 group-hover/edit:opacity-100",
            !lines.length && "invisible",
          )}
        />

        <span className="ml-auto shrink-0 text-muted-foreground/70">{edit.change}</span>
      </button>

      {open && lines.length > 0 && (
        <pre className="overflow-x-auto rounded-md bg-surface-raised px-2.5 py-2 font-mono text-tool">
          {lines.map((line, i) => (
            <div key={i} className={diffLineClass(line)}>
              {line || " "}
            </div>
          ))}
        </pre>
      )}
    </div>
  );
}
