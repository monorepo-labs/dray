/// Static segments under `/app` that an org slug would shadow.
const RESERVED_SLUGS = new Set(["new", "account"]);

/// Why `slug` cannot name an org, or null when it can.
export function slugProblem(slug: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug))
    return "Use 1–40 lowercase letters, digits or dashes, not starting or ending with a dash.";
  if (RESERVED_SLUGS.has(slug)) return `"${slug}" is reserved.`;
  return null;
}

/// Turns any text into slug form, or "" when nothing usable is left.
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/, "");
}

// Names a username may one day need to stand for Dray itself.
const RESERVED_USERNAMES = new Set([
  "admin", "administrator", "api", "app", "dray", "help", "root", "settings", "support", "system",
]);

/// Why `username` can't be one, or null when it can.
export function usernameProblem(username: string): string | null {
  if (!/^[a-z0-9_]{3,20}$/.test(username))
    return "Use 3–20 lowercase letters, digits or underscores.";
  if (RESERVED_USERNAMES.has(username)) return `"${username}" is reserved.`;
  return null;
}

/// Turns an email's local part into username form, or "" when nothing is left.
export function usernameFrom(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "_")
    .replace(/^_+|_+$/g, "")
    .slice(0, 20)
    .replace(/_+$/, "");
}
