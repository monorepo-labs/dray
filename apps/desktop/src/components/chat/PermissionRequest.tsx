import { useState } from "react";

import { Markdown } from "@/components/chat/Markdown";
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
  onViewPlan,
}: {
  /// The agent's own summary of the call. Filled in upstream when the harness
  /// sends none, so it is never empty.
  description: string;
  /// The call's identifying argument — the command, the path. `null` only when
  /// the input carries no conventional field to show.
  argument: string | null;
  options: PermissionOption[];
  onRespond: (optionId: string) => void;
  /// Opens the panel's Plan tab. Present on a plan approval alone, where the
  /// argument is pages of markdown rather than a command: a `<pre>` of it is
  /// the one shape this card cannot draw, so it points at the reader instead.
  ///
  /// Its presence is also what makes the description render as markdown, which
  /// is one question rather than two — a card carrying a plan is exactly the
  /// card whose description was written as one.
  onViewPlan?: () => void;
}) {
  // Never cleared: the reply is one-shot in the backend, so a second click has
  // nothing to answer. This keeps the buttons from inviting one during the round
  // trip that mints the decision event.
  const [sent, setSent] = useState<string | null>(null);

  return (
    // `--card`, the app's one surface-above-the-page token, rather than a wash
    // of `--muted`. The wash is a tint of the page rather than a surface of its
    // own, so on a light palette it landed as a grey slab that read as a
    // disabled region — the one thing a card holding a live question must not
    // look like. `--card` is what every other raised thing here is drawn on, so
    // the question now sits on the same surface as the rest of the app.
    // `--shadow-card`, the token a surface resting on the page takes — the
    // user bubble's own, not the composer's `--shadow-surface`. The border
    // alone drew the box and said nothing about height, which on a card
    // holding the one question in the transcript that blocks the agent is the
    // wrong way round: it has to read as sitting above the conversation rather
    // than as another row in it.
    <div className="rounded-2xl border border-border bg-card p-4 shadow-(--shadow-card)">
      {/* Outlined rather than filled: the card already sits on a raised
          surface, and a second fill inside it reads as a third. */}
      {argument && (
        <pre className="mb-3 overflow-x-auto rounded-lg border border-border px-3 py-2.5 font-mono text-xs">
          {argument}
        </pre>
      )}

      {/* A plan's description *is* the plan — headings, lists, fenced code,
          pages of it — where every other card's is one sentence. Drawn as a
          `<p>` it arrived as one run-on paragraph with the `#` and `-` still
          in it, which is the agent's proposal made harder to read than the
          raw text it was written as. So the one card that carries markdown
          renders it, at `text-chat`'s own reading leading; the Plan tab is
          still where a long one is read, and `View plan` above points there.

          Everything else keeps `leading-snug`. `text-chat` is set at 1.65 for
          paragraphs of prose, and one sentence wrapping to three lines in a
          narrow card then sits further apart than the card's own gaps — it
          reads as loose before it reads as a question. */}
      {onViewPlan ? (
        <div className="text-chat">
          <Markdown>{description}</Markdown>
        </div>
      ) : (
        <p className="text-chat leading-snug">{description}</p>
      )}

      {/* One row, wrapping. It was a column under `@max-sm` for a while, and
          what actually made the narrow card ragged was the label rather than
          the width: a rule carries its own subject — `Always allow mkdir -p
          /tmp/x`, `Always allow in {dir}` — which is shown nowhere else, so
          it cannot share a line with anything and `Deny` fell under it alone
          and read as one answer singled out. It wraps inside its own button
          and lands on its own line instead, which is the honest place for the
          longest answer in the card; stacking them all spent ~70px saying
          what one line already said. */}
      <div className="mt-3 flex flex-wrap items-center gap-1.5">
        {/* Ahead of the answers, and outline rather than filled: reading the
            plan comes before agreeing to it, and it is the one button here
            that decides nothing. */}
        {onViewPlan && (
          <Button size="sm" variant="outline" className="h-7" onClick={onViewPlan}>
            View plan
          </Button>
        )}
        {[...options]
          .sort((a, b) => KIND_ORDER[a.kind] - KIND_ORDER[b.kind])
          .map((option) => (
            <Button
              key={option.id}
              size="sm"
              // The base button is `whitespace-nowrap shrink-0`, so a rule that
              // carries its own subject — `Always allow mkdir -p /long/path` —
              // ran straight out of the card rather than wrapping as the
              // comment above promises. Wrapping inside the button is what
              // keeps the subject readable; truncating would hide the half of
              // the label that says what is being granted.
              className="h-auto min-h-7 max-w-full py-1 text-left break-words whitespace-normal"
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

