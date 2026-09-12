import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // In a workspace, Next traces from whichever lockfile it finds first and
  // guesses wrong; the desktop app's own tree is not this site's root.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
  // PostHog's ingest, served from our own origin so a content blocker sees a
  // first-party request. `api_host: "/ingest"` in `instrumentation-client.ts`
  // is the other half; change one and the other stops working silently.
  //
  // Two rules, not one: the SDK fetches its own assets from a *different* host
  // to the one it posts events to, so a single catch-all leaves the script
  // 404ing and nothing is measured at all.
  //
  // US cloud is written out rather than read from an env var, unlike the
  // desktop's `POSTHOG_HOST` — a rewrite is static config, and a region move
  // is two strings here and a redeploy either way.
  async rewrites() {
    return [
      {
        source: "/ingest/static/:path*",
        destination: "https://us-assets.i.posthog.com/static/:path*",
      },
      { source: "/ingest/:path*", destination: "https://us.i.posthog.com/:path*" },
    ];
  },
  // Required by the rewrite above: PostHog's API cares about the trailing
  // slash, and Next's own redirect would strip it before the proxy saw it.
  skipTrailingSlashRedirect: true,
};

export default config;
