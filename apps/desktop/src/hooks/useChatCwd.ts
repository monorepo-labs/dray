import { createContext, useContext } from "react";

/// Where the session on screen runs, for the parts of a message that name a
/// path relative to it.
///
/// A context rather than a prop, because the one consumer is a `@mention` four
/// components below `Chat` and three of those would carry a string they never
/// read. It is the same bargain `WorkerPoolContext` makes: ambient, session-
/// scoped, and wanted by a leaf.
///
/// `null` is the resting state, not an error. A message can be drawn with no
/// session behind it, and a mention there stays inert rather than resolving
/// against wherever the app happens to be running.
export const ChatCwdContext = createContext<string | null>(null);

export function useChatCwd() {
  return useContext(ChatCwdContext);
}
