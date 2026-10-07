import { Check, Copy } from "lucide-react";

import { useCopied } from "@/hooks/useCopied";
import { cn } from "@/lib/utils";

/// A shell line with a copy on it, for the reader to run in their own terminal.
///
/// Full width by default, so the line has room to be read whole. Beside a
/// button in a row, pass `flex-1` to share the row instead of pushing it off.
export default function CommandChip({ command, className }: { command: string; className?: string }) {
  const [copied, copy] = useCopied();

  return (
    <div
      className={cn(
        "flex h-8 w-full min-w-0 shrink-0 items-center gap-2 rounded-md border border-border pr-1 pl-3 dark:border-input",
        className,
      )}
    >
      <code className="flex-1 truncate font-mono text-code text-foreground">{command}</code>
      <button
        type="button"
        aria-label={`Copy ${command}`}
        onClick={() => void copy(command)}
        className="flex size-6 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}
