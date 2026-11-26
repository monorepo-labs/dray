import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronDown, ChevronLeft, ExternalLink, Lock, X } from "lucide-react";
import { useEffect, useId, useRef, useState, type FormEvent } from "react";

import BotAvatar from "@/components/BotAvatar";
import type { Party } from "@/components/chat/PartyChip";
import MachineMark from "@/components/MachineMark";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { useSecretParties } from "@/hooks/useSecretParties";
import { seededAvatar } from "@/lib/botAvatar";
import { isModClick } from "@/lib/platform";
import { serverName } from "@/lib/servers";
import { invoke, serverOfSession } from "@/lib/transport";
import { cn } from "@/lib/utils";
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
    // PermissionRequest's card: the same surface, inset and type, so a secret
    // reads as one more thing the agent is waiting on.
    <form
      onSubmit={onSubmit}
      autoComplete="off"
      data-secret-card
      className="rounded-2xl border border-[var(--card-edge,var(--border))] bg-[var(--permission-card,var(--card))] p-4 shadow-[var(--shadow-raised-card,var(--shadow-card))]"
    >
      <div className="flex min-w-0 items-start gap-2">
        <div className="flex min-w-0 flex-1 flex-col gap-1">
          <button
            type="button"
            onClick={(e) => parties.open(asker, isModClick(e))}
            className="flex w-fit max-w-full cursor-pointer items-center gap-1.5 text-ui text-muted-foreground hover:text-foreground"
          >
            <BotAvatar still seed={asker.id} avatar={asker.avatar ?? seededAvatar(asker.id)} className="block size-4 shrink-0 scale-[1.18]" />
            <span className="truncate">{asker.title}</span>
            {asker.machine && <MachineMark machine={asker.machine} />}
          </button>
          <p className="text-chat leading-snug font-medium wrap-anywhere">{label ?? name}</p>
          <p className="text-chat leading-snug wrap-anywhere text-muted-foreground">{reason}</p>
          {url && (
            // The system browser, never the session's: the agent can drive that one.
            <button
              type="button"
              onClick={() => void openUrl(url).catch(console.error)}
              className="flex w-fit max-w-full cursor-pointer items-center gap-1 text-ui text-muted-foreground underline-offset-4 hover:text-foreground hover:underline"
            >
              <span className="truncate">{hostOf(url)}</span>
              <ExternalLink className="size-3 shrink-0" aria-hidden />
            </button>
          )}
        </div>
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              aria-label="Decline"
              className="-mt-0.5 -mr-1 shrink-0 text-muted-foreground"
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
        <div className="mt-3 flex min-w-0 items-center gap-1.5">
          {closest && (
            <Button type="button" size="sm" variant="outline" className="h-7 shrink-0" disabled={busy} onClick={() => setPasting(false)}>
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
            // The buttons' height, so the row reads as one control.
            className="h-7 [-webkit-text-security:disc] font-mono placeholder:font-sans"
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
          <Button type="submit" size="sm" className="h-7 shrink-0" disabled={busy || !filled}>
            <Lock />
            {sending === "paste" ? "Saving…" : "Save securely"}
          </Button>
        </div>
      ) : (
        <div className="mt-3 flex min-w-0 flex-wrap items-center gap-1.5">
          <div className="flex min-w-0">
            <Button
              type="submit"
              size="sm"
              autoFocus={autoFocus}
              disabled={busy}
              className={cn("h-7 min-w-0", savedNames.length > 1 && "rounded-r-none")}
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
                    size="icon-sm"
                    aria-label="Pick another saved secret"
                    disabled={busy}
                    className="rounded-l-none border-l border-primary-foreground/20"
                  >
                    <ChevronDown />
                  </Button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-52">
                  <DropdownMenuLabel className="text-xs font-normal text-muted-foreground">
                    Saved on {serverName(serverOfSession(sessionId))}
                  </DropdownMenuLabel>
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
          <Button type="button" size="sm" variant="outline" className="h-7 shrink-0" disabled={busy} onClick={() => setPasting(true)}>
            Paste a new one
          </Button>
        </div>
      )}

      <div className="mt-3 flex flex-wrap items-center gap-x-4 gap-y-2 text-ui text-muted-foreground">
        {pasting && (
          <label htmlFor={keepId} className="flex items-center gap-2">
            <Switch id={keepId} checked={keeps} onCheckedChange={setKeep} disabled={busy || auto} />
            {savedNames.includes(name) ? "Replace saved" : "Save as"} <span className="font-mono">{name}</span>
          </label>
        )}
        <label htmlFor={autoId} className="flex items-center gap-2">
          <Switch id={autoId} checked={auto} onCheckedChange={setAuto} disabled={busy} />
          Let agents use it without asking
        </label>
      </div>

      {error && (
        <p role="alert" className="mt-2 text-ui text-destructive wrap-anywhere">
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
