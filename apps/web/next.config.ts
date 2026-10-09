import path from "node:path";
import type { NextConfig } from "next";

/// Where apps/docs is deployed, its own Vercel project. Its build writes every
/// link with `/docs` in front but the files at the output root, so `/docs/x`
/// here is `/x` there. `blume dev` serves under the base instead, which is why
/// the dev fallback carries `/docs` and a deployed origin does not.
const DOCS_ORIGIN =
  process.env.DOCS_ORIGIN ||
  (process.env.NODE_ENV === "development" ? "http://localhost:4321/docs" : "");

if (!DOCS_ORIGIN) console.warn("DOCS_ORIGIN is unset: /docs will 404 on this build.");

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
      ...(DOCS_ORIGIN
        ? [
            // No trailing slash: `blume dev` redirects `/docs/` to `/docs`,
            // which comes back here and loops.
            { source: "/docs", destination: DOCS_ORIGIN },
            { source: "/docs/:path*", destination: `${DOCS_ORIGIN}/:path*` },
          ]
        : []),
    ];
  },
  // The server page moved into the docs.
  async redirects() {
    return [{ source: "/server", destination: "/docs/server", permanent: true }];
  },
  // Required by the rewrite above: PostHog's API cares about the trailing
  // slash, and Next's own redirect would strip it before the proxy saw it.
  skipTrailingSlashRedirect: true,
};

export default config;
