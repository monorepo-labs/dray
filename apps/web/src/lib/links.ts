export const REPO = "https://github.com/monorepo-labs/dray";

/// `/releases/latest` redirects to whatever the newest stable release is, so
/// the button needs no build-time lookup and can never point at a version that
/// has been superseded. It skips prereleases, which is right here — the beta
/// channel is the updater's, not the download page's.
export const DOWNLOAD = `${REPO}/releases/latest`;

/// Dray drives the CLI; it does not bundle or replace it. Anyone downloading
/// needs Claude Code installed and signed in first, so the setup page is a
/// prerequisite rather than a footnote. `docs.claude.com/en/docs/claude-code/*`
/// still redirects here, but this is where it lands.
export const CLAUDE_SETUP = "https://code.claude.com/docs/en/setup";
