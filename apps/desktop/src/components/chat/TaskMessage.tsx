import { useEffect, useMemo, useState } from "react";

import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui/button";
import { ChatSessionContext, useChatSession } from "@/hooks/useChatSession";
import { READ_TIMEOUT_MS } from "@/hooks/useStallLine";
import { readPreviews } from "@/lib/bots";

/// A read of a task's last message: running, failed — the task's server
/// errored or never answered — or done, with `null` for a task that has
/// written nothing.
type Read = { state: "reading" } | { state: "failed" } | { state: "done"; text: string | null };

/// A task's last message in full, read off the end of its own log — what a
/// "Waiting on you" row shows when picked, in place of scrolling the bot's chat
/// back to its reply, which could mean reading days of the chat's log.
///
/// Drawn in the task's own session context, not the bot chat's around it, so
/// a relative file link resolves in the task's checkout and a picture loads
/// from the task's machine. A file clicked open still lands in the bot chat's
/// panel, the one on screen.
export default function TaskMessage({ sessionId, cwd }: { sessionId: string; cwd: string | null }) {
  const [read, setRead] = useState<Read>({ state: "reading" });
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    setRead({ state: "reading" });
    // `readPreviews` drops a server that errors, so a missing entry is a failure.
    const done = readPreviews([sessionId]).then(
      (p): Read => (p[sessionId] ? { state: "done", text: p[sessionId].text } : { state: "failed" }),
    );
    const timeout = new Promise<Read>((settle) => setTimeout(() => settle({ state: "failed" }), READ_TIMEOUT_MS));
    Promise.race([done, timeout])
      .catch((): Read => ({ state: "failed" }))
      .then((r) => live && setRead(r));
    return () => {
      live = false;
    };
  }, [sessionId, tries]);
  const { sessionId: shown } = useChatSession();
  const context = useMemo(() => ({ cwd, sessionId, opensIn: shown }), [cwd, sessionId, shown]);

  if (read.state === "reading") {
    return (
      <div className="flex flex-col gap-2 py-1">
        <span className="h-3 w-3/4 animate-pulse rounded bg-muted-foreground/20" />
        <span className="h-3 w-1/2 animate-pulse rounded bg-muted-foreground/20" />
      </div>
    );
  }
  if (read.state === "failed") {
    return (
      <p className="flex items-center gap-2 text-ui text-muted-foreground">
        Couldn't read this task's last message.
        <Button variant="ghost" size="xs" onClick={() => setTries((t) => t + 1)}>
          Try again
        </Button>
      </p>
    );
  }
  if (!read.text) return <p className="text-ui text-muted-foreground">This task hasn't written anything yet.</p>;
  return (
    <ChatSessionContext value={context}>
      <Markdown linkFilePaths>{read.text}</Markdown>
    </ChatSessionContext>
  );
}
