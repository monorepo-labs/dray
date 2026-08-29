import { describe, expect, it } from "vitest";

import { absolutePath, findFilePaths, isFilePath } from "@/lib/filePath";

const paths = (text: string) => findFilePaths(text).map((m) => m.path);

describe("findFilePaths", () => {
  it("finds a path in a sentence", () => {
    expect(paths("I changed /Users/yogesh/app/Footer.js for you")).toEqual([
      "/Users/yogesh/app/Footer.js",
    ]);
  });

  it("finds one at the very start", () => {
    expect(paths("/etc/hosts is the file")).toEqual(["/etc/hosts"]);
  });

  /// The failure that would make this feature worse than nothing: every URL in
  /// a transcript turning into a link that opens a file no one has.
  it("leaves a URL alone", () => {
    expect(paths("see https://example.com/a/b for more")).toEqual([]);
  });

  it("leaves a slash inside a word alone", () => {
    expect(paths("read and/or write, plus src/lib/a.ts")).toEqual([]);
  });

  /// One segment is a slash command or a bare root, not a file worth offering.
  it("needs two segments", () => {
    expect(paths("run /compact now")).toEqual([]);
    expect(paths("under /tmp somewhere")).toEqual([]);
  });

  it("keeps bracketing punctuation out of the path", () => {
    expect(paths("(/Users/me/a.ts) and /Users/me/b.ts.")).toEqual([
      "/Users/me/a.ts",
      "/Users/me/b.ts",
    ]);
  });

  it("reports where each run sits, so a text node can be split on it", () => {
    const text = "at /a/b.ts now";
    expect(findFilePaths(text)).toEqual([{ start: 3, end: 10, path: "/a/b.ts" }]);
    expect(text.slice(3, 10)).toBe("/a/b.ts");
  });

  it("finds several", () => {
    expect(paths("/a/one.ts and /b/two.ts")).toEqual(["/a/one.ts", "/b/two.ts"]);
  });

  it("keeps a trailing slash, since a directory opens too", () => {
    expect(paths("in /Users/me/ there")).toEqual(["/Users/me/"]);
  });
});

describe("isFilePath", () => {
  it("rejects a relative path", () => {
    expect(isFilePath("src/lib/a.ts")).toBe(false);
  });

  it("rejects what is left of a URL", () => {
    expect(isFilePath("//example.com/a")).toBe(false);
  });
});

describe("absolutePath", () => {
  it("passes an absolute path through", () => {
    expect(absolutePath("/Users/me/a.ts", "/repo")).toBe("/Users/me/a.ts");
  });

  it("anchors a relative one on the cwd", () => {
    expect(absolutePath("src/a.ts", "/repo")).toBe("/repo/src/a.ts");
    expect(absolutePath("./src/a.ts", "/repo/")).toBe("/repo/src/a.ts");
  });

  /// A mention with nothing to anchor it stays inert. Resolving it against
  /// wherever the app happens to be running would open the wrong file, which is
  /// worse than opening none.
  it("answers null with no cwd", () => {
    expect(absolutePath("src/a.ts", null)).toBeNull();
    expect(absolutePath("", "/repo")).toBeNull();
  });
});
