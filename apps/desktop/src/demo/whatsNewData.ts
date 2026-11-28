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

/// Six highlights for the full-page takes, which show the first four unless
/// asked for a count: a video, pictures, one with no media, two carrying an
/// action. The video and the last two pictures are cut from the site's own app
/// screenshots and kept beside the demo.
export const PAGE_HIGHLIGHTS: Highlight[] = [
  page(
    "Merge a pull request without leaving its task",
    "The PR panel follows checks and reviews as they land, with Squash and merge right beside them. No browser tab needed.",
    [{ kind: "video", url: "/demo/whats-new/pr-panel.webm", alt: "The PR panel beside a task" }],
    { label: "Start a task", target: "new-task" },
  ),
  page(
    "Dray Island shows every task at the top of your screen",
    "A small panel at the top of your screen shows what every task is doing, and tells you the moment one needs you.",
    [{ kind: "image", url: `${SITE}/dray-island.png`, alt: "Dray Island at the top of the screen" }],
  ),
  page(
    "Dray reminds you to take a break",
    "Dray nudges you to stand up after a long stretch, with a short exercise to follow.",
    [{ kind: "image", url: `${SITE}/break-reminder.png`, alt: "A break reminder card" }],
    { label: "Open Breaks settings", target: "settings/breaks" },
  ),
  page(
    "Bots learn from your corrections",
    "Correct a bot and it writes the lesson down where it will use it next time: a rule, a skill or a memory.",
    [],
  ),
  page(
    "⌘F searches every task, in every project",
    "⌘F finds any task by its title or by what was said in it, across every project.",
    [{ kind: "image", url: "/demo/whats-new/sidebar.webp", alt: "The sidebar with Search" }],
  ),
  page(
    "Send follow-ups while an agent is working",
    "Send a follow-up mid-turn and it waits its turn, or steers the agent where the harness allows.",
    [{ kind: "image", url: "/demo/whats-new/composer.webp", alt: "The composer" }],
  ),
];

/// The next release's highlights, on the picked take of each. Their
/// pictures are drawn in code ([whatsNewIllustrations.tsx](whatsNewIllustrations.tsx))
/// and captured at 2560×1440; for the release itself they move to
/// apps/web/public/changelog/.
export const NEXT_RELEASE: Highlight[] = [
  page(
    "Switch a task's harness mid-session.",
    "Pick another harness in the composer and your next message moves the task there, with everything said so far.",
    [{ kind: "image", url: "/demo/whats-new/harness-composer.png", alt: "A chat Claude Code answered, Codex picked in the composer for the next message" }],
  ),
  page(
    "Your agents, in your pocket. Dray is now on iPhone.",
    "Every task on every machine, with questions to answer, permissions to allow and alerts when one is ready to merge.",
    [{ kind: "image", url: "/demo/whats-new/iphone-app.png", alt: "Dray's bot chat on an iPhone, beside a QR code for the App Store" }],
  ),
  page(
    "OpenCode is now in Dray.",
    "Pick OpenCode in the composer and run it like any other agent, with your own models and providers.",
    [{ kind: "image", url: "/demo/whats-new/opencode-logo.png", alt: "The OpenCode logo" }],
  ),
  // For the release that turns Dray's own relay on for every server (#1669):
  // each server's Remote access address changes, so phones and other Macs
  // must pair again. WhatsNewPage draws the title alone, so it says both.
  page(
    "Remote access is faster. Pair your phone and other Macs again.",
    "Your servers now reach your phone through Dray's own relay, which reconnects faster after a drop. Each server has a new address, so scan its pairing code again on your phone, and add it again on your other Macs.",
    [{ kind: "image", url: "/demo/whats-new/relay-pair.png", alt: "Settings → Servers with Pair a phone open, an iPhone scanning its code" }],
    { label: "Open Servers settings", target: "settings/servers" },
  ),
];

/// A next-release highlight on a white card: its drawn picture swapped for
/// the `-white` capture beside it, so picture and card share one fill.
/// The sample highlights have no white twin and are left as they are.
export const onWhite = (h: Highlight): Highlight =>
  NEXT_RELEASE.includes(h)
    ? { ...h, item: { ...h.item, media: h.item.media.map((m) => ({ ...m, url: m.url.replace(/\.png$/, "-white.png") })) } }
    : h;
