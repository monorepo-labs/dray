import { openUrl } from "@tauri-apps/plugin-opener";
import { ExternalLink, KeyRound, ShieldCheck } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { invoke } from "@/lib/transport";

/// An agent asking for a token or password with `dray secret request`. The
/// value goes from this field to the session's server, which writes it to an
/// owner-only file and tells the agent the path; it never enters the
/// transcript, so nothing here keeps it in state or saves a draft of it.
export default function SecretRequest({
  sessionId,
  requestId,
  name,
  label,
  reason,
  url,
  autoFocus = true,
}: {
  sessionId: string;
  requestId: string;
  name: string;
  label?: string;
  reason: string;
  url?: string;
  /// False in the crew column, where the caret belongs to another session.
  autoFocus?: boolean;
}) {
  const inputRef = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState(false);
  const [keep, setKeep] = useState(false);
  const [sending, setSending] = useState<"save" | "decline" | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keepId = useId();
  // Enter and a click can both submit before a render.
  const inFlight = useRef(false);

  useEffect(() => {
    if (autoFocus) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus]);

  const send = async (save: boolean) => {
    const value = save ? inputRef.current?.value.trim() ?? "" : null;
    if (inFlight.current || (save && !value)) return;
    inFlight.current = true;
    setSending(save ? "save" : "decline");
    setError(null);
    try {
      await invoke("answer_secret_request", { sessionId, requestId, value, keep: save && keep });
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
    void send(true);
  };

  const busy = sending !== null;
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

      <div className="flex min-w-0 items-center gap-2">
        <Input
          ref={inputRef}
          // Masked text rather than a password field, so no password manager
          // offers to save it or fill it in.
          type="text"
          name={`dray-secret-${requestId}`}
          aria-label={label ?? name}
          placeholder="Paste the value"
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
        <Button type="submit" size="sm" disabled={busy || !filled}>
          {sending === "save" ? "Saving…" : "Save securely"}
        </Button>
      </div>

      <label htmlFor={keepId} className="flex w-fit items-center gap-2 text-ui text-muted-foreground">
        <Switch id={keepId} checked={keep} onCheckedChange={setKeep} disabled={busy} />
        Save as <span className="font-mono">{name}</span> on this machine
      </label>

      {error && (
        <p role="alert" className="text-ui text-destructive wrap-anywhere">
          {error}
        </p>
      )}

      <div className="flex items-start justify-between gap-3">
        <p className="flex min-w-0 items-start gap-1.5 text-ui text-muted-foreground">
          <ShieldCheck className="mt-0.5 size-3.5 shrink-0" aria-hidden />
          <span>
            Kept out of chat, in a private file on the machine running this task. The agent's commands can read it
            {keep ? " until you delete it in Settings → Secrets." : " for 24 hours."}
          </span>
        </p>
        <Button
          type="button"
          size="xs"
          variant="ghost"
          className="shrink-0 text-muted-foreground"
          disabled={busy}
          onClick={() => void send(false)}
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
