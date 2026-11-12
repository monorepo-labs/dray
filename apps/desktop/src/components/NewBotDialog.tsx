import { useState, type ReactNode } from "react";

import BotAvatar from "@/components/BotAvatar";
import ServerFilledIcon from "@/components/icons/ServerFilledIcon";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogTitle } from "@/components/ui/dialog";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Input } from "@/components/ui/input";
import { DEFAULT_AVATAR, HUES, SHAPES, swatch } from "@/lib/botAvatar";
import { refreshBots } from "@/lib/bots";
import { serverName, useServers } from "@/lib/servers";
import { invoke, LOCAL, type ServerId } from "@/lib/transport";
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
  server,
  onServerChange,
  picker,
  pick,
  onStarted,
}: {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /// Where the bot is made and runs: its folder, its chat and its tasks.
  server: ServerId;
  onServerChange: (server: ServerId) => void;
  /// The composer's own agent and model picker, bound to `pick`.
  picker: ReactNode;
  pick: BotPick;
  onStarted: (chat: SessionIndexItem) => void;
}) {
  const [name, setName] = useState("");
  const [avatar, setAvatar] = useState<Avatar>(DEFAULT_AVATAR);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  // A bot already made whose first chat failed to start: a retry starts it
  // again rather than making a second bot beside it.
  const [made, setMade] = useState<Bot | null>(null);

  const close = (next: boolean) => {
    onOpenChange(next);
    if (!next) {
      setName("");
      setAvatar(DEFAULT_AVATAR);
      setError(null);
      setMade(null);
    }
  };

  const create = async () => {
    if (!name.trim() || busy) return;
    setBusy(true);
    try {
      let bot = made;
      if (!bot) {
        bot = await invoke<Bot>("create_bot", { name: name.trim(), avatar }, server);
        setMade(bot);
        await refreshBots(server);
      }
      const chat = await invoke<SessionIndexItem>("start_bot", { id: bot.id, ...pick }, server);
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

        <div className="flex justify-center gap-1">
          {/* Locked once the bot is made: a retry starts that bot, which lives
              on the server it was made on. */}
          <ServerPicker value={server} onChange={onServerChange} disabled={!!made} />
          {picker}
        </div>

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

/// Which server the bot is made on: This Mac and every remote turned on, an
/// unreachable one disabled. Draws nothing with no remote to choose from.
function ServerPicker({
  value,
  onChange,
  disabled,
}: {
  value: ServerId;
  onChange: (server: ServerId) => void;
  disabled: boolean;
}) {
  const remotes = useServers().filter((s) => s.on);
  if (remotes.length === 0) return null;
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          disabled={disabled}
          aria-label="Server"
          className="max-w-40 gap-1.5 px-1.5 text-ui text-muted-foreground"
        >
          <ServerFilledIcon className="size-3.5 shrink-0" />
          <span className="truncate">{serverName(value)}</span>
        </Button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-auto max-w-96 min-w-40">
        <DropdownMenuRadioGroup value={value} onValueChange={onChange}>
          <DropdownMenuRadioItem value={LOCAL} className="text-ui">
            {serverName(LOCAL)}
          </DropdownMenuRadioItem>
          {remotes.map((s) => (
            <DropdownMenuRadioItem key={s.id} value={s.id} disabled={s.status !== "connected"} className="text-ui">
              <span className="truncate">{s.name}</span>
              {s.status !== "connected" && <span className="ml-auto shrink-0 pl-3 opacity-70">disconnected</span>}
            </DropdownMenuRadioItem>
          ))}
        </DropdownMenuRadioGroup>
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
