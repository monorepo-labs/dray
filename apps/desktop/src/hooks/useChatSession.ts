import { createContext, useContext } from "react";

/// Which session the transcript on screen belongs to, and where it runs.
///
/// A context rather than props, because both consumers are leaves — a
/// `@mention` and a file link, four components below `Chat`, with three in
/// between that would carry values they never read. It is the same bargain
/// `WorkerPoolContext` makes: ambient, session-scoped, and wanted at the bottom.
///
/// `cwd` is what a path relative to the session resolves against. `sessionId` is
/// which session a doc opened from here belongs to — the docs store keys by it,
/// and reading it from the transcript that drew the link is the only way a leaf
/// can know without being told twice.
///
/// Both `null` is the resting state, not an error. A message can be drawn with
/// no session behind it, and a mention there stays inert rather than resolving
/// against wherever the app happens to be running.
export const ChatSessionContext = createContext<{
  cwd: string | null;
  sessionId: string | null;
}>({ cwd: null, sessionId: null });

export function useChatSession() {
  return useContext(ChatSessionContext);
}
