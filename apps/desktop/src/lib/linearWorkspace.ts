/// Which Linear workspace a project reads.
///
/// **Stated twice, and this is the second.** Rust's `pinned_workspace` decides
/// what a tag in a prompt resolves against; this decides what the issues page
/// opens on and what the composer's `#` picker lists. Neither can call the
/// other, so both are pinned by test and must not drift: a picker offering one
/// workspace's issues while the send resolves the tag in another is a wrong
/// link that reads exactly like a right one.
import type { IntegrationsView, Project, TrackerAccount } from "@/types/events";

/// Where a project's workspace came from, which the Settings row says out loud
/// so a reader can see why a project reads what it reads.
export type PinSource = "project" | "space" | "default";

export type ResolvedWorkspace = {
  /// `organization.id`, or `null` where nothing is connected or the default
  /// has not told Linear's id yet — `null` on the wire means the default.
  id: string | null;
  from: PinSource;
};

/// Every connected Linear workspace, the default first. Rust orders them.
export function linearWorkspaces(integrations: IntegrationsView | null): TrackerAccount[] {
  return integrations?.linear ?? [];
}

/// The project's own pin, else its Space's, else the default. A pin naming a
/// workspace that is no longer connected is skipped, so it falls through a
/// level rather than naming a workspace no key can read.
export function workspaceFor(
  project: Pick<Project, "space" | "linearWorkspace"> | null,
  spacePins: Record<string, string | undefined>,
  workspaces: TrackerAccount[],
): ResolvedWorkspace {
  const connected = (id: string | null | undefined): id is string =>
    !!id && workspaces.some((w) => w.workspaceId === id);

  const own = project?.linearWorkspace;
  if (connected(own)) return { id: own, from: "project" };

  const space = project?.space ? spacePins[project.space] : undefined;
  if (connected(space)) return { id: space, from: "space" };

  return { id: workspaces[0]?.workspaceId ?? null, from: "default" };
}

/// The attached project a path sits in: the longest project path it is under,
/// by path segment. Rust's `project_for_dir` is the other statement of this, and
/// they must agree — an exact match here found nothing for a session whose
/// recorded project is a folder inside an attached one (`dray new --project`),
/// so the picker listed the default while the send resolved in the pin.
export function projectForPath<P extends { path: string }>(
  projects: P[],
  path: string | null,
): P | null {
  if (!path) return null;

  const within = (root: string) =>
    path === root || path.startsWith(root.endsWith("/") ? root : `${root}/`);

  return projects
    .filter((project) => within(project.path))
    .reduce<P | null>(
      (best, project) => (!best || project.path.length > best.path.length ? project : best),
      null,
    );
}

/// A workspace's name for a menu, by id. Falls back to the id itself rather
/// than to nothing, so a stale pin still says *something* recognisable.
export function workspaceName(workspaces: TrackerAccount[], id: string | null): string {
  const found = id ? workspaces.find((w) => w.workspaceId === id) : workspaces[0];
  return found?.orgName || id || "Linear";
}
