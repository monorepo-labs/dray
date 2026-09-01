import { beforeEach, describe, expect, it } from "vitest";

import { appendToDraft, readDraft, writeDraft } from "@/hooks/useDraft";

const SESSION = "01931b3c-0000-7000-8000-000000000000";

describe("appendToDraft", () => {
  beforeEach(() => {
    writeDraft(SESSION, "");
    writeDraft(null, "");
  });

  it("starts a draft that does not exist yet", () => {
    appendToDraft(SESSION, "open the changes panel");

    expect(readDraft(SESSION)).toBe("open the changes panel");
  });

  /// The composer's own key for the new-task state, which a session UUID can
  /// never collide with. Dictating before picking a session must still land.
  it("writes to the new-task draft under the null key", () => {
    appendToDraft(null, "start a new session");

    expect(readDraft(null)).toBe("start a new session");
    expect(readDraft(SESSION)).toBe("");
  });

  /// Two dictations build one prompt rather than the second replacing the
  /// first, which is the whole reason this appends.
  it("joins a second dictation with one space", () => {
    appendToDraft(SESSION, "first sentence.");
    appendToDraft(SESSION, "second sentence.");

    expect(readDraft(SESSION)).toBe("first sentence. second sentence.");
  });

  /// Dictating after typing continues the sentence. Without the join the two
  /// words would run together into one.
  it("separates dictation from text already typed", () => {
    writeDraft(SESSION, "look at");
    appendToDraft(SESSION, "the parser");

    expect(readDraft(SESSION)).toBe("look at the parser");
  });

  /// A draft the reader left a trailing space on must not gain a second one,
  /// and a newline is whitespace too — dictating under a bullet should stay
  /// under it rather than being pushed onto the same line.
  it("adds no separator where the draft already ends in whitespace", () => {
    writeDraft(SESSION, "first line\n");
    appendToDraft(SESSION, "second line");

    expect(readDraft(SESSION)).toBe("first line\nsecond line");
  });

  /// The engine returns an empty string for silence, and a short press is
  /// refused outright in Rust. Neither should touch the draft.
  it("ignores empty and whitespace-only text", () => {
    writeDraft(SESSION, "kept");
    appendToDraft(SESSION, "");
    appendToDraft(SESSION, "   \n ");

    expect(readDraft(SESSION)).toBe("kept");
  });

  it("trims what the engine returns", () => {
    appendToDraft(SESSION, "  padded on both sides  ");

    expect(readDraft(SESSION)).toBe("padded on both sides");
  });

  /// Drafts are per session, so a recording started in one must not appear in
  /// another the reader switches to.
  it("keeps sessions apart", () => {
    const other = "01931b3c-1111-7000-8000-000000000000";

    appendToDraft(SESSION, "mine");
    appendToDraft(other, "theirs");

    expect(readDraft(SESSION)).toBe("mine");
    expect(readDraft(other)).toBe("theirs");

    writeDraft(other, "");
  });

  /// The shape `useRecorder` relies on: it pins the session at the moment
  /// recording starts and hands that back, so a transcript arriving after the
  /// reader has switched still lands where it was spoken. Writing to a session
  /// that is not on screen has to be an ordinary, silent success — the draft is
  /// simply there on the way back.
  it("writes to a session that is not the one on screen", () => {
    const spokenIn = "01931b3c-2222-7000-8000-000000000000";

    writeDraft(SESSION, "typed in the session now on screen");
    appendToDraft(spokenIn, "dictated before switching away");

    expect(readDraft(spokenIn)).toBe("dictated before switching away");
    expect(readDraft(SESSION)).toBe("typed in the session now on screen");

    writeDraft(spokenIn, "");
  });
});
