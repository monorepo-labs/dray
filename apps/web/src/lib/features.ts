/// The things the page sells, in reading order, each with the capture that
/// shows it.
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
  /// Handles from testimonials.ts, drawn under the capture — two per feature,
  /// and **empty where there is nothing to say**. Pull requests is empty
  /// today: nobody has posted about it, and a quote about something else
  /// filed under it is worse than a gap, since the whole point of moving
  /// these out of a wall was that each one answers the claim above it.
  ///
  /// Matched to what the post is about wherever it is about anything in
  /// particular, and otherwise paired for shape: one that says something and
  /// one that is a shout, since two shouts together read as a page with
  /// nothing to quote and two paragraphs together stop being punctuation.
  quotes: string[];
};

export const FEATURES: Feature[] = [
  {
    id: "orchestration",
    label: "Agent orchestration",
    title: "Run a swarm of agents in parallel.",
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
    quotes: ["mrterrycarson", "felipe__orlando"],
  },
  {
    // Straight after orchestration, because it is the other half of it: that
    // one is how the work gets handed out, this is how you watch it land.
    id: "split-view",
    label: "Split view",
    title: "One window, four conversations.",
    points: [
      "Drag a session from the sidebar onto the chat to split the view",
      "Up to four panes, each one streaming its own agent live",
      "⌘1–⌘4 jumps between them — hold ⌘ to see which is which",
    ],
    video: {
      src: "/split-view.mp4",
      poster: "/posters/split-view.jpg",
      alt: "Three sessions side by side in Dray, each streaming its own agent",
    },
    quotes: ["paakjong", "evilpsycho42"],
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
    quotes: ["sreedotworld", "aguiarfilho_"],
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
    // Nothing here. `Quotes` draws no row for an empty list, so a feature
    // nobody has posted about yet simply carries none — which beats reaching
    // for a quote that is about something else.
    quotes: [],
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
    // The pair: two people, independently, on the thing this section claims.
    quotes: ["vcfgdev", "Sousinr"],
  },
];
