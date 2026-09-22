import type { ComponentType } from "react";

import { ClaudeGlyph } from "@/components/ClaudeGlyph";
import { FxGlyph } from "@/components/FxGlyph";
import { OpenAIGlyph } from "@/components/OpenAIGlyph";
import { PiGlyph } from "@/components/PiGlyph";

/// The agent CLIs Dray runs, in the order the app's own picker lists them.
/// A new harness is one entry here and one glyph beside the others; the
/// row in the hero draws whatever is listed. Kept out of the hero's
/// sentence for that reason — four names read as a sentence, and the list
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
];
