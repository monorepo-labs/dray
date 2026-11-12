import { useState, type ReactNode } from "react";

import BotAvatar from "@/components/BotAvatar";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { DEFAULT_AVATAR, HUES, SHAPES, swatch } from "@/lib/botAvatar";
import { refreshBots } from "@/lib/bots";
import { invoke } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type {
  ApprovalPolicy,
  Bot,
  BotAvatar as Avatar,
  Effort,
  Harness,
  ModelId,
  SessionIndexItem,
} from "@/types/events";

/// What the bot's chat runs on, as the composer's picker has it.
export type BotPick = {
  harness: Harness;
  model: ModelId;
  effort: Effort | null;
  permissionMode: ApprovalPolicy;
  fast: boolean;
};

/// Makes a bot — a name, a face and what it runs on — and starts its chat with
/// the bot speaking first. Its job is told in reply, never in a form.
export default function NewBotDialog({
  open,
  onOpenChange,
  picker,
  pick,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /// The composer's own agent and model picker, bound to `pick`.
  picker: ReactNode;
  pick: BotPick;
  onStarted: (chat: SessionIndexItem) => void;
}) {
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<Avatar>(DEFAULT_AVATAR);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setName("");
      setAvatar(DEFAULT_AVATAR);
      setError(null);
    }
  };

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      const bot = await invoke<Bot>("create_bot", { name: name.trim(), avatar });
      await refreshBots();
      const chat = await invoke<SessionIndexItem>("start_bot", { id: bot.id, ...pick });
      close(false);
      onStarted(chat);
    } catch (e) {
      setError(String(e));
    } finally {
      setBusy(false);
    }
  };

  // A fixed seed for the picker, so the faces differ by shape and colour alone.
  const seed = "new-bot";

  return (
    <Dialog open={open} onOpenChange={close}>
      <DialogContent className="max-w-96 gap-5">
        <DialogTitle>New bot</DialogTitle>

        <BotAvatar seed={seed} avatar={avatar} animate="always" className="mx-auto size-24" />

        <form
          onSubmit={(e) => {
            e.preventDefault();
            void create();
          }}
        >
          <Input
            autoFocus
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Name your bot"
            aria-label="Bot name"
            className="text-center text-ui md:text-ui"
          />
        </form>

        <div role="radiogroup" aria-label="Shape" className="grid grid-cols-5 justify-items-center gap-2">
          {SHAPES.map((shape) => (
            <button
              key={shape.name}
              type="button"
              role="radio"
              aria-checked={avatar.shape === shape.name}
              aria-label={shape.name}
              onClick={() => setAvatar((a) => ({ ...a, shape: shape.name }))}
              className={cn(
                "flex size-12 cursor-pointer items-center justify-center rounded-full transition-colors hover:bg-muted/60",
                avatar.shape === shape.name && "ring-2 ring-ring/60",
              )}
            >
              <BotAvatar seed={seed} avatar={{ shape: shape.name, hue: avatar.hue }} className="size-9" />
            </button>
          ))}
        </div>

        <div role="radiogroup" aria-label="Colour" className="flex flex-wrap justify-center gap-2.5">
          {HUES.map((colour) => (
            <button
              key={colour.hue}
              type="button"
              role="radio"
              aria-checked={avatar.hue === colour.hue}
              aria-label={colour.name}
              onClick={() => setAvatar((a) => ({ ...a, hue: colour.hue }))}
              style={{ background: swatch(colour.hue) }}
              className={cn(
                "size-7 cursor-pointer rounded-full ring-offset-2 ring-offset-popover",
                avatar.hue === colour.hue && "ring-2 ring-ring/70",
              )}
            />
          ))}
        </div>

        <div className="flex justify-center">{picker}</div>

        {error && <p className="text-ui text-destructive">{error}</p>}

        <div className="flex justify-end gap-2">
          <Button type="button" variant="outline" size="sm" onClick={() => close(false)}>
            Cancel
          </Button>
          <Button type="button" size="sm" disabled={!name.trim() || busy} onClick={() => void create()}>
            Create
          </Button>
        </div>
      </DialogContent>
    </Dialog>
  );
}
