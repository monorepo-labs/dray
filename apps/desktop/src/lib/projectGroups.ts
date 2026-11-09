import { serverConnected } from "@/lib/servers";
import { serverOfPath, type ServerId } from "@/lib/transport";
import type { Project } from "@/types/events";

/// One project as the reader thinks of it: every checkout of one repository,
/// whichever machines hold them. A repo with no shared remote, or on a server
/// too old to report one, is a project of one checkout, keyed on its path.
export type ProjectGroup = { key: string; name: string; checkouts: Project[] };

export const projectKey = (project: Project): string => project.remote ?? project.path;

/// Each group sits where its first checkout does, so the reader's order holds.
export function groupProjects(projects: Project[]): ProjectGroup[] {
  const groups = new Map<string, ProjectGroup>();
  for (const project of projects) {
    const key = projectKey(project);
    const group = groups.get(key);
    if (group) group.checkouts.push(project);
    else groups.set(key, { key, name: project.name, checkouts: [project] });
  }
  return [...groups.values()];
}

/// The key of whichever project `path` is a checkout of. A path nobody attached
/// is its own project, as it was before projects grouped.
export function keyOfPath(projects: Project[], path: string): string {
  const project = projects.find((p) => p.path === path);
  return project ? projectKey(project) : path;
}

/// Every checkout of the project `path` belongs to, which for a path nobody
/// attached is none.
export function checkoutsOf(projects: Project[], path: string): Project[] {
  const key = keyOfPath(projects, path);
  return projects.filter((p) => projectKey(p) === key);
}

/// The one path a project's runs and filter entry go under, so sessions from
/// several checkouts land together. It stays a real path, which is what a
/// heading's click and the stored filter both need.
export function leadPath(projects: Project[], path: string): string {
  return checkoutsOf(projects, path)[0]?.path ?? path;
}

/// The checkout a new task lands on: the newest pick still reachable, since one
/// on a dropped server could not send. With none reachable, the newest anyway.
export function lastUsedCheckout(
  checkouts: Project[],
  connected: (server: ServerId) => boolean = serverConnected,
): Project {
  const newest = (list: Project[]) =>
    list.reduce((best, p) => (p.lastSelected > best.lastSelected ? p : best));
  const reachable = checkouts.filter((p) => connected(serverOfPath(p.path)));
  return newest(reachable.length ? reachable : checkouts);
}

/// The checkout after `path` that could send, wrapping, so one key steps every
/// machine and comes back round. `null` where no other one is up to step to,
/// since a disconnected checkout is one the picker refuses too.
export function nextCheckout(
  checkouts: Project[],
  path: string,
  connected: (server: ServerId) => boolean = serverConnected,
): Project | null {
  const at = checkouts.findIndex((p) => p.path === path);
  for (let step = 1; step <= checkouts.length; step++) {
    const next = checkouts[(at + step) % checkouts.length];
    if (next.path !== path && connected(serverOfPath(next.path))) return next;
  }
  return null;
}

/// The one machine every checkout sits on, or `null` where they span several.
export function soleServer(checkouts: Project[]): ServerId | null {
  const servers = new Set(checkouts.map((p) => serverOfPath(p.path)));
  return servers.size === 1 ? serverOfPath(checkouts[0].path) : null;
}

/// A space is filed per checkout, so a copy attached after the filing has no
/// tag of its own. It takes the first tag among its siblings; its own wins.
export function inheritSpaces(projects: Project[]): Project[] {
  const spaces = new Map<string, string>();
  for (const project of projects) {
    if (project.space && !spaces.has(projectKey(project))) spaces.set(projectKey(project), project.space);
  }
  return projects.map((p) => (p.space ? p : { ...p, space: spaces.get(projectKey(p)) ?? null }));
}
