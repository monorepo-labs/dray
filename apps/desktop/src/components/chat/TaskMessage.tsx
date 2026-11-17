import { useEffect, useMemo, useState } from "react";

import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui/button";
import { ChatSessionContext } from "@/hooks/useChatSession";
import { READ_TIMEOUT_MS } from "@/hooks/useStallLine";
import { readPreviews } from "@/lib/bots";

/// A task's last message in full, read off the end of its own log — what a
/// "Waiting on you" row shows when picked, in place of scrolling the bot's chat
/// back to its reply, which could mean reading days of the chat's log.
///
/// Drawn in the task's own session context, not the bot chat's around it, so
/// a relative file link resolves in the task's checkout and a picture loads
/// from the task's machine.
export default function TaskMessage({ sessionId, cwd }: { sessionId: string; cwd: string | null }) {
  // `undefined` while reading; `failed` where the task's server errored or
  // never answered, told apart from a task that has written nothing (`null`).
  const [text, setText] = useState<string | null | "failed" | undefined>(undefined);
  const [tries, setTries] = useState(0);
  useEffect(() => {
    let live = true;
    setText(undefined);
    // `readPreviews` drops a server that errors, so a missing entry is a failure.
    const read = readPreviews([sessionId]).then((p) => (p[sessionId] ? p[sessionId].text : ("failed" as const)));
    const timeout = new Promise<"failed">((done) => setTimeout(() => done("failed"), READ_TIMEOUT_MS));
    Promise.race([read, timeout])
      .catch(() => "failed" as const)
      .then((found) => live && setText(found));
    return () => {
      live = false;
    };
  }, [sessionId, tries]);
  const context = useMemo(() => ({ cwd, sessionId }), [cwd, sessionId]);

  if (text === undefined) {
    return (
      <div className="flex flex-col gap-2 py-1">
        <span className="h-3 w-3/4 animate-pulse rounded bg-muted-foreground/20" />
        <span className="h-3 w-1/2 animate-pulse rounded bg-muted-foreground/20" />
      </div>
    );
  }
  if (text === "failed") {
    return (
      <p className="flex items-center gap-2 text-ui text-muted-foreground">
        Couldn't read this task's last message.
        <Button variant="ghost" size="xs" onClick={() => setTries((t) => t + 1)}>
          Try again
        </Button>
      </p>
    );
  }
  if (!text) return <p className="text-ui text-muted-foreground">This task hasn't written anything yet.</p>;
  return (
    <ChatSessionContext value={context}>
      <Markdown linkFilePaths>{text}</Markdown>
    </ChatSessionContext>
  );
}
