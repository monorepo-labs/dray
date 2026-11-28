import type { ChangelogItem, Highlight } from "@/lib/changelog";

const page = (title: string, body: string, media: ChangelogItem["media"]): Highlight => ({
  version: "0.33.0",
  item: { title, body, media, highlight: { apps: ["desktop"], action: null } },
});

/// The next release's three highlights, on the picked take of each. Their
/// pictures are drawn in code ([whatsNewIllustrations.tsx](whatsNewIllustrations.tsx))
/// and captured at 2560×1440, with a `-white` twin for What's New's white
/// cards; for the release itself they move to apps/web/public/changelog/.
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
];
