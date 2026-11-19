import { useEffect, useRef, useState } from "react";

import { Markdown } from "@/components/chat/Markdown";
import { useChatSession } from "@/hooks/useChatSession";
import { invoke, serverOfSession } from "@/lib/transport";

/// How long an open row waits on the bot's server. A stopped or asleep machine
/// may never answer, and the row must not hold its skeleton for it.
const READ_TIMEOUT_MS = 8_000;

/// What the bot told the reader about one of its tasks, drawn under that task's
/// open Waiting on you row: its reply to the task's newest report, which the
/// bot's server reads back off the end of its chat (`bot_task_reply`). Read only
/// while the row is open and dropped when it closes. With nothing to show — no
/// reply, a failed read, a server too old to ask — `onNone` runs and the row
/// opens the task instead. Drawn in the bot chat's own context, around it.
export default function BotReply({ taskId, onNone }: { taskId: string; onNone: () => void }) {
  const { sessionId: chatId } = useChatSession();
  const [read, setRead] = useState<{ text: string | null } | null>(null);
  // Held in a ref: the row passes a fresh closure each render, and a read must not restart for it.
  const none = useRef(onNone);
  none.current = onNone;
  useEffect(() => {
    let live = true;
    const reply = chatId
      ? invoke<string | null>("bot_task_reply", { sessionId: chatId, taskId }, serverOfSession(chatId))
      : Promise.resolve(null);
    const timeout = new Promise<null>((done) => setTimeout(() => done(null), READ_TIMEOUT_MS));
    Promise.race([reply, timeout])
      .catch(() => null)
      .then((text) => {
        if (!live) return;
        setRead({ text });
        if (!text) none.current();
      });
    return () => {
      live = false;
    };
  }, [chatId, taskId]);

  if (!read) {
    return (
      <div className="flex flex-col gap-2 py-1">
        <span className="h-3 w-3/4 animate-pulse rounded bg-muted-foreground/20" />
        <span className="h-3 w-1/2 animate-pulse rounded bg-muted-foreground/20" />
      </div>
    );
  }
  if (!read.text) return <p className="text-ui text-muted-foreground">Nothing from the bot about this task yet.</p>;
  return <Markdown linkFilePaths>{read.text}</Markdown>;
}
