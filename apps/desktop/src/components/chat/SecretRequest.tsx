import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, ChevronLeft, ExternalLink, Lock, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import { PartyChip, type Party } from "@/components/chat/PartyChip";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSecretParties } from "@/hooks/useSecretParties";
import { isModClick } from "@/lib/platform";
import { invoke } from "@/lib/transport";
import type { SecretTask } from "@/types/events";

type Answer = "paste" | "saved" | "decline";

/// An agent asking for a token or password with `dray secret request`. The
/// value goes from this field to the server answering, which writes it to an
/// owner-only file and tells the agent the path; it never enters the
/// transcript, so nothing here keeps it in state or saves a draft of it.
///
/// Where the answering machine holds a saved one — by this name, picked for it
/// before, or near it — the card offers that in one click, every other saved
/// one a pick away; the agent gets it under the name it asked for.
export default function SecretRequest({
  sessionId,
  requestId,
  name,
  label,
  reason,
  url,
  savedNames = [],
  closest,
  task,
  autoFocus = true,
}: {
  sessionId: string;
  requestId: string;
  name: string;
  label?: string;
  reason: string;
  url?: string;
  savedNames?: string[];
  closest?: string;
  /// A bot's task on another machine asked; this machine is the bot's, and
  /// keeps the secrets its tasks use.
  task?: SecretTask;
  /// False in the crew column, where the caret belongs to another session.
  autoFocus?: boolean;
}) {
  const parties = useSecretParties();
  const asker: Party = task
    ? { id: task.sessionId, title: task.title, machine: task.machine }
    : parties.asker(sessionId);
  const [pasting, setPasting] = useState(!closest);
  const [pick, setPick] = useState(closest ?? savedNames[0] ?? name);
  const inputRef = useRef<HTMLInputElement>(null);
  const [filled, setFilled] = useState(false);
  const [keep, setKeep] = useState(false);
  const [auto, setAuto] = useState(false);
  const [sending, setSending] = useState<Answer | null>(null);
  const [error, setError] = useState<string | null>(null);
  const keepId = useId();
  const autoId = useId();
  // Enter and a click can both submit before a render.
  const inFlight = useRef(false);

  useEffect(() => {
    if (autoFocus && pasting) inputRef.current?.focus({ preventScroll: true });
  }, [autoFocus, pasting]);

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
        keep: answer === "paste" && (keep || auto),
        useSaved: answer === "saved",
        always: answer !== "decline" && auto,
        from: answer === "saved" ? pick : null,
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
    void send(pasting ? "paste" : "saved");
  };

  const busy = sending !== null;
  // Using it without asking keeps a pasted one, so this reads as on while that is.
  const keeps = keep || auto;
  return (
    <form
      onSubmit={onSubmit}
      autoComplete="off"
      data-secret-card
      className="flex flex-col gap-3 rounded-2xl border border-[var(--card-edge,var(--border))] bg-[var(--permission-card,var(--card))] p-4 shadow-[var(--shadow-raised-card,var(--shadow-card))]"
    >
      <div className="flex min-w-0 items-start justify-between gap-2">
        <div className="flex min-w-0 flex-col gap-1">
          {/* The chip's own inset would push the face off the card's edge line. */}
          <div className="-ml-1 flex min-w-0 text-ui text-muted-foreground">
            <PartyChip parties={[asker]} onClick={(e) => parties.open(asker, isModClick(e))} />
          </div>
          <p className="text-chat font-medium wrap-anywhere">{label ?? name}</p>
          <p className="text-ui text-muted-foreground wrap-anywhere">
            {reason}
            {url && (
              <>
                {" "}
                {/* The system browser, never the session's: the agent can drive that one. */}
                <button
                  type="button"
                  onClick={() => void openUrl(url).catch(console.error)}
                  className="inline-flex cursor-pointer items-center gap-0.5 text-foreground underline-offset-4 hover:underline"
                >
                  {hostOf(url)}
                  <ExternalLink className="size-3" aria-hidden />
                </button>
              </>
            )}
          </p>
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Decline"
              className="-mt-1 -mr-1 shrink-0 text-muted-foreground"
              disabled={busy}
              onClick={() => void send("decline")}
            >
              <X />
            </Button>
          </TooltipTrigger>
          <TooltipContent side="top">Decline</TooltipContent>
        </Tooltip>
      </div>

      {pasting ? (
        <div className="flex min-w-0 items-center gap-2">
          {closest && (
            <Button type="button" variant="ghost" className="shrink-0 px-2" disabled={busy} onClick={() => setPasting(false)}>
              <ChevronLeft />
              Use saved
            </Button>
          )}
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
          <Button type="submit" className="shrink-0" disabled={busy || !filled}>
            <Lock />
            {sending === "paste" ? "Saving…" : "Save securely"}
          </Button>
        </div>
      ) : (
        <div className="flex min-w-0 items-center gap-2">
          <div className="flex min-w-0">
            <Button
              type="submit"
              autoFocus={autoFocus}
              disabled={busy}
              className={savedNames.length > 1 ? "min-w-0 rounded-r-none" : "min-w-0"}
            >
              <span className="truncate">
                Use saved <span className="font-mono">{pick}</span>
              </span>
            </Button>
            {savedNames.length > 1 && (
              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <Button
                    type="button"
                    size="icon"
                    aria-label="Pick another saved secret"
                    disabled={busy}
                    className="rounded-l-none border-l border-primary-foreground/20"
                  >
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-52">
                  <DropdownMenuRadioGroup value={pick} onValueChange={setPick}>
                    {savedNames.map((n) => (
                      <DropdownMenuRadioItem key={n} value={n} className="font-mono">
                        {n}
                      </DropdownMenuRadioItem>
                    ))}
                  </DropdownMenuRadioGroup>
                </DropdownMenuContent>
              </DropdownMenu>
            )}
          </div>
          <Button type="button" variant="ghost" className="shrink-0" disabled={busy} onClick={() => setPasting(true)}>
            Paste a new one
          </Button>
        </div>
      )}

      <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-ui text-muted-foreground">
        {pasting && (
          <label htmlFor={keepId} className="flex items-center gap-2">
            <Switch id={keepId} checked={keeps} onCheckedChange={setKeep} disabled={busy || auto} />
            Save as <span className="font-mono">{name}</span>
          </label>
        )}
        <Tooltip>
          <TooltipTrigger asChild>
            <label htmlFor={autoId} className="flex items-center gap-2">
              <Switch id={autoId} checked={auto} onCheckedChange={setAuto} disabled={busy} />
              Auto
            </label>
          </TooltipTrigger>
          <TooltipContent side="bottom">Let agents use it without asking</TooltipContent>
        </Tooltip>
      </div>

      {error && (
        <p role="alert" className="text-ui text-destructive wrap-anywhere">
          {error}
        </p>
      )}
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
