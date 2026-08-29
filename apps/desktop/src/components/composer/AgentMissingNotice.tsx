import { useEffect, useRef, useState } from "react";
import { Check, Copy } from "lucide-react";
import { openUrl } from "@tauri-apps/plugin-opener";

import { Button } from "@/components/ui/button";
import type { AgentAvailability } from "@/types/events";

const COPIED_MS = 1600;

/// Why the composer will not send, and the two things that fix it.
///
/// Drawn where the composer's error already draws — above the toolbar, so the
/// reason reads before the controls it disables. It is not the error slot
/// itself because this is not a failure that happened: nothing was attempted,
/// and nothing will be until the reader acts on it.
///
/// **No fill.** A well or a tint reads as a result — something that landed —
/// where this is a state the composer is in. `border-border/60` with nothing
/// behind it is the frame [CodeView]/[DiffView] already use for exactly that:
/// a boundary with no claim about what's inside it.
///
/// **`rounded-xl`, one step under the composer card's own `rounded-2xl`.**
/// Matching it exactly read as the same shape repeated; a step down keeps the
/// family without the notice competing with the card it sits above.
///
/// **The command itself is not shown.** The button already carries it —
/// printing it too is the same fact twice, and it was the one line here
/// forcing the row onto two.
///
/// **Buttons sit right, text left**, one row: the two actions are the reply to
/// the sentence beside them, not a block under it.
///
/// **The command is copied, never run.** Each vendor's own install script, not
/// npm: it needs nothing already on the machine, and it's the same route their
/// own docs point at. The link sits beside the button rather than behind it for
/// the reader without `curl`, or wary of piping one into a shell.
export default function AgentMissingNotice({ agent }: { agent: AgentAvailability }) {
  const [copied, setCopied] = useState(false);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(() => () => void (timer.current && clearTimeout(timer.current)), []);

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(agent.installCommand);
    } catch (err) {
      console.error("failed to copy the install command", err);
      return;
    }
    setCopied(true);
    if (timer.current) clearTimeout(timer.current);
    timer.current = setTimeout(() => setCopied(false), COPIED_MS);
  };

  return (
    <div className="mb-2 flex items-center gap-3 rounded-xl border border-border/60 px-3 py-2">
      <p className="min-w-0 flex-1 truncate text-ui text-foreground">
        {agent.label} isn&rsquo;t installed, so this session can&rsquo;t start.
      </p>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="secondary" size="sm" onClick={() => void copy()}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy command"}
        </Button>
        <Button variant="ghost" size="sm" onClick={() => void openUrl(agent.docsUrl)}>
          Install guide
        </Button>
      </div>
    </div>
  );
}
