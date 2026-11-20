import { useCallback, useMemo, useState } from "react";

import { ChevronDown } from "lucide-react";

import PrPanel, { CommentPickContext } from "@/components/PrPanel";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { inputClassName } from "@/components/ui/input";
import { useDraft } from "@/hooks/useDraft";
import type { usePullRequest } from "@/hooks/usePullRequest";
import { prPrompt, unresolvedKeys, type InboxRow } from "@/lib/prInbox";
import { sendToTask } from "@/lib/sendToTask";
import { cn } from "@/lib/utils";
import type { SessionIndexItem } from "@/types/events";

/// The picked pull request on the pull requests page: the PR panel's own rows,
/// with a box on each comment, and under them a message for the session behind
/// the PR. Mounted once per PR (keyed by `App`), so picks never carry across.
export default function PullDetail({
  row,
  data,
  sessions,
  onOpenSession,
  onStartSession,
}: {
  row: InboxRow;
  data: ReturnType<typeof usePullRequest>;
  /// `sessionsForPr`'s answer, best first.
  sessions: SessionIndexItem[];
  onOpenSession: (sessionId: string) => void;
  /// Opens the new-task composer on a draft for this PR's branch, carrying
  /// `prompt`. Answers why it could not, or `null` once it has.
  onStartSession: (prompt: string) => Promise<string | null>;
}) {
  // The panel's read answers every PR on the head branch; this pane is one.
  const pr = data.prs.find((p) => p.number === row.mark.number) ?? null;
  const prs = useMemo(() => (pr ? [pr] : []), [pr]);

  const [picked, setPicked] = useState<ReadonlySet<string>>(() => new Set());
  const toggle = useCallback(
    (key: string) =>
      setPicked((prev) => {
        const next = new Set(prev);
        if (!next.delete(key)) next.add(key);
        return next;
      }),
    [],
  );
  const pick = useMemo(() => ({ picked, toggle }), [picked, toggle]);
  const unresolved = useMemo(() => (pr ? unresolvedKeys(pr.comments) : []), [pr]);

  const live = sessions.filter((s) => !s.archived);
  const [targetId, setTargetId] = useState<string | null>(null);
  const target = live.find((s) => s.sessionId === targetId) ?? live[0] ?? null;

  const [text, setText] = useDraft(`pr:${row.mark.url}`);
  const [sending, setSending] = useState(false);
  const [result, setResult] = useState<{ sent: SessionIndexItem } | { error: string } | null>(null);
  const writable = !row.listing.isCrossRepository;
  // Starting needs no words: the PR and its comments are a task on their own.
  const canSend = !!pr && writable && !sending && (!target || text.trim().length > 0 || picked.size > 0);

  const send = async () => {
    if (!canSend || !pr) return;
    setSending(true);
    setResult(null);
    try {
      if (!target) {
        // The page goes away on success, the composer taking its place.
        const refused = await onStartSession(prPrompt({ pr, picked, text, fresh: true }));
        if (refused) setResult({ error: refused });
        else setText("");
        return;
      }
      await sendToTask(target, prPrompt({ pr, picked, text }));
      setText("");
      setPicked(new Set());
      setResult({ sent: target });
    } catch (e) {
      setResult({ error: e instanceof Error ? e.message : String(e) });
    } finally {
      setSending(false);
    }
  };

  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <CommentPickContext value={pick}>
        <PrPanel {...data} prs={prs} branch={row.mark.headRefName} cwd={row.key} />
      </CommentPickContext>

      {pr && (
        <div className="flex shrink-0 flex-col gap-2 border-t border-border px-3 pt-2.5 pb-3">
          <div className="flex min-h-6 items-center gap-1.5 text-ui text-muted-foreground">
            {row.listing.isCrossRepository ? (
              <span>This branch lives in a fork of the repository, so an agent here can't push to it.</span>
            ) : target ? (
              <>
                <span className="shrink-0">To</span>
                <SessionMenu sessions={live} target={target} onPick={setTargetId} />
                <Button
                  variant="ghost"
                  size="xs"
                  className="ml-auto text-muted-foreground"
                  onClick={() => onOpenSession(target.sessionId)}
                >
                  Open
                </Button>
              </>
            ) : (
              <span>No live session. Start session opens the composer on {row.mark.headRefName}.</span>
            )}
          </div>

          {writable && (
            <>
              <textarea
                rows={3}
                value={text}
                placeholder="Message the agent about this pull request"
                onChange={(e) => setText(e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter" && (e.metaKey || e.ctrlKey)) {
                    e.preventDefault();
                    void send();
                  }
                }}
                className={cn(inputClassName, "h-auto max-h-48 min-h-16 resize-none py-1.5 text-ui md:text-ui field-sizing-content")}
              />
              <div className="flex items-center gap-2 text-ui">
                <Button
                  variant="ghost"
                  size="xs"
                  disabled={unresolved.length === 0}
                  onClick={() => setPicked(new Set(unresolved))}
                >
                  Pick unresolved
                </Button>
                {picked.size > 0 && (
                  <>
                    <span className="text-muted-foreground">
                      {picked.size} {picked.size === 1 ? "comment" : "comments"} picked
                    </span>
                    <Button variant="ghost" size="xs" onClick={() => setPicked(new Set())}>
                      Clear
                    </Button>
                  </>
                )}
                <Button size="xs" className="ml-auto" disabled={!canSend} onClick={() => void send()}>
                  {target ? (sending ? "Sending…" : "Send") : "Start session…"}
                </Button>
              </div>
            </>
          )}

          {result && (
            <p className={cn("text-ui", "error" in result ? "text-destructive" : "text-muted-foreground")}>
              {"error" in result ? (
                result.error
              ) : (
                <>
                  Sent to{" "}
                  <button
                    type="button"
                    className="text-foreground underline-offset-2 hover:underline"
                    onClick={() => onOpenSession(result.sent.sessionId)}
                  >
                    {result.sent.title}
                  </button>
                  .
                </>
              )}
            </p>
          )}
        </div>
      )}
    </div>
  );
}

/// Which session the message goes to. A menu only where the branch has more
/// than one live session, which is rare; otherwise just its title.
function SessionMenu({
  sessions,
  target,
  onPick,
}: {
  sessions: SessionIndexItem[];
  target: SessionIndexItem;
  onPick: (id: string) => void;
}) {
  if (sessions.length < 2) {
    return <span className="min-w-0 truncate text-foreground">{target.title}</span>;
  }
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button type="button" className="flex min-w-0 items-center gap-1 text-foreground">
          <span className="truncate">{target.title}</span>
          <ChevronDown className="size-3 shrink-0 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64">
        {sessions.map((s) => (
          <DropdownMenuCheckboxItem
            key={s.sessionId}
            checked={s.sessionId === target.sessionId}
            onCheckedChange={() => onPick(s.sessionId)}
          >
            {s.title}
          </DropdownMenuCheckboxItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
