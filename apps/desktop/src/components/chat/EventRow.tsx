import { Archive, CircleAlert, CircleDollarSign, ShieldX, TriangleAlert } from "lucide-react";

import AssistantMessage from "@/components/chat/AssistantMessage";
import Reasoning from "@/components/chat/Reasoning";
import ToolCall from "@/components/chat/ToolCall";
import UserMessage from "@/components/chat/UserMessage";
import FileEdits from "@/components/chat/FileEdits";
import { compactTokens, resetTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { AgentEvent, ToolResult } from "@/types/events";

/// A quiet single line for the events that are context rather than content.
function Notice({
  icon: Icon,
  children,
  tone = "muted",
  wrap = false,
}: {
  icon: typeof Archive;
  children: React.ReactNode;
  tone?: "muted" | "destructive";
  /// Lets the text run onto a second line. Off by default — most notices are
  /// context the reader skims — but on where every word carries information the
  /// reader has to act on, and a clipped tail would hide it.
  wrap?: boolean;
}) {
  return (
    <p
      className={cn(
        "flex gap-2 text-chat",
        wrap ? "items-start" : "items-center",
        tone === "destructive" ? "text-destructive" : "text-muted-foreground/70",
      )}
    >
      {/* A flat 4px, not an em fraction. `items-start` puts the icon's box at
          the line's top edge while its glyph sits inset within that box, so it
          reads high against the first line of text. */}
      <Icon className={cn("size-3.5 shrink-0", wrap && "mt-1")} />
      <span className={wrap ? "min-w-0 wrap-anywhere" : "truncate"}>{children}</span>
    </p>
  );
}

/// The one place event payloads become UI. Every variant is handled; the default
/// arm exists for a payload kind from a newer backend than this build.
export default function EventRow({
  event,
  resultByCallId,
  hideToolLabel = false,
  openTool = false,
  onOpenSession,
}: {
  event: AgentEvent;
  /// Results keyed by call id, so a started call renders its own outcome without
  /// searching the event list itself.
  resultByCallId: Map<string, ToolResult>;
  /// Passed down by `ToolGroupRow`, whose header already names the tool.
  hideToolLabel?: boolean;
  /// Draws a tool call already expanded. Only the subagent panel sets it, for
  /// the call the reader opened the run to see.
  openTool?: boolean;
  /// Opens the session that relayed a prompt. Only a `user_message` reads it,
  /// and only one that came over the orchestration socket.
  onOpenSession?: (sessionId: string) => void;
}) {
  const { payload } = event;

  switch (payload.type) {
    case "user_message":
      return (
        <UserMessage
          text={payload.text}
          images={payload.images}
          from={payload.from}
          onOpenSession={onOpenSession}
        />
      );

    case "assistant_text":
      return <AssistantMessage text={payload.text} />;

    case "reasoning":
      return <Reasoning text={payload.text} encrypted={payload.encrypted} />;

    case "tool_call_started":
      return (
        <ToolCall
          name={payload.name}
          toolType={payload.toolType}
          title={payload.title}
          input={payload.input}
          rawInput={payload.rawInput}
          result={resultByCallId.get(payload.callId)}
          hideLabel={hideToolLabel}
          defaultOpen={openTool}
        />
      );

    // Rendered by the `tool_call_started` row it completes, via `resultByCallId`.
    case "tool_call_completed":
      return null;

    case "file_edits":
      return <FileEdits edits={payload.edits} />;

    case "error":
      return (
        <div className="flex items-start gap-2 text-chat text-destructive">
          <TriangleAlert className="mt-0.5 size-3.5 shrink-0" />
          <span className="min-w-0 whitespace-pre-wrap wrap-anywhere">{payload.message}</span>
        </div>
      );

    case "turn_completed":
      // Only a failure earns a line. Cost and token counts are accounting, not
      // conversation, and belong in a session-level surface rather than after
      // every message.
      if (payload.status !== "error") return null;
      // A user abort ends the turn as an error on the wire (`aborted_streaming`
      // mid-response, `aborted_tools` mid-call), but the user did it on
      // purpose — reporting their own stop back as a failure is noise.
      if (payload.stopReason?.startsWith("aborted")) return null;
      return (
        <Notice icon={TriangleAlert} tone="destructive">
          Turn failed{payload.stopReason ? ` — ${payload.stopReason}` : ""}
        </Notice>
      );

    case "rate_limited": {
      // Only actionable reports reach here — the mapper drops the healthy ones
      // — so anything that arrives is worth a line. Overage in use is the
      // softer case: work continues, but the bill moves to usage.
      const resets = payload.resetsAt ? resetTime(payload.resetsAt) : "";
      const suffix = resets ? ` Resets ${resets}.` : "";

      if (payload.usingOverage) {
        return (
          <Notice icon={CircleDollarSign} wrap>
            Plan limit reached — now billed as usage.{suffix}
          </Notice>
        );
      }

      return (
        <Notice icon={CircleAlert} tone="destructive" wrap>
          Usage limit reached.{suffix}
          {payload.overageDisabledReason === "org_level_disabled" &&
            " Your organization has overage turned off."}
        </Notice>
      );
    }

    case "permission_denied":
      return (
        <Notice icon={ShieldX} tone="destructive" wrap>
          {payload.message}
        </Notice>
      );

    // Shaped like a settled tool call — label then detail — because that is what
    // it is: work the harness did on the conversation, reported after the fact.
    // No caret; there is nothing underneath to open.
    case "context_compacted": {
      const saved =
        payload.preTokens != null && payload.postTokens != null
          ? payload.preTokens - payload.postTokens
          : null;

      return (
        <div className="flex w-full items-center gap-2 text-chat">
          <span className="shrink-0 text-foreground/80">Compacted</span>
          {saved != null && saved > 0 && (
            <span className="min-w-0 max-w-fit truncate text-muted-foreground">
              Saved {compactTokens(saved)} tokens
            </span>
          )}
        </div>
      );
    }

    // Deliberately unrendered. Hooks, settings changes, and unrecognized event
    // kinds are harness plumbing the reader never acts on; session setup, token
    // counts, subagent lifecycle, and stream previews drive UI elsewhere (the
    // header, the subagent panel, the live block).
    case "hook":
    case "settings_changed":
    case "unknown":
    case "turn_started":
    case "usage_update":
    case "subagent_started":
    case "subagent_progress":
    case "subagent_completed":
    case "background_tasks_changed":
    case "delta":
    // Drives the working indicator, not a row. It marks the start of a wait, and
    // a wait is exactly the thing with nothing to show.
    case "model_request_started":
    // Drives the live indicator, not a row — the compaction it opens draws its
    // own line when it closes.
    case "context_compaction_started":
    // Every held request lives outside the turn stack: `Chat` renders the open
    // ones below the transcript, where a subagent's request has somewhere to go
    // and a main-thread one can't be buried in a turn that collapses. A settled
    // one draws nothing anywhere — for a question because the `AskUserQuestion`
    // row underneath reports what was answered.
    case "permission_requested":
    case "questions_asked":
    case "permission_decided":
      return null;

    default:
      return null;
  }
}
