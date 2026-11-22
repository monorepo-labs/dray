import type { CSSProperties, ReactNode } from "react";

import AssistantMessage from "@/components/chat/AssistantMessage";
import { BotBubble } from "@/components/chat/BotTranscript";
import { Button } from "@/components/ui/button";

import { AgentList, type AgentSetup } from "./agents";
import { STARTERS } from "./state";

/// Variation C: the bot does the setup by talking. Drawn in the bot's chat
/// column in place of its welcome; the first message sent ends it.
export default function BotSetupChat({
  welcome,
  setup,
  onMore,
  onSay,
}: {
  welcome: string | undefined;
  setup: AgentSetup;
  onMore: () => void;
  onSay: (text: string) => void;
}) {
  const first = setup.ready[0];
  return (
    <div className="h-full overflow-y-auto">
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 pt-6 pb-6">
        {welcome && (
          <Arrive at={0}>
            <BotBubble>
              <AssistantMessage text={welcome} />
            </BotBubble>
          </Arrive>
        )}
        <Arrive at={1}>
          <BotBubble className="w-[min(100%,26rem)]">
            <AssistantMessage text="First, your agents. Here's what's on this Mac:" />
            <div className="mt-2 rounded-lg border border-hairline bg-card px-3 py-1 shadow-(--shadow-surface)">
              <AgentList setup={setup} onMore={onMore} />
            </div>
          </BotBubble>
        </Arrive>
        {!setup.checking && (
          <Arrive at={2} key={first ? "ready" : "none"}>
            <BotBubble>
              <AssistantMessage
                text={
                  first
                    ? `${first.label} is ready. What should we start with?`
                    : "Install or sign in to one of them, and I'll pick it up from here."
                }
              />
            </BotBubble>
          </Arrive>
        )}
        {first && (
          <Arrive at={3} className="flex flex-wrap justify-end gap-1.5">
            {STARTERS.map((text) => (
              <Button key={text} variant="outline" size="sm" onClick={() => onSay(text)}>
                {text}
              </Button>
            ))}
          </Arrive>
        )}
      </div>
    </div>
  );
}

/// Messages land one after another, the way replies arrive.
function Arrive({ at, className, children }: { at: number; className?: string; children: ReactNode }) {
  const style: CSSProperties = { animationDelay: `${at * 450}ms`, animationFillMode: "both" };
  return (
    <div style={style} className={`flex flex-col animate-in fade-in slide-in-from-bottom-1 duration-300 ${className ?? ""}`}>
      {children}
    </div>
  );
}
