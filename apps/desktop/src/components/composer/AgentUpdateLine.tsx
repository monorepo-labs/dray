import { Check } from "lucide-react";

import { Button } from "@/components/ui/button";
import Spinner from "@/components/ui/spinner";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import ShortcutKeys from "@/components/ShortcutKeys";
import { useHotkey } from "@/hooks/useHotkey";
import {
  updateAgent,
  updateAgentInTerminal,
  useAgentUpdates,
} from "@/hooks/useAgentUpdates";
import type { Harness } from "@/types/events";

/// The picked agent's CLI being behind, under the new-task composer.
///
/// Drawn only while there is something to say, the app's own update row's
/// reading. Same muted metrics as the "Press ⏎ to send" hint above it, since it
/// is a fact about the machine and not something the prompt is waiting on.
///
/// `waiting` holds Update while a turn on this agent is running. pi and
/// fx write over files a live session is reading, so they wait for a running
/// turn; the other three install beside the running binary and never wait.
export default function AgentUpdateLine({
  harness,
  waiting,
}: {
  harness: Harness;
  waiting: boolean;
}) {
  const { updates, running, done, failed } = useAgentUpdates();
  const update = updates.find((u) => u.harness === harness);
  const held = waiting || running !== null;
  // Bound only while the Update button is up and clickable, so ⌘U stays free
  // everywhere else.
  const ready = done !== harness && !!update && failed?.harness !== harness;
  useHotkey("agent.update", () => void updateAgent(harness), { enabled: ready && !held });

  if (done === harness) {
    return (
      <Line>
        <Check className="size-3" strokeWidth={2} />
        Updated
      </Line>
    );
  }

  if (!update) return null;

  if (failed?.harness === harness) {
    return (
      <Line>
        <span className="min-w-0 truncate" title={failed.message}>
          {update.label} update failed: {failed.message}
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
      {!busy && <ShortcutKeys ids={["agent.update"]} className={held ? "opacity-50" : undefined} />}
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
    </Line>
  );
}

function Line({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-6 min-w-0 items-center gap-1 text-ui text-muted-foreground/60">{children}</div>
  );
}
