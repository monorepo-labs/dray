import { describe, expect, it } from "vitest";

import { senderPrefix, stripSenderPrefix } from "@/lib/relay";

const from = { sessionId: "abc-123", title: "Fix the login redirect", machine: null };

describe("stripSenderPrefix", () => {
  it("takes off the line the backend put in front", () => {
    expect(stripSenderPrefix(`${senderPrefix(from)}review is done`, from)).toBe("review is done");
  });

  it("leaves a prompt the user typed alone", () => {
    expect(stripSenderPrefix("[not a prefix] just do it", null)).toBe("[not a prefix] just do it");
  });

  // A drifted prefix must cost the reader one extra line, never a swallowed
  // sentence — which is the whole reason this rebuilds rather than parses.
  it("leaves text alone when the prefix names another session", () => {
    const other = `${senderPrefix({ sessionId: "def-456", title: "Something else", machine: null })}hello`;
    expect(stripSenderPrefix(other, from)).toBe(other);
  });

  it("survives a title holding brackets and quotes", () => {
    const odd = { sessionId: "xyz-789", title: 'Fix [the "thing"] (again)', machine: null };
    expect(stripSenderPrefix(`${senderPrefix(odd)}done`, odd)).toBe("done");
  });

  // Pinned against the string `attribute` builds in orchestration.rs.
  it("takes off the line naming a sender on another machine", () => {
    const remote = { sessionId: "abc-123", title: "Fan out", machine: "Yogesh's Mac" };
    const text = `[message from the Dray session "Fan out" (abc-123) on Yogesh's Mac, which this machine cannot message back]\n\ngo`;
    expect(stripSenderPrefix(text, remote)).toBe("go");
  });

  it("keeps a blank line the sender wrote after their own", () => {
    expect(stripSenderPrefix(`${senderPrefix(from)}\nreview is done`, from)).toBe(
      "\nreview is done",
    );
  });
});
