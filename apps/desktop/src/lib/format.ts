/// Compact relative time for session rows — "now", "4m", "3h", "2d", then a date.
export function relativeTime(iso: string): string {
  const then = Date.parse(iso);
  if (Number.isNaN(then)) return "";

  const secs = Math.round((Date.now() - then) / 1000);
  if (secs < 60) return "now";
  if (secs < 3600) return `${Math.floor(secs / 60)}m`;
  if (secs < 86400) return `${Math.floor(secs / 3600)}h`;
  if (secs < 604800) return `${Math.floor(secs / 86400)}d`;

  return new Date(then).toLocaleDateString(undefined, { month: "short", day: "numeric" });
}

/// Whether a timestamp falls on the local calendar day. Calendar days, not a
/// 24-hour window: something touched at 11pm last night is yesterday's work by
/// 1am, which is the reading the sidebar wants.
export function isToday(iso: string): boolean {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return false;
  return daysApart(new Date(), new Date(at)) === 0;
}

/// A future clock time, qualified by day only when it needs to be.
///
/// A five-hour limit usually resets later today, where a bare time reads
/// fastest. But hit one late in the evening and it rolls over past midnight —
/// and "resets at 1:00" then means tomorrow, which is the one reading a bare
/// time gets wrong. Longer windows land days out and get a date outright.
export function resetTime(iso: string): string {
  const at = Date.parse(iso);
  if (Number.isNaN(at)) return "";

  const time = new Date(at).toLocaleTimeString(undefined, {
    hour: "numeric",
    minute: "2-digit",
  });

  // Compared as calendar days rather than as a 24-hour distance: 11pm to 1am
  // is two hours away and still needs "tomorrow" on it.
  const days = daysApart(new Date(), new Date(at));
  if (days <= 0) return time;
  if (days === 1) return `${time} tomorrow`;

  const date = new Date(at).toLocaleDateString(undefined, { month: "short", day: "numeric" });
  return `${time} on ${date}`;
}

function daysApart(from: Date, to: Date): number {
  const midnight = (d: Date) => new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime();
  return Math.round((midnight(to) - midnight(from)) / 86_400_000);
}

/// A token count at a glance — "847", "30.6k", "1.2M". The exact figure is
/// never the point here; the order of magnitude is.
export function compactTokens(n: number): string {
  if (n < 1_000) return `${n}`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")}k`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")}M`;
}

/// A file size at a glance — "812 B", "1.4 KB", "2.3 MB". Decimal units, which
/// is what the OS file picker beside it reports.
export function formatBytes(n: number): string {
  if (n < 1_000) return `${n} B`;
  if (n < 1_000_000) return `${(n / 1_000).toFixed(1).replace(/\.0$/, "")} KB`;
  return `${(n / 1_000_000).toFixed(1).replace(/\.0$/, "")} MB`;
}

/// Trailing path segment, for showing a project as its folder name.
export function basename(path: string): string {
  const parts = path.replace(/\/+$/, "").split("/");
  return parts[parts.length - 1] || path;
}
