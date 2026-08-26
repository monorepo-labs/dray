import { describe, expect, it } from "vitest";

import { senderPrefix, stripSenderPrefix } from "@/lib/relay";

const from = { sessionId: "abc-123", title: "Fix the login redirect" };

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
    const other = `${senderPrefix({ sessionId: "def-456", title: "Something else" })}hello`;
    expect(stripSenderPrefix(other, from)).toBe(other);
  });

  it("survives a title holding brackets and quotes", () => {
    const odd = { sessionId: "xyz-789", title: 'Fix [the "thing"] (again)' };
    expect(stripSenderPrefix(`${senderPrefix(odd)}done`, odd)).toBe("done");
  });

  it("keeps a blank line the sender wrote after their own", () => {
    expect(stripSenderPrefix(`${senderPrefix(from)}\nreview is done`, from)).toBe(
      "\nreview is done",
    );
  });
});
