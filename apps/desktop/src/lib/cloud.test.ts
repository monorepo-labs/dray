import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null, convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const { githubSlug, hasRoom, place, placeTask } = await import("./cloud");
type Io = Parameters<typeof placeTask>[2];
import type { Project } from "@/types/events";

const REMOTE = "github.com/octocat/app";
const project = (path: string, remote: string | null = REMOTE): Project =>
  ({ path, name: "app", space: null, lastSelected: "", remote }) as Project;

/// Every machine named in `loads` connected, answering that load; `null` is a
/// machine whose `machine_load` failed.
function io(loads: Record<string, { turns: number; memAvailableMb: number } | null>, over: Partial<Io> = {}): Io & {
  added: number;
  clones: string[];
} {
  const out = {
    added: 0,
    clones: [] as string[],
    machines: () => Object.keys(loads),
    load: async (s: string) => {
      const load = loads[s];
      if (load === null) throw new Error("unknown command machine_load");
      return load;
    },
    addRoom: async () => {
      out.added++;
      return "c9";
    },
    clone: async (server: string, slug: string) => {
      out.clones.push(`${server}:${slug}`);
      return [project(`dray://${server}/root/dray/app`)];
    },
    ...over,
  };
  return out;
}

const idle = { turns: 0, memAvailableMb: 6000 };

describe("room", () => {
  it("is fewer than 3 turns and at least 1500 MB free", () => {
    expect(hasRoom({ turns: 2, memAvailableMb: 1500 })).toBe(true);
    expect(hasRoom({ turns: 3, memAvailableMb: 8000 })).toBe(false);
    expect(hasRoom({ turns: 0, memAvailableMb: 1499 })).toBe(false);
    expect(hasRoom(null)).toBe(false);
  });

  it("prefers a machine holding the checkout, then the least busy", () => {
    expect(
      place([
        { server: "a", load: idle, checkout: null },
        { server: "b", load: { turns: 2, memAvailableMb: 2000 }, checkout: "dray://b/app" },
      ])?.server,
    ).toBe("b");
    expect(
      place([
        { server: "a", load: { turns: 2, memAvailableMb: 9000 }, checkout: null },
        { server: "b", load: { turns: 1, memAvailableMb: 2000 }, checkout: null },
      ])?.server,
    ).toBe("b");
    expect(place([{ server: "a", load: { turns: 3, memAvailableMb: 9000 }, checkout: "x" }])).toBeNull();
  });
});

describe("placeTask", () => {
  it("lands on a machine with room that already has the checkout, cloning nothing", async () => {
    const fake = io({ c1: idle, c2: { turns: 1, memAvailableMb: 4000 } });
    const projects = [project("/Users/me/app"), project("dray://c2/root/dray/app")];
    expect(await placeTask(projects, REMOTE, fake)).toEqual({ server: "c2", path: "dray://c2/root/dray/app", cloned: null });
    expect(fake.added).toBe(0);
    expect(fake.clones).toEqual([]);
  });

  it("clones onto a machine with room when none holding it has any", async () => {
    const fake = io({ c1: idle, c2: { turns: 3, memAvailableMb: 4000 } });
    const placed = await placeTask([project("dray://c2/root/dray/app")], REMOTE, fake);
    expect(placed.server).toBe("c1");
    expect(placed.path).toBe("dray://c1/root/dray/app");
    expect(fake.clones).toEqual(["c1:octocat/app"]);
  });

  it("adds room where no machine has any, and a machine that cannot say its load has none", async () => {
    const steps: string[] = [];
    const fake = io({ c1: { turns: 0, memAvailableMb: 900 }, c2: null });
    const placed = await placeTask([], REMOTE, fake, (s) => steps.push(s));
    expect(fake.added).toBe(1);
    expect(placed).toMatchObject({ server: "c9", path: "dray://c9/root/dray/app" });
    expect(steps).toEqual(["finding", "starting", "cloning"]);
  });

  it("adds room with no machine at all, and skips the clone on a resumed one that has it", async () => {
    const fake = io({});
    const placed = await placeTask([project("dray://c9/root/dray/app")], REMOTE, fake);
    expect(fake.added).toBe(1);
    expect(fake.clones).toEqual([]);
    expect(placed.path).toBe("dray://c9/root/dray/app");
  });

  it("passes on the cap", async () => {
    const fake = io({}, { addRoom: () => Promise.reject(new Error("Dray Cloud is at its limit of 3 running machines.")) });
    await expect(placeTask([], REMOTE, fake)).rejects.toThrow("limit of 3");
  });

  it("only places a project with a GitHub remote", async () => {
    expect(githubSlug("github.com/octocat/app")).toBe("octocat/app");
    expect(githubSlug("gitlab.com/octocat/app")).toBeNull();
    await expect(placeTask([], "gitlab.com/x/y", io({ c1: idle }))).rejects.toThrow("GitHub");
  });
});
