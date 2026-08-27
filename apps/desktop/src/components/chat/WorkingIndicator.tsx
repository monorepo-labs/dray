import { useState } from "react";

import Orb from "@/components/Orb";
import { compactTokens } from "@/lib/format";

/// "Thinking" is one of these rather than a label the harness switches on. It is
/// accurate often enough, and a word that changes under the reader — Working
/// becoming Thinking a second later — draws more attention to itself than the
/// distinction is worth. Nobody is waiting to be told which kind of wait this is.
const LABELS = ["Working", "Cooking", "Brewing", "Thinking"];

/// The gap-filler for every stretch where the agent is busy and the transcript
/// has nothing to show — the wait before a turn's first output, and the wait
/// after each tool result while the model composes its next move.
export default function WorkingIndicator({
  tokens = 0,
}: {
  /// Live reasoning-token estimate. Hidden at zero — every wait starts there,
  /// and "0 tokens" reads as stalled rather than as starting.
  tokens?: number;
}) {
  // Picked once per mount, so it's one word per wait rather than one per render.
  // The indicator unmounts as soon as content takes over, so each wait still
  // draws its own word.
  const [label] = useState(() => LABELS[Math.floor(Math.random() * LABELS.length)]);

  return (
    <div className="flex items-center gap-2" aria-live="polite">
      {/* 20 and 64 are separately tuned designs rather than one scaled to the
          other, so 20 is the only inline-with-text option. Mode comes from
          `Orb`, which is the whole reason that wrapper exists. */}
      <Orb state="listening" size={20} aria-hidden />

      <span className="shimmer-text text-chat">{label}</span>

      {/* Dimmer than the label and deliberately unshimmered: the count is the
          one part of this row that is really moving, so it doesn't need the
          animation to say so, and pairing the two just made the row noisy. */}
      {tokens > 0 && (
        <span className="text-chat text-muted-foreground/60 tabular-nums">
          {compactTokens(tokens)} tokens
        </span>
      )}
    </div>
  );
}
