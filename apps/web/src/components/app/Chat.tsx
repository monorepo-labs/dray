import type { ReactNode } from "react";
import { ArrowUp, ChevronRight, Plus } from "lucide-react";

import { PanelLeftIcon, cx } from "./Window";

/// The main column's views. Set and order in one, as the app has it.
const VIEW_TABS = ["Chat", "Browser", "Diff", "Files"];

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

/// The chat column's titlebar row: `project / title`, the branch, the view tabs
/// and the panel toggle.
///
/// The selected tab carries no fill, unlike the panel's own tab rows — this one
/// sits in the titlebar next to nothing, where a lozenge is the loudest shape
/// in a strip whose whole job is to be quiet. Colour alone marks it.
export function ChatHeader({
  project,
  title,
  branch,
  tabs = VIEW_TABS,
  activeTab = "Chat",
  className,
}: {
  project: string;
  /// Absent on a split group's header, which names the group alone.
  title?: string;
  branch?: string;
  tabs?: string[];
  activeTab?: string;
  className?: string;
}) {
  return (
    <header
      className={cx(
        "flex h-(--titlebar-h) shrink-0 items-center gap-2 overflow-hidden px-3",
        className,
      )}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3 text-ui">
        <span className="flex min-w-0 items-center gap-1.5 overflow-hidden">
          <span className="shrink-0 text-muted-foreground">{project}</span>
          {title && (
            <>
              <span className="shrink-0 text-muted-foreground/50">/</span>
              <span className="truncate font-medium text-foreground">{title}</span>
            </>
          )}
        </span>

        {branch && (
          <span className="flex min-w-0 items-center gap-1 rounded-md text-muted-foreground">
            <GitBranchIcon className="size-3.5 shrink-0" />
            <span className="truncate">{branch}</span>
          </span>
        )}
      </div>

      <div className="flex min-w-0 items-center gap-0.5 overflow-hidden">
        {tabs.map((tab) => (
          <span
            key={tab}
            className={cx(
              "rounded-md bg-transparent px-1.5 py-1 text-ui",
              tab === activeTab ? "text-sidebar-accent-foreground" : "text-muted-foreground",
            )}
          >
            {tab}
          </span>
        ))}
      </div>

      <span className="grid size-7 shrink-0 place-items-center opacity-80">
        <PanelLeftIcon className="size-4.5" mirrored />
      </span>
    </header>
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
