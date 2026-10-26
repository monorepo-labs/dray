import { defineConfig } from "blume";
import { posthog, script } from "blume/analytics";

export default defineConfig({
  title: "Dray Docs",
  description: "How to install and use Dray, the desktop app for coding agents.",
  // The wordmark already says the name, so no text beside it. `href` leaves
  // the docs for the site, since `/` here is the docs' own index.
  logo: { image: "/logo.svg", text: "", href: "https://www.drayhq.com" },
  content: { root: "content" },
  // Dark first, like the site and the app. The palette is the site's: neutral
  // ramp, near-white accent, Geist.
  theme: {
    mode: "dark",
    accent: { light: "oklch(0.205 0 0)", dark: "oklch(0.922 0 0)" },
    background: { dark: "oklch(0.145 0 0)" },
    fonts: { display: "geist", body: "geist", mono: "geist-mono" },
  },
  // With no analytics adapter a rating goes nowhere, so asking for one is a
  // button that does nothing.
  feedback: false,
  // The site's PostHog project and settings (apps/web instrumentation-client.ts):
  // the same cookie, so a visitor moving between the site and the docs stays one
  // person, no autocapture, no recording. `/ingest` is the site's own
  // rewrite, reachable because the docs are served through drayhq.com.
  // `source` is registered through the snippet's queue, which replays before
  // the first pageview fires, so every docs event can be told from the site's.
  analytics: [
    posthog({
      key: "phc_kLtmvfyx2NtnooMrHzqLhxmzRTHxbPEnfKmxbbTNkDdM",
      host: "/ingest",
      ui_host: "https://us.posthog.com",
      persistence: "localStorage+cookie",
      autocapture: false,
      disable_session_recording: true,
      capture_pageview: "history_change",
      person_profiles: "identified_only",
    }),
    script({ content: 'posthog.register({ source: "docs" });' }),
  ],
  agents: {
    llmsTxt: {
      details:
        "Dray is a free, open-source macOS app that runs coding-agent CLIs (Claude Code, Codex, pi, fx and Grok Build) in one chat window, many sessions at once, each optionally in its own git worktree. Download it from https://www.drayhq.com. Its `dray` command line (`curl -fsSL https://www.drayhq.com/install.sh | sh`) lets you or an agent create, list and message sessions, save drafts, link issues, share a dev server by public link and drive the built-in browser. Dray can also run headless on a Linux server and be driven from the Mac app. Reach for these docs to answer what Dray can do, where in the app a feature lives, and the exact steps, commands and flags.",
    },
  },
  github: { owner: "monorepo-labs", repo: "dray", dir: "apps/docs" },
  footer: {
    copyright: `© ${new Date().getFullYear()} Dray`,
    socials: { x: "https://x.com/yogesharc" },
  },
  // Served at drayhq.com/docs through a rewrite in apps/web. The content
  // folder is not named `docs`, or every page would land at /docs/docs/….
  deployment: { site: "https://www.drayhq.com", base: "/docs" },
});
