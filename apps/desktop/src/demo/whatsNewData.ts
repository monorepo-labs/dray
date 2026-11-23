import type { ChangelogItem, Highlight, Release } from "@/lib/changelog";

/// The highlights both what's-new demos page through. Media is drayhq.com's
/// own; `?video=<url>` puts a video on the second page.
const SITE = "https://www.drayhq.com/changelog";
const video = new URLSearchParams(location.search).get("video");

const item = (title: string, body: string, media: ChangelogItem["media"], action?: string): ChangelogItem => ({
  title,
  body,
  media,
  highlight: {
    apps: ["desktop"],
    action: action ? { label: action, target: "settings/breaks" } : null,
  },
});

export const HIGHLIGHTS: Highlight[] = [
  {
    version: "0.33.0",
    item: item(
      "Break reminders",
      "Dray nudges you to stand up after a long stretch, with a short exercise to follow.",
      [{ kind: "image", url: `${SITE}/break-reminder.png`, alt: "" }],
      "Open Breaks settings",
    ),
  },
  {
    version: "0.33.0",
    item: item(
      "Dray Island",
      "A small panel at the top of your screen shows what every task is doing, and `dray island` opens it.",
      [video ? { kind: "video", url: video, alt: "" } : { kind: "image", url: `${SITE}/dray-island.png`, alt: "" }],
    ),
  },
  { version: "0.32.0", item: item("No picture on this one", "A page can go without media.", []) },
];

export const RELEASE: Release = {
  version: "0.33.0",
  date: null,
  notify: true,
  beta: false,
  sections: [{ kind: "new", items: HIGHLIGHTS.map((h) => ({ ...h.item, highlight: null })) }],
};

const page = (
  title: string,
  body: string,
  media: ChangelogItem["media"],
  action?: { label: string; target: string },
): Highlight => ({
  version: "0.33.0",
  item: { title, body, media, highlight: { apps: ["desktop"], action: action ?? null } },
});

/// Four highlights for the full-page takes: a video, two pictures and one with
/// no media, two of them carrying an action. The video is a pan over the
/// site's own app screenshot, kept beside the demo.
export const PAGE_HIGHLIGHTS: Highlight[] = [
  page(
    "Merge from the task",
    "The PR panel follows checks and reviews as they land, with Squash and merge right beside them. No browser tab needed.",
    [{ kind: "video", url: "/demo/whats-new/pr-panel.webm", alt: "The PR panel beside a task" }],
    { label: "Start a task", target: "new-task" },
  ),
  page(
    "Dray Island",
    "A small panel at the top of your screen shows what every task is doing, and tells you the moment one needs you.",
    [{ kind: "image", url: `${SITE}/dray-island.png`, alt: "Dray Island at the top of the screen" }],
  ),
  page(
    "Break reminders",
    "Dray nudges you to stand up after a long stretch, with a short exercise to follow.",
    [{ kind: "image", url: `${SITE}/break-reminder.png`, alt: "A break reminder card" }],
    { label: "Open Breaks settings", target: "settings/breaks" },
  ),
  page(
    "Bots learn from corrections",
    "Correct a bot and it writes the lesson down where it will use it next time: a rule, a skill or a memory.",
    [],
  ),
];
