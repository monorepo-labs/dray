import type { CSSProperties } from "react";

import BotAvatar from "@/components/BotAvatar";
import MachineMark from "@/components/MachineMark";
import { seededAvatar } from "@/lib/botAvatar";
import type { BotAvatar as Avatar } from "@/types/events";

/// Who a line names: a task, by its session id, or a bot, with its own face.
/// `machine` is set for a task on another machine than the one reading.
export type Party = { id: string; title: string; avatar?: Avatar | null; machine?: string | null };

/// Who a line is about: one task's face and name, or several faces stacked
/// and a count.
export function PartyChip({
  parties,
  expanded,
  onClick,
}: {
  parties: Party[];
  /// Set where the chip opens messages rather than a task.
  expanded?: boolean;
  onClick: (e: React.MouseEvent) => void;
}) {
  const single = parties.length === 1 ? parties[0] : null;
  return (
    <button
      type="button"
      aria-expanded={expanded}
      onClick={onClick}
      className="flex min-w-0 cursor-pointer items-center gap-1.5 rounded-full py-0.5 pr-1.5 pl-1 transition-colors hover:bg-(--party-wash) hover:text-(--party-ink)"
      style={single ? partyColours(single) : NEUTRAL}
    >
      <span className="flex shrink-0 -space-x-2">
        {parties.slice(0, 3).map((p) => (
          <span key={p.id} className="size-5">
            <BotAvatar still seed={p.id} avatar={p.avatar ?? seededAvatar(p.id)} className="block size-5 scale-[1.18]" />
          </span>
        ))}
      </span>
      <span className="truncate">{single ? single.title : `${parties.length} tasks`}</span>
      {single?.machine && <MachineMark machine={single.machine} />}
    </button>
  );
}

const NEUTRAL = { "--party-wash": "var(--muted)", "--party-ink": "var(--foreground)" } as CSSProperties;

/// A party's name, on hover, in a pill of its own face's colour.
function partyColours(party: Party): CSSProperties {
  const { hue } = party.avatar ?? seededAvatar(party.id);
  return {
    "--party-wash": `oklch(0.7 0.12 ${hue} / 0.16)`,
    "--party-ink": `oklch(0.78 0.12 ${hue})`,
  } as CSSProperties;
}
