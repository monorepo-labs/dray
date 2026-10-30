import type { ReactNode } from "react";
import { ArrowUp, ChevronRight, CornerDownLeft, Folder, Mic, Plus } from "lucide-react";

import { Wordmark } from "@/components/Wordmark";

import { cx } from "./Window";

/// Git branch glyph, drawn to the chrome's own 1.5 stroke rather than pulled
/// from an icon family with a heavier one.
export function GitBranchIcon({ className }: { className?: string }) {
  return (
    <svg
      viewBox="0 0 24 24"
      fill="none"
      stroke="currentColor"
      strokeWidth={1.5}
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
      className={className}
    >
      <circle cx="6" cy="5" r="2.25" />
      <circle cx="6" cy="19" r="2.25" />
      <circle cx="18" cy="7" r="2.25" />
      <path d="M6 7.25v9.5" />
      <path d="M18 9.25a6 6 0 0 1-6 6H6" />
    </svg>
  );
}

/// The transcript's column: the app's own `max-w-3xl` measure and spacing.
export function Transcript({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("relative min-h-0 flex-1 overflow-hidden", className)}>
      <div className="mx-auto flex max-w-3xl flex-col gap-4 px-6 py-6">{children}</div>
    </div>
  );
}

/// One turn: the prompt, then the work under it.
export function Turn({ children, className }: { children: ReactNode; className?: string }) {
  return <div className={cx("flex flex-col gap-3", className)}>{children}</div>;
}

/// The transcript's spine — one tick per prompt, in the gutter left of the
/// column. A table of contents, not a minimap: tick spacing is fixed rather
/// than proportional to a turn's length.
export function CheckpointRail({
  count,
  activeIndex = 0,
  className,
}: {
  count: number;
  activeIndex?: number;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col", className)}>
      {Array.from({ length: count }, (_, i) => (
        // Hit areas stack with no gap: the rail reads as one scrubber rather
        // than a column of small targets.
        <span key={i} className="flex h-3 w-5 shrink-0 items-center justify-center">
          <span
            className={cx(
              "h-0.5 w-2.5 rounded-full",
              i === activeIndex ? "bg-foreground/70" : "bg-muted-foreground/40",
            )}
          />
        </span>
      ))}
    </div>
  );
}

/// What the reader sent. Right-aligned and filled; the assistant's own output
/// is unbubbled, since wrapping code blocks in one only costs horizontal room.
export function UserBubble({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex flex-col items-end gap-1.5", className)}>
      <div className="max-w-[85%] rounded-xl bg-card px-3 py-2 text-card-foreground">
        <div className="text-chat">{children}</div>
      </div>
    </div>
  );
}

/// Assistant prose. One size for every element in the message — weight and
/// colour carry hierarchy now that size no longer does.
export function AssistantText({
  children,
  className,
}: {
  children: ReactNode;
  className?: string;
}) {
  return <div className={cx("text-chat", className)}>{children}</div>;
}

/// A run of consecutive same-tool calls behind one row. The caret is drawn at
/// rest the way the app draws it: invisible until the row is hovered.
export function ToolGroup({ label, className }: { label: ReactNode; className?: string }) {
  return (
    <div className={cx("flex flex-col gap-1.5", className)}>
      <div className="flex w-full items-center gap-2 text-left text-chat text-muted-foreground">
        <span className="shrink-0">{label}</span>
        <ChevronRight className="size-3 shrink-0 opacity-0" />
      </div>
    </div>
  );
}

/// How full the model's context is, as a ring. A proportion rather than a
/// count, since "how much room is left" is the question at a glance.
function ContextRing({ fraction }: { fraction: number }) {
  const r = 9;
  const circumference = 2 * Math.PI * r;

  return (
    <span className="flex shrink-0 items-center px-1.5">
      <svg viewBox="0 0 24 24" className="size-3.5 text-muted-foreground" aria-hidden>
        <circle cx="12" cy="12" r={r} fill="none" stroke="currentColor" strokeWidth="3" opacity="0.25" />
        {/* Rotated so the arc starts at twelve o'clock; SVG's own zero angle is
            three o'clock, which reads as a gauge beginning a quarter turn in. */}
        <circle
          cx="12"
          cy="12"
          r={r}
          fill="none"
          stroke="currentColor"
          strokeWidth="3"
          strokeLinecap="round"
          strokeDasharray={circumference}
          strokeDashoffset={circumference * (1 - fraction)}
          transform="rotate(-90 12 12)"
        />
      </svg>
    </span>
  );
}

/// The composer card and the control row under it. The card carries the edge
/// and no shadow: a shadow under a dark card falls on something already darker
/// than itself.
export function Composer({
  placeholder = "Send follow-up",
  value,
  controls,
  mic = false,
  toolbar = true,
  agent,
  model,
  effort,
  mode,
  context = 0.3,
  trailing,
  radius = "rounded-2xl",
  className,
}: {
  placeholder?: string;
  /// Text already in the box, drawn in the prose colour where the placeholder
  /// is muted. A slot rather than a string, since a tag in it is a chip.
  value?: ReactNode;
  /// Controls drawn before the send button — the dictate control, mostly.
  controls?: ReactNode;
  /// The resting mic, which the app draws in every composer. Off by default,
  /// since a card about dictation passes its own control instead.
  mic?: boolean;
  /// The model, mode and context row under the card. Off where the card
  /// alone is the subject and the row would be chrome around it.
  toolbar?: boolean;
  /// The harness's brand glyph, drawn at `size-3.5` before the model's name.
  /// A slot rather than a table: the site already owns those marks.
  agent?: ReactNode;
  model: string;
  effort?: string;
  mode: string;
  /// How full the ring is drawn, 0–1. Ignored where `trailing` stands in.
  context?: number;
  /// Takes the ring's place at the row's right end.
  trailing?: ReactNode;
  /// The box's corner. The app's own is `rounded-2xl`; a composer drawn
  /// inside a card a few px from its edge wants less, since an inner corner
  /// rounder than the one around it reads as a pill dropped in a box.
  radius?: string;
  className?: string;
}) {
  return (
    <div className={cx("px-4 pb-4", className)}>
      <div className="mx-auto max-w-3xl">
        <div className={cx("relative border border-edge-surface bg-composer backdrop-blur-xl", radius)}>
          {/* Controls ride the text's own row, always. `items-end` is what makes
              one row read correctly at both heights. */}
          <div className="flex items-end gap-1 px-3 py-3">
            <div className="relative min-w-0 flex-1">
              <div className={cx("px-1 py-1 text-prompt", value ? "text-foreground" : "text-muted-foreground")}>
                {value ?? placeholder}
              </div>
            </div>

            <div className="flex shrink-0 items-center gap-1">
              {controls}
              {mic && (
                <span className="grid size-7 place-items-center text-muted-foreground">
                  <Mic className="size-4" />
                </span>
              )}
              {/* The one filled button that keeps `--primary`, and the one round
                  control in a row of rounded squares. */}
              <span className="grid size-7 place-items-center rounded-full bg-primary text-primary-foreground">
                <span className="grid size-4 place-items-center">
                  <ArrowUp strokeWidth={2} className="size-4" />
                </span>
              </span>
            </div>
          </div>
        </div>

        {toolbar && (
        <div className="pt-1.5">
          <div className="flex min-w-0 items-center gap-0.5 px-1">
            <span className="grid size-7 shrink-0 place-items-center rounded-[min(var(--radius-md),12px)] text-muted-foreground">
              <Plus className="size-4" />
            </span>

            {/* Effort is a qualifier on the model, not part of its name, so it
                is held back a step rather than reading as one long label. */}
            <span className="flex h-7 shrink-0 items-center gap-1 rounded-[min(var(--radius-md),12px)] px-1.5 text-ui font-medium text-muted-foreground">
              {agent}
              <span>{model}</span>
              {effort && <span className="text-muted-foreground/60">{effort}</span>}
            </span>

            <span className="flex h-7 shrink-0 items-center rounded-[min(var(--radius-md),12px)] px-1.5 text-ui font-medium text-muted-foreground">
              {mode}
            </span>

            {/* `ml-auto` rather than a spacer, so a long branch name still gets
                the whole middle of the row. */}
            <div className="ml-auto flex items-center">
              {trailing ?? <ContextRing fraction={context} />}
            </div>
          </div>
        </div>
        )}
      </div>
    </div>
  );
}

const BUTTON =
  "flex h-7 items-center rounded-[min(var(--radius-md),12px)] px-2.5 text-[0.8rem] font-medium transition-colors focus-visible:ring-2 focus-visible:ring-ring focus-visible:outline-none";

/// A question the agent is blocked on, as `QuestionRequest` draws it: no card
/// around it, since the choices carry their own edges. Skip is a real answer,
/// so `onAnswer` gets `null` for it, and for Send with nothing picked.
export function QuestionCard({
  question,
  options,
  onAnswer,
}: {
  question: string;
  options: { label: string; description: string }[];
  onAnswer: (label: string | null) => void;
}) {
  return (
    <form
      className="flex max-w-md flex-col gap-3"
      onSubmit={(event) => {
        event.preventDefault();
        const picked = new FormData(event.currentTarget).get("answer");
        onAnswer(typeof picked === "string" ? picked : null);
      }}
    >
      <p className="text-chat font-medium">{question}</p>
      <div className="flex flex-col gap-2">
        {options.map((option) => (
          <label
            key={option.label}
            className="group relative flex cursor-pointer items-start gap-2.5 rounded-lg border border-border px-3 py-2 text-sm transition-colors select-none hover:bg-muted/50 has-checked:border-primary/40 has-checked:bg-muted has-focus-visible:ring-2 has-focus-visible:ring-ring"
          >
            <input type="radio" name="answer" value={option.label} className="peer sr-only" />
            <span className="mt-0.5 grid size-4 shrink-0 place-items-center rounded-full border border-border peer-checked:border-primary peer-checked:bg-primary">
              <span className="hidden size-2 rounded-full bg-primary-foreground group-has-checked:block" />
            </span>
            <span className="flex min-w-0 flex-col gap-0.5 leading-snug">
              <span className="font-medium">{option.label}</span>
              <span className="text-muted-foreground">{option.description}</span>
            </span>
          </label>
        ))}
      </div>
      <div className="flex items-center justify-end gap-2">
        <button type="button" onClick={() => onAnswer(null)} className={cx(BUTTON, "hover:bg-muted/70")}>
          Skip
        </button>
        <button
          type="submit"
          className={cx(BUTTON, "bg-primary text-primary-foreground shadow-[0_1px_4px_rgba(0,0,0,0.35)] hover:bg-primary/90")}
        >
          Send
        </button>
      </div>
    </form>
  );
}

/// The composer before a session exists, standing alone mid-sheet: the
/// wordmark, the toolbar above the box rather than under it, no card around
/// the box, and a hint where the send button was. Enter sends.
export function NewTaskComposer({
  value,
  onChange,
  onSend,
  agent,
  model,
  effort,
  mode,
  project,
  base,
}: {
  value: string;
  onChange: (value: string) => void;
  onSend: () => void;
  agent?: ReactNode;
  model: string;
  effort?: string;
  mode: string;
  project: string;
  /// What a worktree forks from, named since the CLI ignores the checkout.
  base: string;
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center px-10">
      <form
        className="mx-auto w-full max-w-3xl"
        onSubmit={(event) => {
          event.preventDefault();
          onSend();
        }}
      >
        <Wordmark className="mb-4 h-auto w-30 text-foreground/10" />
        <div className="-ml-2.5 flex min-w-0 items-center gap-0.5 px-1 pb-1.5 text-ui font-medium text-muted-foreground">
          <span className="grid size-7 shrink-0 place-items-center">
            <Plus className="size-4" />
          </span>
          <span className="flex h-7 shrink-0 items-center gap-1 px-1.5">
            {agent}
            <span>{model}</span>
            {effort && <span className="text-muted-foreground/60">{effort}</span>}
          </span>
          <span className="flex h-7 shrink-0 items-center gap-1.5 px-1.5">
            <Folder className="size-3.5 shrink-0 fill-current" />
            {project}
          </span>
          {/* The track reads as on or off at a glance. */}
          <span className="flex h-7 shrink-0 items-center gap-1.5 px-1.5 text-foreground">
            <span className="flex h-3 w-5 shrink-0 items-center rounded-full bg-primary p-px">
              <span className="size-2.5 translate-x-2 rounded-full bg-background" />
            </span>
            Worktree
          </span>
          <span className="truncate px-1.5 font-normal text-muted-foreground/60">from {base}</span>
          <span className="flex h-7 shrink-0 items-center px-1.5">{mode}</span>
        </div>
        <textarea
          rows={1}
          autoFocus
          aria-label="Describe a task"
          value={value}
          onChange={(event) => onChange(event.target.value)}
          onKeyDown={(event) => {
            // An IME's Enter picks a character; it is not a send.
            if (event.key === "Enter" && !event.shiftKey && !event.nativeEvent.isComposing) {
              event.preventDefault();
              onSend();
            }
          }}
          placeholder="Describe a task."
          className="field-sizing-content max-h-40 w-full resize-none bg-transparent py-1 text-prompt text-foreground outline-none placeholder:text-muted-foreground"
        />
        <div className="flex items-center gap-1 pt-2 text-ui text-muted-foreground/60">
          Press <CornerDownLeft className="size-3" strokeWidth={2} /> to send
        </div>
      </form>
    </div>
  );
}
