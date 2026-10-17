import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { pickAgentMode, useAgentModes, usePendingAgentMode } from "@/lib/agentModes";
import { invoke, type ServerId } from "@/lib/transport";
import type { Harness } from "@/types/events";

/// An ACP agent's stance picker, drawn from the agent's own modes under its own
/// names — Dray's four stances mean nothing to an agent that publishes its own.
///
/// The list is learned off the agent's last session, so an agent never run here
/// draws nothing until its first session has opened.
export default function AgentModeSelector({
  server,
  harness,
  sessionId,
  locked = false,
}: {
  server: ServerId;
  harness: Harness;
  /// `null` for a new task, whose pick rides the send.
  sessionId: string | null;
  locked?: boolean;
}) {
  const { modes, current } = useAgentModes(harness, sessionId, server);
  const pending = usePendingAgentMode(harness);
  // Moved optimistically, until the session's own answer comes back.
  const [moved, setMoved] = useState<string | null>(null);
  useEffect(() => setMoved(null), [sessionId, current]);
  const [open, setOpen] = useState(false);
  if (locked && open) setOpen(false);
  if (modes.length < 2) return null;

  const value = sessionId ? (moved ?? current) : (pending ?? current);
  const selected = modes.find((m) => m.id === value);

  const choose = (mode: string) => {
    if (!sessionId) return pickAgentMode(harness, mode);
    setMoved(mode);
    invoke("set_agent_mode", { sessionId, mode }).catch(() => setMoved(null));
  };

  return (
    <DropdownMenu open={open} onOpenChange={(next) => setOpen(next && !locked)}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="sm"
              aria-disabled={locked}
              className="px-1.5 text-ui text-muted-foreground aria-disabled:opacity-50"
              aria-label="Switch mode"
            >
              {selected?.name ?? "Mode"}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        <TooltipContent side="top">
          {locked ? "Mode can't be changed mid-turn" : "Switch mode"}
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="start" className="min-w-44 max-w-72">
        <DropdownMenuRadioGroup value={value ?? ""} onValueChange={choose}>
          {modes.map((mode) => (
            <DropdownMenuRadioItem key={mode.id} value={mode.id} className="text-ui">
              <span className="flex flex-col">
                {mode.name}
                {mode.description && (
                  <span className="text-xs text-muted-foreground">{mode.description}</span>
                )}
              </span>
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
