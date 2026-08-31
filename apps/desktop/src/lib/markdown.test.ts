import { describe, expect, it } from "vitest";

import { isMarkdownPath } from "./markdown";

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
