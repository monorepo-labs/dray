import { Check } from "lucide-react";
import { useEffect, useRef, useState } from "react";

import AccountsSettings from "@/components/settings/AccountsSettings";
import CommandChip from "@/components/settings/CommandChip";
import { Button } from "@/components/ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from "@/components/ui/dialog";
import Spinner from "@/components/ui/spinner";
import { Switch } from "@/components/ui/switch";
import { useServers } from "@/lib/servers";
import { invoke, listen, LOCAL } from "@/lib/transport";
import type { Survey } from "@/types/events";

type Step =
  | { kind: "looking" }
  | { kind: "picking"; survey: Survey }
  | { kind: "installing" }
  | { kind: "connecting"; id: string | null }
  | { kind: "signing_in"; id: string };

/// Lines of install output kept on screen; a package manager can print
/// thousands, and only the end says how it went.
const LOG_LINES = 400;

const message = (err: unknown) =>
  err && typeof err === "object" && "message" in err ? String(err.message) : String(err);

/// Puts Dray on a server that has none, over the login it was added with:
/// asks what is there, offers what is missing, installs it, connects, then
/// lists the logins. One dialog for the whole first meeting, since every step
/// after the first needs the answer of the one before.
export default function ServerSetupDialog({
  line,
  name,
  connect,
  onClose,
}: {
  line: string;
  name: string;
  /// Connects once Dray is on the server, answering its id.
  connect: () => Promise<string>;
  onClose: () => void;
}) {
  const [step, setStep] = useState<Step>({ kind: "looking" });
  const [error, setError] = useState<string | null>(null);
  const [picks, setPicks] = useState<string[]>([]);
  const [log, setLog] = useState<string[]>([]);
  const logEnd = useRef<HTMLDivElement>(null);
  const servers = useServers();

  const look = async () => {
    setStep({ kind: "looking" });
    setError(null);
    try {
      const survey = await invoke<Survey>("survey_server", { line }, LOCAL);
      // git is on by default, since Dray needs it, unless this login cannot install it.
      const git = survey.tools.find((t) => t.id === "git");
      setPicks(git && !git.found && !survey.gitCommand ? ["git"] : []);
      setStep({ kind: "picking", survey });
    } catch (err) {
      setError(message(err));
    }
  };

  useEffect(() => {
    void look();
    // Once per dialog; `look` is the Look again button after that.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (step.kind !== "installing") return;
    let unlisten: (() => void) | undefined;
    let live = true;
    void listen<{ line: string; text: string }>("server_installing", ({ payload }) => {
      if (payload.line === line) setLog((prev) => [...prev.slice(-(LOG_LINES - 1)), payload.text]);
    }).then((off) => (live ? (unlisten = off) : off()));
    return () => {
      live = false;
      unlisten?.();
    };
  }, [step.kind, line]);

  useEffect(() => logEnd.current?.scrollIntoView({ block: "nearest" }), [log]);

  // The row going green is the answer, whichever way the connect was asked for.
  const connecting = step.kind === "connecting" && step.id ? servers.find((s) => s.id === step.id) : undefined;
  useEffect(() => {
    if (connecting?.status === "connected") setStep({ kind: "signing_in", id: connecting.id });
  }, [connecting?.status, connecting?.id]);

  const install = async () => {
    setStep({ kind: "installing" });
    setError(null);
    setLog([]);
    try {
      await invoke("install_on_server", { line, picks }, LOCAL);
    } catch (err) {
      setError(message(err));
      return;
    }
    await finish();
  };

  const finish = async () => {
    setStep({ kind: "connecting", id: null });
    setError(null);
    try {
      const id = await connect();
      setStep({ kind: "connecting", id });
    } catch (err) {
      setError(message(err));
    }
  };

  const toggle = (id: string, on: boolean) =>
    setPicks((prev) => (on ? [...prev, id] : prev.filter((p) => p !== id)));

  // The row's own sentence once its connect gave up. Its old "not installed"
  // can still be on screen for the moment before the new connect is announced.
  const connectError =
    connecting?.status === "disconnected" && connecting.fix?.kind !== "install" ? connecting.error : null;
  const shownError = error ?? connectError;

  const linux = step.kind !== "picking" || step.survey.os === "Linux";
  const stillWaiting =
    step.kind === "looking" || step.kind === "installing" || step.kind === "connecting";
  // Closing mid-install would leave a half-set-up server with nothing on screen
  // saying so; the run carries on there either way. A failure lets go.
  const locked = (step.kind === "installing" || step.kind === "connecting") && !shownError;

  return (
    <Dialog open onOpenChange={(next) => !next && !locked && onClose()}>
      <DialogContent className="grid-cols-[minmax(0,1fr)]" showClose={!locked}>
        <DialogHeader>
          <DialogTitle>{step.kind === "signing_in" ? `Sign in on ${name}` : `Install Dray on ${name}`}</DialogTitle>
          <DialogDescription>
            {step.kind === "signing_in"
              ? "Dray is running there. Each agent needs its own login on that machine."
              : step.kind === "picking" && !linux
                ? `Dray runs as a server on Linux, and ${name} is ${step.survey.os || "something else"}.`
                : "Dray installs into your home directory there and runs in the background, so it keeps going when this Mac sleeps."}
          </DialogDescription>
        </DialogHeader>

        {step.kind === "picking" && linux && (
          <div className="flex flex-col">
            <p className="pb-1 text-ui text-muted-foreground">Also install:</p>
            {step.survey.tools.map((tool) => (
              <div key={tool.id} className="flex min-h-9 flex-col justify-center gap-1.5 py-1">
                <div className="flex items-center gap-3">
                  <span className="flex-1 text-ui">{tool.name}</span>
                  {tool.found ? (
                    <span className="flex items-center gap-1 text-ui text-muted-foreground">
                      <Check className="size-3.5" />
                      Installed
                    </span>
                  ) : tool.id === "git" && step.survey.gitCommand ? null : (
                    <Switch
                      aria-label={`Install ${tool.name}`}
                      checked={picks.includes(tool.id)}
                      onCheckedChange={(on) => toggle(tool.id, on)}
                    />
                  )}
                </div>
                {!tool.found && tool.id === "git" && step.survey.gitCommand && (
                  <>
                    <span className="text-ui text-muted-foreground">
                      Dray needs git, and installing it there takes admin rights. Run this on the server, then look again:
                    </span>
                    <div className="flex items-center gap-2">
                      <CommandChip command={step.survey.gitCommand} />
                      <Button variant="ghost" size="sm" onClick={() => void look()}>
                        Look again
                      </Button>
                    </div>
                  </>
                )}
              </div>
            ))}
          </div>
        )}

        {(step.kind === "installing" || (step.kind === "connecting" && log.length > 0)) && (
          <div className="max-h-56 overflow-auto rounded-md border border-border px-2 py-1.5 dark:border-input">
            <pre className="font-mono text-code break-all whitespace-pre-wrap text-muted-foreground">
              {log.join("\n") || "Logging in…"}
            </pre>
            <div ref={logEnd} />
          </div>
        )}

        {step.kind === "signing_in" && (
          <div className="max-h-[50vh] overflow-auto">
            <AccountsSettings cwd="" only={step.id} />
          </div>
        )}

        {stillWaiting && !shownError && (
          <p className="flex items-center gap-2 text-ui text-muted-foreground">
            <Spinner className="size-3.5" />
            {step.kind === "looking"
              ? `Looking at ${name}…`
              : step.kind === "installing"
                ? "Installing…"
                : "Starting the server…"}
          </p>
        )}
        {shownError && <p className="text-ui text-destructive">{shownError}</p>}

        <div className="flex justify-end gap-2">
          {step.kind === "signing_in" ? (
            <Button onClick={onClose} autoFocus>
              Done
            </Button>
          ) : (
            <>
              {!locked && (
                <Button variant="ghost" onClick={onClose}>
                  Cancel
                </Button>
              )}
              {step.kind === "looking" && error && <Button onClick={() => void look()}>Try again</Button>}
              {step.kind === "picking" && linux && <Button onClick={() => void install()}>Install</Button>}
              {step.kind === "installing" && error && <Button onClick={() => void install()}>Try again</Button>}
              {step.kind === "connecting" && shownError && <Button onClick={() => void finish()}>Try again</Button>}
            </>
          )}
        </div>
      </DialogContent>
    </Dialog>
  );
}
