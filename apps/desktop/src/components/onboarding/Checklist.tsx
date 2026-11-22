import { useState, type ReactNode } from "react";
import { Check, ChevronDown, X } from "lucide-react";

import { Button } from "@/components/ui/button";
import { cn } from "@/lib/utils";
import type { Bot } from "@/types/events";

import { AgentList, type AgentSetup } from "./agents";
import { STARTERS } from "./state";

/// Variation B: the app opens as usual, with a "Get started" card in What's
/// New's corner that ticks itself off as the reader goes.
export default function Checklist({
  setup,
  bot,
  chatStarted,
  onMore,
  onSay,
  onWrite,
  onClose,
}: {
  setup: AgentSetup;
  bot: Bot | undefined;
  chatStarted: boolean;
  onMore: () => void;
  onSay: (text: string) => void;
  onWrite: () => void;
  onClose: () => void;
}) {
  const agentsDone = setup.ready.length > 0;
  const done = [agentsDone, chatStarted].filter(Boolean).length;
  // Which item is open: the first not done, until the reader picks another.
  const [picked, setPicked] = useState<0 | 1 | null>(null);
  const open = picked ?? (agentsDone ? 1 : 0);
  const [folded, setFolded] = useState(false);
  const name = bot?.name ?? "Dray Bot";

  if (folded)
    return (
      <button
        type="button"
        onClick={() => setFolded(false)}
        className="fixed bottom-3 left-3 z-50 flex cursor-pointer items-center gap-2 rounded-lg bg-popover px-3 py-2 text-ui font-medium text-popover-foreground shadow-(--shadow-ring) backdrop-blur-xl animate-in fade-in"
      >
        <Ring done={done} />
        Get started
        <span className="text-muted-foreground">{done}/2</span>
      </button>
    );

  return (
    <div
      role="region"
      aria-label="Get started"
      className="fixed bottom-3 left-3 z-50 flex w-80 flex-col overflow-hidden rounded-xl bg-popover text-popover-foreground shadow-(--shadow-ring) backdrop-blur-xl animate-in fade-in slide-in-from-bottom-2"
    >
      <div className="flex items-center gap-2 px-3 pt-2.5 pb-1">
        <Ring done={done} />
        <span className="text-ui font-medium">Get started</span>
        <span className="text-ui text-muted-foreground">{done}/2</span>
        <span className="ml-auto flex">
          <Button variant="ghost" size="icon-sm" aria-label="Minimize" onClick={() => setFolded(true)}>
            <ChevronDown />
          </Button>
          <Button variant="ghost" size="icon-sm" aria-label="Close" onClick={onClose}>
            <X />
          </Button>
        </span>
      </div>

      {done === 2 ? (
        <div className="flex flex-col gap-2 px-3 pt-1 pb-3">
          <p className="text-ui text-muted-foreground">You're all set.</p>
          <Button size="sm" onClick={onClose}>
            Done
          </Button>
        </div>
      ) : (
        <div className="flex flex-col p-1.5 pt-0">
          <Item index={1} title="Set up an agent" done={agentsDone} open={open === 0} onOpen={() => setPicked(0)}>
            <AgentList setup={setup} onMore={onMore} className="px-1" />
          </Item>
          <Item index={2} title={`Say hi to ${name}`} done={chatStarted} open={open === 1} onOpen={() => setPicked(1)}>
            <div className="flex flex-col items-start gap-1 px-1 pb-1">
              {STARTERS.map((text) => (
                <Button
                  key={text}
                  variant="outline"
                  size="sm"
                  disabled={!agentsDone}
                  className="max-w-full justify-start truncate"
                  onClick={() => onSay(text)}
                >
                  {text}
                </Button>
              ))}
              <Button variant="ghost" size="sm" className="text-muted-foreground" onClick={onWrite}>
                Write your own
              </Button>
            </div>
          </Item>
        </div>
      )}
    </div>
  );
}

function Item({
  index,
  title,
  done,
  open,
  onOpen,
  children,
}: {
  index: number;
  title: string;
  done: boolean;
  open: boolean;
  onOpen: () => void;
  children: ReactNode;
}) {
  return (
    <div className={cn("flex flex-col rounded-lg", open && "bg-muted/50")}>
      <button
        type="button"
        onClick={onOpen}
        aria-expanded={open}
        className="flex h-9 cursor-pointer items-center gap-2.5 rounded-lg px-2 text-left text-ui"
      >
        <span
          aria-hidden
          className={cn(
            "flex size-4.5 shrink-0 items-center justify-center rounded-full text-[10px] font-medium",
            done ? "bg-accent-add text-white" : "border border-border text-muted-foreground",
          )}
        >
          {done ? <Check className="size-3" strokeWidth={3} /> : index}
        </span>
        <span className={cn("flex-1", done && "text-muted-foreground line-through decoration-muted-foreground/40")}>{title}</span>
      </button>
      {open && <div className="px-1 pb-1.5 animate-in fade-in">{children}</div>}
    </div>
  );
}

/// Progress as a ring, half per item.
function Ring({ done }: { done: number }) {
  const c = 2 * Math.PI * 6;
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" aria-hidden className="-rotate-90">
      <circle cx="8" cy="8" r="6" fill="none" stroke="currentColor" strokeOpacity={0.15} strokeWidth="2" />
      <circle
        cx="8"
        cy="8"
        r="6"
        fill="none"
        stroke="var(--accent-add)"
        strokeWidth="2"
        strokeDasharray={c}
        strokeDashoffset={c * (1 - done / 2)}
        strokeLinecap="round"
        className="transition-[stroke-dashoffset] duration-500"
      />
    </svg>
  );
}
