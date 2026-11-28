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
/// target never breaks an older build. `required` is a highlight the reader
/// must act on, drawn first and set apart: always, or only where the app finds
/// a condition holds, the app showing `otherwise` as a plain title elsewhere,
/// with `otherwiseMedia` in place of the item's picture where one is named.
/// Both absent rather than empty, so the feed only grows where they are used.
export type Highlight = {
  apps: App[];
  action: { label: string; target: string } | null;
  required?: true | Condition;
  otherwise?: string;
  otherwiseMedia?: Media;
};
/// What an app can find out about its reader: `remote-access`, Remote access
/// on for this machine.
export type Condition = "remote-access";
const CONDITIONS: readonly string[] = ["remote-access"];
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

/// What follows `highlight` in `<!-- highlight: desktop, ios · required ·
/// action: Label → target -->`, `required` also as `required if <condition> ·
/// otherwise: Title · otherwise image: path`. Throws on anything it cannot read, which fails the site's
/// build: a highlight dropped quietly is an announcement nobody sees.
export function parseHighlight(spec: string, where: string, mediaBase = MEDIA_BASE): Highlight {
  const fail = (why: string): never => {
    throw new Error(`CHANGELOG.md, ${where}: ${why} in "<!-- highlight${spec}-->"`);
  };
  const apps: App[] = [];
  let action: Highlight["action"] = null;
  let required: Highlight["required"];
  let otherwise: string | undefined;
  let otherwiseMedia: Media | undefined;
  for (const part of spec.replace(/^\s*:/, "").split("·").map((p) => p.trim())) {
    if (part === "required") {
      required = true;
      continue;
    }
    const when = /^required\s+if\s+(\S+)$/.exec(part);
    if (when) {
      if (!CONDITIONS.includes(when[1])) fail(`unknown condition "${when[1]}"`);
      required = when[1] as Condition;
      continue;
    }
    const picture = /^otherwise\s+image\s*:\s*(\S+)$/.exec(part);
    if (picture) {
      otherwiseMedia = toMedia(picture[1], "", mediaBase);
      continue;
    }
    const plain = /^otherwise\s*:\s*(.+)$/.exec(part);
    if (plain) {
      // As an item's bold title is read: its closing stop dropped.
      otherwise = plain[1].replace(/[.!?]$/, "");
      continue;
    }
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
  if ((otherwise || otherwiseMedia) && typeof required !== "string") fail("`otherwise` goes with `required if`");
  return {
    apps,
    action,
    ...(required && { required }),
    ...(otherwise && { otherwise }),
    ...(otherwiseMedia && { otherwiseMedia }),
  };
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
function toMedia(path: string, alt: string, mediaBase: string): Media {
  return {
    kind: VIDEO.test(path) ? "video" : "image",
    url: /^https?:/.test(path) ? path : `${mediaBase}/${path.replace(/^\.?\//, "")}`,
    alt,
  };
}

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
      if (h) highlight = parseHighlight(h[1], `${releases.at(-1)!.version} "${lines[0].slice(0, 40)}"`, mediaBase);
      else if (!m) lines.push(line);
      else
        media.push(toMedia(m[2], m[1], mediaBase));
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
