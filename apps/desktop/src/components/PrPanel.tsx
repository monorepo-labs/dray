import { useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";
import {
  Check,
  ChevronDown,
  ChevronRight,
  CircleDashed,
  CircleSlash,
  ExternalLink,
  GitMerge,
  GitPullRequest,
  GitPullRequestClosed,
  GitPullRequestDraft,
  Loader2,
  MinusCircle,
  X,
} from "lucide-react";

import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import type { usePullRequest, PrAction } from "@/hooks/usePullRequest";
import { relativeTime } from "@/lib/format";
import { firstLine, mergeReadiness, stripBotMarkers, summarizeChecks, type Tone } from "@/lib/pr";
import { cn } from "@/lib/utils";
import type {
  MergeMethod,
  PrCheck,
  PrComment,
  PrUnavailable,
  PullRequest,
} from "@/types/events";

/// Everything the panel needs, owned by `App` — see [usePullRequest]. The panel
/// draws it and nothing more, because the tab row above it reads the same data
/// to decide whether to exist and where to sit.
export type PrData = ReturnType<typeof usePullRequest>;

type PrPanelProps = PrData & {
  /// The branch this session's work lands on. Null for a session in a
  /// directory that is not a repo.
  branch: string | null;
};

const TONE_TEXT: Record<Tone, string> = {
  ready: "text-emerald-500",
  blocked: "text-accent-command",
  conflict: "text-destructive",
  pending: "text-accent-command",
  neutral: "text-muted-foreground",
};

/// What to say when we couldn't ask, in the words of what the reader would do
/// about it. `no_cli` and `no_remote` hide the tab outright, so they are here
/// only for the window between a stale render and the tab going away.
const UNAVAILABLE: Record<PrUnavailable["kind"], string> = {
  no_cli: "GitHub CLI (gh) is not installed.",
  not_authenticated: "GitHub CLI is not logged in. Run `gh auth login` to see pull requests here.",
  no_remote: "This directory has no GitHub remote.",
  other: "",
};

/// The pull requests opened from this session's branch, one collapsible row
/// each — the shape the changes panel already uses, because the question is the
/// same: a list of things that changed, any one of which can be opened.
///
/// The PR body is deliberately absent from the expanded row. It is the one
/// thing here the reader wrote themselves, it is usually the longest thing on
/// the page, and it pushes the checks — the part that changes — below the fold.
/// The title links out for anyone who wants the rest.
export default function PrPanel({ branch, prs, error, loading, acting, act }: PrPanelProps) {
  if (!branch) {
    return <Empty>This session is not on a branch, so it has no pull request.</Empty>;
  }

  // An error only takes the pane when there is nothing to take it from. A
  // refresh that failed against rows already on screen is reported under the
  // header instead, where it can't hide what it failed to update.
  if (!prs.length && error) {
    return <Empty tone="error">{UNAVAILABLE[error.kind] || errorText(error)}</Empty>;
  }
  if (!prs.length && loading) return <Empty>Looking for a pull request…</Empty>;
  if (!prs.length) {
    return (
      <Empty>
        No pull request for <code className="text-foreground">{branch}</code>.
      </Empty>
    );
  }

  // No header line of its own. The count rides the tab's own badge — the same
  // place the subagent count already sits — and the refresh button belongs to
  // the frame, so a strip repeating the word "pull request" above a list of
  // pull requests was the only thing left on it.
  return (
    <>
      <div className="min-h-0 flex-1 overflow-y-auto">
        {error && (
          <p className="px-3 py-2 text-ui text-destructive">
            {UNAVAILABLE[error.kind] || errorText(error)}
          </p>
        )}

        {prs.map((pr, i) => (
          // Newest first, and the first one open: the backend sorts open PRs
          // ahead of settled ones, so row zero is the one being worked on and
          // opening it costs the reader nothing they didn't want.
          <PrRow
            key={pr.number}
            pr={pr}
            defaultOpen={i === 0}
            collapsible={prs.length > 1}
            acting={acting}
            act={act}
          />
        ))}
      </div>
    </>
  );
}

function errorText(error: PrUnavailable): string {
  return error.kind === "other" ? error.detail : "";
}

/// One pull request: a row that says what it is and how big it is, opening onto
/// whether it can land, what the checks say, and what was left on it.
function PrRow({
  pr,
  defaultOpen,
  collapsible,
  acting,
  act,
}: {
  pr: PullRequest;
  defaultOpen: boolean;
  /// False when this is the only PR on the branch. It is then always open, its
  /// header is a label rather than a control, and the chevron goes: a disclosure
  /// arrow that can only ever point down is an affordance for nothing, and
  /// collapsing the single row leaves the tab showing one line.
  collapsible: boolean;
  acting: boolean;
  act: (action: PrAction) => Promise<void>;
}) {
  const [collapsed, setCollapsed] = useState(!defaultOpen);
  const open = !collapsible || !collapsed;
  const checks = summarizeChecks(pr.checks);

  const Header = collapsible ? "button" : "div";

  return (
    <div className="border-b border-border last:border-b-0">
      <Header
        {...(collapsible
          ? { type: "button" as const, onClick: () => setCollapsed((prev) => !prev) }
          : {})}
        className={cn(
          "flex w-full items-center gap-2 px-3 py-2.5 text-left text-ui",
          collapsible && "cursor-pointer transition-colors hover:bg-sidebar-accent/50",
        )}
      >
        {collapsible && (
          <ChevronRight
            className={cn(
              "size-3.5 shrink-0 text-muted-foreground transition-transform",
              open && "rotate-90",
            )}
          />
        )}
        <StateIcon pr={pr} />
        <span className="shrink-0 text-muted-foreground">#{pr.number}</span>
        <span className="min-w-0 flex-1 truncate text-sidebar-foreground">{pr.title}</span>
        <Counts added={pr.additions} removed={pr.deletions} />
      </Header>

      {open && (
        <div className="flex flex-col gap-4 pb-3">
          <Readiness pr={pr} acting={acting} act={act} />

          <Section
            title="Checks"
            count={
              checks.total
                ? [
                    checks.failed && `${checks.failed} failing`,
                    checks.pending && `${checks.pending} running`,
                    checks.passed && `${checks.passed} passed`,
                  ]
                    .filter(Boolean)
                    .join(" · ")
                : undefined
            }
          >
            {pr.checks.length ? (
              pr.checks.map((check, i) => <CheckRow key={`${check.name}-${i}`} check={check} />)
            ) : (
              <p className="px-3 py-1 text-ui text-muted-foreground">No checks on this branch.</p>
            )}
          </Section>

          <Section title="Comments" count={pr.comments.length || undefined}>
            {pr.comments.length ? (
              // Checks are a dense column of one-line facts; comments are
              // separate things people said, so they get air between them
              // rather than the same tight rhythm.
              <div className="flex flex-col gap-2">
                {pr.comments.map((comment, i) => (
                  <CommentCard
                    key={`${comment.author}-${comment.createdAt}-${i}`}
                    comment={comment}
                  />
                ))}
              </div>
            ) : (
              <p className="px-3 py-1 text-ui text-muted-foreground">Nothing left on it yet.</p>
            )}
          </Section>
        </div>
      )}
    </div>
  );
}

/// Lines added and removed, same shape and same colours as the changes panel's
/// — a PR is a diff, and the reader already knows how to read this figure.
function Counts({ added, removed }: { added: number; removed: number }) {
  return (
    <span className="shrink-0 font-mono text-ui">
      {added > 0 && <span className="text-emerald-500">+{added}</span>}
      {added > 0 && removed > 0 && " "}
      {removed > 0 && <span className="text-destructive">−{removed}</span>}
    </span>
  );
}

function StateIcon({ pr }: { pr: PullRequest }) {
  const [Icon, tone, label] =
    pr.state === "MERGED"
      ? ([GitMerge, "text-purple-500", "Merged"] as const)
      : pr.state === "CLOSED"
        ? ([GitPullRequestClosed, "text-destructive", "Closed"] as const)
        : pr.isDraft
          ? ([GitPullRequestDraft, "text-muted-foreground", "Draft"] as const)
          : ([GitPullRequest, "text-emerald-500", "Open"] as const);

  return <Icon className={cn("size-3.5 shrink-0", tone)} aria-label={label} />;
}

/// A commenter's or a check reporter's picture, falling back to their initial.
///
/// The image is remote and its account may have none, so the letter is the
/// resting state and the image covers it once it loads — that way a slow or
/// missing avatar never leaves a hole where a row's left edge should be.
function Avatar({ src, name }: { src: string | null; name: string }) {
  const [failed, setFailed] = useState(false);

  return (
    <span
      aria-hidden
      className="relative flex size-4 shrink-0 items-center justify-center overflow-hidden rounded-full bg-muted text-[9px] uppercase text-muted-foreground"
    >
      {name.slice(0, 1)}
      {src && !failed && (
        <img
          src={src}
          alt=""
          loading="lazy"
          onError={() => setFailed(true)}
          className="absolute inset-0 size-full object-cover"
        />
      )}
    </span>
  );
}

/// GitHub's green, on both halves of the split button.
///
/// The primary fill is a near-white on this palette, which made the least
/// reversible control on the pane also the brightest thing on it. Green is what
/// the same button is on GitHub, so it is recognisable before it is read.
const MERGE_FILL =
  "bg-accent-merge text-accent-merge-foreground hover:bg-accent-merge-hover shadow-none";

/// Kept clickable-looking while a write is in flight.
///
/// `disabled` is still set — the guard against a second click is the point —
/// but its 50% fade is dropped. A button that dims and keeps its label says
/// only "not now"; one that spins and renames itself to the verb in progress
/// says what it is doing, which is the question during the two seconds a merge
/// takes. The base sets `disabled:pointer-events-none`, so the cursor already
/// stops promising a click without any help here.
const BUSY = "disabled:opacity-100";

/// The verb, while it is happening.
function busyLabel(kind: PrAction["kind"]): string {
  return { merge: "Merging…", reopen: "Reopening…", ready: "Marking ready…" }[kind];
}

const METHOD_LABEL: Record<MergeMethod, string> = {
  squash: "Squash and merge",
  merge: "Create a merge commit",
  rebase: "Rebase and merge",
};

/// What each one does to the base branch's history, in the one line that
/// actually distinguishes them. Spelled out in the menu rather than left to be
/// known: this is the only irreversible choice on the pane.
const METHOD_DETAIL: Record<MergeMethod, string> = {
  squash: "All commits become one new commit on the base.",
  merge: "Every commit is kept, plus a merge commit joining the two histories.",
  rebase: "Each commit is replayed onto the base. Linear history, new SHAs.",
};

/// Whether it can land, where it lands, and the button that lands it — one row.
///
/// The three were three stacked lines and did not need to be: the verdict is
/// two words, the base is two more, and the button belongs beside the verdict
/// it depends on rather than under it. `detail` is the one part that still
/// wraps to its own line, because it is a sentence and only appears when
/// something is wrong.
function Readiness({
  pr,
  acting,
  act,
}: {
  pr: PullRequest;
  acting: boolean;
  act: (action: PrAction) => Promise<void>;
}) {
  const [method, setMethod] = useState<MergeMethod>("squash");
  const [confirming, setConfirming] = useState(false);

  const readiness = mergeReadiness(pr);
  const ready = readiness.tone === "ready";

  return (
    <section className="px-3">
      <div className="flex min-h-7 items-center gap-2">
        <p className={cn("shrink-0 text-ui font-medium", TONE_TEXT[readiness.tone])}>
          {readiness.label}
        </p>

        {/* The base only. The head is this session's own branch, named in the
            window header two inches away, so repeating it spends space saying
            what the reader already knows — where the work is *going* is the
            half that isn't on screen anywhere else, and the half that tells two
            PRs from one branch apart. */}
        {pr.state === "OPEN" && (
          <p className="min-w-0 truncate text-ui text-muted-foreground">
            <span className="text-muted-foreground/50">into</span> {pr.baseRefName}
          </p>
        )}

        <div className="ml-auto flex shrink-0 items-center gap-1.5">
          <Button
            variant="ghost"
            size="icon-sm"
            className="text-muted-foreground/60 hover:text-muted-foreground"
            onClick={() => void openUrl(pr.url)}
            title="Open on GitHub"
          >
            <ExternalLink className="size-3" />
          </Button>

          {pr.state === "CLOSED" && (
            <Button
              variant="outline"
              size="sm"
              className={BUSY}
              disabled={acting}
              onClick={() => void act({ kind: "reopen" })}
            >
              {acting && <Loader2 className="animate-spin" />}
              {acting ? busyLabel("reopen") : "Reopen"}
            </Button>
          )}

          {pr.state === "OPEN" &&
            (pr.isDraft ? (
              <Button
                variant="outline"
                size="sm"
                className={BUSY}
                disabled={acting}
                onClick={() => void act({ kind: "ready" })}
              >
                {acting && <Loader2 className="animate-spin" />}
                {acting ? busyLabel("ready") : "Ready for review"}
              </Button>
            ) : confirming ? (
              <>
                <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                  Cancel
                </Button>
                <Button
                  size="sm"
                  className={cn(MERGE_FILL, "shadow-(--shadow-button)")}
                  disabled={acting}
                  onClick={() => {
                    setConfirming(false);
                    void act({ kind: "merge", method });
                  }}
                >
                  Confirm {METHOD_LABEL[method].toLowerCase()}
                </Button>
              </>
            ) : (
              // One green rectangle with a seam, not two buttons pushed
              // together: the shadow and the radius belong to the pair, so they
              // sit here and each half drops its own. The seam is an inset
              // shadow on the right half — a border would be a line of a third
              // colour across a single fill.
              <div
                className={cn(
                  "flex items-center rounded-[min(var(--radius-md),12px)] shadow-(--shadow-button)",
                  // The not-ready dim, which is about the PR rather than about
                  // a write in flight — those two must not stack, or a merge
                  // started from a not-ready PR fades twice.
                  !ready && !acting && "opacity-60",
                )}
              >
                {/* Not `disabled`: a disabled button explains nothing and can't
                    be hovered for the reason. It stays clickable at reduced
                    strength and the verdict beside it is the answer — the same
                    bargain the update row's install button makes.

                    No icon. The label already says "merge", and the glyph was
                    the widest thing in a button that only ever names one of
                    three near-identical actions. */}
                <Button
                  size="sm"
                  className={cn(MERGE_FILL, BUSY, "rounded-r-none")}
                  disabled={acting}
                  title={ready ? undefined : "This pull request is not ready to merge"}
                  onClick={() => setConfirming(true)}
                >
                  {acting && <Loader2 className="animate-spin" />}
                  {acting ? busyLabel("merge") : METHOD_LABEL[method]}
                </Button>

                <DropdownMenu>
                  <DropdownMenuTrigger asChild>
                    <Button
                      size="sm"
                      className={cn(
                        MERGE_FILL,
                        BUSY,
                        "rounded-l-none px-1.5 shadow-(--accent-merge-seam)",
                      )}
                      disabled={acting}
                      aria-label="Merge method"
                    >
                      <ChevronDown />
                    </Button>
                  </DropdownMenuTrigger>

                  {/* Ends flush with the button, which sits at the pane's right
                      edge — aligned to its start the menu would open off the
                      window. Wide enough for the descriptions to sit on one or
                      two lines: at the menu's default width each was five
                      lines, and the menu was taller than the panel. */}
                  <DropdownMenuContent align="end" className="w-80">
                    {(["squash", "merge", "rebase"] as const).map((value) => (
                      <DropdownMenuItem
                        key={value}
                        onSelect={() => setMethod(value)}
                        className="flex-col items-start gap-0"
                      >
                        <span className="flex w-full items-center">
                          {METHOD_LABEL[value]}
                          {method === value && <Check className="ml-auto size-3.5" />}
                        </span>
                        <span className="text-ui text-muted-foreground">
                          {METHOD_DETAIL[value]}
                        </span>
                      </DropdownMenuItem>
                    ))}
                  </DropdownMenuContent>
                </DropdownMenu>
              </div>
            ))}
        </div>
      </div>

      {readiness.detail && (
        <p className="mt-0.5 text-ui text-muted-foreground">{readiness.detail}</p>
      )}
    </section>
  );
}

function Section({
  title,
  count,
  children,
}: {
  title: string;
  count?: string | number;
  children: React.ReactNode;
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

const CHECK_ICON: Record<PrCheck["state"], { Icon: typeof Check; tone: string }> = {
  success: { Icon: Check, tone: "text-emerald-500" },
  failure: { Icon: X, tone: "text-destructive" },
  // Spins, because a running check is the one row on this pane that is going to
  // change on its own — and the poll that changes it is invisible otherwise.
  pending: { Icon: CircleDashed, tone: "text-accent-command animate-spin [animation-duration:3s]" },
  skipped: { Icon: MinusCircle, tone: "text-muted-foreground" },
  cancelled: { Icon: CircleSlash, tone: "text-muted-foreground" },
  neutral: { Icon: MinusCircle, tone: "text-muted-foreground" },
};

function CheckRow({ check }: { check: PrCheck }) {
  const { Icon, tone } = CHECK_ICON[check.state];

  // The whole row opens the log rather than a link inside it: a check is one
  // fact and one destination, and a 12px target inside a row that does nothing
  // is the harder thing to hit. No hover fill — a check row is a fact with a
  // link on it, not a list item to pick from, and a band sweeping the pane on
  // every pass of the cursor made a short static list feel like a menu.
  return (
    <button
      type="button"
      disabled={!check.url}
      onClick={() => check.url && void openUrl(check.url)}
      className={cn(
        "flex w-full items-center gap-2 px-3 py-1 text-left text-ui",
        check.url ? "cursor-pointer" : "cursor-default",
      )}
    >
      {/* State first, in a column the eye can run down; the reporter's mark
          second, where it reads as who is saying so. The state is why anyone
          looks at this list, so it keeps the left edge. */}
      <Icon className={cn("size-3.5 shrink-0", tone)} />
      <Avatar src={check.avatar} name={check.name} />
      <span className="truncate text-sidebar-foreground">{check.name}</span>
      {check.workflow && (
        <span className="shrink-0 truncate text-muted-foreground">{check.workflow}</span>
      )}
    </button>
  );
}

/// What a review's verdict is called, in the words GitHub uses. A plain comment
/// gets none — "commented" beside a comment is the row saying its own type.
const VERDICT: Record<PrComment["kind"], { word?: string; tone?: string }> = {
  comment: {},
  approved: { word: "approved", tone: "text-emerald-500" },
  changes_requested: { word: "requested changes", tone: "text-destructive" },
  reviewed: { word: "reviewed", tone: "text-muted-foreground" },
};

/// One entry on the timeline, collapsed until opened.
///
/// All of them, including reviews: a list where some rows are open and some are
/// closed reads as an accident rather than a rule, and the first line each one
/// shows is enough to decide which is worth the click. The verdict — approved,
/// requested changes — is carried by a coloured word in the closed row, so the
/// one thing worth knowing without opening anything is already there.
///
/// The author's picture stands in for the icon that used to sit here. It says
/// who in the same space, and a column of identical speech bubbles said nothing
/// at all.
function CommentCard({ comment }: { comment: PrComment }) {
  const { word, tone } = VERDICT[comment.kind];
  const body = stripBotMarkers(comment.body);

  const [open, setOpen] = useState(false);

  return (
    <article className="px-3">
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        disabled={!body}
        className="flex w-full cursor-pointer items-center gap-1.5 py-0.5 text-left text-ui disabled:cursor-default"
      >
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground/60 transition-transform",
            open && "rotate-90",
            !body && "invisible",
          )}
        />
        <Avatar src={comment.avatar} name={comment.author} />
        <span className="shrink-0 text-sidebar-foreground">{comment.author}</span>
        {word && <span className={cn("shrink-0", tone)}>{word}</span>}

        {/* Closed, the first line stands in for the body — a row that says only
            who wrote it makes the reader open every one to find the one that
            matters. */}
        {!open && body && (
          <span className="min-w-0 flex-1 truncate text-muted-foreground">{firstLine(body)}</span>
        )}

        <span className={cn("shrink-0 text-muted-foreground", open && "ml-auto")}>
          {relativeTime(comment.createdAt)}
        </span>
      </button>

      {/* Bot comments carry tables, badges and preview links, so this is real
          markdown rather than text — a Vercel comment rendered flat is a wall
          of pipe characters. */}
      {open && body && <Markdown className="mb-1 mt-1 pl-6 text-ui">{body}</Markdown>}
    </article>
  );
}

function Empty({
  children,
  tone = "muted",
}: {
  children: React.ReactNode;
  tone?: "muted" | "error";
}) {
  return (
    <div className="flex min-h-0 flex-1 items-center justify-center p-6">
      <p
        className={cn(
          "max-w-72 text-balance text-center text-ui",
          tone === "error" ? "text-destructive" : "text-muted-foreground",
        )}
      >
        {children}
      </p>
    </div>
  );
}
