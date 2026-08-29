import { defaultRehypePlugins, type StreamdownProps } from "streamdown";

import { findFilePaths, isFilePath } from "@/lib/filePath";

// `rehype-harden` drops the href of any link it cannot resolve, which is right,
// and then writes " [blocked]" into the prose beside it, which is not: two
// ordinary shapes hit it. Greptile's severity badges are `<a href="#">` around
// an image — harden's hash-only branch compares `new URL("#", base).hash`
// against `"#"` and that is `""`, so a bare fragment falls through to a parse
// that throws — and a bare relative path in agent output (`src/foo.tsx`) starts
// with none of `/`, `./`, `../`, so it is never parsed either. `text-only`
// keeps the link's own content and adds nothing; real http(s) links are
// untouched, and losing the href is the safe direction.
//
// Harden's own function comes back out of Streamdown's default list rather than
// from a direct dependency, which is what pins it to whatever version
// Streamdown itself runs. Passing `rehypePlugins` replaces that list whole, so
// raw and sanitize have to be named here too.
const [hardenPlugin, hardenDefaults] = defaultRehypePlugins.harden as [
  unknown,
  Record<string, unknown>,
];

const HARDEN = [
  hardenPlugin,
  { ...hardenDefaults, linkBlockPolicy: "text-only", imageBlockPolicy: "text-only" },
];

/// Streamdown's own rehype pipeline, with harden told to block a link by
/// unwrapping it rather than by annotating the text around it.
export const REHYPE_PLUGINS = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  HARDEN,
] as StreamdownProps["rehypePlugins"];

/// The marker `rehypeFilePaths` leaves on a run it picked out, and what tells
/// `Markdown`'s `span` override which spans are its own.
///
/// The path itself rides `title`, not the text, because the two are not always
/// the same thing: a path found in prose is its own label, and a markdown link
/// spelled `[Footer.js](/Users/me/Footer.js)` has a label of its own that has to
/// survive. `title` is what the reader wants on hover either way, so it is
/// carrying a fact rather than being smuggled.
export const FILE_PATH_CLASS = "dray-file-path";

/// Set beside [FILE_PATH_CLASS] on a run that was a markdown link before it was
/// a file link, so it can be drawn as the link its author wrote rather than as
/// a path found in a sentence. Two classes rather than one, because "is ours"
/// and "was written as a link" are two facts and only the first decides whether
/// this opens anything.
export const FILE_LINK_CLASS = "dray-file-path-link";

/// Enough of hast to walk it. Typed here rather than pulled from `@types/hast`,
/// which is not a dependency and would be one for four fields.
export type HastNode = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: HastNode[];
};

/// Not prose, so not searched. `pre` covers a fenced block and its `code` with
/// it, since nothing descends into a skipped element — a path inside one is
/// already being drawn by the highlighter, and splitting its text would break
/// the tokens. `a` is here too, and checked *after* `anchorToFile`: a link whose
/// href names a file becomes one of ours, and any other link is left whole. A
/// path sitting in a real link's own label therefore stays plain, which it must
/// — that text already belongs to a link, and nesting a second one inside it
/// would fire both on one click.
const NOT_PROSE = new Set(["pre", "a", "script", "style"]);

function marked(path: string, children: HastNode[], wasLink = false): HastNode {
  return {
    type: "element",
    tagName: "span",
    properties: {
      className: wasLink ? [FILE_PATH_CLASS, FILE_LINK_CLASS] : [FILE_PATH_CLASS],
      title: path,
    },
    children,
  };
}

/// The link a markdown anchor is, where its href names a file rather than a
/// page.
///
/// `[Footer.js](/Users/me/app/Footer.js)` is the shape, and it is the one an
/// agent writes most readily. Left alone it stays an anchor, so clicking it
/// raised the external-link confirmation for something that is not a URL and
/// then had nowhere to go. Converting it here means Streamdown never sees a
/// link at all. The anchor's own children carry through, so the label the agent
/// wrote is what stays on screen.
function anchorToFile(node: HastNode): HastNode | null {
  if (node.tagName !== "a") return null;

  const href = node.properties?.href;
  if (typeof href !== "string") return null;

  // `[x](/Users/me/My%20Project/x.ts)` is the one way to write a path holding a
  // space as a markdown link — a bare one there ends the href — so the encoded
  // form is the shape to expect, and it names no file left as it is. Decoding
  // cannot smuggle anything past `isFilePath`, which still runs on the result.
  const path = decodePath(href);
  if (!isFilePath(path)) return null;

  return marked(path, node.children ?? [], true);
}

/// `href` with its escapes resolved, or unchanged where they do not resolve.
/// A malformed escape throws, and a link nobody can decode is still a link.
function decodePath(href: string): string {
  try {
    return decodeURIComponent(href);
  } catch {
    return href;
  }
}

/// Marks every absolute path in the prose so `Markdown` can draw it as a link.
///
/// Runs after sanitize, which would otherwise strip what this adds, and
/// **before** harden, which rewrites or unwraps an href before this could read
/// one. It is a hand-written walk rather than `unist-util-visit` because the
/// walk is twenty lines and the visitor is a dependency, and because splitting
/// one node into several is the case a visitor makes awkward anyway.
function rehypeFilePaths() {
  return (tree: HastNode) => walk(tree);
}

export function walk(node: HastNode) {
  const children = node.children;
  if (!children) return;

  // Left null until something actually matches, so a tree with no path in it
  // is walked without being rebuilt.
  let next: HastNode[] | null = null;

  for (let i = 0; i < children.length; i += 1) {
    const child = children[i];

    if (child.type === "element") {
      const link = anchorToFile(child);
      if (link) {
        next ??= children.slice(0, i);
        next.push(link);
        continue;
      }

      if (!NOT_PROSE.has(child.tagName ?? "")) walk(child);
      next?.push(child);
      continue;
    }

    const value = child.type === "text" ? child.value : undefined;
    const matches = value ? findFilePaths(value) : [];
    if (!value || matches.length === 0) {
      next?.push(child);
      continue;
    }

    next ??= children.slice(0, i);

    let at = 0;
    for (const { start, end, path } of matches) {
      if (start > at) next.push({ type: "text", value: value.slice(at, start) });
      next.push(marked(path, [{ type: "text", value: path }]));
      at = end;
    }
    if (at < value.length) next.push({ type: "text", value: value.slice(at) });
  }

  if (next) node.children = next;
}

/// The same pipeline with paths marked, for the one surface where a path names
/// a file on *this* machine.
///
/// A second list rather than a flag, because which surface gets this is the
/// part worth being able to read. An issue description or a PR comment names
/// paths from somebody else's checkout, so linking them there would offer to
/// open files the reader does not have.
export const REHYPE_PLUGINS_WITH_FILE_PATHS = [
  defaultRehypePlugins.raw,
  defaultRehypePlugins.sanitize,
  rehypeFilePaths,
  HARDEN,
] as StreamdownProps["rehypePlugins"];
