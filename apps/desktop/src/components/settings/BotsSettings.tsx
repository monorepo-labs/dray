import { useEffect, useId, useState } from "react";

import { Button } from "@/components/ui/button";
import { Input, inputClassName } from "@/components/ui/input";
import { refreshBots, useBots } from "@/lib/bots";
import { invoke } from "@/lib/transport";
import { cn } from "@/lib/utils";
import type { Bot, BotDetail } from "@/types/events";

const TEXTAREA = cn(
  inputClassName,
  "field-sizing-content h-auto max-h-80 min-h-20 resize-none py-1.5 text-ui md:text-ui",
);

/// Settings › Bots: make a bot, and edit what it is told and what it remembers.
export default function BotsSettings() {
  const bots = useBots();
  const [creating, setCreating] = useState(false);
  const [open, setOpen] = useState<string | null>(null);

  return (
    <section className="flex flex-col gap-3">
      {bots.map((bot) =>
        open === bot.id ? (
          <BotEditor key={bot.id} bot={bot} onClose={() => setOpen(null)} />
        ) : (
          <button
            key={bot.id}
            type="button"
            onClick={() => setOpen(bot.id)}
            className="flex h-9 items-center rounded-lg border border-border px-3 text-left text-ui hover:bg-muted/50"
          >
            {bot.name}
          </button>
        ),
      )}

      {creating ? (
        <NewBot onDone={() => setCreating(false)} />
      ) : (
        <Button type="button" variant="outline" size="sm" className="self-start" onClick={() => setCreating(true)}>
          New bot
        </Button>
      )}
    </section>
  );
}

function NewBot({ onDone }: { onDone: () => void }) {
  const [name, setName] = useState("");
  const [instructions, setInstructions] = useState("");
  const [error, setError] = useState<string | null>(null);
  const create = async () => {
    try {
      await invoke("create_bot", { name, instructions });
      await refreshBots();
      onDone();
    } catch (e) {
      setError(String(e));
    }
  };
  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <Fields
        name={name}
        onName={setName}
        instructions={instructions}
        onInstructions={setInstructions}
      />
      {error && <p className="text-ui text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={!name.trim()} onClick={() => void create()}>
          Create
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onDone}>
          Cancel
        </Button>
      </div>
    </div>
  );
}

function BotEditor({ bot, onClose }: { bot: Bot; onClose: () => void }) {
  const [detail, setDetail] = useState<BotDetail | null>(null);
  const [name, setName] = useState(bot.name);
  const [instructions, setInstructions] = useState("");
  const [memory, setMemory] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [deleting, setDeleting] = useState(false);
  const memoryId = useId();

  useEffect(() => {
    invoke<BotDetail>("read_bot", { id: bot.id })
      .then((d) => {
        setDetail(d);
        setInstructions(d.instructions);
        setMemory(d.memory);
      })
      .catch((e) => setError(String(e)));
  }, [bot.id]);

  const save = async () => {
    try {
      await invoke("update_bot", { id: bot.id, name, instructions, memory });
      await refreshBots();
      onClose();
    } catch (e) {
      setError(String(e));
    }
  };
  const remove = async () => {
    try {
      await invoke("delete_bot", { id: bot.id });
      await refreshBots();
    } catch (e) {
      setError(String(e));
    }
  };

  return (
    <div className="flex flex-col gap-3 rounded-lg border border-border p-3">
      <Fields name={name} onName={setName} instructions={instructions} onInstructions={setInstructions} />
      <div className="flex flex-col gap-1.5">
        <label htmlFor={memoryId} className="text-ui text-muted-foreground">
          Memory
        </label>
        <textarea
          id={memoryId}
          value={memory}
          onChange={(e) => setMemory(e.target.value)}
          placeholder="Nothing yet. The bot writes here as it learns."
          className={TEXTAREA}
        />
      </div>
      <p className="text-ui text-muted-foreground">
        Changes reach the bot the next time its chat starts. Its folder: {bot.path}
      </p>
      {error && <p className="text-ui text-destructive">{error}</p>}
      <div className="flex gap-2">
        <Button type="button" size="sm" disabled={!detail || !name.trim()} onClick={() => void save()}>
          Save
        </Button>
        <Button type="button" size="sm" variant="ghost" onClick={onClose}>
          Cancel
        </Button>
        {/* Two presses, since it takes the bot's memory with it. */}
        <Button
          type="button"
          size="sm"
          variant="destructive"
          className="ml-auto"
          onClick={() => (deleting ? void remove() : setDeleting(true))}
        >
          {deleting ? "Delete for good" : "Delete bot"}
        </Button>
      </div>
    </div>
  );
}

function Fields({
  name,
  onName,
  instructions,
  onInstructions,
}: {
  name: string;
  onName: (name: string) => void;
  instructions: string;
  onInstructions: (text: string) => void;
}) {
  const nameId = useId();
  const instructionsId = useId();
  return (
    <>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={nameId} className="text-ui text-muted-foreground">
          Name
        </label>
        <Input
          id={nameId}
          value={name}
          onChange={(e) => onName(e.target.value)}
          placeholder="Ops"
          className="text-ui md:text-ui"
        />
      </div>
      <div className="flex flex-col gap-1.5">
        <label htmlFor={instructionsId} className="text-ui text-muted-foreground">
          Instructions
        </label>
        <textarea
          id={instructionsId}
          value={instructions}
          onChange={(e) => onInstructions(e.target.value)}
          placeholder="What this bot is for and how it should work."
          className={TEXTAREA}
        />
      </div>
    </>
  );
}
