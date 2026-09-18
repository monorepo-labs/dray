import { describe, expect, it } from "vitest";

import { highlightSegments } from "@/lib/highlight";
import {
  applySession,
  filterSessions,
  parseSessionTag,
  sessionSpan,
  sessionTag,
} from "@/lib/sessionTag";
import type { SessionIndexItem } from "@/types/events";

const ID = "019a3f2c-7b41-7d3e-9f80-12ab34cd56ef";
const OTHER = "019a3f2c-7b41-7d3e-9f80-12ab34cd56aa";

function item(over: Partial<SessionIndexItem>): SessionIndexItem {
  return {
    sessionId: ID,
    title: "Fix the login redirect",
    projectPath: "/repo",
    archived: false,
    ...over,
  } as SessionIndexItem;
}

describe("sessionSpan", () => {
  it("opens on a bare & and reads the token to its end", () => {
    expect(sessionSpan("&", 1)).toEqual({ start: 0, end: 1, query: "" });
    expect(sessionSpan("tell &logi about it", 10)).toEqual({ start: 5, end: 10, query: "logi" });
  });

  it("stays shut where the & does not open a word", () => {
    expect(sessionSpan("A&B", 3)).toBeNull();
    expect(sessionSpan("nothing here", 4)).toBeNull();
  });

  it("does not reopen inside a placed tag's id", () => {
    const text = sessionTag("Fix login", ID);
    expect(sessionSpan(text, text.length)).toBeNull();
  });
});

describe("applySession", () => {
  it("writes the title and the id, with one trailing space", () => {
    const text = "ask &log to check";
    const span = sessionSpan(text, 8)!;

    expect(applySession(text, span, "Fix the login redirect", ID)).toEqual({
      text: `ask &Fix the login redirect (${ID}) to check`,
      caret: `ask &Fix the login redirect (${ID}) `.length,
    });
  });

  it("does not double the space that is already there", () => {
    const text = "&l ok";
    const out = applySession(text, sessionSpan(text, 2)!, "L", ID);

    expect(out.text).toBe(`&L (${ID}) ok`);
  });
});

describe("parseSessionTag", () => {
  it("splits a tag into the half worth reading and the address", () => {
    const tag = sessionTag("Fix the login redirect", ID);
    const parsed = parseSessionTag(`${tag} please`, 0)!;

    expect(parsed).toEqual({
      text: tag,
      head: "&Fix the login redirect",
      trail: ` (${ID})`,
      id: ID,
    });
    // The property the composer's overlay is laid out by.
    expect(parsed.head + parsed.trail).toBe(parsed.text);
  });

  it("closes on the first id, so a title holding parens survives", () => {
    const parsed = parseSessionTag(`&Fix (login) redirect (${ID})`, 0)!;

    expect(parsed.head).toBe("&Fix (login) redirect");
    expect(parsed.id).toBe(ID);
  });

  it("refuses anything that is not a real id", () => {
    expect(parseSessionTag("&Fix login (nope)", 0)).toBeNull();
    expect(parseSessionTag("&Fix login", 0)).toBeNull();
  });
});

describe("filterSessions", () => {
  const sessions = [
    item({ sessionId: ID }),
    item({ sessionId: OTHER, title: "Rewrite the parser" }),
    item({ sessionId: "c", title: "Old login work", archived: true }),
  ];

  it("drops the session being typed in, and settled ones", () => {
    expect(filterSessions(sessions, ID, "").map((s) => s.sessionId)).toEqual([OTHER]);
  });

  it("narrows on one word of the title", () => {
    expect(filterSessions(sessions, null, "login").map((s) => s.sessionId)).toEqual([ID]);
    expect(filterSessions(sessions, null, "nothing")).toEqual([]);
  });
});

describe("highlightSegments", () => {
  it("paints a whole tag as one run and keeps the round trip", () => {
    const text = `ask ${sessionTag("Fix login", ID)} to report back`;
    const segments = highlightSegments(text);
    const tag = segments.find((s) => s.kind === "session")!;

    expect(tag.text).toBe(`&Fix login (${ID})`);
    expect(tag.inner).toBe("&Fix login");
    expect(tag.sessionId).toBe(ID);
    // What keeps the composer's overlay in register with the textarea.
    expect(segments.map((s) => s.text).join("")).toBe(text);
  });

  it("leaves an ampersand in prose alone", () => {
    expect(highlightSegments("Ben & Jerry (not a tag)").every((s) => s.kind === "text")).toBe(true);
  });
});
