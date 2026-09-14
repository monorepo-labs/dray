import { useEffect, useMemo, useRef, useState } from "react";
import { Check, Sliders } from "lucide-react";
import AgentIcon from "@/components/AgentIcon";
import ModelLibraryDialog from "@/components/composer/ModelLibraryDialog";
import { useAgentAvailability } from "@/hooks/useAgentAvailability";
import { useLocalStorage } from "@/hooks/useLocalStorage";
import {
  byProvider,
  STARRED_MODELS_KEY,
  topLevel,
  underMore,
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
import ShortcutKeys from "@/components/ShortcutKeys";
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from "@/components/ui/tooltip";
import { invoke } from "@tauri-apps/api/core";
import { FX_PROVIDERS, HARNESS_ORDER, isUnsetModel } from "@/lib/model";
import type { Effort, Harness, Model, ModelId } from "@/types/events";

const EFFORT_LABELS: Record<Effort, string> = {
  low: "Low",
  medium: "Medium",
  high: "High",
  xhigh: "Extra High",
  ultra: "Ultra",
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
  fx: "fx",
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
  onReloadModels,
  onSeedProvider,
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
  /// Asks the harness for its list again, dropping the backend cache first.
  /// Only pi has one that can change under the reader — the other two are
  /// tables — so it is optional here.
  onRefreshModels?: () => void;
  /// Re-reads the current list *without* dropping the cache. The fx provider
  /// switch uses it: the new provider's list is keyed server-side, so this
  /// reads it cached rather than re-paying fx's startup on every hop.
  onReloadModels?: () => void;
  /// Shows a provider's cached fx models the instant it is picked, before the
  /// fresh read lands. A provider never visited seeds nothing and waits.
  onSeedProvider?: (provider: string) => void;
  loadingModels?: boolean;
}) {
  // Controlled so a click on a submenu trigger can close the whole menu; Radix
  // otherwise keeps the parent open for the submenu it just opened on hover.
  const [open, setOpen] = useState(false);
  const [libraryOpen, setLibraryOpen] = useState(false);
  // The provider fx is switching *to*, held so the segmented control moves the
  // instant it is clicked: `fx provider` plus a re-read of the list is ~3s on a
  // large provider, and a control that sits still that long reads as broken.
  // Cleared when the refreshed list lands, which is when the real state governs.
  const [pendingProvider, setPendingProvider] = useState<string | null>(null);
  // Clear the optimistic thumb only once the *new* provider's list has landed,
  // never on any list change: the switch fires a seed and then a reload, and an
  // intermediate update still naming the old provider would otherwise clear the
  // thumb and snap it back to where the switch came from. Also cleared when the
  // reload settles on nothing — a provider with no models — so the thumb can't
  // hang on a list that will never name it. A switch that errors clears it in
  // the click's own catch.
  useEffect(() => {
    if (pendingProvider == null) return;
    const landed = models[0]?.provider === pendingProvider;
    const settledEmpty = models.length === 0 && !loadingModels;
    if (landed || settledEmpty) setPendingProvider(null);
  }, [models, pendingProvider, loadingModels]);

  // One copy, held here and handed down: the dialog and the menu both read it,
  // and `useLocalStorage` is per-hook state rather than a store, so two
  // mounted copies would desync the moment one of them wrote.
  const [starred, setStarred] = useLocalStorage<ModelId[]>(STARRED_MODELS_KEY, []);

  const shortlisted = usesShortlist(harness);
  // Shared with Shift+Tab, which cycles exactly what this draws — a chord
  // landing on a model the menu never offered is the bug the sharing prevents.
  const listed = useMemo(
    () => topLevel(models, starred, harness, modelId),
    [models, starred, harness, modelId],
  );
  const more = useMemo(() => underMore(models, harness), [models, harness]);
  // Headings earn their place only when two providers share the list — pi's
  // multi-provider answer. fx serves one provider at a time, so its single
  // group's heading names what nothing disputes and is dropped.
  const providerGroups = useMemo(() => byProvider(listed), [listed]);

  const selected = models.find((m) => m.id === modelId) ?? null;
  const activeAgent = AGENTS.findIndex((a) => a.id === harness);
  // fx lists one provider at a time, so every row shares its provider — the
  // active one, which is what the segmented control marks. A pending switch
  // wins so the thumb moves at once; `undefined` before the first read, or when
  // no provider is signed in, leaves the thumb hidden and nothing checked.
  const currentProvider = pendingProvider ?? models[0]?.provider;
  const activeProvider = FX_PROVIDERS.findIndex((p) => p.id === currentProvider);
  // A switch whose new provider's list has not landed yet: the rows still name
  // the *old* provider's models.
  const awaitingProvider = pendingProvider != null && models[0]?.provider !== pendingProvider;
  // A known provider's list lands in tens of ms, so blanking to a loading row
  // on every switch only flashes. Wait a beat first: if the new list still has
  // not arrived, the switch is a real probe (gateway, seconds long), and *that*
  // is worth a loading state over a list still naming the old provider. A fast
  // swap clears `awaitingProvider` before the timer, so its old rows hold for
  // the one frame nobody sees.
  const [switchStalled, setSwitchStalled] = useState(false);
  useEffect(() => {
    if (!awaitingProvider) {
      setSwitchStalled(false);
      return;
    }
    const t = setTimeout(() => setSwitchStalled(true), 200);
    return () => clearTimeout(t);
  }, [awaitingProvider]);
  const blanked = awaitingProvider && switchStalled;
  const shown = blanked ? [] : listed;
  // `null` until the first read lands, which is why the mark is drawn from an
  // explicit `!a.available` rather than from "not found in the list": an
  // unanswered read must mark nothing, not mark everything.
  const availability = useAgentAvailability();

  // Provider switches are serialized: each `set_fx_provider` is chained after
  // the previous, so the settings file ends on the *last* click rather than
  // whichever fx call happened to finish last. Only the latest click reloads or
  // clears the thumb — a superseded click's completion is ignored, so a slow
  // earlier switch can't reload the picker onto a provider the reader left.
  const switchQueue = useRef<Promise<unknown>>(Promise.resolve());
  const latestProvider = useRef<string | null>(null);

  const switchProvider = (id: string) => {
    setPendingProvider(id);
    // Cached rows on screen at once; the reload below refreshes them. A provider
    // never visited seeds nothing and falls to the loading state instead.
    onSeedProvider?.(id);
    latestProvider.current = id;
    switchQueue.current = switchQueue.current
      .catch(() => {})
      .then(() => invoke("set_fx_provider", { provider: id }))
      .then(
        () => {
          if (latestProvider.current === id) onReloadModels?.();
        },
        (e) => {
          console.error("[fx provider]", e);
          if (latestProvider.current === id) setPendingProvider(null);
        },
      );
  };

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
          // The picked model takes a check where the submenu chevron would sit,
          // no leading indent and no background tint fighting the hover.
          // Unpicked rows keep the chevron that says "opens an effort submenu".
          trailingIcon={
            model.id === modelId ? <Check className="ml-auto size-3.5" /> : undefined
          }
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
            <ShortcutKeys ids={["effort.next"]} />
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
              {level === rowEffort(model) && <Check className="ml-auto size-3.5" />}
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
        {model.id === modelId && <Check className="ml-auto size-3.5" />}
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
              <span>{selected?.label ?? (isUnsetModel(modelId) ? "Select Model" : modelId)}</span>
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
          <ShortcutKeys ids={["model.next"]} />
        </TooltipContent>
      </Tooltip>

      <DropdownMenuContent align="start" className="min-w-[202px]">
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
            <ShortcutKeys ids={["harness.next"]} className="ml-auto pr-0.5" />
          </div>
        )}

        {/* fx's list is its *active provider's*, and the provider is a global
            fx setting (`fx provider …`, written to `~/.fx/settings.json`).
            Creation-time only, beside the agent control and built the same way:
            a segmented control says "one of these" where stacked rows read as
            more models. Text, not icons — the providers have no brand mark here.
            The active one is read off the rows fx answered with. */}
        {harness === "fx" && canSwitchHarness && (
          <div
            role="radiogroup"
            aria-label="Provider"
            className="mb-1 flex items-center rounded-md bg-surface-well p-1"
          >
            <div className="relative flex flex-1 items-center">
              {/* The moving thumb, one segment wide, placed by index — the
                  switch slides across rather than blinking between pills. Hidden
                  until a provider is known, so first run reads as "none picked"
                  rather than the first segment being silently selected. */}
              {activeProvider >= 0 && (
                <span
                  aria-hidden
                  className="absolute top-0 left-0 h-6 rounded-sm bg-surface-thumb shadow-(--shadow-button) transition-transform duration-150 ease-out"
                  style={{
                    width: `${100 / FX_PROVIDERS.length}%`,
                    transform: `translateX(${activeProvider * 100}%)`,
                  }}
                />
              )}
              {FX_PROVIDERS.map((provider) => (
                <button
                  key={provider.id}
                  type="button"
                  role="radio"
                  aria-checked={provider.id === currentProvider}
                  aria-label={provider.label}
                  onClick={() => switchProvider(provider.id)}
                  className="relative z-10 flex h-6 flex-1 items-center justify-center rounded-sm text-ui opacity-55 transition-opacity hover:opacity-100 aria-checked:opacity-100"
                >
                  {provider.short}
                </button>
              ))}
            </div>
          </div>
        )}

        {/* Grouped only where a heading says something: pi answers with a
            provider per model, and a reader picking between two providers'
            models needs to know which is which. A one-provider list — fx, or
            any harness with a single vendor — draws its rows flat, the heading
            naming what the agent mark on the trigger already said. */}
        {shortlisted && providerGroups.length > 1 && !blanked
          ? providerGroups.map((group) => (
              <div key={group.provider}>
                <p className="px-2 pt-1.5 pb-0.5 text-ui text-muted-foreground">
                  {group.provider}
                </p>
                {group.models.map(modelRow)}
              </div>
            ))
          : shown.map(modelRow)}

        {/* The agent control keeps this menu open on purpose, so a switch to an
            agent whose list is a *read* rather than a table lands here with
            nothing to draw. A row saying so holds the menu's shape and names
            the wait; collapsing to nothing and springing back is the glitch
            this replaces. Not a `DropdownMenuItem` — there is nothing to
            select, and one would take arrow focus. */}
        {shown.length === 0 && (
          <p className="px-2 py-1.5 text-ui text-muted-foreground">
            {loadingModels || blanked
              ? "Loading models…"
              : models.length === 0
                ? "No models available"
                : "No models shortlisted yet"}
          </p>
        )}

        {/* A submenu rather than a second block under a heading, because the
            rows below are not a category the reader is choosing *between* —
            they are the ones they will not open this menu for. Folding them
            away is what keeps Shift+Tab's cycle two presses long, and the
            cycle skips exactly what lives here. */}
        {more.length > 0 && (
          <DropdownMenuSub>
            <DropdownMenuSubTrigger className="text-ui text-muted-foreground">
              More models
            </DropdownMenuSubTrigger>
            <DropdownMenuSubContent>{more.map(modelRow)}</DropdownMenuSubContent>
          </DropdownMenuSub>
        )}

        {/* No rule above it. The row is already a different shape to the models
            over it — muted, and the one thing in the menu carrying a glyph — so
            a line there drew a box round the difference rather than making it. */}
        {shortlisted && (
          <DropdownMenuItem
            className="cursor-pointer gap-2 text-ui text-muted-foreground"
            onSelect={() => setLibraryOpen(true)}
          >
            <Sliders className="size-3.5" />
            Choose models…
          </DropdownMenuItem>
        )}
      </DropdownMenuContent>

      <ModelLibraryDialog
        open={libraryOpen}
        // Opening the library closed the menu (it opens from a menu item), so
        // closing it drops the reader back with nothing open — one shortlist
        // edit and they have to reopen the picker to actually pick. Reopen the
        // menu on close, where the freshly-starred models are waiting.
        onOpenChange={(next) => {
          setLibraryOpen(next);
          if (!next) setOpen(true);
        }}
        models={models}
        starred={starred}
        onStarredChange={setStarred}
        onRefresh={() => onRefreshModels?.()}
        loading={loadingModels}
      />
    </DropdownMenu>
  );
}
