import { useSyncExternalStore } from "react";

import { readLocalStorage, writeLocalStorage } from "@/hooks/useLocalStorage";
import { channel } from "@/lib/channel";
import { accountReady, cloudAccountNow, refreshCloudAccount, subscribeCloudAccount } from "@/lib/cloudAccount";
import { projectKey } from "@/lib/projectGroups";
import { cloudServer, subscribeServers } from "@/lib/servers";
import { invoke, listen, LOCAL, serverOfPath, type ServerId } from "@/lib/transport";
import type { CloudInfo, Project } from "@/types/events";

/// Dray Cloud (#857): hosted machines, each a server marked `cloud`, one per
/// task. A new task on Cloud starts its own and clones its repo there.

/// Cloud offered to any reader with a Dray account, set up through
/// `CloudSetup` (#1021). Dev builds only until billing, per-user machines and
/// the GitHub App are live; a release offers Cloud on a key alone, as before.
export const CLOUD_SIGNUP = import.meta.env.DEV;

const FOCUS_GAP_MS = 30_000;

let info: CloudInfo = { on: false, keyed: false, error: null };
let started = false;
const changed = channel<void>();

function start() {
  if (started) return;
  started = true;
  if (CLOUD_SIGNUP) {
    void refreshCloudAccount();
    // A plan lapsing or a sign-out happens in the browser and says nothing
    // here, so coming back to the window is when the pick is rechecked.
    window.addEventListener("focus", () => void refreshCloudAccount(FOCUS_GAP_MS));
  }
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
  const offAccount = subscribeCloudAccount(listener);
  return () => {
    off();
    offServers();
    offAccount();
  };
}

export function useCloud(): CloudInfo {
  return useSyncExternalStore(subscribe, () => info);
}

/// On and keyed: the operator's way in, which needs no setup.
export const cloudReady = (cloud: CloudInfo = info): boolean => cloud.on && cloud.keyed;

/// Whether the composer offers Cloud at all. Without a key it is the way into
/// setup, so it shows before anything is set up.
export const cloudOffered = (cloud: CloudInfo = info): boolean => cloudReady(cloud) || CLOUD_SIGNUP;

/// Whether a task in the repo `slug` can start on Cloud now: keyed, or every
/// setup step done for that repo.
export const cloudUsable = (slug: string | null, cloud: CloudInfo = info): boolean =>
  cloudReady(cloud) || (CLOUD_SIGNUP && accountReady(cloudAccountNow(), slug));

export { cloudServer as isCloud } from "@/lib/servers";

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
  const slug = githubSlug(project?.remote);
  if (!project || !slug || !cloudUsable(slug)) return false;
  return cloudPicked(projectKey(project)) || cloudServer(serverOfPath(project.path));
}

export type PlaceStep = "starting" | "cloning";

/// What placement reaches, apart so a test can stand in for the machine.
export type PlaceIo = {
  start: () => Promise<ServerId>;
  clone: (server: ServerId, slug: string) => Promise<Project[]>;
  drop: (server: ServerId) => Promise<void>;
};

export type Placed = {
  server: ServerId;
  path: string;
  /// The machine's project list after the clone, to merge into the sidebar's.
  cloned: Project[];
};

/// A cloud step that failed, worded for the reader: what the task shows, with
/// Retry beside it, in place of a send error.
export class CloudError extends Error {}

const reason = (e: unknown) => (e instanceof Error ? e.message : String(e));

/// Starts a machine of its own for a new task in the project whose remote is
/// `remote`, and clones the repo there. A machine whose clone failed is
/// deleted, so a retry starts clean and nothing is left running for nothing.
export async function placeTask(
  remote: string,
  io: PlaceIo,
  onStep: (step: PlaceStep) => void = () => {},
): Promise<Placed> {
  const slug = githubSlug(remote);
  if (!slug) throw new CloudError("Cloud runs projects with a GitHub remote.");
  onStep("starting");
  let server: ServerId;
  try {
    server = await io.start();
  } catch (e) {
    throw new CloudError(`Couldn't start a cloud machine: ${reason(e)}`);
  }
  onStep("cloning");
  try {
    const cloned = await io.clone(server, slug);
    const project =
      cloned.find((p) => p.remote === remote) ??
      cloned.find((p) => p.path.endsWith(`/${slug.split("/")[1]}`));
    if (!project) throw new Error("the machine didn't list it afterwards");
    return { server, path: project.path, cloned };
  } catch (e) {
    void io.drop(server).catch(() => {});
    throw new CloudError(`Couldn't clone ${slug} onto its cloud machine: ${reason(e)}`);
  }
}

export const cloudIo: PlaceIo = {
  start: () => invoke<string>("start_cloud_machine", {}, LOCAL),
  clone: (server, slug) => invoke<Project[]>("clone_github_repo", { slug }, server),
  drop: (server) => invoke<void>("drop_cloud_machine", { id: server }, LOCAL),
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

/// The last cloud step that failed, and for which task: `null` for a new one.
export type CloudFailure = { sessionId: string | null; message: string };
let failure: CloudFailure | null = null;

export function setCloudFailure(next: CloudFailure | null) {
  if (failure === next) return;
  failure = next;
  changed.emit();
}

export function useCloudFailure(): CloudFailure | null {
  return useSyncExternalStore(subscribe, () => failure);
}
