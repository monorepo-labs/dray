import { defineConfig } from "blume";

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
  github: { owner: "monorepo-labs", repo: "dray", dir: "apps/docs" },
  footer: {
    copyright: `© ${new Date().getFullYear()} Dray`,
    socials: { x: "https://x.com/yogesharc" },
  },
  // Served at drayhq.com/docs through a rewrite in apps/web. The content
  // folder is not named `docs`, or every page would land at /docs/docs/….
  deployment: { site: "https://www.drayhq.com", base: "/docs" },
});
