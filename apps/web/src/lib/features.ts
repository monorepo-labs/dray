/// The four things the page sells, in reading order. Each carries the capture
/// that shows it; `Board` drops those from its own run so nothing appears
/// twice.
///
/// `label` is the term itself — "Agent orchestration" — for the reader who
/// already knows it and needs nothing else. `title` is the one sentence for
/// everyone else. `points` are short lines, not prose: a paragraph under a
/// capture goes unread, three lines get scanned.
export type Feature = {
  id: string;
  label: string;
  title: string;
  points: string[];
  video: { src: string; poster: string; alt: string };
};

export const FEATURES: Feature[] = [
  {
    id: "orchestration",
    label: "Agent orchestration",
    title: "One agent, many sessions.",
    points: [
      "Ask an agent to split up the work and it starts a session per task, as many as you need",
      "Each one runs in its own worktree, so they never get in each other's way",
      "Sessions can message each other when you ask them to",
    ],
    video: {
      src: "/orchestration-dray.mp4",
      poster: "/posters/orchestration-dray.jpg",
      alt: "An agent fanning work out into several sessions, each nested under it in the sidebar",
    },
  },
  {
    id: "linear",
    label: "Linear integration",
    title: "Your issues, in the app.",
    points: [
      "Type # to tag an issue",
      "Description, comments and attachments beside the transcript",
      "Every issue — in progress, done, all of it — without leaving the app",
    ],
    video: {
      src: "/linear-integration-dray.mp4",
      poster: "/posters/linear-integration-dray.jpg",
      alt: "Browsing Linear issues in Dray and reading one beside the session that works on it",
    },
  },
  {
    id: "pull-requests",
    label: "Pull requests",
    title: "The PR, beside the work.",
    points: [
      "Checks, review threads and merge readiness, live",
      "Refreshes on its own as CI reports",
      "Merge from the panel once it's green",
    ],
    video: {
      src: "/pull-request.mp4",
      poster: "/posters/pull-request-dray.jpg",
      alt: "Reviewing checks and comments on a session's pull request",
    },
  },
  {
    // Not "native": it's a webview in a Tauri shell, and the word would be a
    // claim the first curious visitor could check. Fast and the UX are the
    // pitch, and both are true.
    id: "fast",
    label: "Speed and UX",
    title: "Fast, with the best UX you'll find.",
    points: [
      "Sessions open instantly",
      "Diffs highlight off the main thread",
      "Every control has a shortcut, shown where you'd reach for it",
    ],
    video: {
      src: "/speed-run-dray.mp4",
      poster: "/posters/speed-run-dray.jpg",
      alt: "A full session in Dray at speed, from prompt to reviewed diff",
    },
  },
];

export const FEATURED_SRCS = new Set(FEATURES.map((f) => f.video.src));
