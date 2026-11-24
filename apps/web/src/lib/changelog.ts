import { readFileSync } from "node:fs";
import path from "node:path";

/// The desktop app's changelog, read at build time. The app fetches the parsed
/// result from `/changelog.json`, so this is the one parser — the app holds
/// only the types.
///
/// Format is written down at the top of CHANGELOG.md itself.

export type Media = { kind: "image" | "video"; url: string; alt: string };
/// `title` is the item's bold lead when it ends a sentence — `**Title.** Rest`.
/// A bold run mid-sentence (`**⌘E** opens it`) is not a title, and the item is
/// a one-liner with `title: null`.
export type Item = { title: string | null; body: string; media: Media[]; highlight: Highlight | null };
export type App = "desktop" | "ios" | "android";
/// An item that gets a page of its own, in the apps it names, after an update.
/// `target` is the app's to read — `new-task`, `settings/<tab>`, an `https:`
/// URL — and one an app does not know draws no button there, so a newer
/// target never breaks an older build.
export type Highlight = { apps: App[]; action: { label: string; target: string } | null };
export type SectionKind = "new" | "improved" | "fixed";
export type Section = { kind: SectionKind; items: Item[] };
export type Release = {
  version: string;
  date: string | null;
  /// Raises the app's what's-new card for readers who update to it.
  notify: boolean;
  /// Shown in the app on the beta channel alone, and never on the site.
  beta: boolean;
  sections: Section[];
};

/// Media lives in this site's `public/changelog/`. Absolute, since the app
/// reads the same URLs out of `/changelog.json`.
const MEDIA_BASE = "https://www.drayhq.com";

const SECTIONS: Record<string, SectionKind> = {
  New: "new",
  Improved: "improved",
  Fixed: "fixed",
};
const MEDIA_LINE = /^\s*!\[([^\]]*)\]\(([^)\s]+)\)\s*$/;
const VIDEO = /\.(mp4|m4v|mov|webm)$/i;
const TITLE = /^\*\*(.+?)[.!?]\*\*\s*/s;
/// A comment, so GitHub's release notes and every markdown viewer hide it.
const HIGHLIGHT_LINE = /^\s*<!--\s*highlight\b(.*?)-->\s*$/;
const APPS: readonly string[] = ["desktop", "ios", "android"];
const TARGET = /^(https:\/\/\S+|[a-z][a-z0-9-]*(\/[a-z0-9-]+)*)$/;

/// What follows `highlight` in `<!-- highlight: desktop, ios · action: Label →
/// target -->`. Throws on anything it cannot read, which fails the site's
/// build: a highlight dropped quietly is an announcement nobody sees.
export function parseHighlight(spec: string, where: string): Highlight {
  const fail = (why: string): never => {
    throw new Error(`CHANGELOG.md, ${where}: ${why} in "<!-- highlight${spec}-->"`);
  };
  const apps: App[] = [];
  let action: Highlight["action"] = null;
  for (const part of spec.replace(/^\s*:/, "").split("·").map((p) => p.trim())) {
    if (/^action\b/.test(part)) {
      const act = /^action\s*:\s*(.+?)\s*(?:→|->)\s*(\S+)$/.exec(part);
      if (!act) fail("an action reads `action: Label → target`");
      if (!TARGET.test(act![2])) fail(`bad action target "${act![2]}"`);
      action = { label: act![1], target: act![2] };
      continue;
    }
    for (const name of part.split(/[\s,]+/).filter(Boolean)) {
      if (!APPS.includes(name)) fail(`unknown app "${name}"`);
      if (!apps.includes(name as App)) apps.push(name as App);
    }
  }
  if (apps.length === 0) fail("no app named");
  return { apps, action };
}

function toItem(lines: string[], media: Media[], highlight: Highlight | null): Item {
  const text = lines
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) => p.split("\n").map((l) => l.trim()).join(" ").trim())
    .filter(Boolean)
    .join("\n\n");
  const m = TITLE.exec(text);
  return m
    ? { title: m[1], body: text.slice(m[0].length), media, highlight }
    : { title: null, body: text, media, highlight };
}

/// Pure, so it is testable without the file.
export function parseChangelog(md: string, mediaBase = MEDIA_BASE): Release[] {
  const releases: Release[] = [];
  let section: Section | null = null;
  let lines: string[] | null = null;
  let media: Media[] = [];
  let highlight: Highlight | null = null;

  const flush = () => {
    if (section && lines) section.items.push(toItem(lines, media, highlight));
    lines = null;
    media = [];
    highlight = null;
  };

  for (const line of md.split("\n")) {
    if (line.startsWith("## ")) {
      flush();
      section = null;
      const [version, ...rest] = line.slice(3).split("·").map((s) => s.trim());
      releases.push({
        version,
        date: rest.find((r) => /^\d{4}-\d{2}-\d{2}$/.test(r)) ?? null,
        notify: rest.includes("notify"),
        beta: version.includes("-"),
        sections: [],
      });
    } else if (line.startsWith("### ")) {
      flush();
      const kind = SECTIONS[line.slice(4).trim()];
      const release = releases.at(-1);
      section = kind && release ? { kind, items: [] } : null;
      if (section) release!.sections.push(section);
    } else if (!section) {
      continue;
    } else if (line.startsWith("- ")) {
      flush();
      lines = [line.slice(2)];
    } else if (lines) {
      const h = HIGHLIGHT_LINE.exec(line);
      const m = MEDIA_LINE.exec(line);
      if (h) highlight = parseHighlight(h[1], `${releases.at(-1)!.version} "${lines[0].slice(0, 40)}"`);
      else if (!m) lines.push(line);
      else
        media.push({
          kind: VIDEO.test(m[2]) ? "video" : "image",
          url: /^https?:/.test(m[2]) ? m[2] : `${mediaBase}/${m[2].replace(/^\.?\//, "")}`,
          alt: m[1],
        });
    }
  }
  flush();
  return releases;
}

/// The whole file, parsed. Next runs this at build, with cwd at `apps/web`.
export function loadChangelog(): Release[] {
  return parseChangelog(
    readFileSync(path.join(process.cwd(), "../desktop/CHANGELOG.md"), "utf8"),
  );
}
