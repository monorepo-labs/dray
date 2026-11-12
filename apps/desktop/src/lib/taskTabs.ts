/// A task open as a tab in its bot's row. The title is kept from when it was
/// opened, since a settled task leaves the active index and would otherwise
/// lose its name.
export type TaskTab = { sessionId: string; title: string };

/// Each bot's open task tabs, keyed by the bot's id, in the order they were
/// opened. The bot's id rather than its chat's session, since switching agent
/// starts a new session and the tabs must stay. In memory: a restart closes
/// them, the bargain the rest of the titlebar row makes.
export type TaskTabs = Record<string, TaskTab[]>;

/// Adds `tab` to `bot`'s row, or leaves the row alone where it is open.
export function openTaskTab(tabs: TaskTabs, bot: string, tab: TaskTab): TaskTabs {
  const row = tabs[bot] ?? [];
  if (row.some((t) => t.sessionId === tab.sessionId)) return tabs;
  return { ...tabs, [bot]: [...row, tab] };
}

/// Takes `sessionId` out of every row, which is also what a deleted task needs.
export function closeTaskTab(tabs: TaskTabs, sessionId: string): TaskTabs {
  let changed = false;
  const next: TaskTabs = {};
  for (const [bot, row] of Object.entries(tabs)) {
    const kept = row.filter((t) => t.sessionId !== sessionId);
    if (kept.length !== row.length) changed = true;
    if (kept.length > 0) next[bot] = kept;
  }
  return changed ? next : tabs;
}

/// The bot whose row holds `sessionId` as a task tab, where it was last
/// stepped into through that row (`via`); ⌘-click clears `via`, so a task
/// reached that way draws its own row.
export function rowBotOf(tabs: TaskTabs, sessionId: string, via: string | null): string | null {
  return via && tabs[via]?.some((t) => t.sessionId === sessionId) ? via : null;
}

/// Whose row the screen draws: the selected bot chat's own, or — with one of
/// its tasks picked from that row — still the bot's, the task lit in it.
/// `bot` is the row's key; `owner` the bot's current chat session, which
/// `chatOf` names, since that is what the row's chat tab shows.
export function stripOf(
  tabs: TaskTabs,
  selected: string | null,
  selectedBot: string | null,
  via: string | null,
  chatOf: (bot: string) => string | undefined,
): { bot: string; owner: string; lit: string | null } | null {
  if (!selected) return null;
  if (selectedBot) return { bot: selectedBot, owner: selected, lit: null };
  const bot = rowBotOf(tabs, selected, via);
  const owner = bot && chatOf(bot);
  return bot && owner ? { bot, owner, lit: selected } : null;
}

/// A Diff or Files tab in a bot's row, showing whichever session the reader
/// picked in its side column (#892). `target` is a task, or for Files the bot
/// chat itself, whose folder holds its instructions and memory.
export type PickTab = { id: string; kind: "changes" | "files"; target: string };

/// Each bot chat's pick tabs, keyed like `TaskTabs`. In memory, the same bargain.
export type PickTabs = Record<string, PickTab[]>;

export function addPickTab(tabs: PickTabs, owner: string, tab: PickTab): PickTabs {
  return { ...tabs, [owner]: [...(tabs[owner] ?? []), tab] };
}

export function closePickTab(tabs: PickTabs, owner: string, id: string): PickTabs {
  const kept = (tabs[owner] ?? []).filter((t) => t.id !== id);
  const next = { ...tabs, [owner]: kept };
  if (kept.length === 0) delete next[owner];
  return next;
}

export function repickTab(tabs: PickTabs, owner: string, id: string, target: string): PickTabs {
  return { ...tabs, [owner]: (tabs[owner] ?? []).map((t) => (t.id === id ? { ...t, target } : t)) };
}

/// Closes the tabs showing `target`, every kind or only `kind`: a deleted
/// task or worktree leaves nothing to show, a settled task no files to open.
export function closePicksOn(tabs: PickTabs, target: string, kind?: PickTab["kind"]): PickTabs {
  let changed = false;
  const next: PickTabs = {};
  for (const [owner, row] of Object.entries(tabs)) {
    const kept = row.filter((t) => t.target !== target || (!!kind && t.kind !== kind));
    if (kept.length !== row.length) changed = true;
    if (kept.length > 0) next[owner] = kept;
  }
  return changed ? next : tabs;
}

/// The open-files store a Files pick reads. Per tab *and* target, so each tab
/// keeps its own files and picking another task brings that task's set up.
export function pickFilesKey(tab: PickTab): string {
  return `pick:${tab.id}:${tab.target}`;
}

/// The session whose last turn started or ended most recently.
export function newestSession(items: readonly { sessionId: string; modified: string }[]): string | null {
  let best: { sessionId: string; at: number } | null = null;
  for (const item of items) {
    const at = Date.parse(item.modified);
    if (!best || at > best.at) best = { sessionId: item.sessionId, at };
  }
  return best?.sessionId ?? null;
}
