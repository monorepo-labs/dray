import { afterEach, describe, expect, it } from "vitest";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";

/// These tests run in the node environment like every other one here, so there
/// is no `localStorage` to spy on — the store is stood up by hand.
function useStore() {
  const held = new Map<string, string>();

  Object.defineProperty(globalThis, "localStorage", {
    configurable: true,
    value: {
      getItem: (k: string) => held.get(k) ?? null,
      setItem: (k: string, v: string) => held.set(k, v),
    },
  });

  return { held };
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
});
