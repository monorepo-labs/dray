export const REPO = "https://github.com/monorepo-labs/dray";

/// The newest stable dmg, off the R2 mirror rather than GitHub, whose release
/// CDN has had 42MB take 45 minutes. release.yml overwrites this one key on
/// every stable release, so the button needs no build-time lookup; betas leave
/// it alone, the beta channel being the updater's and not this page's.
export const DOWNLOAD = "https://downloads.drayhq.com/Dray_universal.dmg";

/// The person who builds it, on X — the nav's "Feedback" link and the
/// footer's mark both. Most visitors arrive from a tweet, so this is the
/// channel they are already on.
///
/// The product's own account (`x.com/dray_hq`) was here too and the footer
/// pointed at it. It posts releases; somebody who reaches the bottom of this
/// page is looking for a person, so both now go to the same place and there
/// is no second constant to keep.
export const FEEDBACK = "https://x.com/yogesharc";

export const COMPANY = "Monorepo Labs";

/// Where the next sponsor signs up.
export const SPONSOR = "https://www.patreon.com/c/yogesharc/membership";

/// What the nav shows when GitHub cannot be asked. Bump it now and then so a
/// rate-limited render does not undercount by much.
export const STARS_FALLBACK = 58;
