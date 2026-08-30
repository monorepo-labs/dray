import { describe, expect, it } from "vitest";

import { authFailedTurn } from "@/lib/auth";
import type { AgentEvent } from "@/types/events";

/// Only the fields `authFailedTurn` reads are filled. The rest of the envelope
/// has no bearing on which turn gets picked.
function turn(id: string, authFailed: boolean): AgentEvent {
  return {
    id,
    sessionId: "s",
    harness: "claude_code",
    seq: 0,
    ts: "2026-08-30T00:00:00Z",
    turnId: null,
    subagent: null,
    raw: null,
    payload: {
      type: "turn_completed",
      status: authFailed ? "error" : "success",
      stopReason: null,
      authFailed,
      finalText: null,
      usage: null,
      durationMs: null,
      head: null,
    },
  };
}

function message(id: string): AgentEvent {
  return {
    ...turn(id, false),
    payload: { type: "assistant_text", text: "hi", block: null },
  };
}

describe("authFailedTurn", () => {
  it("names the failing turn by its own id", () => {
    expect(authFailedTurn([turn("a", true)])).toBe("a");
  });

  it("answers null for a session that never failed", () => {
    expect(authFailedTurn([turn("a", false)])).toBeNull();
    expect(authFailedTurn([])).toBeNull();
  });

  /// The whole reason the walk stops at the first turn it meets. A login that
  /// has since worked is not a state to cure, and reading further back would
  /// leave the notice up forever.
  it("forgets a failure once any later turn completes", () => {
    expect(authFailedTurn([turn("a", true), turn("b", false)])).toBeNull();
  });

  it("raises again when a later turn fails, under a new id", () => {
    expect(authFailedTurn([turn("a", true), turn("b", false), turn("c", true)])).toBe("c");
  });

  /// Events that are not turn endings are stepped over rather than ending the
  /// search — a failed turn is followed by whatever the reader does next.
  it("looks past events that are not turn endings", () => {
    expect(authFailedTurn([turn("a", true), message("m")])).toBe("a");
  });
});
