import { describe, expect, it } from "vitest";

import { highlightSegments, splitMention } from "./highlight";
import { applyMention, mentionSpan } from "./mention";

/// Written against caret positions rather than "the text looks right", because
/// the caret is the whole input to these — the same string opens the picker or
/// doesn't depending only on where the cursor is.
describe("mentionSpan", () => {
  it("opens on the @ that starts the line", () => {
    expect(mentionSpan("@src/lib", 8)).toEqual({ start: 0, end: 8, query: "src/lib" });
  });

  it("opens as soon as the @ is typed, with nothing after it", () => {
    expect(mentionSpan("@", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("finds a mention in the middle of a sentence", () => {
    const text = "look at @src/App.tsx please";
    expect(mentionSpan(text, 19)).toEqual({ start: 8, end: 20, query: "src/App.tsx" });
  });

  it("finds the mention the caret is in when there are several", () => {
    const text = "@a/one.ts and @b/two.ts";
    expect(mentionSpan(text, 3)?.query).toBe("a/one.ts");
    expect(mentionSpan(text, 20)?.query).toBe("b/two.ts");
  });

  /// The one case the leading-slash rule gets for free and this doesn't. An
  /// address is the common `@` in ordinary prose, so firing on it would make the
  /// picker feel like it opens at random.
  it("ignores the @ inside an email address", () => {
    expect(mentionSpan("mail me@example.com", 12)).toBeNull();
    expect(mentionSpan("me@example.com", 5)).toBeNull();
  });

  it("stays shut when the caret is outside any mention", () => {
    const text = "@src/App.tsx please";
    // Just past the mention's trailing space, i.e. in the following word.
    expect(mentionSpan(text, 16)).toBeNull();
    // Before the `@` there is nothing to be inside of.
    expect(mentionSpan(text, 0)).toBeNull();
  });

  /// The query is the whole token, not the prefix before the caret — so
  /// backspacing into a path to fix a typo filters on the corrected path rather
  /// than on its first half.
  it("reads the whole token when the caret is mid-path", () => {
    expect(mentionSpan("@src/lib/slash.ts", 5)?.query).toBe("src/lib/slash.ts");
  });
});

describe("applyMention", () => {
  it("replaces the typed mention and leaves the caret past a space", () => {
    const text = "@src/li";
    const next = applyMention(text, mentionSpan(text, 7)!, "src/lib/slash.ts");

    expect(next.text).toBe("@src/lib/slash.ts ");
    expect(next.caret).toBe(next.text.length);
  });

  /// The space after the mention already exists here, so adding another would
  /// leave a gap that grows with every pick.
  it("reuses the existing space rather than doubling it", () => {
    const text = "read @src/li and report";
    const next = applyMention(text, mentionSpan(text, 12)!, "src/lib/slash.ts");

    expect(next.text).toBe("read @src/lib/slash.ts and report");
    expect(next.caret).toBe("read @src/lib/slash.ts ".length);
  });

  it("leaves an earlier mention alone", () => {
    const text = "@a/one.ts and @b/tw";
    const next = applyMention(text, mentionSpan(text, 19)!, "b/two.ts");

    expect(next.text).toBe("@a/one.ts and @b/two.ts ");
  });
});

describe("highlightSegments", () => {
  /// Every consumer paints these in sequence over or in place of the original,
  /// so a segmentation that drops or duplicates a character shows up as
  /// ghosting in the composer overlay.
  const roundTrips = (text: string) =>
    expect(
      highlightSegments(text)
        .map((s) => s.text)
        .join(""),
    ).toBe(text);

  it("leaves ordinary prose as one run", () => {
    expect(highlightSegments("just some text")).toEqual([
      { kind: "text", text: "just some text" },
    ]);
  });

  it("marks a leading command", () => {
    expect(highlightSegments("/compact the history")).toEqual([
      { kind: "command", text: "/compact" },
      { kind: "text", text: " the history" },
    ]);
  });

  it("marks every mention in the line", () => {
    expect(highlightSegments("diff @a/one.ts against @b/two.ts now")).toEqual([
      { kind: "text", text: "diff " },
      { kind: "mention", text: "@a/one.ts" },
      { kind: "text", text: " against " },
      { kind: "mention", text: "@b/two.ts" },
      { kind: "text", text: " now" },
    ]);
  });

  it("marks a command and a mention together", () => {
    expect(highlightSegments("/review @src/lib/slash.ts")).toEqual([
      { kind: "command", text: "/review" },
      { kind: "text", text: " " },
      { kind: "mention", text: "@src/lib/slash.ts" },
    ]);
  });

  it("marks an http(s) URL and leaves the sentence's punctuation outside it", () => {
    expect(highlightSegments("see https://example.com/a?b=1). ok")).toEqual([
      { kind: "text", text: "see " },
      { kind: "url", text: "https://example.com/a?b=1" },
      { kind: "text", text: "). ok" },
    ]);
    expect(highlightSegments("(https://en.wikipedia.org/wiki/Foo_(bar))")).toEqual([
      { kind: "text", text: "(" },
      { kind: "url", text: "https://en.wikipedia.org/wiki/Foo_(bar)" },
      { kind: "text", text: ")" },
    ]);
    expect(highlightSegments("nothttps://x.y and http:// alone")).toEqual([
      { kind: "text", text: "nothttps://x.y and http:// alone" },
    ]);
  });

  it("leaves an email address plain", () => {
    expect(highlightSegments("ping me@example.com about it")).toEqual([
      { kind: "text", text: "ping me@example.com about it" },
    ]);
  });

  /// The colour should arrive with the path, not flash on the `@` the moment it
  /// is typed and then stay.
  it("leaves a bare @ plain", () => {
    expect(highlightSegments("look at @")).toEqual([{ kind: "text", text: "look at @" }]);
  });

  it("marks an issue tag", () => {
    expect(highlightSegments("start on #DRA-53 today")).toEqual([
      { kind: "text", text: "start on " },
      { kind: "issue", text: "#DRA-53" },
      { kind: "text", text: " today" },
    ]);
  });

  /// All three can share one sentence, which is why the three colours are
  /// chosen far apart in hue — and why this case is pinned.
  it("marks a command, a mention and a tag together", () => {
    expect(highlightSegments("/review #DRA-53 @src/lib/issue.ts")).toEqual([
      { kind: "command", text: "/review" },
      { kind: "text", text: " " },
      { kind: "issue", text: "#DRA-53" },
      { kind: "text", text: " " },
      { kind: "mention", text: "@src/lib/issue.ts" },
    ]);
  });

  /// The tag stops at the number, so the punctuation after it stays part of the
  /// sentence rather than being painted as an address.
  it("stops a tag at the end of its number", () => {
    expect(highlightSegments("see #DRA-53, then stop")).toEqual([
      { kind: "text", text: "see " },
      { kind: "issue", text: "#DRA-53" },
      { kind: "text", text: ", then stop" },
    ]);
  });

  /// Bracketed is still a tag, because the backend links it — the overlay and
  /// the link have to agree about what a tag is, or a word is painted as an
  /// address that nothing resolves, or the reverse.
  it("marks a bracketed tag", () => {
    expect(highlightSegments("see (#DRA-53) first")).toEqual([
      { kind: "text", text: "see (" },
      { kind: "issue", text: "#DRA-53" },
      { kind: "text", text: ") first" },
    ]);
  });

  /// A colour and a heading are prose. Painting either would promise a link
  /// that nothing is going to make.
  it("leaves a hash that is not an identifier plain", () => {
    expect(highlightSegments("border #fff please")).toEqual([
      { kind: "text", text: "border #fff please" },
    ]);
    expect(highlightSegments("# Heading")).toEqual([{ kind: "text", text: "# Heading" }]);
    expect(highlightSegments("channel#DRA-1")).toEqual([
      { kind: "text", text: "channel#DRA-1" },
    ]);
  });

  it("concatenates back to the original", () => {
    roundTrips("/review @src/lib/slash.ts and @src/lib/mention.ts please");
    roundTrips("ping me@example.com");
    roundTrips("@a @b @c");
    roundTrips("");
    roundTrips("/compact");
    roundTrips("/review #DRA-53 @src/lib/issue.ts");
    roundTrips("see (#DRA-53), and #fff, and #DRA-9.");
    roundTrips("#");
  });
});

describe("splitMention", () => {
  it("splits a nested path at the last slash", () => {
    expect(splitMention("@src/components/ChatInput.tsx")).toEqual({
      dir: "@src/components/",
      name: "ChatInput.tsx",
    });
  });

  it("gives a root file an @ and nothing else", () => {
    expect(splitMention("@CLAUDE.md")).toEqual({ dir: "@", name: "CLAUDE.md" });
  });

  it("splits a half-typed path", () => {
    expect(splitMention("@src/li")).toEqual({ dir: "@src/", name: "li" });
    expect(splitMention("@src/")).toEqual({ dir: "@src/", name: "" });
  });

  /// The composer paints these two spans over a textarea still laying out the
  /// whole string, so losing or duplicating a character here slides the caret
  /// out of register with the glyphs. That makes this the load-bearing half of
  /// the split, not the pretty one.
  it("rejoins to the segment exactly", () => {
    for (const mention of [
      "@src/components/ChatInput.tsx",
      "@CLAUDE.md",
      "@src/",
      "@a/b/c/d/e.rs",
      "@",
    ]) {
      const { dir, name } = splitMention(mention);
      expect(dir + name).toBe(mention);
    }
  });
});
