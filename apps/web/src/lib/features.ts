import type { ComponentType } from "react";

import { GitHubGlyph } from "@/components/GitHubGlyph";
import { LinearGlyph } from "@/components/LinearGlyph";

/// The things the page sells, in reading order.
///
/// `label` is the term itself — "Agent orchestration" — for the reader who
/// already knows it and needs nothing else. `title` is the headline, and it is
/// what gets read: nobody reads past it, so `line` is one sentence and there
/// is no list.
///
/// `video` is the old capture, drawn only until the feature has an
/// illustration of its own in `Features.tsx`; a feature with one omits it.
export type Feature = {
  id: string;
  label: string;
  title: string;
  line: string;
  /// Kept out of the page for now. The speed section wants a capture of the
  /// app as it is, not a drawing, and the one on disk is out of date.
  hidden?: boolean;
  /// Drawn as one of the cards under the big sections rather than as a
  /// section of its own — a feature whose subject is one panel or control,
  /// not the whole window.
  card?: boolean;
  /// Trackers drawn after the label, where the feature is an integration:
  /// the marks say which without the label having to list them.
  marks?: ComponentType<{ className?: string }>[];
  video?: { src: string; poster: string; alt: string };
};

export const FEATURES: Feature[] = [
  {
    id: "orchestration",
    label: "Agent orchestration",
    title: "Run a swarm of agents in parallel.",
    line: "Ask one agent to split the work. It starts a session per task, each in its own worktree.",
  },
  {
    // Straight after orchestration, because it is the other half of it: that
    // one is how the work gets handed out, this is how you watch it land.
    id: "split-view",
    label: "Split view",
    title: "One window, every conversation.",
    line: "Drag a session onto the chat to split it. As many panes as you like, each streaming live.",
  },
  {
    id: "pull-requests",
    card: true,
    label: "Pull requests",
    title: "The PR, beside the work.",
    line: "Checks, review threads and merge readiness, live. Merge from the panel once it's green.",
  },
  {
    id: "linear",
    card: true,
    label: "Issues",
    marks: [LinearGlyph, GitHubGlyph],
    title: "Your issues, in the app.",
    line: "Type # to tag an issue. Description, comments and attachments sit beside the transcript.",
  },
  {
    id: "dictation",
    card: true,
    label: "Dictation",
    title: "Talk, don't type.",
    line: "Press ⌘D and say it. Transcribed on your Mac by a local model — nothing leaves the machine.",
  },
  {
    id: "browser",
    card: true,
    label: "Built-in browser",
    title: "The agent gets a browser too.",
    line: "A Chromium tab beside the chat. The agent runs your app and checks its own UI work. You can browse in it too.",
  },
  {
    // Not "native": it's a webview in a Tauri shell, and the word would be a
    // claim the first curious visitor could check. Fast and the UX are the
    // pitch, and both are true.
    id: "fast",
    hidden: true,
    label: "Speed and UX",
    title: "Fast, with the best UX you'll find.",
    line: "Sessions open instantly, diffs highlight off the main thread, and every control has a shortcut.",
    video: {
      src: "/speed-run-dray.mp4",
      poster: "/posters/speed-run-dray.jpg",
      alt: "A full session in Dray at speed, from prompt to reviewed diff",
    },
  },
];
