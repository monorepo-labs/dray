import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // In a workspace, Next traces from whichever lockfile it finds first and
  // guesses wrong; the desktop app's own tree is not this site's root.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),

  // Tweet video is served from `video.twimg.com`, which 403s any request whose
  // Referer is not an X domain — `https://dray.app/` is refused exactly like
  // `http://localhost` is, so this is not a dev-only quirk. Sending no referer
  // at all is allowed, and is the only lever a third-party page has: `<video>`
  // takes no `referrerpolicy` attribute, so the policy has to be the whole
  // document's. It costs nothing here — the outbound links are GitHub and the
  // Claude docs, and inbound attribution is set by the sending site, not by us.
  // If X ever starts requiring a positive x.com referer this stops working and
  // the cards fall back to poster plus "Watch on X", which is where they were.
  async headers() {
    return [
      {
        source: "/:path*",
        headers: [{ key: "Referrer-Policy", value: "no-referrer" }],
      },
    ];
  },
};

export default config;
