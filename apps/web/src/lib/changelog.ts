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
export type Item = { title: string | null; body: string; media: Media[] };
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

function toItem(lines: string[], media: Media[]): Item {
  const text = lines
    .join("\n")
    .split(/\n\s*\n/)
    .map((p) => p.split("\n").map((l) => l.trim()).join(" ").trim())
    .filter(Boolean)
    .join("\n\n");
  const m = TITLE.exec(text);
  return m
    ? { title: m[1], body: text.slice(m[0].length), media }
    : { title: null, body: text, media };
}

/// Pure, so it is testable without the file.
export function parseChangelog(md: string, mediaBase = MEDIA_BASE): Release[] {
  const releases: Release[] = [];
  let section: Section | null = null;
  let lines: string[] | null = null;
  let media: Media[] = [];

  const flush = () => {
    if (section && lines) section.items.push(toItem(lines, media));
    lines = null;
    media = [];
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
      const m = MEDIA_LINE.exec(line);
      if (!m) lines.push(line);
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
