import type { ReactNode } from "react";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  RefreshCw,
} from "lucide-react";
import { HINT_KEYS, Keys } from "./Sidebar";
import { cx } from "./Window";

/// The right pane, drawn as `RightPanel` draws it: one frame with a tab row,
/// and the PR tab's rows under it. Static; the scene animates over it.
export default function Panel({
  tabs,
  active,
  counts,
  children,
  width = 460,
  className,
}: {
  tabs: string[];
  active: string;
  counts?: Record<string, number>;
  children: ReactNode;
  width?: number;
  className?: string;
}) {
  return (
    <aside
      className={cx("relative flex shrink-0 flex-col border-l border-border", className)}
      style={{ width }}
    >
      <div className="flex h-(--titlebar-h) shrink-0 items-center gap-0.5 overflow-hidden border-b border-border px-2">
        <div className="flex h-full min-w-0 items-center gap-0.5">
          {tabs.map((tab) => (
            <span
              key={tab}
              className={cx(
                "rounded-md px-2 py-1 text-ui",
                tab === active
                  ? "bg-sidebar-accent text-sidebar-accent-foreground"
                  : "text-muted-foreground",
              )}
            >
              {tab}
              {!!counts?.[tab] && <span className="ml-1 text-muted-foreground">{counts[tab]}</span>}
            </span>
          ))}
          <Keys caps={["⌘", "⇧", "[ ]"]} className={cx("ml-1.5 shrink-0 opacity-50", HINT_KEYS)} />
        </div>
        <div className="ml-auto flex shrink-0 items-center">
          <span className="grid size-7 place-items-center text-muted-foreground/60">
            <RefreshCw className="size-3" />
          </span>
        </div>
      </div>
      {children}
    </aside>
  );
}

/// The PR's own row: state glyph, number, title, counts, and the link out.
export function PrRow({
  number,
  title,
  added,
  removed,
  glyph,
  className,
}: {
  number: number;
  title: string;
  added: number;
  removed: number;
  /// The state glyph slot, so a scene can swap open for merged.
  glyph?: ReactNode;
  className?: string;
}) {
  return (
    <div className={cx("flex w-full items-center gap-2 px-3 py-2.5 text-left text-ui", className)}>
      {glyph ?? <PrOpenGlyph />}
      <span className="shrink-0 text-muted-foreground">#{number}</span>
      <span className="min-w-0 flex-1 truncate text-sidebar-foreground">{title}</span>
      <span className="shrink-0 font-mono text-ui">
        <span className="text-accent-add">+{added}</span> <span className="text-destructive">−{removed}</span>
      </span>
      <span className="-mr-1 grid size-6 shrink-0 place-items-center text-muted-foreground/60">
        <ExternalLink className="size-3" />
      </span>
    </div>
  );
}

export function PrOpenGlyph({ className }: { className?: string }) {
  return <GitPullRequest className={cx("size-4 shrink-0 text-accent-add", className)} />;
}

export function PrMergedGlyph({ className }: { className?: string }) {
  return <GitMerge className={cx("size-4 shrink-0 text-accent-merged", className)} />;
}

/// The verdict line and the merge control beside it.
export function Readiness({
  label,
  tone,
  base,
  detail,
  ready,
  className,
}: {
  label: ReactNode;
  tone: "ready" | "pending";
  base: string;
  detail?: ReactNode;
  ready: boolean;
  className?: string;
}) {
  return (
    <section className={cx("px-3", className)}>
      <div className="flex min-h-7 items-center gap-2">
        <p
          className={cx(
            "shrink-0 text-ui font-medium",
            tone === "ready" ? "text-accent-add" : "text-accent-command",
          )}
        >
          {label}
        </p>
        <p className="min-w-0 truncate text-ui text-muted-foreground">
          <span className="text-muted-foreground/50">into</span> {base}
        </p>
        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          {/* The split merge button, drawn at reduced strength until the PR is
              ready — the app's own reading, where the verdict beside it is the
              reason. */}
          <div
            className={cx(
              "flex items-center rounded-[min(var(--radius-md),12px)] shadow-[0_1px_4px_rgba(0,0,0,0.35)] transition-opacity duration-300",
              !ready && "opacity-60",
            )}
          >
            <span className="flex h-7 items-center rounded-l-[min(var(--radius-md),12px)] bg-accent-merge px-2.5 text-[0.8rem] font-medium text-accent-merge-foreground">
              Squash and merge
            </span>
            <span className="flex h-7 items-center rounded-r-[min(var(--radius-md),12px)] bg-accent-merge px-1.5 text-accent-merge-foreground shadow-[inset_1px_0_1px_rgba(255,255,255,0.1)]">
              <ChevronDown className="size-3.5" />
            </span>
          </div>
        </div>
      </div>
      {detail && <p className="mt-0.5 text-ui text-muted-foreground">{detail}</p>}
    </section>
  );
}

export function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: ReactNode;
  children: ReactNode;
}) {
  return (
    <section>
      <h3 className="flex items-baseline gap-2 px-3 pb-1 text-ui text-sidebar-foreground">
        {title}
        {count !== undefined && <span className="text-muted-foreground">{count}</span>}
      </h3>
      {children}
    </section>
  );
}

/// A check: its state on the left edge, then who is saying so.
export function CheckRow({
  state,
  avatar,
  name,
  className,
}: {
  state: ReactNode;
  avatar: ReactNode;
  name: string;
  className?: string;
}) {
  return (
    <div className={cx("flex w-full items-center gap-2 px-3 py-1 text-left text-ui", className)}>
      {state}
      <CheckAvatar>{avatar}</CheckAvatar>
      <span className="truncate text-sidebar-foreground">{name}</span>
    </div>
  );
}

export function CheckPassed({ className }: { className?: string }) {
  return <Check className={cx("size-3.5 shrink-0 text-accent-add", className)} />;
}

export function CheckRunning({ className }: { className?: string }) {
  return (
    <CircleDashed
      className={cx("size-3.5 shrink-0 animate-spin text-accent-command [animation-duration:3s]", className)}
      strokeWidth={1.5}
    />
  );
}

/// The 16px round avatar a check or comment carries.
export function CheckAvatar({ children }: { children: ReactNode }) {
  return (
    <span className="relative flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[9px] text-muted-foreground uppercase">
      {children}
    </span>
  );
}

/// Vercel's triangle, at the size a check or comment avatar draws it.
export function VercelMark() {
  return (
    <svg viewBox="0 0 16 16" className="size-2 fill-foreground" aria-hidden>
      <path d="M8 2l7 12H1z" />
    </svg>
  );
}

/// A comment's collapsed row: author, verdict, first line, age.
export function CommentRow({
  avatar,
  author,
  word,
  preview,
  replies,
  age,
}: {
  avatar: ReactNode;
  author: string;
  word?: string;
  preview?: string;
  replies?: number;
  age: string;
}) {
  return (
    <article className="px-3">
      <div className="flex w-full items-center gap-1.5 py-0.5 text-left text-ui">
        <ChevronRight className="size-3 shrink-0 text-muted-foreground/60" />
        <CheckAvatar>{avatar}</CheckAvatar>
        <span className="shrink-0 text-sidebar-foreground">{author}</span>
        {word && <span className="shrink-0 text-muted-foreground">{word}</span>}
        {preview && <span className="min-w-0 flex-1 truncate text-muted-foreground">{preview}</span>}
        {replies && (
          <span className={cx("shrink-0 text-muted-foreground", !preview && "ml-auto")}>
            {replies} {replies === 1 ? "reply" : "replies"}
          </span>
        )}
        <span className={cx("shrink-0 text-muted-foreground", !preview && !replies && "ml-auto")}>
          {age}
        </span>
      </div>
    </article>
  );
}
