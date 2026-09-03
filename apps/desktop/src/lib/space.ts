import type { Project } from "@/types/events";

/// Where the active space is stored. Read outside React by `announce`, which
/// fires from a listener registered once and so cannot hold hook state.
export const SPACE_KEY = "ade.space";

/// Where spaces nobody has filled yet are stored.
///
/// Membership is a tag on the project and needs no list — but a space is made
/// *before* it holds anything, and a space with no project has nowhere to live
/// in `projects.json`. So a made space is declared here and existence is the
/// union of the two: the reader's own list, plus every name a project carries.
/// A tag whose name was never declared still counts, which is what keeps a
/// project filed on another machine from reading as filed nowhere.
export const SPACE_LIST_KEY = "ade.spaces";

/// Every space there is, in the order the switcher walks them.
///
/// The declared list **is** the order — it is what the reader arranges — so it
/// leads as written. A name carried only by a project's tag is one filed on
/// another machine, with no place in this reader's arrangement yet, so those
/// follow sorted: alphabetical is arbitrary but stable, where the order
/// projects happen to be attached in would move the switcher under the reader
/// every time one did.
export function spaceNames(projects: Project[], declared: string[] = []): string[] {
  const tagged = projects
    .map((p) => p.space)
    .filter((s): s is string => Boolean(s));

  const undeclared = [...new Set(tagged)]
    .filter((s) => !declared.includes(s))
    .sort((a, b) => a.localeCompare(b));

  return [...new Set([...declared, ...undeclared])];
}

/// The list with one name stepped `delta` places.
///
/// A step off either end is the list unchanged rather than a wrap: the buttons
/// are disabled there, so a move that arrives anyway is a mistake to absorb and
/// not a request to send the space to the other end.
export function moveSpace(names: string[], name: string, delta: number): string[] {
  const from = names.indexOf(name);
  const to = from + delta;
  if (from === -1 || to < 0 || to >= names.length) return names;

  const next = [...names];
  next.splice(to, 0, ...next.splice(from, 1));
  return next;
}

/// The space actually in force. A stored name that has since been removed falls
/// back to every project — the same answer the project filter gives for a
/// project that was detached, and the only honest one, since the alternative is
/// a switcher naming a space that no longer exists over an empty list.
export function activeSpace(
  projects: Project[],
  stored: string | null,
  declared: string[] = [],
): string | null {
  return stored && spaceNames(projects, declared).includes(stored) ? stored : null;
}

/// The projects a space holds. `null` is every project, which is the shape the
/// app has before anybody makes a space and the one it returns to when the last
/// one goes. A space just made holds nothing, and that is an ordinary state.
export function inSpace(projects: Project[], space: string | null): Project[] {
  return space === null ? projects : projects.filter((p) => p.space === space);
}

/// Whether a session belongs to what the reader is looking at. The sidebar, the
/// session chords and the notifications all ask this one question, so a session
/// hidden from the list is also one that stays quiet.
///
/// A session under a project nobody has attached has no space to be in, so it
/// shows under every project and under no space — the same reading `inSpace`
/// gives its project.
export function sessionInSpace(
  projects: Project[],
  space: string | null,
  projectPath: string,
): boolean {
  return (
    space === null ||
    projects.some((p) => p.path === projectPath && p.space === space)
  );
}

/// Whether a session may be *announced* under the active space, given whatever
/// is known about where it ran.
///
/// Unknown fails **closed** while a space is up, and that asymmetry is the
/// point: the session index holds one side of the archived split at a time and
/// a new session's entry lands after its first events, so "no project found" is
/// never "not filed elsewhere". A notice or banner names the session out loud,
/// which is the thing a chosen space is asking not to see. Cost: a settled
/// session in the *active* space stays quiet while the reader is on the live
/// list.
///
/// Not the rule for what stays on *screen* — closing a transcript already drawn
/// on a guess is worse than drawing it a moment longer.
export function allowedInSpace(
  projects: Project[],
  space: string | null,
  projectPath: string | null | undefined,
): boolean {
  if (space === null) return true;
  return Boolean(projectPath) && sessionInSpace(projects, space, projectPath as string);
}

/// A path as the settings list draws it. The leading slash is the one segment
/// every absolute path on this machine shares, so it separates nothing and only
/// costs the rest of the path a character of width.
export function displayPath(path: string): string {
  return path.replace(/^\//, "");
}
