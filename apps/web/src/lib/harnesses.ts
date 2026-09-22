import type { ComponentType } from "react";

import { ClaudeGlyph } from "@/components/ClaudeGlyph";
import { FxGlyph } from "@/components/FxGlyph";
import { GrokGlyph } from "@/components/GrokGlyph";
import { OpenAIGlyph } from "@/components/OpenAIGlyph";
import { PiGlyph } from "@/components/PiGlyph";

/// The agent CLIs Dray runs, in the order the app's own picker lists them.
/// A new harness is one entry here and one glyph beside the others; the
/// row in the hero draws whatever is listed. Kept out of the hero's
/// sentence for that reason — a few names read as a sentence, and the list
/// is growing past the point where a sentence can hold it.
export type Harness = {
  name: string;
  Glyph: ComponentType<{ className?: string }>;
};

export const HARNESSES: Harness[] = [
  { name: "Claude Code", Glyph: ClaudeGlyph },
  { name: "Codex", Glyph: OpenAIGlyph },
  { name: "pi", Glyph: PiGlyph },
  { name: "fx", Glyph: FxGlyph },
  // "Grok", the app's own picker label, not "Grok Build" the installer's —
  // the row is read at a glance and the mark beside it already says which
  // Grok this is.
  { name: "Grok", Glyph: GrokGlyph },
];
