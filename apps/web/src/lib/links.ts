export const REPO = "https://github.com/monorepo-labs/dray";

/// `/releases/latest` redirects to whatever the newest stable release is, so
/// the button needs no build-time lookup and can never point at a version that
/// has been superseded. It skips prereleases, which is right here — the beta
/// channel is the updater's, not the download page's.
export const DOWNLOAD = `${REPO}/releases/latest`;

/// The universal `.dmg`'s size, decimal MB rounded to match Finder's own
/// "Get Info" — hand-updated per release since the link above deliberately
/// carries no build-time lookup to compute it from. Check the latest release's
/// asset list when bumping.
export const DOWNLOAD_SIZE = "32 MB";

/// The product's own account. Separate from `FEEDBACK` below, which is a DM
/// to the person who builds it — this one is where the app posts, so it is
/// somewhere to follow rather than somewhere to write to.
export const DRAY_X = "https://x.com/dray_hq";

/// Where feedback goes: a DM to the person who builds it. Most visitors
/// arrive from a tweet, so this is the channel they are already on.
export const FEEDBACK = "https://x.com/yogesharc";

export const COMPANY = "Monorepo Labs";

/// What the nav shows when GitHub cannot be asked. Bump it now and then so a
/// rate-limited render does not undercount by much.
export const STARS_FALLBACK = 23;
