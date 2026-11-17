"use client";

import { useEffect, useRef, useState, type ComponentType } from "react";
import { Check, ChevronRight, Sliders } from "lucide-react";

import { ClaudeGlyph } from "@/components/ClaudeGlyph";
import { GrokGlyph } from "@/components/GrokGlyph";
import { OpenAIGlyph } from "@/components/OpenAIGlyph";
import { PiGlyph } from "@/components/PiGlyph";

import { Keys } from "./Sidebar";
import { cx } from "./Window";

type Model = {
  label: string;
  /// The effort ladder, which a hover on the row opens; empty for none.
  efforts: string[];
  /// What the row reads, and what picking the model lands on.
  effort?: string;
  /// Has a faster tier, so the menu offers Fast mode under it.
  fast?: boolean;
};

const CLAUDE_EFFORTS = ["Low", "Medium", "High", "Extra High", "Max"];
const CODEX_EFFORTS = ["Low", "Medium", "High", "Extra High"];

/// The agents a bot can run on and each one's shortlist. Scripted: the app
/// reads these off each CLI.
const AGENTS: { id: string; label: string; Glyph: ComponentType<{ className?: string }>; models: Model[] }[] = [
  {
    id: "claude",
    label: "Claude Code",
    Glyph: ClaudeGlyph,
    models: [
      { label: "Opus 5.5", efforts: CLAUDE_EFFORTS, effort: "High", fast: true },
      { label: "Sonnet 5.5", efforts: CLAUDE_EFFORTS, effort: "High" },
      { label: "Haiku 5.5", efforts: [] },
    ],
  },
  {
    id: "codex",
    label: "Codex",
    Glyph: OpenAIGlyph,
    models: [
      { label: "GPT-5.5", efforts: CODEX_EFFORTS, effort: "Medium" },
      { label: "GPT-5.5 mini", efforts: CODEX_EFFORTS, effort: "Medium" },
    ],
  },
  { id: "grok", label: "Grok", Glyph: GrokGlyph, models: [{ label: "Grok 5", efforts: [] }, { label: "Grok 5 Fast", efforts: [] }] },
  {
    id: "pi",
    label: "pi",
    Glyph: PiGlyph,
    models: [
      { label: "Opus 5.5", efforts: CLAUDE_EFFORTS, effort: "High" },
      { label: "GPT-5.5", efforts: CODEX_EFFORTS, effort: "Medium" },
    ],
  },
];

const ROW =
  "flex w-full cursor-pointer items-center gap-1 rounded-md px-1.5 py-1 text-left text-ui outline-none select-none hover:bg-accent focus-visible:bg-accent";

/// The menu's fill, as the app's dropdowns draw it: glass, a hairline ring, a soft drop.
const MENU = "rounded-lg bg-popover p-1 text-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-xl";

/// The app's model picker in a bot's composer: the agent track on top, since
/// a bot's agent can change; the shortlist under it, each row opening its
/// effort ladder on hover; Fast mode under a model that has it. Picks only
/// change what the trigger reads.
export function ModelPicker() {
  const [open, setOpen] = useState(false);
  const [agent, setAgent] = useState(0);
  const [picks, setPicks] = useState<Record<string, { model: string; effort?: string }>>({});
  const [fast, setFast] = useState(false);
  const [sub, setSub] = useState<string | null>(null);
  const root = useRef<HTMLDivElement>(null);

  const { id, models, Glyph } = AGENTS[agent];
  const pick = picks[id] ?? { model: models[0].label, effort: models[0].effort };
  const selected = models.find((m) => m.label === pick.model) ?? models[0];
  const choose = (model: Model, effort = model.label === pick.model ? pick.effort : model.effort) => {
    setPicks((all) => ({ ...all, [id]: { model: model.label, effort } }));
    setOpen(false);
  };

  useEffect(() => {
    if (!open) return;
    const away = (e: PointerEvent) => !root.current?.contains(e.target as Node) && setOpen(false);
    const escape = (e: KeyboardEvent) => e.key === "Escape" && setOpen(false);
    document.addEventListener("pointerdown", away);
    document.addEventListener("keydown", escape);
    return () => {
      document.removeEventListener("pointerdown", away);
      document.removeEventListener("keydown", escape);
    };
  }, [open]);

  return (
    <div ref={root} className="relative shrink-0">
      <button
        type="button"
        aria-haspopup="menu"
        aria-expanded={open}
        onClick={() => {
          setSub(null);
          setOpen((o) => !o);
        }}
        className="flex h-7 items-center gap-1 rounded-[min(var(--radius-md),12px)] px-1.5 text-ui font-medium text-muted-foreground transition-colors outline-none hover:bg-muted/50 hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring aria-expanded:bg-muted aria-expanded:text-foreground light:hover:bg-muted/70"
      >
        <Glyph className="size-3.5" />
        <span>{selected.label}</span>
        {pick.effort && <span className="text-muted-foreground/60">{pick.effort}</span>}
        {fast && selected.fast && <span className="text-muted-foreground/60">Fast</span>}
      </button>

      {open && (
        <div role="menu" className={cx(MENU, "absolute bottom-full left-0 z-50 mb-1 w-[232px]")}>
          {/* A segmented control, not rows: it says "one of these", and the
              menu stays open so switching agent and then a model is one visit. */}
          <div className="mb-1 flex items-center gap-1 rounded-md bg-[oklch(0_0_0/22%)] p-1 light:bg-[oklch(0_0_0/7%)]">
            <div role="radiogroup" aria-label="Agent" className="relative flex items-center">
              <span
                aria-hidden
                className="absolute top-0 left-0 size-6 rounded-sm bg-surface-thumb shadow-[0_1px_4px_oklch(0_0_0/45%)] transition-transform duration-150 ease-out light:shadow-[0_1px_3px_oklch(0_0_0/12%)]"
                style={{ transform: `translateX(${agent * 100}%)` }}
              />
              {AGENTS.map((a, i) => (
                <button
                  key={a.id}
                  type="button"
                  role="radio"
                  aria-checked={i === agent}
                  aria-label={a.label}
                  onClick={() => {
                    setAgent(i);
                    setSub(null);
                  }}
                  className="relative flex size-6 items-center justify-center rounded-sm opacity-55 transition-opacity hover:opacity-100 aria-checked:opacity-100"
                >
                  <a.Glyph className="size-3.5" />
                </button>
              ))}
            </div>
            <Keys caps={["⌘", "Shift", "A"]} className="ml-auto pr-0.5" />
          </div>

          {models.map((model) => {
            const effort = model.label === pick.model ? pick.effort : model.effort;
            const current = model.label === selected.label;
            const openSub = () => setSub(model.efforts.length ? model.label : null);
            return (
              // Focus opens the ladder as hover does, so Tab reaches its levels.
              <div key={model.label} className="relative" onPointerEnter={openSub} onFocus={openSub}>
                <button
                  type="button"
                  role="menuitem"
                  onClick={() => choose(model)}
                  className={cx(ROW, sub === model.label && "bg-accent")}
                >
                  <span className="min-w-0 truncate">{model.label}</span>
                  {effort && <span className="shrink-0 text-muted-foreground/60">{effort}</span>}
                  {current ? (
                    <Check className="ml-auto size-3.5 shrink-0" />
                  ) : (
                    model.efforts.length > 0 && <ChevronRight className="ml-auto size-4 shrink-0" />
                  )}
                </button>
                {sub === model.label && (
                  <div role="menu" className={cx(MENU, "absolute top-0 left-full z-50 ml-1 min-w-[132px] shadow-lg")}>
                    <div className="flex px-1.5 py-1">
                      <Keys caps={["⌘", "Shift", "E"]} />
                    </div>
                    {model.efforts.map((level) => (
                      <button key={level} type="button" role="menuitem" onClick={() => choose(model, level)} className={ROW}>
                        {level}
                        {level === effort && <Check className="ml-auto size-3.5" />}
                      </button>
                    ))}
                  </div>
                )}
              </div>
            );
          })}

          {selected.fast && (
            // Held open, unlike every other row: a switch that vanishes on the
            // press never shows which way it went.
            <button
              type="button"
              role="switch"
              aria-checked={fast}
              onPointerEnter={() => setSub(null)}
              onFocus={() => setSub(null)}
              onClick={() => setFast((f) => !f)}
              className={cx(ROW, "gap-1.5")}
            >
              Fast mode
              <Keys caps={["⌘", "Shift", "F"]} />
              <span
                aria-hidden
                className={cx(
                  "ml-auto inline-flex h-4 w-7 shrink-0 items-center rounded-full p-px transition-colors",
                  fast ? "bg-primary" : "bg-muted-foreground/30",
                )}
              >
                <span className={cx("block size-3.5 rounded-full bg-background transition-transform", fast && "translate-x-3")} />
              </span>
            </button>
          )}

          <button
            type="button"
            role="menuitem"
            onPointerEnter={() => setSub(null)}
            onFocus={() => setSub(null)}
            onClick={() => setOpen(false)}
            className={cx(ROW, "gap-2 text-muted-foreground")}
          >
            <Sliders className="size-3.5" />
            Shortlist models
          </button>
        </div>
      )}
    </div>
  );
}
