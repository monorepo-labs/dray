import path from "node:path";
import type { NextConfig } from "next";

const config: NextConfig = {
  reactStrictMode: true,
  // In a workspace, Next traces from whichever lockfile it finds first and
  // guesses wrong; the desktop app's own tree is not this site's root.
  outputFileTracingRoot: path.join(import.meta.dirname, "../.."),
};

export default config;
