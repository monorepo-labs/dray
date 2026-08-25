import { beforeEach, describe, expect, it } from "vitest";

import {
  ANSWERED_BY_OPENING,
  dismissNotice,
  getNotices,
  noticeKey,
  pushNotice,
  type Notice,
} from "./useNotices";

const notice = (sessionId: string, kind: Notice["kind"]): Notice => ({
  sessionId,
  kind,
  label: kind,
});

const keys = () => getNotices().map(noticeKey);

describe("the notice stack", () => {
  // Module state, so each test drains what the last one left.
  beforeEach(() => {
    for (const { sessionId } of [...getNotices()]) dismissNotice(sessionId);
  });

  // The store used to key on the session alone, on the grounds that a session
  // could not both be blocked on a question and have finished its turn. A pull
  // request turning ready is neither of those and broke it: CI reports on its
  // own schedule, so one card replaced the other and dropped a signal that had
  // nothing else to carry it.
  it("holds one card per session and kind, not one per session", () => {
    pushNotice(notice("a", "asking"));
    pushNotice(notice("a", "pr"));
    expect(keys()).toEqual(["a:asking", "a:pr"]);
  });

  it("still replaces a card with one of the same kind", () => {
    pushNotice(notice("a", "pr"));
    pushNotice(notice("a", "pr"));
    expect(keys()).toEqual(["a:pr"]);
  });

  // Each card's countdown dismisses that card. Left keyed on the session, one
  // card's bar running out would take the other down with it.
  it("dismisses by kind without touching the session's other card", () => {
    pushNotice(notice("a", "completed"));
    pushNotice(notice("a", "pr"));

    dismissNotice("a", "completed");
    expect(keys()).toEqual(["a:pr"]);
  });

  it("dismisses every kind when none is named", () => {
    pushNotice(notice("a", "completed"));
    pushNotice(notice("a", "pr"));
    pushNotice(notice("b", "pr"));

    dismissNotice("a");
    expect(keys()).toEqual(["b:pr"]);
  });

  // Opening a session answers what the other three cards report. It does not
  // answer this one: the pull request is ready whether or not anyone is looking
  // at the session, and stays ready after they look away. Its own countdown is
  // what retires it.
  it("leaves the pull request card out of what opening a session answers", () => {
    pushNotice(notice("a", "completed"));
    pushNotice(notice("a", "asking"));
    pushNotice(notice("a", "pr"));

    dismissNotice("a", ANSWERED_BY_OPENING);
    expect(keys()).toEqual(["a:pr"]);
  });

  // The stack's array identity is what `useSyncExternalStore` subscribes on, so
  // a dismissal that found nothing must not mint a new one — see the early
  // return in `dismissNotice`.
  it("keeps its identity when a dismissal finds nothing", () => {
    pushNotice(notice("a", "pr"));
    const before = getNotices();

    dismissNotice("a", "completed");
    dismissNotice("b");
    expect(getNotices()).toBe(before);
  });
});
