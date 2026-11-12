/// A task open as a tab in its bot's row. The title is kept from when it was
/// opened, since a settled task leaves the active index and would otherwise
/// lose its name.
export type TaskTab = { sessionId: string; title: string };

/// Each bot chat's open task tabs, keyed by the chat's session id, in the
/// order they were opened. In memory: a restart closes them, the bargain the
/// rest of the titlebar row makes.
export type TaskTabs = Record<string, TaskTab[]>;

/// Adds `tab` to `owner`'s row, or leaves the row alone where it is open.
export function openTaskTab(tabs: TaskTabs, owner: string, tab: TaskTab): TaskTabs {
  const row = tabs[owner] ?? [];
  if (row.some((t) => t.sessionId === tab.sessionId)) return tabs;
  return { ...tabs, [owner]: [...row, tab] };
}

/// Takes `sessionId` out of every row, which is also what a deleted task needs.
export function closeTaskTab(tabs: TaskTabs, sessionId: string): TaskTabs {
  let changed = false;
  const next: TaskTabs = {};
  for (const [owner, row] of Object.entries(tabs)) {
    const kept = row.filter((t) => t.sessionId !== sessionId);
    if (kept.length !== row.length) changed = true;
    if (kept.length > 0) next[owner] = kept;
  }
  return changed ? next : tabs;
}

/// Whose row the screen draws: the selected bot chat's own, or — with one of
/// its tasks picked from that row — still the bot's, the task lit in it.
/// `via` is the bot chat the reader last stepped into a task tab from; a task
/// reached any other way draws its own row, so ⌘-click and the breadcrumb
/// keep today's single-session view.
export function stripOf(
  tabs: TaskTabs,
  selected: string | null,
  selectedIsBot: boolean,
  via: string | null,
): { owner: string; lit: string | null } | null {
  if (!selected) return null;
  if (selectedIsBot) return { owner: selected, lit: null };
  if (via && tabs[via]?.some((t) => t.sessionId === selected)) return { owner: via, lit: selected };
  return null;
}
