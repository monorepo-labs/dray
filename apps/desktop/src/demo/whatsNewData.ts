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
