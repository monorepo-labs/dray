import { Check, Copy } from "lucide-react";

import { useCopied } from "@/hooks/useCopied";

/// A shell line with a copy on it, for the reader to run in their own terminal.
///
/// Pinned to `h-6` with a `size-5` copy inside it so it matches a small button
/// beside it: its own `py-1` around a `size-6` button comes to 34px where a
/// small button draws at 26.
export default function CommandChip({ command }: { command: string }) {
  const [copied, copy] = useCopied();

  return (
    <div className="flex h-6 max-w-full min-w-0 shrink-0 items-center gap-1 rounded-md border border-border pr-0.5 pl-2 dark:border-input">
      <code className="truncate font-mono text-code text-foreground">{command}</code>
      <button
        type="button"
        aria-label={`Copy ${command}`}
        onClick={() => void copy(command)}
        className="flex size-5 shrink-0 cursor-pointer items-center justify-center rounded-sm text-muted-foreground transition-colors outline-none hover:bg-sidebar-accent hover:text-foreground focus-visible:ring-3 focus-visible:ring-ring/50"
      >
        {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
      </button>
    </div>
  );
}
