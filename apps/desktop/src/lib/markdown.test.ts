import { describe, expect, it } from "vitest";

import { isMarkdownPath, splitMarkdownSections } from "./markdown";

describe("isMarkdownPath", () => {
  it("takes both spellings", () => {
    expect(isMarkdownPath("/Users/me/app/README.md")).toBe(true);
    expect(isMarkdownPath("/Users/me/app/notes.markdown")).toBe(true);
  });

  it("ignores case, since a repo is free to shout its readme", () => {
    expect(isMarkdownPath("/Users/me/app/README.MD")).toBe(true);
    expect(isMarkdownPath("/Users/me/app/NOTES.Markdown")).toBe(true);
  });

  // The panel renders with Streamdown, which would draw a component tag as
  // prose. An MDX file is better off in the reader's editor.
  it("refuses .mdx", () => {
    expect(isMarkdownPath("/Users/me/app/page.mdx")).toBe(false);
  });

  it("needs the extension at the end of the name, not anywhere in it", () => {
    expect(isMarkdownPath("/Users/me/app/README.md.bak")).toBe(false);
    expect(isMarkdownPath("/Users/me/app/md/index.ts")).toBe(false);
  });

  it("says no to a path with no extension, and to a directory", () => {
    expect(isMarkdownPath("/Users/me/app/Makefile")).toBe(false);
    expect(isMarkdownPath("/Users/me/app/docs/")).toBe(false);
  });
});

describe("splitMarkdownSections", () => {
  // The property the whole approach rests on: the pieces are the file, so
  // stacking their renders draws what one render of the whole would.
  const rejoins = (text: string) =>
    expect(splitMarkdownSections(text).join("\n")).toBe(text);

  it("cuts at every top-level heading", () => {
    expect(splitMarkdownSections("# One\na\n\n## Two\nb")).toEqual([
      "# One\na\n",
      "## Two\nb",
    ]);
  });

  it("keeps what comes before the first heading", () => {
    expect(splitMarkdownSections("intro\n\n# One\na")).toEqual(["intro\n", "# One\na"]);
  });

  it("gives one section back for a file with no headings", () => {
    expect(splitMarkdownSections("just\n\nprose")).toEqual(["just\n\nprose"]);
  });

  // A `#` comment in a bash block is ordinary, and cutting there would leave an
  // unterminated fence in one piece and an orphaned one in the next.
  it("does not cut inside a fenced block", () => {
    const text = "# One\n\n```bash\n# not a heading\n```\n\n## Two";
    expect(splitMarkdownSections(text)).toEqual([
      "# One\n\n```bash\n# not a heading\n```\n",
      "## Two",
    ]);
  });

  it("closes a fence only on its own character", () => {
    const text = "# One\n\n~~~\n# no\n```\n# still no\n~~~\n\n## Two";
    expect(splitMarkdownSections(text)).toHaveLength(2);
  });

  // `#foo` is not a heading in CommonMark, and an indented one is code or a
  // list continuation rather than a cut point.
  it("wants a real heading, not a bare hash or an indented one", () => {
    expect(splitMarkdownSections("a\n#foo\nb")).toHaveLength(1);
    expect(splitMarkdownSections("a\n   # indented\nb")).toHaveLength(1);
  });

  // A closing fence takes no info string, so this opens rather than closes.
  // Read as a close, the rest of the block came back into play and the next
  // `#` inside it became a cut.
  it("does not close a fence on a line carrying an info string", () => {
    const text = "# One\n\n```\n```js\n# still inside\n```\n\n## Two";
    expect(splitMarkdownSections(text)).toHaveLength(2);
  });

  // The pieces have to mean what the whole meant, not merely rejoin to it.
  describe("leaves a document alone where cutting it would change the render", () => {
    it("keeps a link reference definition with the link that uses it", () => {
      expect(splitMarkdownSections("see [docs][d]\n\n# One\n\n[d]: /x")).toHaveLength(1);
    });

    it("keeps an HTML block whole, since a heading does not end one", () => {
      expect(splitMarkdownSections("<div>\n\n# One\n\n</div>")).toHaveLength(1);
    });

    it("leaves front matter alone", () => {
      expect(splitMarkdownSections("---\ntitle: x\n---\n\n# One\n\n# Two")).toHaveLength(1);
    });

    // Both tests are loose on purpose: over-reading one costs a slower render,
    // under-reading one costs a wrong one.
    it("is not fooled by either construct sitting inside a fence", () => {
      const text = "# One\n\n```\n[d]: /x\n<div>\n```\n\n## Two";
      expect(splitMarkdownSections(text)).toHaveLength(2);
    });
  });

  it("rejoins to the input, whatever it was given", () => {
    rejoins("# One\na\n\n## Two\nb\n");
    rejoins("no headings at all");
    rejoins("");
    rejoins("# One\n\n```\n# fence\n```\n\n### Three\n\ntrailing\n");
  });
});
