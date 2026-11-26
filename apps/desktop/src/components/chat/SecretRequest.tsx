import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, KeyRound, ShieldCheck } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { serverName } from "@/lib/servers";
import { invoke, serverOfSession } from "@/lib/transport";
import type { SecretTask } from "@/types/events";

type Answer = "paste" | "saved" | "decline";

/// An agent asking for a token or password with `dray secret request`. The
/// value goes from this field to the session's server, which writes it to an
/// owner-only file and tells the agent the path; it never enters the
/// transcript, so nothing here keeps it in state or saves a draft of it.
///
/// Where `saved`, the machine already holds one by this name, offered in one
/// click. Letting agents use it without asking makes later requests skip the card.
export default function SecretRequest({
  sessionId,
  requestId,
  name,
  label,
  reason,
  url,
  saved = false,
  task,
  title,
  autoFocus = true,
}: {
  sessionId: string;
  requestId: string;
  name: string;
  label?: string;
  reason: string;
  url?: string;
  saved?: boolean;
  /// A bot's task on another machine asked; this machine is the bot's, and
  /// keeps the secrets its tasks use.
  task?: SecretTask;
  /// The asking session's title, for the line saying where the value goes.
  title?: string;
  /// False in the crew column, where the caret belongs to another session.
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState(false);
  const [keep, setKeep] = useState(false);
  const [always, setAlways] = useState(false);
  const [sending, setSending] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keepId = useId();
  const alwaysId = useId();
  // Enter and a click can both submit before a render.
  const inFlight = useRef(false);

  // A saved one is the likely answer, so the button has the focus there.
  useEffect(() => {
    if (autoFocus && !saved) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus, saved]);

  const send = async (answer: Answer) => {
    const value = answer === "paste" ? inputRef.current?.value.trim() ?? "" : null;
    if (inFlight.current || (answer === "paste" && !value)) return;
    inFlight.current = true;
    setSending(answer);
    setError(null);
    try {
      await invoke("answer_secret_request", {
        sessionId,
        requestId,
        value,
        keep: answer === "paste" && (keep || always),
        useSaved: answer === "saved",
        always: answer !== "decline" && always,
      });
      if (inputRef.current) inputRef.current.value = "";
    } catch (e) {
      setError(String(e));
      setSending(null);
    } finally {
      inFlight.current = false;
    }
  };

  const onSubmit = (e: FormEvent) => {
    e.preventDefault();
    void send("paste");
  };

  const busy = sending !== null;
  const where = task
    ? `Kept out of chat, sent encrypted to ${task.machine} into a private file the task's commands can read for 24 hours`
    : "Kept out of chat, in a private file on the machine running this task. The agent's commands can read it";
  const footnote = task
    ? always
      ? `. Saved here for your bot's tasks, which get it without this card from now on.`
      : keep
        ? ". Saved here too, for your bot's other tasks."
        : "."
    : always
    ? `Later requests for ${name} skip this card; turn that off in Settings → Secrets.`
    : keep
      ? " until you delete it in Settings → Secrets."
      : saved
        ? ". A new one pasted here lasts 24 hours unless it replaces the saved one."
        : " for 24 hours.";
  return (
    <form
      onSubmit={onSubmit}
      autoComplete="off"
      data-secret-card
      className="flex flex-col gap-3 rounded-2xl border border-[var(--card-edge,var(--border))] bg-[var(--permission-card,var(--card))] p-4 shadow-[var(--shadow-raised-card,var(--shadow-card))]"
    >
      <div className="flex min-w-0 flex-col gap-1">
        <p className="flex items-center gap-2 text-chat font-medium">
          <KeyRound className="size-4 shrink-0 text-muted-foreground" aria-hidden />
          <span className="truncate">{label ?? name}</span>
        </p>
        {/* Every card says where the value lands before anything is pasted. */}
        <p className="truncate text-ui text-muted-foreground">
          For {task?.title ?? title ?? "this task"} on {task?.machine ?? serverName(serverOfSession(sessionId))}
        </p>
        <p className="text-chat leading-snug wrap-anywhere text-muted-foreground">{reason}</p>
        {url && (
          // The system browser, never the session's: the agent can drive that one.
          <button
            type="button"
            onClick={() => void openUrl(url).catch(console.error)}
            className="flex w-fit max-w-full cursor-pointer items-center gap-1 text-ui text-foreground underline-offset-4 hover:underline"
          >
            <span className="truncate">{hostOf(url)}</span>
            <ExternalLink className="size-3 shrink-0" aria-hidden />
          </button>
        )}
      </div>

      {saved && (
        <div className="flex min-w-0 items-center justify-between gap-2 rounded-lg border border-border px-3 py-2">
          <span className="min-w-0 truncate text-ui">
            <span className="font-mono">{name}</span> is saved on this machine
          </span>
          <Button
            type="button"
            size="sm"
            autoFocus={autoFocus}
            disabled={busy}
            onClick={() => void send("saved")}
          >
            {sending === "saved" ? "Sending…" : `Use saved ${name}`}
          </Button>
        </div>
      )}

      <div className="flex min-w-0 items-center gap-2">
        <Input
          ref={inputRef}
          // Masked text rather than a password field, so no password manager
          // offers to save it or fill it in.
          type="text"
          name={`dray-secret-${requestId}`}
          aria-label={label ?? name}
          placeholder={saved ? "Or paste a new one" : "Paste the value"}
          className="[-webkit-text-security:disc] font-mono"
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          spellCheck={false}
          data-1p-ignore
          data-lpignore="true"
          data-bwignore
          data-form-type="other"
          disabled={busy}
          aria-invalid={error !== null || undefined}
          onChange={(e) => setFilled(e.currentTarget.value.trim() !== "")}
        />
        <Button type="submit" size="sm" variant={saved ? "outline" : "default"} disabled={busy || !filled}>
          {sending === "paste" ? "Saving…" : "Save securely"}
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2">
        <label htmlFor={keepId} className="flex w-fit items-center gap-2 text-ui text-muted-foreground">
          {/* Using it without asking keeps a pasted one, so on a first card this reads as
              on while that is. On a saved card it would read as overwriting. */}
          <Switch
            id={keepId}
            checked={keep || (always && !saved)}
            onCheckedChange={setKeep}
            disabled={busy || (always && !saved)}
          />
          {saved ? "Replace saved" : "Save as"} <span className="font-mono">{name}</span>
        </label>
        <label htmlFor={alwaysId} className="flex w-fit items-center gap-2 text-ui text-muted-foreground">
          <Switch id={alwaysId} checked={always} onCheckedChange={setAlways} disabled={busy} />
          Let agents use it without asking
        </label>
      </div>

      {error && (
        <p role="alert" className="text-ui text-destructive wrap-anywhere">
          {error}
        </p>
      )}

      <div className="flex items-start justify-between gap-3">
        <p className="flex min-w-0 items-start gap-1.5 text-ui text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            {where}
            {always && !task ? ". " : ""}
            {footnote}
          </span>
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="shrink-0 text-muted-foreground"
          disabled={busy}
          onClick={() => void send("decline")}
        >
          Decline
        </Button>
      </div>
    </form>
  );
}

function hostOf(url: string): string {
  try {
    const u = new URL(url);
    return u.host + (u.pathname === "/" ? "" : u.pathname);
  } catch {
    return url;
  }
}
