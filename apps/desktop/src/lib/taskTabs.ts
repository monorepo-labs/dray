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
