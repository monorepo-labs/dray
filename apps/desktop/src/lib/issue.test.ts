import { describe, expect, it } from "vitest";

import {
  applyIssue,
  groupIssues,
  issueSpan,
  issueTag,
  issueUrl,
  parseIdentifier,
} from "@/lib/issue";
import type { Issue, IssueRef, IssueStateKind } from "@/types/events";

const ref = (identifier: string, title: string): IssueRef => ({
  tracker: "linear",
  id: `uuid-${identifier}`,
  identifier,
  title,
  url: `https://linear.app/x/issue/${identifier}`,
});

describe("issueSpan", () => {
  it("opens on a tag the caret is inside", () => {
    const text = "fix #DRA-53 now";
    // Caret just after the `3`.
    expect(issueSpan(text, 11)).toEqual({ start: 4, end: 11, query: "DRA-53" });
  });

  it("opens on a bare hash, which is the whole assigned list", () => {
    expect(issueSpan("#", 1)).toEqual({ start: 0, end: 1, query: "" });
  });

  it("stays shut on a hash that does not open a word", () => {
    // The colour case: a `#` mid-token is not a tag, and painting one would
    // open the picker on every hex value anybody types.
    expect(issueSpan("border #fff", 11)).not.toBeNull();
    expect(issueSpan("color:#fff", 10)).toBeNull();
  });

  it("reads the whole token, not the half before the caret", () => {
    // Backing up to fix a typo filters on the corrected whole — the same rule
    // the file picker follows, and what makes the correction visible.
    const span = issueSpan("#DRA-53", 4);
    expect(span?.query).toBe("DRA-53");
  });

  it("is null when the caret is not in a token at all", () => {
    expect(issueSpan("plain words", 5)).toBeNull();
    expect(issueSpan("#DRA-53 after", 13)).toBeNull();
  });
});

describe("applyIssue", () => {
  it("writes the identifier and the title, and leaves the caret past a space", () => {
    const span = issueSpan("fix #DRA", 8)!;
    const next = applyIssue("fix #DRA", span, "DRA-53", "Issue tracker integration");

    expect(next.text).toBe("fix #DRA-53 Issue tracker integration ");
    expect(next.caret).toBe(next.text.length);
  });

  it("keeps the rest of the line and does not double its space", () => {
    const span = issueSpan("fix #DR now", 7)!;
    const next = applyIssue("fix #DR now", span, "DRA-53", "Fix it");

    expect(next.text).toBe("fix #DRA-53 Fix it now");
    // Caret sits after the space, ready for the next word.
    expect(next.text.slice(next.caret)).toBe("now");
  });

  /// The string Rust's `tag_text` writes for `--issue`, so a tag picked from the
  /// menu and one appended by the CLI are the same thing.
  it("matches the shape the backend writes", () => {
    expect(issueTag("DRA-53", "One")).toBe("#DRA-53 One");
    // A title we never resolved leaves the identifier standing alone rather
    // than a trailing space nobody typed.
    expect(issueTag("DRA-53", "")).toBe("#DRA-53");
  });
});

describe("parseIdentifier", () => {
  it("takes a key and a number, and uppercases the key", () => {
    expect(parseIdentifier("DRA-53")).toBe("DRA-53");
    expect(parseIdentifier("dra-53")).toBe("DRA-53");
    // Trailing punctuation stops the scan rather than failing it.
    expect(parseIdentifier("DRA-53),")).toBe("DRA-53");
  });

  it("refuses everything that is not one", () => {
    expect(parseIdentifier("fff")).toBeNull();
    expect(parseIdentifier("53")).toBeNull();
    expect(parseIdentifier("1-2")).toBeNull();
    expect(parseIdentifier("DRA-")).toBeNull();
  });
});

describe("issueUrl", () => {
  it("finds where a tag points", () => {
    const issues = [ref("DRA-53", "One"), ref("DRA-9", "Two")];

    expect(issueUrl(issues, "DRA-9")).toBe("https://linear.app/x/issue/DRA-9");
  });

  /// A tag whose issue never resolved — the tracker was unreachable when the
  /// prompt was sent — stays plain text rather than becoming a dead link.
  it("is null for a tag nothing was linked for", () => {
    expect(issueUrl([], "DRA-53")).toBeNull();
    expect(issueUrl([ref("DRA-53", "One")], "DRA-9")).toBeNull();
  });
});

const issue = (identifier: string, kind: IssueStateKind): Issue => ({
  tracker: "linear",
  id: `uuid-${identifier}`,
  identifier,
  title: identifier,
  url: `https://linear.app/x/issue/${identifier}`,
  state: { name: "Whatever this team calls it", kind, color: "#000" },
  priority: "none",
  assignee: null,
  labels: [],
  team: "DRA",
  project: null,
  updatedAt: "2026-08-27T00:00:00Z",
});

describe("groupIssues", () => {
  /// Started first and settled last, whatever order the list arrived in — the
  /// order work moves through, which is the order attention should reach it in.
  it("buckets by state kind, in the page's own order", () => {
    const groups = groupIssues([
      issue("DRA-1", "completed"),
      issue("DRA-2", "started"),
      issue("DRA-3", "backlog"),
      issue("DRA-4", "started"),
    ]);

    expect(groups.map((g) => g.label)).toEqual(["In Progress", "Backlog", "Done"]);
    expect(groups[0].issues.map((i) => i.identifier)).toEqual(["DRA-2", "DRA-4"]);
  });

  /// Grouping on the *kind*, not the name: a name is per-team prose, so a list
  /// spanning three teams would otherwise draw a dozen headings for what are
  /// really the same few states.
  it("gathers teams that name one state differently", () => {
    const a = issue("DRA-1", "started");
    const b = { ...issue("OPS-1", "started"), state: { name: "Shipping", kind: "started" as const, color: "#000" } };

    expect(groupIssues([a, b])).toHaveLength(1);
  });

  it("drops empty buckets", () => {
    expect(groupIssues([])).toEqual([]);
  });
});
