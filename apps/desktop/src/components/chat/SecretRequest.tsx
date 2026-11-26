import { openUrl } from "@tauri-apps/plugin-opener";
import { KeyIcon, ShieldCheckIcon } from "@heroicons/react/16/solid";
import { ArrowLeft, ChevronDown, ExternalLink, X } from "lucide-react";
import type { ComponentProps, ComponentType, SVGProps } from "react";
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
  // Yogesh's card (Paper): 18px corners, 14/16/16 inset less the 1px border, 24 between the two
  // halves. The fill and ring are the permission card's tokens, which is what
  // his dark values are, so light mode follows.
  return (
    <form
      onSubmit={onSubmit}
      autoComplete="off"
      data-secret-card
      className="flex w-full max-w-lg flex-col gap-[18px] self-start rounded-[18px] border border-[var(--card-edge,var(--border))] bg-[var(--permission-card,var(--card))] px-[15px] pt-[13px] pb-[15px] shadow-[var(--shadow-raised-card,var(--shadow-card))]"
    >
      <div className="flex flex-col gap-3">
        <div className="flex items-center gap-3">
          <button
            type="button"
            onClick={(e) => parties.open(asker, isModClick(e))}
            className="flex min-w-0 flex-1 cursor-pointer items-center gap-1.5 text-sm leading-5 text-muted-foreground hover:text-foreground"
          >
            <BotAvatar still seed={asker.id} avatar={asker.avatar ?? seededAvatar(asker.id)} className="block size-4 shrink-0 scale-[1.18]" />
            <span className="truncate">{asker.title}</span>
            {asker.machine && <MachineMark machine={asker.machine} />}
          </button>
          <Tooltip>
            <TooltipTrigger asChild>
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label="Decline"
                className="shrink-0 rounded-lg text-muted-foreground"
                disabled={busy}
                onClick={() => void send("decline")}
              >
                <X className="size-3.5" />
              </Button>
            </TooltipTrigger>
            <TooltipContent side="top">Decline</TooltipContent>
          </Tooltip>
        </div>
        <div className="flex min-w-0 flex-col gap-1.5">
          <p className="text-sm leading-5 font-medium wrap-anywhere">{label ?? name}</p>
          <p className="flex min-w-0 flex-wrap items-center gap-x-1 text-sm leading-5">
            <span className="text-muted-foreground">{reason}</span>
            {url && (
              // The system browser, never the session's: the agent can drive that one.
              <button
                type="button"
                onClick={() => void openUrl(url).catch(console.error)}
                className="flex min-w-0 cursor-pointer items-center gap-1 underline-offset-4 hover:underline"
              >
                <ExternalLink className="size-3 shrink-0" aria-hidden />
                <span className="truncate">{hostOf(url)}</span>
              </button>
            )}
          </p>
        </div>
      </div>

      <div className="flex flex-col gap-3">
        {pasting ? (
          <div className="flex min-w-0 items-center gap-2">
            {closest && (
              <Button
                type="button"
                variant="ghost"
                size="icon"
                aria-label="Use saved"
                className="-ml-2 shrink-0 text-muted-foreground"
                disabled={busy}
                onClick={() => setPasting(false)}
              >
                <ArrowLeft />
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
              className="h-8 rounded-lg px-2.5 font-mono text-sm leading-[18px] [-webkit-text-security:disc] placeholder:font-sans md:text-sm"
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
            <SendSecurelyButton type="submit" disabled={busy || !filled}>
              {sending === "paste" ? "Sending…" : "Send securely"}
            </SendSecurelyButton>
          </div>
        ) : (
          <div className="flex min-w-0 flex-wrap items-center gap-2">
            <div className="flex min-w-0 gap-2">
              <Button
                type="submit"
                autoFocus={autoFocus}
                disabled={busy}
                size="sm"
                className="h-8 min-w-0"
              >
                <KeyIcon className="size-4" />
                <span className="truncate">
                  Use saved <span className="font-mono">{pick}</span>
                </span>
              </Button>
              {savedNames.length > 1 && (
                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      type="button"
                      aria-label="Pick another saved secret"
                      disabled={busy}
                      size="icon-sm"
                      className="size-8"
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
            <Button type="button" variant="ghost" size="sm" className="h-8 shrink-0 text-muted-foreground" disabled={busy} onClick={() => setPasting(true)}>
              Paste a new one
            </Button>
          </div>
        )}

        <div className="flex flex-wrap items-center gap-x-5 gap-y-2 text-sm leading-5 text-muted-foreground">
          {pasting && (
            <label htmlFor={keepId} className="flex items-center gap-2">
              <Switch id={keepId} checked={keeps} onCheckedChange={setKeep} disabled={busy || auto} />
              Save
            </label>
          )}
          <label htmlFor={autoId} className="flex items-center gap-2">
            <Switch id={autoId} checked={auto} onCheckedChange={setAuto} disabled={busy} />
            Let agents use it without asking you
          </label>
        </div>

        {error && (
          <p role="alert" className="text-ui text-destructive wrap-anywhere">
            {error}
          </p>
        )}
      </div>
    </form>
  );
}

/// The card's main answer: the light button with a solid icon. `icon` is
/// there so the demo can put the candidates side by side.
export function SendSecurelyButton({
  icon: Icon = ShieldCheckIcon,
  className,
  children = "Send securely",
  ...props
}: ComponentProps<typeof Button> & { icon?: ComponentType<SVGProps<SVGSVGElement>> }) {
  return (
    // The permission card's Allow once: the app's own button, small.
    <Button size="sm" className={cn("h-8 shrink-0 disabled:opacity-100", className)} {...props}>
      <Icon className="size-4" aria-hidden />
      {children}
    </Button>
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
