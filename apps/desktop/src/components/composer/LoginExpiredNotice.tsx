import { useEffect, useRef, useState } from "react";
import { Check, Copy, KeyRound, SquareTerminal, TriangleAlert } from "lucide-react";
import { invoke } from "@tauri-apps/api/core";

import { Button } from "@/components/ui/button";
import { Tooltip, TooltipContent, TooltipTrigger } from "@/components/ui/tooltip";
import { cn } from "@/lib/utils";
import type { AgentAvailability } from "@/types/events";

const COPIED_MS = 1600;
const FAILED_MS = 4000;

/// Why the composer will not send when the agent's login has run out, and the
/// two ways through it.
///
/// Frame, placement and the buttons-right row are [AgentMissingNotice]'s, and
/// deliberately so: both say "nothing can be attempted yet, here is the cure",
/// which is what the composer's `notice` slot is for. Two shapes for one kind
/// of statement would read as two different kinds.
///
/// **Sending stays blocked, which is the point.** Retyping prompts that can
/// never work is the whole complaint this answers, so the slot's own gate is
/// the feature rather than a side effect.
///
/// **Either button clears it, because nothing else can.** No signal comes back
/// from a terminal — the reader logs in over there and the app never hears —
/// so the acknowledgement has to be theirs. Both buttons mean "I am dealing
/// with this", so both count. If they were not, the next turn fails on auth
/// and the notice returns under a new id: self-correcting, with no polling and
/// no retry button to explain.
///
/// **Log in trails, against its sibling's order.** There the two buttons are
/// alternatives — copy the command or read the guide — so the likelier one
/// leads. Here they are one action and its escape hatch, and the action the
/// notice exists for belongs where the row ends rather than where it starts.
///
/// **The launch is Terminal.app's, the copy is anyone's.** Only Terminal runs
/// a command handed to `open` (measured — Ghostty and Warp accept it and run
/// nothing), so the button cannot honour the terminal picked next door. The
/// copied command is the escape hatch for a reader who lives in one of those,
/// and it is spelled the way they would type it rather than as the absolute
/// path the script uses.
export default function LoginExpiredNotice({
  agent,
  cwd,
  onHandled,
}: {
  agent: AgentAvailability;
  cwd: string;
  onHandled: () => void;
}) {
  const [copied, setCopied] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const copiedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const errorTimer = useRef<ReturnType<typeof setTimeout> | null>(null);

  useEffect(
    () => () => {
      if (copiedTimer.current) clearTimeout(copiedTimer.current);
      if (errorTimer.current) clearTimeout(errorTimer.current);
    },
    [],
  );

  const logIn = async () => {
    try {
      await invoke("open_login_terminal", { harness: agent.harness, cwd });
    } catch (err) {
      // A failed launch must not clear the block: nothing was opened, so the
      // reader has not been handed the cure yet.
      setError(typeof err === "string" ? err : "Could not open Terminal.");
      if (errorTimer.current) clearTimeout(errorTimer.current);
      errorTimer.current = setTimeout(() => setError(null), FAILED_MS);
      return;
    }
    onHandled();
  };

  const copy = async () => {
    try {
      await navigator.clipboard.writeText(agent.loginCommand);
    } catch (err) {
      console.error("failed to copy the login command", err);
      return;
    }
    setCopied(true);
    if (copiedTimer.current) clearTimeout(copiedTimer.current);
    copiedTimer.current = setTimeout(() => setCopied(false), COPIED_MS);
    onHandled();
  };

  return (
    <div className="mb-2 flex items-center gap-3 rounded-xl border border-border/60 px-3 py-2">
      {/* The one notice in this slot that takes a mark. Its sibling
          [AgentMissingNotice] spends a whole sentence on the consequence and
          needs none; this line is four words, so the glyph carries what they
          dropped. A key rather than an alert: the row's other glyph is
          [TriangleAlert] on a failed launch, and two warning marks a gap apart
          would read as one thing having gone wrong twice. */}
      {/* The mark and its line are one thing, so they get their own tighter
          gap — the row's `gap-3` is the distance between the statement and the
          buttons answering it, and at that width the glyph read as a third
          item rather than as part of the sentence. `gap-2` is what [Notice]
          already sets an icon against a sentence at. */}
      <div className="flex min-w-0 flex-1 items-center gap-2">
        <KeyRound className="size-3.5 shrink-0 text-muted-foreground" />
        {/* The hint sits under the sentence, not in the Log in button's
            tooltip. pi's command opens a TUI rather than starting a login, so
            a reader who clicks without hovering would otherwise arrive there
            having never been told to type `/login`. Absent for the harnesses
            whose command is the whole cure, which keeps this one line for
            them. */}
        <div className="min-w-0">
          <p className="truncate text-ui text-foreground">
            {agent.label} isn&rsquo;t logged in
          </p>
          {agent.loginHint && (
            <p className="truncate text-ui text-muted-foreground">{agent.loginHint}</p>
          )}
        </div>
      </div>

      <div className="flex shrink-0 items-center gap-1.5">
        <Button variant="ghost" size="sm" onClick={() => void copy()}>
          {copied ? <Check className="size-3.5" /> : <Copy className="size-3.5" />}
          {copied ? "Copied" : "Copy command"}
        </Button>

        {/* Keyed so a settled failure starts a fresh instance: flipping `open`
            between `true` and `undefined` swaps controlled for uncontrolled and
            Radix keeps its stale open state across it. Same treatment
            [OpenInButton] gives a failed launch, for the same reason — `open`'s
            own sentence is the only thing naming the cure. */}
        <Tooltip key={error ? "failed" : "idle"} open={error ? true : undefined}>
          <TooltipTrigger asChild>
            <Button
              variant="secondary"
              size="sm"
              className={cn(error && "text-destructive")}
              onClick={() => void logIn()}
            >
              {error ? (
                <TriangleAlert className="size-3.5" />
              ) : (
                // The mark says where this goes before it is pressed. Logging
                // in leaves the app for a terminal, which is a bigger thing to
                // discover after the fact than a copied string is.
                <SquareTerminal className="size-3.5" />
              )}
              Log in
            </Button>
          </TooltipTrigger>
          <TooltipContent side="bottom" className={cn(error && "max-w-xs text-wrap")}>
            {error ?? `Runs ${agent.loginCommand} in Terminal`}
          </TooltipContent>
        </Tooltip>
      </div>
    </div>
  );
}
