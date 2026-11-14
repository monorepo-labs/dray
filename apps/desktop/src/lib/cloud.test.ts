import { describe, expect, it, vi } from "vitest";

vi.mock("@tauri-apps/api/core", () => ({ invoke: async () => null, convertFileSrc: (p: string) => p }));
vi.mock("@tauri-apps/api/event", () => ({ listen: async () => () => {} }));

const { githubSlug, placeTask, CloudError } = await import("./cloud");
type Io = Parameters<typeof placeTask>[1];
import type { Project } from "@/types/events";

const REMOTE = "github.com/octocat/app";
const project = (path: string, remote: string | null = REMOTE): Project =>
  ({ path, name: "app", space: null, lastSelected: "", remote }) as Project;

function io(over: Partial<Io> = {}): Io & { started: number; repos: string[]; clones: string[]; dropped: string[] } {
  const out = {
    started: 0,
    repos: [] as string[],
    clones: [] as string[],
    dropped: [] as string[],
    start: async (slug: string): Promise<string> => {
      out.repos.push(slug);
      return `c${++out.started}`;
    },
    clone: async (server: string, slug: string) => {
      out.clones.push(`${server}:${slug}`);
      return [project(`dray://${server}/root/dray/app`)];
    },
    drop: async (server: string) => {
      out.dropped.push(server);
    },
    ...over,
  };
  return out;
}

describe("placeTask", () => {
  it("starts a machine of its own for every task and clones there", async () => {
    const machines = io();
    const steps: string[] = [];
    const first = await placeTask(REMOTE, machines, (s) => steps.push(s));
    const second = await placeTask(REMOTE, machines);
    expect(first).toMatchObject({ server: "c1", path: "dray://c1/root/dray/app" });
    expect(second.server).toBe("c2");
    expect(machines.clones).toEqual(["c1:octocat/app", "c2:octocat/app"]);
    // Each machine is made for its repo, which is what its GitHub token covers.
    expect(machines.repos).toEqual(["octocat/app", "octocat/app"]);
    expect(steps).toEqual(["starting", "cloning"]);
  });

  it("says plainly when no machine starts", async () => {
    const machines = io({ start: async () => Promise.reject("Couldn't reach Dray Cloud: connection refused") });
    const err = await placeTask(REMOTE, machines).catch((e) => e);
    expect(err).toBeInstanceOf(CloudError);
    expect(err.message).toBe("Couldn't start a cloud machine: Couldn't reach Dray Cloud: connection refused");
    expect(machines.clones).toEqual([]);
  });

  it("deletes the machine whose clone failed, and says why", async () => {
    const machines = io({ clone: async () => Promise.reject(new Error("repository not found")) });
    const err = await placeTask(REMOTE, machines).catch((e) => e);
    expect(err).toBeInstanceOf(CloudError);
    expect(err.message).toBe("Couldn't clone octocat/app onto its cloud machine: repository not found");
    expect(machines.dropped).toEqual(["c1"]);
  });

  it("refuses a project with no GitHub remote before starting anything", async () => {
    const machines = io();
    await expect(placeTask("gitlab.com/a/b", machines)).rejects.toThrow("GitHub remote");
    expect(machines.started).toBe(0);
  });
});

describe("githubSlug", () => {
  it("takes a GitHub remote alone", () => {
    expect(githubSlug("github.com/octocat/app")).toBe("octocat/app");
    expect(githubSlug("gitlab.com/octocat/app")).toBeNull();
    expect(githubSlug(null)).toBeNull();
  });
});
