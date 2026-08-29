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

/// The diffs a patch made, drawn inside the tool row that made them.
///
/// Codex reports edits first-class; Claude Code does not, so its edits arrive as
/// ordinary `file_edit` tool calls and this renders only for Codex sessions.
///
/// A single edit draws **no header of its own**. The row above already says
/// "Edited notes.md" with the full path on it, so repeating the filename put it
/// on screen twice and made one action read as two. Several edits still get one
/// line each, because there the row above says only how many files there were.
export default function FileEdits({ edits }: { edits: FileEdit[] }) {
  if (!edits.length) return null;

  return (
    <div className="flex flex-col gap-1.5">
      {edits.map((edit) => (
        <FileEditRow
          key={`${edit.path}-${edit.change}`}
          edit={edit}
          named={edits.length > 1}
        />
      ))}
    </div>
  );
}

function FileEditRow({ edit, named }: { edit: FileEdit; named: boolean }) {
  const [open, setOpen] = useState(!named);

  const lines = edit.unifiedDiff?.split("\n") ?? [];

  // The only edit in a patch: the row above is its header, so this is the diff
  // and nothing else.
  if (!named) {
    return lines.length ? (
      <pre className="overflow-x-auto rounded-md bg-surface-raised px-2.5 py-2 font-mono text-tool">
        {lines.map((line, i) => (
          <div key={i} className={diffLineClass(line)}>
            {line || " "}
          </div>
        ))}
      </pre>
    ) : null;
  }

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
