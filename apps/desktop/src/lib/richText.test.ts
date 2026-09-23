import { describe, expect, it } from "vitest";

import { highlightSegments } from "./highlight";
import { rememberIssueTitle } from "./issue";
import { diffRange } from "./richDom";
import { chipLabel, chipSignature, placeSegments, pushEntry, type Entry } from "./richText";

const ID = "0195f2a1-8c3d-7e4b-9f11-2ab7c0d3e5f6";

/// The composer's whole promise: what is drawn is shorter than what is sent, and
/// what is sent is what the reader assembled. So these are written as "the face
/// says this, the run is still that" rather than as a label lookup — a label
/// that stopped matching its run would pass a test asking only about the label.
function place(text: string, caret: number | null) {
  return placeSegments(highlightSegments(text), caret);
}

describe("chipLabel", () => {
  it("keeps a mention's filename and drops the path", () => {
    const [segment] = highlightSegments("@src/harness/claude_code/mapper.rs");
    expect(chipLabel(segment)).toBe("mapper.rs");
  });

  it("keeps a bare filename whole", () => {
    const [segment] = highlightSegments("@README.md");
    expect(chipLabel(segment)).toBe("README.md");
  });

  it("keeps a session's title and drops the id", () => {
    const [segment] = highlightSegments(`&Fix the auth loop (${ID})`);
    expect(chipLabel(segment)).toBe("Fix the auth loop");
  });

  it("falls back to the identifier where no title was written", () => {
    const [segment] = highlightSegments("#DRA-269");
    expect(chipLabel(segment)).toBe("#DRA-269");
  });

  it("elides a filename too long to fit the box", () => {
    const [segment] = highlightSegments(`@src/${"a".repeat(60)}.ts`);
    expect(chipLabel(segment)).toHaveLength(40);
    expect(chipLabel(segment)!.endsWith("…")).toBe(true);
  });

  it("never cuts an emoji in half", () => {
    const [segment] = highlightSegments(`@src/${"😀".repeat(60)}.ts`);
    expect(chipLabel(segment)).toBe(`${"😀".repeat(39)}…`);
  });

  it("refuses a command, a url and plain prose", () => {
    expect(highlightSegments("/caveman").map(chipLabel)).toEqual([null]);
    expect(highlightSegments("https://drayhq.com").map(chipLabel)).toEqual([null]);
    expect(highlightSegments("just words").map(chipLabel)).toEqual([null]);
  });
});

/// The rule that keeps the caret still. A tag is already a tag to the parser
/// after one character, so chipping on the parser's word alone would rebuild the
/// tree under the reader on every keystroke of a path — which is the fragility
/// the overlay had and this exists to avoid.
describe("placeSegments", () => {
  it("leaves a mention as text while the caret is inside it", () => {
    const placed = place("@src/lib", 4);
    expect(placed[0].label).toBeNull();
  });

  it("leaves it as text with the caret at its end, which is where typing sits", () => {
    const text = "@src/lib";
    expect(place(text, text.length)[0].label).toBeNull();
  });

  it("leaves it as text with the caret at its start", () => {
    expect(place("@src/lib", 0)[0].label).toBeNull();
  });

  it("chips it once the caret has left, which the space that ends the word does", () => {
    const placed = place("@src/lib.ts x", 13);
    expect(placed[0].label).toBe("lib.ts");
  });

  it("chips everything when nothing is focused", () => {
    const placed = place("@src/lib", null);
    expect(placed[0].label).toBe("lib");
  });

  it("chips one tag while the other is being edited", () => {
    const text = `&Task (${ID}) and @src/a.ts`;
    // Caret inside the mention at the end.
    const placed = place(text, text.length);
    expect(placed.map((p) => p.label)).toEqual(["Task", null, null]);
  });

  it("carries a file glyph on a mention and on nothing else", () => {
    const placed = place(`@src/a.ts and #DRA-1 and &T (${ID})`, null);
    const icons = placed.filter((p) => p.icon !== null);

    expect(icons).toHaveLength(1);
    expect(icons[0].segment.kind).toBe("mention");
    expect(icons[0].icon).toMatch(/^\/file-icons\/.+\.svg$/);
  });

  it("reports offsets that index back into the string", () => {
    const text = `read @a/b.ts and #DRA-269`;
    for (const entry of place(text, null)) {
      expect(text.slice(entry.start, entry.start + entry.segment.text.length)).toBe(
        entry.segment.text,
      );
    }
  });
});

/// What decides whether the tree is rebuilt at all. Ordinary typing must not
/// move it, or the composer is the overlay again with extra steps.
describe("chipSignature", () => {
  it("does not move as prose is typed beside a chip", () => {
    const before = chipSignature(place("@a/b.ts hello", 13));
    const after = chipSignature(place("@a/b.ts hello!", 14));
    expect(after).toBe(before);
  });

  it("moves when a tag finishes being typed", () => {
    const before = chipSignature(place("@a/b.ts", 7));
    const after = chipSignature(place("@a/b.ts ", 8));
    expect(after).not.toBe(before);
  });

  it("moves when text before a chip shifts it along", () => {
    const before = chipSignature(place("x @a/b.ts y", 11));
    const after = chipSignature(place("xx @a/b.ts y", 12));
    expect(after).not.toBe(before);
  });
});

/// The title is not in the issue segment — nothing closes it, so the scanner
/// stops at the identifier and leaves it as prose. These pin the rejoining, and
/// above all that the run stays the text back exactly however it is relabelled.
describe("issue titles", () => {
  it("shows the title, keeping the # and dropping the identifier", () => {
    rememberIssueTitle("DRA-269", "Composer chips");
    const [chip] = place("#DRA-269 Composer chips please", null);

    expect(chip.label).toBe("#Composer chips");
    expect(chip.segment.text).toBe("#DRA-269 Composer chips");
  });

  it("leaves the rest of the sentence alone", () => {
    rememberIssueTitle("DRA-269", "Composer chips");
    const text = "#DRA-269 Composer chips please";

    expect(place(text, null).map((p) => p.segment.text).join("")).toBe(text);
  });

  it("elides a title too long to sit in a line of prose", () => {
    const long = "Replace the mirrored overlay with real inline chips";
    rememberIssueTitle("DRA-900", long);
    const [chip] = place(`#DRA-900 ${long}`, null);

    expect(chip.label!.length).toBeLessThanOrEqual(30);
    expect(chip.label!.endsWith("…")).toBe(true);
  });

  it("refuses a title that is only the start of a longer word", () => {
    rememberIssueTitle("DRA-1", "Fix");
    const [chip] = place("#DRA-1 Fixed the login", null);

    expect(chip.label).toBe("#DRA-1");
    expect(chip.segment.text).toBe("#DRA-1");
  });

  it("takes a title the sentence carries on after with punctuation", () => {
    rememberIssueTitle("DRA-2", "Fix");
    const [chip] = place("#DRA-2 Fix, then ship", null);

    expect(chip.label).toBe("#Fix");
    expect(chip.segment.text).toBe("#DRA-2 Fix");
  });

  it("gives the title back once the reader edits it, rather than claiming it", () => {
    rememberIssueTitle("DRA-269", "Composer chips");
    const [chip] = place("#DRA-269 Composer chops", null);

    expect(chip.label).toBe("#DRA-269");
    expect(chip.segment.text).toBe("#DRA-269");
  });

  it("handles a tag that ends the prompt", () => {
    rememberIssueTitle("DRA-269", "Composer chips");
    const placed = place("#DRA-269 Composer chips", null);

    expect(placed).toHaveLength(1);
    expect(placed[0].label).toBe("#Composer chips");
  });
});

/// The piece whose being wrong would send words nobody typed: every programmatic
/// change reaches the DOM through this range.
describe("diffRange", () => {
  it("names the inserted run alone", () => {
    expect(diffRange("hello world", "hello brave world")).toEqual({
      start: 6,
      end: 6,
      text: "brave ",
    });
  });

  it("names a deletion as an empty replacement", () => {
    expect(diffRange("hello brave world", "hello world")).toEqual({
      start: 6,
      end: 12,
      text: "",
    });
  });

  it("reduces a pick to the tag rather than the prompt", () => {
    const before = "look at @src/li and tell me";
    const after = "look at @src/lib/richText.ts and tell me";
    const { start, end, text } = diffRange(before, after);

    expect(before.slice(0, start) + text + before.slice(end)).toBe(after);
    // The prose either side is untouched, which is what keeps undo meaningful.
    expect(before.slice(0, start)).toBe("look at @src/li");
  });

  it("answers an empty range where the strings match", () => {
    expect(diffRange("same", "same")).toEqual({ start: 4, end: 4, text: "" });
  });

  it("round-trips whatever it is given", () => {
    const cases: [string, string][] = [
      ["", "hello"],
      ["hello", ""],
      ["abc", "abd"],
      ["aaa", "aa"],
      ["", ""],
      ["one\ntwo", "one\n\ntwo"],
    ];

    for (const [before, after] of cases) {
      const { start, end, text } = diffRange(before, after);
      expect(before.slice(0, start) + text + before.slice(end)).toBe(after);
    }
  });
});

describe("undo history", () => {
  /// Types `text` a character at a time from empty, the way the effect files it.
  function type(text: string): { history: Entry[]; at: number } {
    const history: Entry[] = [{ text: "", caret: 0, run: null }];
    let at = 0;

    for (let i = 1; i <= text.length; i += 1) {
      at = pushEntry(history, at, text.slice(0, i), i);
    }

    return { history, at };
  }

  it("collapses a typed word into one entry", () => {
    const { history, at } = type("hello");

    expect(history.map((e) => e.text)).toEqual(["", "hello"]);
    expect(at).toBe(1);
  });

  it("breaks the run at a space, so undo takes back one word", () => {
    const { history } = type("hello there");

    expect(history.map((e) => e.text)).toEqual(["", "hello", "hello ", "hello there"]);
  });

  it("keeps deletes in their own run", () => {
    const history: Entry[] = [{ text: "", caret: 0, run: null }];
    let at = pushEntry(history, 0, "ab", 2);
    at = pushEntry(history, at, "a", 1);
    at = pushEntry(history, at, "", 0);

    expect(history.map((e) => e.text)).toEqual(["", "ab", ""]);
    expect(at).toBe(2);
  });

  it("opens a new entry for a character typed somewhere else", () => {
    const history: Entry[] = [{ text: "ab", caret: 2, run: null }];
    let at = pushEntry(history, 0, "abc", 3);
    at = pushEntry(history, at, "xabc", 1);

    expect(history.map((e) => e.text)).toEqual(["ab", "abc", "xabc"]);
  });

  it("files a pick as its own entry, never joined to the word before it", () => {
    const history: Entry[] = [{ text: "", caret: 0, run: null }];
    let at = pushEntry(history, 0, "s", 1);
    at = pushEntry(history, at, "see @src/lib/richText.ts ", 24);

    expect(history).toHaveLength(3);
    expect(history[2].run).toBeNull();
  });

  it("drops the redo tail once an edit lands on an undone state", () => {
    const { history } = type("hi");
    // Undone back to empty, then something else typed.
    const at = pushEntry(history, 0, "x", 1);

    expect(history.map((e) => e.text)).toEqual(["", "x"]);
    expect(at).toBe(1);
  });

  it("moves the caret on the newest entry rather than filing a state", () => {
    const { history, at } = type("hi");
    const next = pushEntry(history, at, "hi", 0);

    expect(next).toBe(at);
    expect(history).toHaveLength(2);
    expect(history[1].caret).toBe(0);
  });
});
