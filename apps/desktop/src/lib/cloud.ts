import { useSyncExternalStore } from "react";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { channel } from "@/lib/channel";
import { projectKey } from "@/lib/projectGroups";
import { remoteServers, subscribeServers } from "@/lib/servers";
import { invoke, listen, LOCAL, serverOfPath, type ServerId } from "@/lib/transport";
import type { CloudInfo, Project } from "@/types/events";

/// Dray Cloud (#857): hosted machines, each a server marked `cloud`, and a new
/// task placed on whichever has room. Placement lives here for now and moves
/// to the control plane once a second client needs it.

let info: CloudInfo = { on: false, keyed: false, error: null };
let started = false;
const changed = channel<void>();

function start() {
  if (started) return;
  started = true;
  let heard = false;
  void listen<CloudInfo>("cloud_changed", ({ payload, server }) => {
    if (server !== LOCAL) return;
    heard = true;
    info = payload;
    changed.emit();
  }).then(() =>
    invoke<CloudInfo>("cloud_info", {}, LOCAL)
      .then((now) => {
        if (heard) return;
        info = now;
        changed.emit();
      })
      .catch(() => {}),
  );
}

function subscribe(listener: () => void): () => void {
  start();
  const off = changed.subscribe(listener);
  const offServers = subscribeServers(listener);
  return () => {
    off();
    offServers();
  };
}

export function useCloud(): CloudInfo {
  return useSyncExternalStore(subscribe, () => info);
}

/// On and keyed: the only state in which Cloud is offered as a place to run.
export const cloudReady = (cloud: CloudInfo = info): boolean => cloud.on && cloud.keyed;

export const isCloud = (id: ServerId): boolean => remoteServers().some((s) => s.id === id && s.cloud);

/// The `owner/repo` a project's remote names on GitHub, which is what a cloud
/// machine clones. Any other remote has nothing to clone from there.
export function githubSlug(remote: string | null | undefined): string | null {
  return remote?.match(/^github\.com\/([^/]+\/[^/]+)$/)?.[1] ?? null;
}

/// Which projects send new tasks to Cloud, by project key. Kept apart from the
/// checkout pick, since Cloud is no one checkout until a task is placed.
const PICKS = "ade.cloudPicks";
let picks: string[] = readLocalStorage<string[]>(PICKS, []);

export function cloudPicked(key: string): boolean {
  return picks.includes(key);
}

/// Its own hook: a pick changes nothing `useCloud` returns, so that snapshot
/// would never redraw a selector for one.
export function useCloudPicks(): string[] {
  return useSyncExternalStore(subscribe, () => picks);
}

export function setCloudPick(key: string, on: boolean) {
  if (cloudPicked(key) === on) return;
  picks = on ? [...picks, key] : picks.filter((k) => k !== key);
  writeLocalStorage(PICKS, picks);
  changed.emit();
}

/// Whether a new task in `path`'s project goes to Cloud: picked, or a checkout
/// already on a cloud machine, since every one of those reads as Cloud.
export function onCloud(projects: Project[], path: string | null): boolean {
  const project = path ? projects.find((p) => p.path === path) : undefined;
  if (!project || !cloudReady() || !githubSlug(project.remote)) return false;
  return cloudPicked(projectKey(project)) || isCloud(serverOfPath(project.path));
}

/// `dray-serve`'s `machine_load`.
export type MachineLoad = { turns: number; memAvailableMb: number };

export const MAX_TURNS = 3;
/// Memory, not CPU, is what kills a box (#708).
export const MIN_MEM_MB = 1500;

export const hasRoom = (load: MachineLoad | null): boolean =>
  !!load && load.turns < MAX_TURNS && load.memAvailableMb >= MIN_MEM_MB;

/// One connected cloud machine as placement sees it. `load` is `null` where it
/// did not answer, which is never room.
export type Candidate = { server: ServerId; load: MachineLoad | null; checkout: string | null };

/// Where a new task goes: a machine with room, one already holding the
/// checkout first, then the least busy. `null` is no room anywhere.
export function place(candidates: Candidate[]): Candidate | null {
  const roomy = candidates.filter((c) => hasRoom(c.load));
  roomy.sort(
    (a, b) =>
      Number(!!b.checkout) - Number(!!a.checkout) ||
      a.load!.turns - b.load!.turns ||
      b.load!.memAvailableMb - a.load!.memAvailableMb,
  );
  return roomy[0] ?? null;
}

export type PlaceStep = "finding" | "starting" | "cloning";

/// What placement reaches, apart so a test can stand in for every machine.
export type PlaceIo = {
  machines: () => ServerId[];
  load: (server: ServerId) => Promise<MachineLoad | null>;
  addRoom: () => Promise<ServerId>;
  clone: (server: ServerId, slug: string) => Promise<Project[]>;
};

export type Placed = {
  server: ServerId;
  path: string;
  /// The machine's project list after a clone, to merge into the sidebar's.
  cloned: Project[] | null;
};

/// Places a new task for the project whose remote is `remote`: asks each
/// connected cloud machine its load, takes the best with room, adds room
/// through the control plane where none has any, and clones there unless the
/// checkout is already on it.
export async function placeTask(
  projects: Project[],
  remote: string,
  io: PlaceIo,
  onStep: (step: PlaceStep) => void = () => {},
): Promise<Placed> {
  const slug = githubSlug(remote);
  if (!slug) throw new Error("Cloud runs projects with a GitHub remote.");
  const checkoutOn = (server: ServerId) =>
    projects.find((p) => p.remote === remote && serverOfPath(p.path) === server)?.path ?? null;

  onStep("finding");
  const servers = io.machines();
  const loads = await Promise.all(servers.map((s) => io.load(s).catch(() => null)));
  const pick = place(servers.map((server, i) => ({ server, load: loads[i], checkout: checkoutOn(server) })));

  let server = pick?.server;
  if (!server) {
    onStep("starting");
    server = await io.addRoom();
  }
  const there = pick?.checkout ?? checkoutOn(server);
  if (there) return { server, path: there, cloned: null };

  onStep("cloning");
  const cloned = await io.clone(server, slug);
  const project =
    cloned.find((p) => p.remote === remote) ??
    cloned.find((p) => p.path.endsWith(`/${slug.split("/")[1]}`));
  if (!project) throw new Error(`Cloned ${slug}, but the machine didn't list it.`);
  return { server, path: project.path, cloned };
}

/// How long a machine has to answer its load before it counts as full.
const LOAD_WAIT_MS = 5000;

export const cloudIo: PlaceIo = {
  machines: () => remoteServers().filter((s) => s.cloud && s.status === "connected").map((s) => s.id),
  load: (server) =>
    Promise.race([
      invoke<MachineLoad>("machine_load", {}, server),
      new Promise<null>((resolve) => setTimeout(() => resolve(null), LOAD_WAIT_MS)),
    ]),
  addRoom: () => invoke<string>("add_cloud_room", {}, LOCAL),
  clone: (server, slug) => invoke<Project[]>("clone_github_repo", { slug }, server),
};

/// Where a placement is, for the composer's notice. `null` while none runs.
let placing: PlaceStep | null = null;

export function setPlacing(step: PlaceStep | null) {
  placing = step;
  changed.emit();
}

export function usePlacing(): PlaceStep | null {
  return useSyncExternalStore(subscribe, () => placing);
}
