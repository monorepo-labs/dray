import { useEffect, useState } from "react";

import { Kbd, KbdGroup } from "@/components/ui/kbd";
import { Switch } from "@/components/ui/switch";
import { cn } from "@/lib/utils";
import type { Bot } from "@/types/events";

import BotSetupChat from "./BotSetupChat";
import Checklist from "./Checklist";
import Steps from "./Steps";
import Tour from "./Tour";
import { useAgentSetup } from "./agents";
import {
  finishOnboarding,
  replayOnboarding,
  setFreshMachine,
  useFreshMachine,
  useOnboarding,
  useOnboardingPick,
  VARIANTS,
} from "./state";

export type OnboardingProps = {
  /// Dray Bot, the one the flows introduce.
  bot: Bot | undefined;
  /// Its chat has a first message.
  chatStarted: boolean;
  settingsOpen: boolean;
  onOpenBot: () => void;
  /// Sends `text` to the bot, opening its chat first; empty focuses its composer.
  onAsk: (text: string) => void;
  /// Settings → Agents, for the sign-ins a menu cannot carry.
  onMore: () => void;
};

/// Whichever onboarding flow the dev switch picked, over the app. The bot-led
/// chat is drawn by `App` in the chat column instead, as `OnboardingChat`.
export default function Onboarding(props: OnboardingProps) {
  const { variant, run } = useOnboarding();
  const { onOpenBot } = props;
  // The in-app flows start on the bot's chat.
  useEffect(() => {
    if (variant && variant !== "steps") onOpenBot();
    // Once per replay; `onOpenBot` is rebuilt every render.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [variant, run]);

  return (
    <>
      {import.meta.env.DEV && <DevSwitch />}
      {variant && variant !== "chat" && !props.settingsOpen && <Flow key={run} variant={variant} {...props} />}
    </>
  );
}

function Flow({ variant, bot, chatStarted, onAsk, onMore }: OnboardingProps & { variant: "steps" | "checklist" | "tour" }) {
  const setup = useAgentSetup();
  // A chat already there when this run began doesn't tick the checklist, so a
  // replay starts from nothing done.
  const [hadChat] = useState(chatStarted);
  const [said, setSaid] = useState(false);
  const ask = (text: string) => {
    if (variant !== "checklist") finishOnboarding();
    if (text) setSaid(true);
    onAsk(text);
  };
  if (variant === "steps")
    return (
      <Steps
        setup={setup}
        bot={bot}
        onMore={onMore}
        onSay={ask}
        onWrite={() => ask("")}
        onSkip={() => ask("")}
      />
    );
  if (variant === "checklist")
    return (
      <Checklist
        setup={setup}
        bot={bot}
        chatStarted={said || (chatStarted && !hadChat)}
        onMore={onMore}
        onSay={ask}
        onWrite={() => ask("")}
        onClose={finishOnboarding}
      />
    );
  return <Tour setup={setup} bot={bot} onMore={onMore} onSay={ask} onDone={finishOnboarding} />;
}

/// The bot-led chat, for `App` to draw in place of the bot's welcome.
export function OnboardingChat({
  welcome,
  onAsk,
  onMore,
}: {
  welcome: string | undefined;
  onAsk: (text: string) => void;
  onMore: () => void;
}) {
  const setup = useAgentSetup();
  return (
    <BotSetupChat
      welcome={welcome}
      setup={setup}
      onMore={onMore}
      onSay={(text) => {
        finishOnboarding();
        onAsk(text);
      }}
    />
  );
}

/// ⌘⇧O: pick a flow and play it from the start, or turn onboarding off.
function DevSwitch() {
  const [open, setOpen] = useState(false);
  const pick = useOnboardingPick();
  const fresh = useFreshMachine();

  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.metaKey || e.ctrlKey) && e.shiftKey && !e.altKey && e.code === "KeyO") {
        e.preventDefault();
        e.stopPropagation();
        setOpen((was) => !was);
      }
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, []);

  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => {
      const digit = Number(e.key);
      if (e.key === "Escape") setOpen(false);
      else if (e.key === "0") replayOnboarding(null);
      else if (digit >= 1 && digit <= VARIANTS.length) replayOnboarding(VARIANTS[digit - 1].id);
      else return;
      e.preventDefault();
      e.stopPropagation();
      setOpen(false);
    };
    window.addEventListener("keydown", onKey, true);
    return () => window.removeEventListener("keydown", onKey, true);
  }, [open]);

  if (!open) return null;
  const row = (label: string, key: string, current: boolean, onClick: () => void) => (
    <button
      key={key}
      type="button"
      onClick={() => {
        onClick();
        setOpen(false);
      }}
      className={cn(
        "flex h-8 cursor-pointer items-center gap-2 rounded-md px-2 text-left text-ui hover:bg-muted",
        current && "font-medium",
      )}
    >
      <Kbd>{key}</Kbd>
      <span className="flex-1">{label}</span>
      {current && <span className="text-xs text-muted-foreground">current</span>}
    </button>
  );

  return (
    <div className="fixed top-12 right-3 z-[60] flex w-64 flex-col rounded-xl bg-popover p-1.5 text-popover-foreground shadow-(--shadow-ring) backdrop-blur-xl animate-in fade-in zoom-in-95">
      <div className="flex items-center justify-between px-2 pt-1 pb-1.5">
        <span className="text-ui font-medium">Onboarding</span>
        <KbdGroup>
          <Kbd>⌘</Kbd>
          <Kbd>⇧</Kbd>
          <Kbd>O</Kbd>
        </KbdGroup>
      </div>
      {VARIANTS.map((v, i) => row(v.label, String(i + 1), pick === v.id, () => replayOnboarding(v.id)))}
      {row("Off", "0", pick === null, () => replayOnboarding(null))}
      <label className="mt-1 flex h-8 cursor-pointer items-center gap-2 border-t border-hairline px-2 pt-1 text-ui">
        <Switch checked={fresh} onCheckedChange={setFreshMachine} />
        Show agents as not set up
      </label>
    </div>
  );
}
