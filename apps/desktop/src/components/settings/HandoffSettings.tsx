import { useEffect, useRef, useState } from "react";
import { Plus, Trash2 } from "lucide-react";

import { handoffIcon } from "@/components/composer/handoffIcons";
import { CancelOrConfirm } from "@/components/settings/InRowConfirm";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import {
  resetHandoffButtons,
  setHandoffButtons,
  useHandoffButtons,
} from "@/hooks/useHandoffButtons";
import {
  BUILTIN_HANDOFF,
  DEFAULT_HANDOFF_BUTTONS,
  isBuiltinHandoff,
  labelFromPrompt,
} from "@/lib/handoff";
import type { HandoffButton } from "@/lib/handoff";

/// The buttons parked behind the composer's top edge: one row per button with
/// its label, its prompt and a remove, then Add and Reset.
///
/// A built-in's fields start **empty with the shipped text as placeholder**,
/// since empty means "what ships" there — so the placeholder is exactly what
/// the button will send, and clearing a field is how to go back to it.
export default function HandoffSettings() {
  const buttons = useHandoffButtons();
  const [confirmingReset, setConfirmingReset] = useState(false);
  // The row just added, whose label field takes focus once it is drawn.
  const [added, setAdded] = useState<string | null>(null);

  const edit = (id: string, patch: Partial<HandoffButton>) =>
    setHandoffButtons(buttons.map((b) => (b.id === id ? { ...b, ...patch } : b)));

  const isDefault = JSON.stringify(buttons) === JSON.stringify(DEFAULT_HANDOFF_BUTTONS);

  return (
    // What the tab is for is its subtitle, in `SettingsPage`'s `TAB_SUBTITLES`.
    <section className="flex flex-col gap-4">
      {buttons.length === 0 ? (
        <p className="text-ui text-muted-foreground">
          No buttons. Add one, or reset to bring the three that ship back.
        </p>
      ) : (
        <div className="flex flex-col gap-2">
          {buttons.map((button) => (
            <ButtonRow
              key={button.id}
              button={button}
              focus={button.id === added}
              onChange={(patch) => edit(button.id, patch)}
              onRemove={() => setHandoffButtons(buttons.filter((b) => b.id !== button.id))}
            />
          ))}
        </div>
      )}

      <div className="flex items-center gap-2">
        <Button
          variant="outline"
          size="sm"
          onClick={() => {
            const id = `custom-${crypto.randomUUID()}`;
            setHandoffButtons([...buttons, { id, label: "", prompt: "" }]);
            setAdded(id);
          }}
        >
          <Plus />
          Add button
        </Button>
        {confirmingReset ? (
          <CancelOrConfirm
            verb="Reset"
            autoFocus
            onCancel={() => setConfirmingReset(false)}
            onConfirm={() => {
              setConfirmingReset(false);
              resetHandoffButtons();
            }}
          >
            <span className="text-ui text-muted-foreground">
              Back to the three that ship?
            </span>
          </CancelOrConfirm>
        ) : (
          !isDefault && (
            <Button variant="ghost" size="sm" onClick={() => setConfirmingReset(true)}>
              Reset to defaults
            </Button>
          )
        )}
      </div>
    </section>
  );
}

function ButtonRow({
  button,
  focus,
  onChange,
  onRemove,
}: {
  button: HandoffButton;
  focus: boolean;
  onChange: (patch: Partial<HandoffButton>) => void;
  onRemove: () => void;
}) {
  const label = useRef<HTMLInputElement>(null);
  useEffect(() => {
    if (focus) label.current?.focus();
  }, [focus]);

  const builtin = isBuiltinHandoff(button.id) ? button.id : null;
  const Icon = handoffIcon(builtin);
  const shipped = builtin ? BUILTIN_HANDOFF[builtin] : null;
  // What the button is called on the row, for the remove's spoken name too.
  const name =
    button.label.trim() || shipped?.label || labelFromPrompt(button.prompt) || "button";

  return (
    <div className="flex items-center gap-2">
      <Icon className="size-3.5 shrink-0 text-muted-foreground" strokeWidth={1.5} />
      <Input
        ref={label}
        aria-label="Label"
        placeholder={shipped?.label ?? (labelFromPrompt(button.prompt) || "Label")}
        value={button.label}
        onChange={(e) => onChange({ label: e.target.value })}
        className="w-36 shrink-0 text-ui"
      />
      <Input
        aria-label="Prompt"
        placeholder={shipped?.prompt ?? "The prompt it sends"}
        value={button.prompt}
        onChange={(e) => onChange({ prompt: e.target.value })}
        className="flex-1 text-ui"
      />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={`Remove ${name}`}
        onClick={onRemove}
        className="text-muted-foreground hover:text-foreground"
      >
        <Trash2 />
      </Button>
    </div>
  );
}
