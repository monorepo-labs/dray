import { useEffect, useState } from "react";

import { Markdown } from "@/components/chat/Markdown";
import { readPreviews } from "@/lib/bots";

/// A task's last message in full, read off the end of its own log — what a
/// "Waiting on you" row shows when picked, in place of scrolling the bot's chat
/// back to its reply, which could mean reading days of the chat's log.
export default function TaskMessage({ sessionId }: { sessionId: string }) {
  // `undefined` while reading, `null` where the task has said nothing.
  const [text, setText] = useState<string | null | undefined>(undefined);
  useEffect(() => {
    let live = true;
    setText(undefined);
    readPreviews([sessionId])
      .then((p) => live && setText(p[sessionId]?.text ?? null))
      .catch(() => live && setText(null));
    return () => {
      live = false;
    };
  }, [sessionId]);

  if (text === undefined) {
    return (
      <div className="flex flex-col gap-2 py-1">
        <span className="h-3 w-3/4 animate-pulse rounded bg-muted-foreground/20" />
        <span className="h-3 w-1/2 animate-pulse rounded bg-muted-foreground/20" />
      </div>
    );
  }
  if (!text) return <p className="text-ui text-muted-foreground">This task hasn't written anything yet.</p>;
  return <Markdown linkFilePaths>{text}</Markdown>;
}
