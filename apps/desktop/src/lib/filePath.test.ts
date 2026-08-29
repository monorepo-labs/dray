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

  /// The scan stops at whitespace, so a path holding a space is cut in half —
  /// and the half is a real path that can exist and open the wrong directory.
  /// Dropped rather than guessed at.
  it("drops a path a space cut in half", () => {
    expect(paths("open /Users/me/My Project/file.ts now")).toEqual([]);
  });

  /// A path can hold several spaces, so the read has to cross more than one
  /// word to find the slash that gives the break away.
  it("drops one several spaces cut up", () => {
    expect(paths("open /Users/me/My Project Sub/file.ts now")).toEqual([]);
  });

  /// And what stops that read from eating ordinary prose. A match that already
  /// names a file stops at one word, so the relative path four words later does
  /// not cost it its link.
  it("keeps a path that names a file, past the first word", () => {
    expect(paths("Updated /a/b/x.ts and src/foo.ts")).toEqual(["/a/b/x.ts"]);
  });

  /// A dot in the last segment is a guess — `project.v2` is a directory — so it
  /// only ever stops the read early and never accepts a match on its own. The
  /// word straight after a break still decides.
  it("drops a dotted directory a space cut in half", () => {
    expect(paths("in /Users/me/project.v2 source/file.ts here")).toEqual([]);
  });

  /// The other stop: a word opening with a slash is a path of its own.
  it("is not fooled by a second path later in the line", () => {
    expect(paths("open /a/b now and see /c/d")).toEqual(["/a/b", "/c/d"]);
  });

  /// The cost of the rule, stated rather than discovered. A slash in a
  /// following word is not conclusive, and losing a link is the side to be
  /// wrong on.
  it("also drops one followed by a word holding a slash", () => {
    expect(paths("see /a/b and/or c")).toEqual([]);
    expect(paths("see /a/b and c")).toEqual(["/a/b"]);
  });

  /// A path does not span lines, so the next line is a new sentence.
  it("is not fooled across a newline", () => {
    expect(paths("open /a/b.ts\nthen /c/d.ts")).toEqual(["/a/b.ts", "/c/d.ts"]);
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
