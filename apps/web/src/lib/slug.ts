/// Static segments under `/app` that an org slug would shadow.
const RESERVED = new Set(["new"]);

/// Why `slug` cannot name an org, or null when it can.
export function slugProblem(slug: string): string | null {
  if (!/^[a-z0-9](?:[a-z0-9-]{0,38}[a-z0-9])?$/.test(slug))
    return "Use 1–40 lowercase letters, digits or dashes, not starting or ending with a dash.";
  if (RESERVED.has(slug)) return `"${slug}" is reserved.`;
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
