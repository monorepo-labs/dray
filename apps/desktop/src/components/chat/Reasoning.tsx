import { useState } from "react";
import { ChevronRight } from "lucide-react";
import { ThinkingOrb } from "thinking-orbs";

import { cn } from "@/lib/utils";

const PREVIEW_CHARS = 280;

/// Thinking text, dimmed and collapsed. Encrypted reasoning carries no readable
/// text at all, so it renders nothing rather than an empty block.
///
/// Committed reasoning (`streaming` false) shows nothing but the "Thought" label
/// until clicked open — it's scrollback the reader rarely needs, so a row of
/// dead space for it by default is worse than making them ask for it. The live
/// preview stays character-clamped and labeled "Thinking", with a `composing`
/// orb: it's still growing and there's no "done" state to collapse to yet. The
/// orb drops once committed — nothing is happening anymore.
export default function Reasoning({
  text,
  encrypted,
  streaming = false,
}: {
  text: string;
  encrypted: boolean;
  streaming?: boolean;
}) {
  const [open, setOpen] = useState(false);

  const trimmed = text.trim();
  if (encrypted || !trimmed) return null;

  if (streaming) {
    const long = trimmed.length > PREVIEW_CHARS;
    const shown = open || !long ? trimmed : `${trimmed.slice(0, PREVIEW_CHARS)}…`;

    return (
      <div>
        <button
          type="button"
          disabled={!long}
          onClick={() => setOpen((prev) => !prev)}
          className="group/think flex items-center gap-1.5 text-chat text-muted-foreground"
        >
          <ThinkingOrb state="composing" size={20} theme="dark" aria-hidden />
          <span>Thinking</span>
          {long && (
            <ChevronRight
              className={cn(
                "size-3 transition-all",
                open ? "rotate-90 opacity-100" : "opacity-0 group-hover/think:opacity-100",
              )}
            />
          )}
        </button>

        <p className="mt-1 whitespace-pre-wrap wrap-anywhere text-chat text-muted-foreground italic">
          {shown}
        </p>
      </div>
    );
  }

  return (
    <div>
      <button
        type="button"
        onClick={() => setOpen((prev) => !prev)}
        className="group/think flex items-center gap-1.5 text-chat text-muted-foreground"
      >
        <span>Thought</span>
        <ChevronRight
          className={cn(
            "size-3 transition-all",
            open ? "rotate-90 opacity-100" : "opacity-0 group-hover/think:opacity-100",
          )}
        />
      </button>

      {open && (
        <p className="mt-1 whitespace-pre-wrap wrap-anywhere text-chat text-muted-foreground italic">
          {trimmed}
        </p>
      )}
    </div>
  );
}
