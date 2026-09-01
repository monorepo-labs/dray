import { useMemo, useState } from "react";
import { Sliders } from "lucide-react";
import AgentIcon from "@/components/AgentIcon";
import ModelLibraryDialog from "@/components/composer/ModelLibraryDialog";
import { useAgentAvailability } from "@/hooks/useAgentAvailability";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import {
  byProvider,
  shortlist,
  STARRED_MODELS_KEY,
  usesShortlist,
} from "@/lib/starredModels";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Kbd, KbdGroup } from "@/components/ui/kbd";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { HARNESS_ORDER, isUnsetModel } from "@/lib/model";
import type { Effort, Harness, Model, ModelId } from "@/types/events";

const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  max: "Max",
};

/// Named as the reader knows them, not as the wire spells them. The label is
/// the screen reader's alone — the row is marks, since two of them side by side
/// say "pick one" in less space than two words do, and a tooltip repeating the
/// name is longer than the row it hangs off.
const AGENT_LABELS: Record<Harness, string> = {
  claude_code: "Claude Code",
  codex: "Codex",
  pi: "pi",
};
const AGENTS = HARNESS_ORDER.map((id) => ({ id, label: AGENT_LABELS[id] }));

/// Next effort level for `model`, wrapping — what ⌘⇧E lands on. `null`
/// where the model offers nothing to cycle, so the chord no-ops rather than
/// inventing an effort the CLI would ignore.
///
/// `low` is left out of the cycle and stays pickable from the menu: a blind
/// chord landing on it makes the model worse at the work, which is not
/// something anyone reaches for a shortcut to do. An effort outside the
/// remaining list — `low` itself included — enters at the start.
export function nextEffort(model: Model | undefined, current: Effort | null): Effort | null {
  const cycle: Effort[] = model?.efforts.filter((e) => e !== "low") ?? [];
  if (cycle.length === 0) return null;
  const from = current ?? model?.defaultEffort ?? null;
  const i = from ? cycle.indexOf(from) : -1;
  return cycle[(i + 1) % cycle.length];
}

/// Which agent runs the session, which model it runs on, and at what effort —
/// one control, because the three are one decision.
///
/// The agent used to sit in its own picker to the left. Folding it in costs
/// nothing to reach (it is the first row of a menu that was already there) and
/// buys the row a slot back, which the handoff row's three-button budget was
/// already short of. It also puts the mark *on the trigger*, so the agent is
/// readable at rest rather than only while the menu is open.
export default function ModelSelector({
  harness,
  onHarnessChange,
  canSwitchHarness,
  models,
  modelId,
  effort,
  onChange,
  onRefreshModels,
  loadingModels = false,
}: {
  harness: Harness;
  onHarnessChange: (harness: Harness) => void;
  /// The agent is the child process, so it is fixed once a session exists. The
  /// row of icons goes with it; the trigger's own mark stays, since naming the
  /// agent a session runs is worth a glyph whether or not it can change.
  canSwitchHarness: boolean;
  models: Model[];
  modelId: ModelId;
  effort: Effort | null;
  onChange: (modelId: ModelId, effort: Effort | null) => void;
  /// Asks the harness for its list again. Only pi has one that can change
  /// under the reader — the other two are tables — so it is optional here.
  onRefreshModels?: () => void;
  loadingModels?: boolean;
}) {
  // Controlled so a click on a submenu trigger can close the whole menu; Radix
  // otherwise keeps the parent open for the submenu it just opened on hover.
  const [open, setOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);

  // One copy, held here and handed down: the dialog and the menu both read it,
  // and `useLocalStorage` is per-hook state rather than a store, so two
  // mounted copies would desync the moment one of them wrote.
  const [starred, setStarred] = useLocalStorage<ModelId[]>(STARRED_MODELS_KEY, []);

  const shortlisted = usesShortlist(harness);
  // The whole list for a harness whose models Dray names itself; the reader's
  // own shortlist for pi, whose list is discovered and unbounded.
  const listed = useMemo(
    () => (shortlisted ? shortlist(models, starred, modelId) : models),
    [shortlisted, models, starred, modelId],
  );

  const selected = models.find((m) => m.id === modelId) ?? null;
  const activeAgent = AGENTS.findIndex((a) => a.id === harness);
  // `null` until the first read lands, which is why the mark is drawn from an
  // explicit `!a.available` rather than from "not found in the list": an
  // unanswered read must mark nothing, not mark everything.
  const availability = useAgentAvailability();

  /// What a row would resolve to if clicked: the live effort for the model
  /// already selected, each other model's own default. Mirrors the resolution
  /// in `useSessions`, so the menu can't advertise an effort the send wouldn't use.
  const rowEffort = (model: Model): Effort | null =>
    model.id === modelId ? effort : model.defaultEffort;

  const modelRow = (model: Model) =>
    model.efforts.length ? (
      // One row: hover opens the effort submenu (Radix's own behaviour), click
      // picks the model and leaves its effort alone. Splitting the two into
      // separate items would give the row two hover states.
      <DropdownMenuSub key={model.id}>
        <DropdownMenuSubTrigger
          className="cursor-pointer gap-1 text-ui"
          onClick={() => {
            onChange(model.id, null);
            setOpen(false);
          }}
        >
          {model.label}
          {rowEffort(model) && (
            <span className="text-muted-foreground/60">
              {EFFORT_LABELS[rowEffort(model)!]}
            </span>
          )}
        </DropdownMenuSubTrigger>
        <DropdownMenuSubContent>
          {/* The chord lives here, on the control it drives, rather than on the
              model trigger — that tooltip was carrying a shortcut for a thing
              one level down. No word beside it and no rule under it: the levels
              below say what it cycles, and a separator would draw a box round
              a hint. */}
          <div className="flex px-1.5 py-1">
            <KbdGroup>
              <Kbd>⌘</Kbd>
              <Kbd>Shift</Kbd>
              <Kbd>E</Kbd>
            </KbdGroup>
          </div>
          {model.efforts.map((level) => (
            <DropdownMenuItem
              key={level}
              className="text-ui"
              onSelect={() => {
                onChange(model.id, level);
                setOpen(false);
              }}
            >
              {EFFORT_LABELS[level]}
            </DropdownMenuItem>
          ))}
        </DropdownMenuSubContent>
      </DropdownMenuSub>
    ) : (
      // No submenu and no chevron for a model with no effort levels.
      <DropdownMenuItem
        key={model.id}
        className="text-ui"
        onSelect={() => onChange(model.id, null)}
      >
        {model.label}
      </DropdownMenuItem>
    );

  return (
    <DropdownMenu open={open} onOpenChange={setOpen}>
      <Tooltip>
        <TooltipTrigger asChild>
          <DropdownMenuTrigger asChild>
            {/* `text-ui` over the button's own `text-sm`: the toolbar has to track
                the runtime font-size setting like the rest of the chrome. */}
            <Button
              type="button"
              variant="ghost"
              size="sm"
              className="gap-1 px-1.5 text-ui text-muted-foreground"
            >
              <AgentIcon harness={harness} brand className="size-3.5" />
              {/* Effort is a qualifier on the model, not part of its name, so it's
                  held back a step rather than reading as one long label. */}
              {/* The unset sentinel is not a name and there is no name to
                  draw, so the placeholder stands in. pi is the one harness
                  that reaches this: Dray names no default for it, and the
                  spawn omits the flag so pi's own settings decide. */}
              <span>{selected?.label ?? (isUnsetModel(modelId) ? "Model" : modelId)}</span>
              {effort && (
                <span className="text-muted-foreground/60">{EFFORT_LABELS[effort]}</span>
              )}
            </Button>
          </DropdownMenuTrigger>
        </TooltipTrigger>
        {/* One thing only. Effort has its own control inside the menu and names
            its own chord there, so listing both here made a tooltip that read
            as a menu of shortcuts — hence `max-w-none`, which the default
            `max-w-xs` would wrap. */}
        <TooltipContent side="top" className="max-w-none whitespace-nowrap">
          Switch model
          <KbdGroup>
            <Kbd>Shift</Kbd>
            <Kbd>Tab</Kbd>
          </KbdGroup>
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="start" className="min-w-48">
        {/* Not menu items: a segmented control says "one of these two" where
            two stacked rows would read as two more models. Plain buttons, so
            the menu stays open — switching agent and then picking one of its
            models is one visit rather than two. `mb-1` is the whole separation
            from the list below: a rule there drew a box round a control that is
            already a different shape. */}
        {canSwitchHarness && (
          <div
            role="radiogroup"
            aria-label="Agent"
            className="mb-1 flex items-center gap-1 rounded-md bg-surface-well p-1"
          >
            {/* The one moving part. A thumb under the marks, placed by index,
                so switching reads as the selection sliding across rather than
                one pill blinking out and another in. Unknown harness parks it
                under the first mark rather than off the track.

                `--surface-thumb` and a shadow, not `--accent`: the thumb has to
                come up *past* the surface the menu is drawn at, out of the well
                the track cuts. `--accent` is a white veil on glass, which over
                a scrim is a few percent of light and read as nothing. */}
            <div className="relative flex items-center">
              <span
                aria-hidden
                className="absolute top-0 left-0 size-6 rounded-sm bg-surface-thumb shadow-(--shadow-button) transition-transform duration-150 ease-out"
                style={{ transform: `translateX(${Math.max(activeAgent, 0) * 100}%)` }}
              />
              {/* Dimmed by opacity, not by colour. A muted-to-foreground ladder
                  only moves a mark drawn in `currentColor`, so it lit Codex on
                  hover and left Claude — which carries its own rust — sitting
                  at one state forever. Opacity is the one dial both marks
                  answer to. */}
              {AGENTS.map((agent) => {
                const missing = availability?.some(
                  (a) => a.harness === agent.id && !a.available,
                );
                return (
                  <button
                    key={agent.id}
                    type="button"
                    role="radio"
                    aria-checked={agent.id === harness}
                    aria-label={
                      missing ? `${agent.label} (not installed)` : agent.label
                    }
                    onClick={() => onHarnessChange(agent.id)}
                    className="relative flex size-6 items-center justify-center rounded-sm opacity-55 transition-opacity hover:opacity-100 aria-checked:opacity-100"
                  >
                    <AgentIcon harness={agent.id} brand className="size-3.5" />
                    {/* Marked, not disabled. Disabling leaves nowhere to say
                        why — a tooltip is the only slot left, and the cure is
                        two lines and two buttons. Picking it is what draws the
                        notice under the composer, so the mark is an invitation
                        to find out rather than a closed door.

                        Drawn as a dot rather than a colour: the marks are
                        brand art and already carry their own, so recolouring
                        one says "Codex" more than it says "missing". */}
                    {missing && (
                      <span
                        aria-hidden
                        className="absolute -top-px -right-px size-1.5 rounded-full bg-destructive ring-1 ring-surface-well"
                      />
                    )}
                  </button>
                );
              })}
            </div>
            {/* Inside the track, in the width the two marks leave: a hint you
                have to hover to find is one nobody finds. */}
            <KbdGroup className="ml-auto pr-0.5">
              <Kbd>⌘</Kbd>
              <Kbd>Shift</Kbd>
              <Kbd>A</Kbd>
            </KbdGroup>
          </div>
        )}

        {/* Grouped only where a heading says something: pi answers with a
            provider per model, and a reader picking between two providers'
            models needs to know which is which. The other two harnesses have
            one vendor each, so a heading there names what the agent mark on
            the trigger already said. */}
        {shortlisted
          ? byProvider(listed).map((group) => (
              <div key={group.provider}>
                <p className="px-2 pt-1.5 pb-0.5 text-ui text-muted-foreground">
                  {group.provider}
                </p>
                {group.models.map(modelRow)}
              </div>
            ))
          : listed.map(modelRow)}

        {/* No rule above it. The row is already a different shape to the models
            over it — muted, and the one thing in the menu carrying a glyph — so
            a line there drew a box round the difference rather than making it. */}
        {shortlisted && (
          <DropdownMenuItem
            className="cursor-pointer gap-2 text-ui text-muted-foreground"
            onSelect={() => setLibraryOpen(true)}
          >
            <Sliders className="size-3.5" />
            {listed.length > 0 ? "Choose models…" : "Select models…"}
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>

      <ModelLibraryDialog
        open={libraryOpen}
        onOpenChange={setLibraryOpen}
        models={models}
        starred={starred}
        onStarredChange={setStarred}
        onRefresh={() => onRefreshModels?.()}
        loading={loadingModels}
      />
    </DropdownMenu>
  );
}
