import { describe, expect, it } from "vitest";

import { isDirty, withDiskText, type Doc, type DocBody } from "./useDocs";

const ready = (base: string, draft = base, rest: Partial<DocBody> = {}) =>
  ({
    status: "ready",
    base,
    draft,
    stale: false,
    saving: false,
    saveError: null,
    ...rest,
  }) as Extract<DocBody, { status: "ready" }>;

const doc = (body: DocBody): Doc => ({ path: "/a/README.md", mode: "view", body });

describe("isDirty", () => {
  it("is the draft against what it was made from, and nothing else", () => {
    expect(isDirty(doc(ready("hi")))).toBe(false);
    expect(isDirty(doc(ready("hi", "hi there")))).toBe(true);
  });

  // A doc edited back to what it said is not something to warn about closing,
  // which is the whole reason this is read off the text rather than latched by
  // the first keystroke.
  it("goes clean again where the reader types the file back", () => {
    expect(isDirty(doc(ready("hi", "hi")))).toBe(false);
  });

  it("says no before the text has arrived, and where it never will", () => {
    expect(isDirty(doc({ status: "loading" }))).toBe(false);
    expect(isDirty(doc({ status: "error", message: "not a regular file" }))).toBe(false);
  });
});

describe("withDiskText", () => {
  it("takes the file where the reader has changed nothing", () => {
    const next = withDiskText(ready("old"), "new");
    expect(next.base).toBe("new");
    expect(next.draft).toBe("new");
    expect(next.stale).toBe(false);
  });

  it("keeps the draft and flags it where both sides moved", () => {
    const next = withDiskText(ready("old", "mine"), "theirs");
    expect(next.draft).toBe("mine");
    expect(next.stale).toBe(true);
  });

  // `base` is what the next save sends as `expect`. Moving it to the disk text
  // would make the backend's compare-and-swap pass and quietly overwrite the
  // write that caused the flag in the first place.
  it("leaves base alone on the stale branch, so the next save still refuses", () => {
    expect(withDiskText(ready("old", "mine"), "theirs").base).toBe("old");
  });

  it("is no news where the file says what it said", () => {
    const before = ready("old", "mine");
    expect(withDiskText(before, "old")).toBe(before);
  });

  // A doc already flagged and then reloaded elsewhere must not clear its own
  // warning by adopting: the draft is still unsaved.
  it("keeps a standing flag while the draft is still dirty", () => {
    expect(withDiskText(ready("old", "mine", { stale: true }), "later").stale).toBe(true);
  });

  it("clears the flag once the draft matches base again", () => {
    const next = withDiskText(ready("old", "old", { stale: true }), "theirs");
    expect(next.stale).toBe(false);
    expect(next.draft).toBe("theirs");
  });
});
