import { afterEach, describe, expect, it } from "vitest";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";

/// These tests run in the node environment like every other one here, so there
/// is no `localStorage` to spy on — the store is stood up by hand, which also
/// makes "refuses the write" a one-line state rather than a mock.
function useStore(options: { refuse?: boolean } = {}) {
  const held = new Map<string, string>();

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => {
        if (options.refuse) throw new Error("QuotaExceededError");
        held.set(k, v);
      },
    },
  });

  return {
    held,
    accept: () => {
      options.refuse = false;
    },
  };
}

afterEach(() => {
  Reflect.deleteProperty(globalThis, "localStorage");
});

describe("readLocalStorage", () => {
  it("reads back what was written", () => {
    useStore();
    writeLocalStorage("read.ok", ["a", "b"]);

    expect(readLocalStorage<string[]>("read.ok", [])).toEqual(["a", "b"]);
  });

  it("answers the initial value for an absent or unparseable key", () => {
    const store = useStore();

    expect(readLocalStorage<string[]>("read.absent", [])).toEqual([]);

    store.held.set("read.garbage", "not json");
    expect(readLocalStorage<string[]>("read.garbage", [])).toEqual([]);
  });

  /// The failure path the write explicitly supports. It is best-effort and the
  /// hook keeps the value in React state either way, so "the preference just
  /// won't outlive the session" has to hold for this reader too — otherwise the
  /// model menu and Shift+Tab, which must cycle exactly what the menu draws,
  /// read two different star lists the moment one write is refused.
  it("answers a refused value, not the last one the store accepted", () => {
    const store = useStore();
    writeLocalStorage("read.refused", ["old"]);

    store.held.clear();
    useStore({ refuse: true });
    writeLocalStorage("read.refused", ["new"]);

    expect(readLocalStorage<string[]>("read.refused", [])).toEqual(["new"]);
  });

  /// And a write that lands has to retire the parked value, or the store stays
  /// shadowed by a stale copy for the rest of the session.
  it("stops answering the parked value once a write lands", () => {
    const store = useStore({ refuse: true });
    writeLocalStorage("read.recovered", ["parked"]);

    store.accept();
    writeLocalStorage("read.recovered", ["landed"]);

    expect(readLocalStorage<string[]>("read.recovered", [])).toEqual(["landed"]);
    expect(JSON.parse(store.held.get("read.recovered")!)).toEqual(["landed"]);
  });
});
