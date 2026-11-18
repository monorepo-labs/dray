import { openUrl } from "@tauri-apps/plugin-opener";
import { Check } from "lucide-react";
import { useEffect, useState } from "react";

import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogTitle } from "@/components/ui/dialog";
import Spinner from "@/components/ui/spinner";
import { refreshCloudAccount, setupSteps, useCloudAccount, type Step, type StepId } from "@/lib/cloudAccount";
import { invoke, LOCAL } from "@/lib/transport";
import { cn } from "@/lib/utils";

/// Every step but sign-in finishes in the browser, which tells the app
/// nothing, so the account is read again this often while the sheet is open.
const REREAD_MS = 4000;

/// Dray Cloud's first-run setup (#1021): sign in, choose a plan, connect
/// GitHub, connect Claude or Codex. Raised by picking Cloud before all four
/// are done; each step says what is missing and opens where it gets done.
/// `onReady` is the pick going through, offered once every step is done.
export default function CloudSetup({
  open,
  onOpenChange,
  slug,
  onReady,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /// The project's `owner/repo`, which the GitHub step checks the App reaches.
  slug: string | null;
  onReady: () => void;
}) {
  const { account, error, loaded } = useCloudAccount();
  const [opened, setOpened] = useState<Set<StepId>>(new Set());
  const [signInError, setSignInError] = useState<string | null>(null);
  const canSignIn = useSignInAvailable(open);

  useEffect(() => {
    if (!open) return;
    void refreshCloudAccount();
    const timer = setInterval(() => void refreshCloudAccount(), REREAD_MS);
    const onFocus = () => void refreshCloudAccount();
    window.addEventListener("focus", onFocus);
    return () => {
      clearInterval(timer);
      window.removeEventListener("focus", onFocus);
      setOpened(new Set());
      setSignInError(null);
    };
  }, [open]);

  const steps = setupSteps(account, slug);
  const done = steps.filter((s) => s.done).length;
  const next = steps.find((s) => !s.done)?.id;

  const act = async (step: Step) => {
    setOpened((was) => new Set(was).add(step.id));
    if (step.id !== "signIn") {
      if (step.url) await openUrl(step.url).catch(console.error);
      return;
    }
    setSignInError(null);
    try {
      // #889's sign-in: This Mac's link flow, with the app's sign-in riding it.
      const pending = await invoke<{ url: string }>("org_link_start", { signIn: true }, LOCAL);
      await openUrl(pending.url);
    } catch (e) {
      setSignInError(String(e));
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md gap-5">
        <div className="flex flex-col gap-1.5">
          <DialogTitle>Set up Dray Cloud</DialogTitle>
          <DialogDescription>
            A task on Cloud gets a machine of its own and keeps working with your computer closed.
          </DialogDescription>
        </div>

        <ol className="flex flex-col gap-1">
          {steps.map((step, i) => {
            const waiting = opened.has(step.id) && !step.done;
            const signInBlocked = step.id === "signIn" && !step.done && canSignIn === false;
            const detail = signInBlocked
              ? "This build can't sign in to Dray yet. Update Dray."
              : step.id === "signIn" && signInError
                ? signInError
                : waiting
                  ? "Finish in your browser. This updates on its own."
                  : step.detail;
            const showButton = !step.done && !signInBlocked && (step.id === "signIn" ? canSignIn !== false : !!step.url);
            return (
              <li key={step.id} className="flex items-center gap-3 rounded-md px-1 py-2">
                <StepMark index={i + 1} done={step.done} waiting={waiting} />
                <div className="flex min-w-0 flex-1 flex-col">
                  <span className={cn("text-ui", step.done ? "text-muted-foreground" : "font-medium")}>{step.title}</span>
                  <span
                    className={cn(
                      "text-ui text-muted-foreground",
                      step.id === "signIn" && signInError && "text-destructive",
                    )}
                  >
                    {detail}
                  </span>
                </div>
                {showButton && (
                  <Button
                    size="sm"
                    variant={step.id === next && !waiting ? "default" : "outline"}
                    className="shrink-0"
                    onClick={() => void act(step)}
                  >
                    {waiting ? "Open again" : step.verb}
                  </Button>
                )}
              </li>
            );
          })}
        </ol>

        {error && <p className="text-ui text-destructive">{error}</p>}

        <div className="flex items-center justify-end gap-2">
          <span className="mr-auto text-ui text-muted-foreground">
            {!loaded ? "Checking…" : `${done} of ${steps.length} done`}
          </span>
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            Not now
          </Button>
          <Button
            size="sm"
            disabled={done < steps.length}
            onClick={() => {
              onReady();
              onOpenChange(false);
            }}
          >
            Use Cloud
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}

function StepMark({ index, done, waiting }: { index: number; done: boolean; waiting: boolean }) {
  if (waiting) {
    return (
      <span className="flex size-5 shrink-0 items-center justify-center text-muted-foreground">
        <Spinner className="size-3.5" />
      </span>
    );
  }
  return (
    <span
      aria-label={done ? "Done" : undefined}
      className={cn(
        "flex size-5 shrink-0 items-center justify-center rounded-full text-xs tabular-nums",
        done ? "bg-primary text-primary-foreground" : "border border-border text-muted-foreground",
      )}
    >
      {done ? <Check className="size-3" strokeWidth={3} /> : index}
    </span>
  );
}

/// Whether this build's server can sign the app in: #889's `account_state`
/// answers where it can. Null until known.
function useSignInAvailable(open: boolean): boolean | null {
  const [able, setAble] = useState<boolean | null>(null);
  useEffect(() => {
    if (!open || able !== null) return;
    let live = true;
    invoke("account_state", {}, LOCAL)
      .then(() => live && setAble(true))
      // Any other failure is the server being away, not too old: let it try.
      .catch((e) => live && setAble(!String(e).includes("unknown command")));
    return () => {
      live = false;
    };
  }, [open, able]);
  return able;
}
