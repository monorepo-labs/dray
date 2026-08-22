import { useState } from "react";

import { Button } from "@/components/ui/button";
import type { PermissionOption, PermissionOptionKind } from "@/types/events";

/// Ordered by how much they grant, which is not the order the CLI suggests them
/// in. "Allow once" reads first because it is the answer that commits to
/// nothing, and the session-wide options sit last so a fast click can't land on
/// them.
const KIND_ORDER: Record<PermissionOptionKind, number> = {
  once: 0,
  always_rule: 1,
  always_directory: 2,
  switch_mode: 3,
  deny: 4,
};

/// A tool call waiting on the user. The agent is blocked while this renders, so
/// it is the one row in the transcript that must never be purely informational.
///
/// Rendered below the transcript rather than inside a turn, which is what lets
/// one component serve both threads: a subagent's tool call is filed into the
/// panel and a main-thread one sits in a turn that collapses when it closes, so
/// neither can be relied on to be next to the question.
///
/// That is also why it carries the command itself. Nothing above it is
/// guaranteed to be on screen, and "Create a marker file" with no command under
/// it is a question about something invisible.
///
/// Purely transient: once answered it disappears, either way. The tool call it
/// belongs to reports both outcomes on its own — a refusal as its error, an
/// approval by simply running.
export default function PermissionRequest({
  description,
  argument,
  options,
  onRespond,
}: {
  /// The agent's own summary of the call. Filled in upstream when the harness
  /// sends none, so it is never empty.
  description: string;
  /// The call's identifying argument — the command, the path. `null` only when
  /// the input carries no conventional field to show.
  argument: string | null;
  options: PermissionOption[];
  onRespond: (optionId: string) => void;
}) {
  // Never cleared: the reply is one-shot in the backend, so a second click has
  // nothing to answer. This keeps the buttons from inviting one during the round
  // trip that mints the decision event.
  const [sent, setSent] = useState<string | null>(null);

  return (
    <div className="rounded-2xl border border-border bg-muted/30 p-4">
      {/* Outlined rather than filled: the card already sits on a tinted panel,
          and a second fill inside it reads as a third surface. */}
      {argument && (
        <pre className="mb-3 overflow-x-auto rounded-lg border border-border px-3 py-2.5 font-mono text-xs">
          {argument}
        </pre>
      )}

      <p className="text-chat">{description}</p>

      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {[...options]
          .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
          .map((option) => (
            <Button
              key={option.id}
              size="sm"
              variant={optionVariant(option.kind)}
              disabled={sent !== null}
              onClick={() => {
                setSent(option.id);
                onRespond(option.id);
              }}
            >
              {option.label}
            </Button>
          ))}
      </div>
    </div>
  );
}

/// Only "allow once" is filled. The standing-rule options outlast the call they
/// were granted for, so they read as the deliberate choice rather than the
/// obvious one.
function optionVariant(kind: PermissionOptionKind) {
  if (kind === "once") return "default" as const;
  if (kind === "deny") return "destructive" as const;
  return "outline" as const;
}

