import { useEffect, useId, useRef, useState } from "react";
import { ArrowUp, MousePointer2, Plus, Trash2 } from "lucide-react";

import { handoffIcon } from "@/components/composer/handoffIcons";
import { ConfirmOrKeep } from "@/components/settings/InRowConfirm";
import { Grip, useRowReorder } from "@/components/settings/rowReorder";
import { Button } from "@/components/ui/button";
import { Input, inputClassName } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";
import { setHandoffConfig, useHandoffConfig } from "@/hooks/useHandoffConfig";
import { builtinHandoff, labelFromPrompt } from "@/lib/handoff";
import type { BuiltinHandoffId, CustomHandoffButton, HandoffConfig, HandoffEntry } from "@/lib/handoff";
import { cn } from "@/lib/utils";

/// When each built-in shows, which is the reason it has a switch and not a
/// text field: the rule is about the checkout, and only right for the words.
const WHEN: Record<BuiltinHandoffId, string> = {
  commit: "Shown when there are uncommitted changes.",
  pr: "Shown when the branch has work to propose and no pull request yet.",
  runServer: "Shown whenever a session is open.",
};

/// The buttons parked behind the composer's top edge: a picture of where they
/// are, then one list of built-ins and the reader's own, dragged into the order
/// the row draws them in.
export default function HandoffSettings() {
  const config = useHandoffConfig();
  // The row just added, whose label field takes focus once it is drawn.
  const [added, setAdded] = useState<string | null>(null);
  // One id, so one press leaves one question on screen.
  const [confirming, setConfirming] = useState<string | null>(null);

  const drag = useRowReorder(
    config,
    (entry) => entry.id,
    (entry, _delta, to) => {
      const next = config.filter((e) => e.id !== entry.id);
      next.splice(to, 0, entry);
      setHandoffConfig(next);
    },
  );

  const update = (id: string, patch: Partial<HandoffEntry>) =>
    setHandoffConfig(config.map((e) => (e.id === id ? ({ ...e, ...patch } as HandoffEntry) : e)));

  return (
    <>
      <RowPicture config={config} />

      <section className="flex flex-col gap-3">
        <div ref={drag.list} className="flex flex-col gap-1.5">
          {drag.shown.map((entry, i) =>
            entry.kind === "builtin" ? (
              <div key={entry.id} {...drag.row(i, "gap-4 py-2 pr-3 pl-1.5")}>
                <BuiltinRow
                  id={entry.id}
                  on={entry.on}
                  onChange={(on) => update(entry.id, { on })}
                  onGripKey={(e) => drag.onGripKey(e, i)}
                />
              </div>
            ) : (
              <div key={entry.id} {...drag.row(i, "group items-start gap-2 py-2.5 pr-3 pl-1.5")}>
                <CustomRow
                  button={entry}
                  focus={entry.id === added}
                  confirming={confirming === entry.id}
                  onAskRemove={() => setConfirming(entry.id)}
                  onKeep={() => setConfirming(null)}
                  onChange={(patch) => update(entry.id, patch)}
                  onRemove={() => {
                    setConfirming(null);
                    setHandoffConfig(config.filter((e) => e.id !== entry.id));
                  }}
                  onGripKey={(e) => drag.onGripKey(e, i)}
                />
              </div>
            ),
          )}
        </div>
        <div>
          <Button
            variant="outline"
            size="sm"
            onClick={() => {
              const id = `custom-${crypto.randomUUID()}`;
              setHandoffConfig([...config, { kind: "custom", id, label: "", prompt: "" }]);
              setAdded(id);
              setConfirming(null);
            }}
          >
            <Plus />
            Add button
          </Button>
        </div>
      </section>
    </>
  );
}

/// The composer with its row risen out of the top edge and a cursor on it,
/// since "the composer's top edge" says little until it is seen — the Island
/// tab's pictures for the same reason. Drawn with the row's own buttons and the
/// composer's own surface, from the reader's config, so a switch, a new button
/// or a move shows up here as it is made.
function RowPicture({ config }: { config: HandoffConfig }) {
  const buttons = config.flatMap((entry) => {
    if (entry.kind === "builtin") {
      return entry.on
        ? [{ key: entry.id, label: builtinHandoff(entry.id).label, Icon: handoffIcon(entry.id) }]
        : [];
    }
    const label = entry.label.trim() || labelFromPrompt(entry.prompt);
    return label ? [{ key: entry.id, label, Icon: handoffIcon(null) }] : [];
  });

  return (
    // Inert: a picture of buttons, not buttons.
    <div aria-hidden inert className="pointer-events-none flex flex-col gap-1">
      {/* `px-3` and `gap-1` are the real row's: aligned with the card's inner
          edge, and clearing its top by the reserve. */}
      <div className="relative flex h-7 gap-1 overflow-hidden px-3">
        {buttons.map(({ key, label, Icon }) => (
          <Button key={key} type="button" size="sm" variant="secondary" tabIndex={-1} className="max-w-48">
            <Icon className="size-3.5" strokeWidth={1.5} />
            <span className="truncate">{label}</span>
          </Button>
        ))}
        {buttons.length > 0 && (
          <MousePointer2
            className="absolute top-4 left-16 size-4 fill-foreground text-background"
            strokeWidth={1.5}
          />
        )}
      </div>
      {/* The composer as it sits with one line in it: send on the same line. */}
      <div className="flex h-11 items-center justify-end rounded-2xl border border-edge-surface bg-composer px-2 shadow-(--shadow-surface)">
        <span className="flex size-7 items-center justify-center rounded-full bg-primary text-primary-foreground">
          <ArrowUp className="size-4" strokeWidth={2} />
        </span>
      </div>
    </div>
  );
}

function BuiltinRow({
  id,
  on,
  onChange,
  onGripKey,
}: {
  id: BuiltinHandoffId;
  on: boolean;
  onChange: (on: boolean) => void;
  onGripKey: (e: React.KeyboardEvent) => void;
}) {
  const switchId = useId();
  const { label } = builtinHandoff(id);
  return (
    <>
      <div className="flex min-w-0 items-center gap-1.5">
        <Grip label={`Reorder ${label}`} onKeyDown={onGripKey} />
        <div className="flex min-w-0 flex-col gap-0.5">
          <label htmlFor={switchId} className="text-ui font-medium">
            {label}
          </label>
          <p className="text-ui text-muted-foreground">{WHEN[id]}</p>
        </div>
      </div>
      <Switch id={switchId} checked={on} onCheckedChange={onChange} />
    </>
  );
}

function CustomRow({
  button,
  focus,
  confirming,
  onAskRemove,
  onKeep,
  onChange,
  onRemove,
  onGripKey,
}: {
  button: CustomHandoffButton;
  focus: boolean;
  confirming: boolean;
  onAskRemove: () => void;
  onKeep: () => void;
  onChange: (patch: Partial<CustomHandoffButton>) => void;
  onRemove: () => void;
  onGripKey: (e: React.KeyboardEvent) => void;
}) {
  const labelId = useId();
  const promptId = useId();
  const label = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) label.current?.focus();
  }, [focus]);

  const fallback = labelFromPrompt(button.prompt);
  const name = button.label.trim() || fallback || "button";

  return (
    <>
      <div className="mt-6 shrink-0">
        <Grip label={`Reorder ${name}`} onKeyDown={onGripKey} />
      </div>
      <div className="flex w-40 shrink-0 flex-col gap-1.5">
        {/* Real labels, not placeholders alone: a placeholder is gone the
            moment something is typed, and the two fields look alike. */}
        <label htmlFor={labelId} className="flex h-6 items-center text-ui text-muted-foreground">
          Label
        </label>
        <Input
          ref={label}
          id={labelId}
          // Empty falls back to the prompt's first words, so the placeholder
          // is what the button will be called.
          placeholder={fallback || "Commit and push"}
          value={button.label}
          onChange={(e) => onChange({ label: e.target.value })}
          className="text-ui md:text-ui"
        />
      </div>
      <div className="relative flex min-w-0 flex-1 flex-col gap-1.5">
        <label htmlFor={promptId} className="flex h-6 items-center text-ui text-muted-foreground">
          Prompt
        </label>
        {/* A textarea, since a pasted checklist or code block must keep its
            line breaks — an `<input>` strips them and sends different
            instructions. It grows with its text, capped so one long prompt
            cannot push the list off the page. */}
        <textarea
          id={promptId}
          rows={1}
          placeholder="commit your changes and push them"
          value={button.prompt}
          onChange={(e) => onChange({ prompt: e.target.value })}
          className={cn(
            inputClassName,
            "field-sizing-content h-auto max-h-32 min-h-8 resize-none py-1.5 text-ui md:text-ui",
          )}
        />
        {/* After the prompt in the DOM and drawn up on its label line, so Tab
            goes label → prompt → remove rather than stopping on the bin
            between the two fields. */}
        <div className="absolute top-0 right-0">
          {confirming ? (
            <ConfirmOrKeep
              confirmLabel={`Remove ${name}`}
              keepLabel={`Keep ${name}`}
              onConfirm={onRemove}
              onKeep={onKeep}
            />
          ) : (
            // Out of the way until the row is pointed at or tabbed into: a bin
            // on every row reads as the thing each row is for.
            <Button
              variant="ghost"
              size="icon-xs"
              aria-label={`Remove ${name}`}
              onClick={onAskRemove}
              className="text-muted-foreground opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-foreground focus-visible:opacity-100"
            >
              <Trash2 />
            </Button>
          )}
        </div>
      </div>
    </>
  );
}
