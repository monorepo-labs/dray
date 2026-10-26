import { GitCommitHorizontal, GitPullRequest, MessageSquareText, Play } from "lucide-react";
import type { LucideIcon } from "lucide-react";

import type { HandoffAction } from "@/lib/handoff";

/// One glyph per built-in handoff action.
///
/// The pull request glyph is the one the sidebar row and the panel toggle
/// already draw — the mark and the thing it leads to have to match wherever
/// they appear.
export const HANDOFF_ICONS: Record<NonNullable<HandoffAction["builtin"]>, LucideIcon> = {
  commit: GitCommitHorizontal,
  pr: GitPullRequest,
  runServer: Play,
};

/// Every button the reader added shares one: it is a prompt, and nothing here
/// knows what that prompt does.
export const CUSTOM_HANDOFF_ICON: LucideIcon = MessageSquareText;

export function handoffIcon(builtin: HandoffAction["builtin"]): LucideIcon {
  return builtin ? HANDOFF_ICONS[builtin] : CUSTOM_HANDOFF_ICON;
}
