import { useEffect, useState } from "react";

import EventRow from "@/components/chat/EventRow";
import UserMessage from "@/components/chat/UserMessage";
import { OrbLine } from "@/components/chat/WorkingIndicator";
import { ChatSessionContext } from "@/hooks/useChatSession";
import { invoke } from "@/lib/transport";
import { subagentBrief } from "@/lib/tools";
import type { SubagentRun } from "@/lib/transcript";
import type { AgentEvent, ToolResult } from "@/types/events";

/// A subagent's conversation as a tab of its own: the brief it was given, then
/// everything it did. Claude Code streams a child's work into the parent's log,
/// so the run already holds it; fx streams none of it, so its run is read back
/// from fx's own session store, which saves a turn only once it ends.
export default function SubagentView({
  run,
  sessionId,
  cwd,
  resultByCallId,
}: {
  run: SubagentRun;
  sessionId: string;
  cwd: string;
  resultByCallId: Map<string, ToolResult>;
}) {
  const spawn = run.spawn?.payload.type === "tool_call_started" ? run.spawn.payload : null;
  const input = spawn?.input as Record<string, unknown> | undefined;
  const nested = spawn ? subagentBrief(spawn.input) : null;
  const brief = nested?.task ?? (typeof input?.prompt === "string" ? input.prompt : null);
  const agent = run.spawn?.harness === "fx" ? (nested?.agent ?? null) : null;
  // The call's result moves when fx's report lands, which is when the child's
  // turn is saved and worth reading again.
  const report = resultByCallId.get(run.id)?.text;
  const fx = useFxHistory(agent ? sessionId : null, agent, report);
  const working = !run.done;
  // OpenCode streams nothing of the child's own, so its report — the spawning
  // call's result — is drawn as the child's answer once it lands.
  const opencodeReport =
    run.spawn?.harness === "opencode" && !working && report
      ? [{ ...run.spawn, id: `${run.spawn.id}:report`, payload: { type: "assistant_text" as const, block: null, text: report } }]
      : [];
  const events = (agent ? (fx.events ?? []) : run.events).flatMap(handback).concat(opencodeReport);

  return (
    <ChatSessionContext value={{ cwd, sessionId }}>
      <div className="min-h-0 flex-1 overflow-y-auto">
        <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">
          {/* Claude Code logs the brief as the child's first message, and fx
              keeps it in the child's saved history; drawn here only until
              one of those is there to draw it. */}
          {brief && !events.some((e) => e.payload.type === "user_message") && <UserMessage text={brief} />}
          {events.map((event) => (
            <EventRow key={event.id} event={event} resultByCallId={fx.results ?? resultByCallId} />
          ))}
          {working ? (
            <OrbLine state="working" label={run.status ?? "Working"} />
          ) : (
            agent &&
            fx.error && <p className="text-ui text-muted-foreground">{fx.error}</p>
          )}
        </div>
      </div>
    </ChatSessionContext>
  );
}

/// Claude Code's subagent reports back through a `SubagentHandback` call whose
/// `message` is its answer. Drawn as a tool row it hid the one thing the reader
/// opened the tab for, so it reads as the reply it is, and its "delivered"
/// result goes.
function handback(event: AgentEvent): AgentEvent[] {
  const p = event.payload;
  if (p.type !== "tool_call_started" || p.name !== "SubagentHandback") return [event];
  const text = (p.input as Record<string, unknown> | null)?.message;
  return typeof text === "string" ? [{ ...event, payload: { type: "assistant_text", block: null, text } }] : [event];
}

type FxHistory = { events: AgentEvent[] | null; results: Map<string, ToolResult> | null; error: string | null };

/// An fx child's saved conversation, read again whenever `revision` moves.
function useFxHistory(sessionId: string | null, agent: string | null, revision: unknown): FxHistory {
  const [state, setState] = useState<FxHistory>({ events: null, results: null, error: null });
  useEffect(() => {
    if (!sessionId || !agent) return;
    let live = true;
    invoke<AgentEvent[]>("fx_subagent_events", { sessionId, agent })
      .then((events) => {
        if (!live) return;
        const results = new Map<string, ToolResult>();
        for (const e of events) if (e.payload.type === "tool_call_completed") results.set(e.payload.callId, e.payload.result);
        setState({ events, results, error: null });
      })
      .catch((e) => live && setState((prev) => ({ ...prev, error: String(e) })));
    return () => {
      live = false;
    };
  }, [sessionId, agent, revision]);
  return state;
}
