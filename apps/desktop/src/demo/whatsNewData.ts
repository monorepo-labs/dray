import type { ChangelogItem, Highlight } from "@/lib/changelog";

const page = (
  title: string,
  body: string,
  media: ChangelogItem["media"],
  action?: { label: string; target: string },
): Highlight => ({
  version: "0.33.0",
  item: { title, body, media, highlight: { apps: ["desktop"], action: action ?? null } },
});

/// The next release's highlights, on the picked take of each. Their
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
  // For the release that turns Dray's own relay on for every server (#1669):
  // each server's Remote access address changes, so phones and other Macs
  // must pair again. WhatsNewPage draws the title alone, so it says both.
  page(
    "Remote access is faster. Pair your phone and other Macs again.",
    "Your servers now reach your phone through Dray's own relay, which reconnects faster after a drop. Each server has a new address, so scan its pairing code again on your phone, and add it again on your other Macs.",
    [{ kind: "image", url: "/demo/whats-new/relay-pair.png", alt: "A server's card with Remote access on and a new relay address, beside its pairing code: Scan to reconnect" }],
    { label: "Open Servers settings", target: "settings/servers" },
  ),
];
