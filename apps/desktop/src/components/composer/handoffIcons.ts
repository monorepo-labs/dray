import {
  ArrowUp,
  GitCommitHorizontal,
  GitPullRequest,
  GitPullRequestDraft,
  Play,
} from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { HandoffAction } from "@/lib/handoff";

/// One glyph per handoff action.
///
/// The two pull request glyphs are the pair the sidebar row and the panel
/// toggle already draw — the mark and the thing it leads to have to match
/// wherever they appear.
export const HANDOFF_ICONS: Record<HandoffAction["id"], LucideIcon> = {
  commit: GitCommitHorizontal,
  commitPush: ArrowUp,
  push: ArrowUp,
  pr: GitPullRequest,
  draftPr: GitPullRequestDraft,
  runServer: Play,
};
