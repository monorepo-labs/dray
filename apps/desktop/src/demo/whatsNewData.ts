import type { ChangelogItem, Highlight } from "@/lib/changelog";

/// The next release's highlights, as CHANGELOG.md will carry them. Pictures
/// are drawn in code ([whatsNewIllustrations.tsx](whatsNewIllustrations.tsx))
/// and captured at 2560×1440, white for What's New's white cards; for the
/// release itself they move to apps/web/public/changelog/.
export const NEXT_RELEASE: Highlight[] = [
  // The relay as every server's default (#1669): a reader with Remote access
  // on has phones and Macs pointing at the old address and must pair again,
  // so for them it is the required action card; for anyone else, a plain
  // card under `otherwise`. See `settle` in lib/changelog.ts.
  {
    version: "next",
    item: {
      title: "Reconnect your phone and other Macs. Remote access is now more reliable and faster",
      body: "Each server has a new address. Scan its pairing code again on your phone, and add it again on your other Macs.",
      media: [
        {
          kind: "image",
          url: "/demo/whats-new/relay-link-white.png",
          alt: "A MacBook and an iPhone, the old link between them broken, the new one in blue",
        },
      ] satisfies ChangelogItem["media"],
      highlight: {
        apps: ["desktop"],
        action: { label: "Open Servers settings", target: "settings/servers" },
        required: "remote-access",
        otherwise: "Remote access is now more reliable and faster",
        // One of two takes, not yet picked: relay-path or relay-comeback.
        otherwiseMedia: {
          kind: "image",
          url: "/demo/whats-new/relay-path-white.png",
          alt: "An iPhone reaching a MacBook through Dray's relay, the path in blue",
        },
      },
    },
  },
];
