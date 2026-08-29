import { describe, expect, it } from "vitest";

import { FILE_LINK_CLASS, FILE_PATH_CLASS, REHYPE_PLUGINS, walk } from "./markdownPlugins";

type Hast = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Hast[];
};

// The list's last entry is harden, and it is the only one under test — raw and
// sanitize both want a real unified pipeline around them.
function runHarden(tree: Hast) {
  const entry = (REHYPE_PLUGINS as unknown[]).at(-1) as [
    (options: Record<string, unknown>) => (tree: Hast) => void,
    Record<string, unknown>,
  ];
  const [plugin, options] = entry;
  plugin(options)(tree);
  return tree;
}

function text(tree: Hast): string {
  if (tree.type === "text") return tree.value ?? "";
  return (tree.children ?? []).map(text).join("");
}

function link(href: string, children: Hast[]): Hast {
  return { type: "root", children: [{ type: "element", tagName: "a", properties: { href }, children }] };
}

describe("REHYPE_PLUGINS", () => {
  // Greptile wraps every severity badge in `<a href="#">`, so this shape lands
  // in the PR panel on more or less every review.
  it("unwraps a bare fragment link without annotating it", () => {
    const badge: Hast = {
      type: "element",
      tagName: "img",
      properties: { alt: "P1", src: "https://greptile-static-assets.s3.amazonaws.com/badges/p1.svg" },
      children: [],
    };
    const out = runHarden(link("#", [badge]));

    expect(text(out)).toBe("");
    expect(out.children?.[0]?.children?.[0]).toMatchObject({ tagName: "img" });
  });

  it("leaves a relative path as its own text", () => {
    const out = runHarden(link("src/lib/pr.ts", [{ type: "text", value: "src/lib/pr.ts" }]));

    expect(text(out)).toBe("src/lib/pr.ts");
    expect(out.children?.[0]?.tagName).toBe("span");
  });

  it("keeps a real link a link", () => {
    const out = runHarden(link("https://example.com/x", [{ type: "text", value: "x" }]));

    expect(out.children?.[0]).toMatchObject({
      tagName: "a",
      properties: { href: "https://example.com/x", target: "_blank" },
    });
  });
});

describe("rehypeFilePaths", () => {
  const paragraph = (children: Hast[]): Hast => ({
    type: "root",
    children: [{ type: "element", tagName: "p", properties: {}, children }],
  });

  /// Every element the walk marked, wherever it ended up in the tree.
  const marked = (node: Hast): Hast[] =>
    (node.children ?? []).flatMap((child) =>
      child.properties?.className ? [child] : marked(child),
    );

  it("splits a path out of a sentence and marks it", () => {
    const tree = paragraph([{ type: "text", value: "I changed /a/b/Footer.js today" }]);
    walk(tree);

    const parts = tree.children![0].children!;
    expect(parts.map((c) => c.value ?? c.children![0].value)).toEqual([
      "I changed ",
      "/a/b/Footer.js",
      " today",
    ]);
    expect(marked(tree)[0].properties).toEqual({
      className: [FILE_PATH_CLASS],
      title: "/a/b/Footer.js",
    });
  });

  /// Punctuation stays outside the run, so the path on `title` is the path and
  /// nothing else. Opening `/a/b.ts).` would fail in a way nobody could read.
  it("puts the path and only the path inside the span", () => {
    const tree = paragraph([{ type: "text", value: "see (/a/b.ts)." }]);
    walk(tree);

    expect(marked(tree)[0].properties?.title).toBe("/a/b.ts");
    expect(marked(tree)[0].children).toEqual([{ type: "text", value: "/a/b.ts" }]);
  });

  /// The shape an agent writes most readily. Left as an anchor it raised the
  /// external-link confirmation for something that is not a URL, and then had
  /// nowhere to go.
  it("converts a markdown link whose href is a path, keeping its label", () => {
    const tree = paragraph([
      {
        type: "element",
        tagName: "a",
        properties: { href: "/Users/me/app/Footer.js" },
        children: [{ type: "text", value: "Footer.js" }],
      },
    ]);
    walk(tree);

    const [span] = marked(tree);
    expect(span.tagName).toBe("span");
    expect(span.properties?.title).toBe("/Users/me/app/Footer.js");
    expect(span.children).toEqual([{ type: "text", value: "Footer.js" }]);
    // Drawn as the link its author wrote, not as a path found in a sentence.
    expect(span.properties?.className).toEqual([FILE_PATH_CLASS, FILE_LINK_CLASS]);
  });

  it("leaves a markdown link to a real URL as a link", () => {
    const tree = paragraph([
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://example.com/a/b" },
        children: [{ type: "text", value: "the docs" }],
      },
    ]);
    walk(tree);

    expect(marked(tree)).toEqual([]);
    expect(tree.children![0].children![0].tagName).toBe("a");
  });

  /// That text already belongs to a link. A second one nested inside it would
  /// fire both on one click.
  it("leaves a path alone inside a real link's label", () => {
    const tree = paragraph([
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://example.com" },
        children: [{ type: "text", value: "see /a/b.ts" }],
      },
    ]);
    walk(tree);

    expect(marked(tree)).toEqual([]);
  });

  /// Splitting a highlighted block's text would break its tokens, and the path
  /// is already drawn there.
  it("leaves a fenced block alone", () => {
    const tree = paragraph([]);
    tree.children!.push({
      type: "element",
      tagName: "pre",
      properties: {},
      children: [
        {
          type: "element",
          tagName: "code",
          properties: {},
          children: [{ type: "text", value: "open /a/b.ts" }],
        },
      ],
    });
    walk(tree);

    expect(marked(tree)).toEqual([]);
  });

  it("leaves an autolinked URL alone", () => {
    const tree = paragraph([
      {
        type: "element",
        tagName: "a",
        properties: { href: "https://example.com/a/b" },
        children: [{ type: "text", value: "https://example.com/a/b" }],
      },
    ]);
    walk(tree);

    expect(marked(tree)).toEqual([]);
  });

  /// Where an agent puts a path most of the time.
  it("marks a path inside inline code", () => {
    const tree = paragraph([
      {
        type: "element",
        tagName: "code",
        properties: {},
        children: [{ type: "text", value: "/a/b.ts" }],
      },
    ]);
    walk(tree);

    expect(marked(tree)[0].children).toEqual([{ type: "text", value: "/a/b.ts" }]);
  });

  it("leaves a tree with no path in it untouched", () => {
    const tree = paragraph([{ type: "text", value: "nothing here" }]);
    const before = tree.children![0].children;
    walk(tree);

    expect(tree.children![0].children).toBe(before);
  });
});
