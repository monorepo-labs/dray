import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import Spinner from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import ShortcutKeys from "@/components/ShortcutKeys";
import { HINT_KEYS } from "@/components/Sidebar";
import { useHotkey } from "@/hooks/useHotkey";
import {
  updateAgent,
  updateAgentInTerminal,
  useAgentUpdates,
} from "@/hooks/useAgentUpdates";
import { cn } from "@/lib/utils";
import type { Harness } from "@/types/events";

/// The picked agent's CLI updating, under the new-task composer.
///
/// Drawn only while there is something to say, the app's own update row's
/// reading. Same muted metrics as the "Press ⏎ to send" hint above it, since it
/// is a fact about the machine and not something the prompt is waiting on.
///
/// Updates run on their own, so this says one is running, finished or failed.
/// With that setting off it offers the Update button instead, and `waiting`
/// holds the button while a turn on this agent is running. pi and fx write over
/// files a live session is reading, so they wait for a running turn; the other
/// three install beside the running binary and never wait.
export default function AgentUpdateLine({
  harness,
  waiting,
}: {
  harness: Harness;
  waiting: boolean;
}) {
  const { updates, running, done, failed, auto } = useAgentUpdates();
  const update = updates.find((u) => u.harness === harness);
  const held = waiting || running !== null;
  // Bound only while the Update button is up and clickable, so ⌘U stays free
  // everywhere else. Platform-only, since Ctrl+U on a Mac deletes to the line
  // start in the composer.
  const failure = failed[harness];
  const ready = !auto && done !== harness && !!update && !failure;
  useHotkey("agent.update", () => void updateAgent(harness), {
    enabled: ready && !held,
    platformOnly: true,
  });

  if (done === harness) {
    return (
      <Line>
        <Check className="size-3" strokeWidth={2} />
        Updated
      </Line>
    );
  }

  if (!update) return null;

  if (failure) {
    return (
      <Line>
        <span className="min-w-0 truncate" title={failure}>
          {update.label} update failed: {failure}
        </span>
        <Button
          type="button"
          variant="ghost"
          size="xs"
          onClick={() => updateAgentInTerminal(harness)}
        >
          Run in Terminal
        </Button>
      </Line>
    );
  }

  const busy = running === harness;
  if (auto) {
    return busy ? (
      <Line>
        <Spinner className="size-3" />
        Updating {update.label}…
      </Line>
    ) : null;
  }

  // `aria-disabled` rather than `disabled`, `UpdateRow`'s reason: the wait is
  // explained in a tooltip, and a disabled button opens none.
  const button = (
    <Button
      type="button"
      variant="ghost"
      size="xs"
      aria-disabled={held}
      onClick={() => !held && void updateAgent(harness)}
      className="aria-disabled:cursor-default aria-disabled:opacity-50"
    >
      {busy && <Spinner className="size-3" />}
      {busy ? "Updating…" : "Update"}
    </Button>
  );

  return (
    <Line>
      <span className="min-w-0 truncate text-accent-add">
        {update.label} update available
      </span>
      {waiting && !busy ? (
        <Tooltip>
          <TooltipTrigger asChild>{button}</TooltipTrigger>
          <TooltipContent side="bottom">
            Waiting for the running {update.label} turn to finish.
          </TooltipContent>
        </Tooltip>
      ) : (
        button
      )}
      {!busy && (
        <ShortcutKeys
          ids={["agent.update"]}
          className={cn(
            "[&_kbd]:h-4 [&_kbd]:min-w-4 [&_kbd]:text-[10px]",
            held && HINT_KEYS,
          )}
        />
      )}
    </Line>
  );
}

function Line({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-6 min-w-0 items-center gap-1 text-ui text-muted-foreground/60">{children}</div>
  );
}
