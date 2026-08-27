import { useState } from "react";

import { openUrl } from "@tauri-apps/plugin-opener";
import { ChevronRight, ExternalLink, Unlink } from "lucide-react";

import Avatar from "@/components/Avatar";
import { IssueFile, IssueImage } from "@/components/IssueAsset";
import IssueStateIcon, { IssuePriorityIcon } from "@/components/IssueStateIcon";
import { Markdown } from "@/components/chat/Markdown";
import { Button } from "@/components/ui/button";
import { relativeTime } from "@/lib/format";
import { cn } from "@/lib/utils";
import type { Components } from "streamdown";

import type { IssueDetail, IssueRef, IssueUnavailable } from "@/types/events";

/// What to say when the issue could not be read, in terms of what the reader
/// would do about it. `not_connected` keeps its own sentence because it is not
/// a failure — it is the app's resting state before anyone has connected a
/// tracker. Both cures name the Issues page, which is the one place a key can
/// be pasted; a sentence pointing at Settings would send the reader to a row
/// that only ever disconnects.
const UNAVAILABLE: Record<IssueUnavailable["kind"], string> = {
  not_connected: "Connect Linear on the Issues page to see this issue.",
  unauthorized:
    "Linear rejected the saved key. Disconnect it in Settings, then paste a new one on the Issues page.",
  offline: "Could not reach Linear.",
  other: "",
};

function errorText(error: IssueUnavailable): string {
  return UNAVAILABLE[error.kind] || (error.kind === "other" ? error.detail : "");
}

/// Uploads inside a description, drawn rather than linked.
///
/// Linear puts both in the description's markdown — an image as `![](…)`, a
/// file as `[name](…)` — and both point at `uploads.linear.app`, which serves
/// them behind the same auth the API is behind. So the webview cannot fetch
/// either on its own: the image renders as broken and the link opens a browser
/// tab that 401s. These two send the request through the backend, where the key
/// is, which is the whole of the fix.
///
/// Anything *not* an upload is left exactly as it was — an ordinary link in an
/// issue is an ordinary link, and rewriting it would take the app's own link
/// dialog off it.
const ASSETS: Components = {
  img: ({ src, alt }) =>
    typeof src === "string" && isUpload(src) ? (
      <IssueImage src={src} alt={alt} />
    ) : (
      <img src={typeof src === "string" ? src : undefined} alt={alt ?? ""} />
    ),
  a: ({ href, children, ...rest }) =>
    typeof href === "string" && isUpload(href) ? (
      // The link text is the filename Linear wrote into the markdown, and it
      // is the only place the name survives — the URL itself is an opaque key.
      <IssueFile href={href} name={typeof children === "string" ? children : href} />
    ) : (
      <a href={href} {...rest}>
        {children}
      </a>
    ),
};

/// Whether a URL is one of Linear's own uploads.
///
/// The frontend's copy of Rust's `is_upload`, and it has to agree with it: this
/// decides what gets *drawn* as an asset, that one decides what the key is sent
/// to. Host-exactly, not by prefix — `uploads.linear.app.evil.test` passes a
/// prefix test and is not Linear.
function isUpload(url: string): boolean {
  try {
    return new URL(url).host === "uploads.linear.app";
  } catch {
    return false;
  }
}

/// The issues this session's work is against, one collapsible row each — the
/// shape the changes and pull request panels already use, because the question
/// is the same: a list of things, any one of which can be opened.
///
/// The rows are drawn from the session's **links**, not from the read: a link
/// carries the identifier and the title, so the panel has something to show
/// before the tracker answers and keeps it if the tracker never does. The read
/// fills in the body, the status and the conversation.
export default function IssuePanel({
  sessionId,
  issues,
  details,
  loading,
  unavailable,
  onUnlink,
}: {
  sessionId: string | null;
  /// What the session is tagged with, newest last.
  issues: IssueRef[];
  /// Detail by identifier, as far as it has arrived.
  details: Record<string, IssueDetail>;
  loading: boolean;
  unavailable: IssueUnavailable | null;
  onUnlink: (sessionId: string, key: string) => void;
}) {
  if (!issues.length) {
    return (
      <Empty>
        No issue on this session. Tag one with <code className="text-foreground">#</code> in the
        composer.
      </Empty>
    );
  }

  return (
    <div className="min-h-0 flex-1 overflow-y-auto">
      {/* Under the rows it failed to update rather than over them: a refresh
          that failed against issues already on screen must not hide them. */}
      {unavailable && <p className="px-3 py-2 text-ui text-destructive">{errorText(unavailable)}</p>}

      {issues.map((issue, i) => (
        <IssueRow
          key={issue.id}
          issue={issue}
          detail={details[issue.identifier] ?? null}
          loading={loading}
          // Newest tag last, and the first row open: a session tagged once has
          // its issue open, and one tagged three times opens on the oldest —
          // which is the one it was started against.
          defaultOpen={i === 0}
          collapsible={issues.length > 1}
          onUnlink={sessionId ? () => onUnlink(sessionId, issue.id) : undefined}
        />
      ))}
    </div>
  );
}

function IssueRow({
  issue,
  detail,
  loading,
  defaultOpen,
  collapsible,
  onUnlink,
}: {
  issue: IssueRef;
  detail: IssueDetail | null;
  loading: boolean;
  defaultOpen: boolean;
  /// False when this is the session's only issue. It is then always open and
  /// its header is a label rather than a control — a disclosure arrow that can
  /// only point down is an affordance for nothing.
  collapsible: boolean;
  onUnlink?: () => void;
}) {
  const [collapsed, setCollapsed] = useState(!defaultOpen);
  const open = !collapsible || !collapsed;
  const toggle = () => setCollapsed((prev) => !prev);

  return (
    <div className="border-b border-border last:border-b-0">
      {/* A div behaving as a button, because the buttons inside it are real
          ones and a button cannot nest a button — the same shape `PrRow` and
          `SessionRow` use. */}
      <div
        {...(collapsible
          ? {
              role: "button",
              tabIndex: 0,
              onClick: toggle,
              onKeyDown: (e: React.KeyboardEvent) => {
                if (e.key === "Enter" || e.key === " ") {
                  e.preventDefault();
                  toggle();
                }
              },
            }
          : {})}
        className={cn(
          "group flex w-full items-center gap-2 px-3 py-2.5 text-left text-ui",
          collapsible &&
            "cursor-pointer transition-colors hover:bg-sidebar-accent/50 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-sidebar-ring",
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

        {/* Always drawn, "no priority" included — the slot is reserved so the
            row does not reflow when the read lands. `none` until it does,
            which is the honest resting value rather than a guess. */}
        <IssuePriorityIcon priority={detail?.priority ?? "none"} />

        <span className="shrink-0 font-medium tabular-nums">{issue.identifier}</span>

        {/* From the read where it has landed, and a resting glyph until then —
            so the row never jumps between two heights as detail arrives. */}
        {detail ? (
          <IssueStateIcon
            kind={detail.state.kind}
            color={detail.state.color}
            label={detail.state.name}
          />
        ) : (
          <IssueStateIcon kind="other" label={loading ? "Loading" : "Unknown"} />
        )}

        {/* The link's own title until the read lands, then the tracker's — a
            link is a copy and can be stale, and this is where that shows. */}
        <span className="min-w-0 flex-1 truncate text-muted-foreground">
          {detail?.title ?? issue.title}
        </span>

        <div className="flex shrink-0 items-center gap-0.5">
          {onUnlink && (
            <Button
              variant="ghost"
              size="icon-sm"
              aria-label={`Remove ${issue.identifier}`}
              title={`Remove ${issue.identifier} from this session`}
              // Shown on hover and on focus, like every other row-level control
              // here: untagging is rare, and a button on every row at rest is
              // one more thing between the reader and what the row says.
              className="text-muted-foreground opacity-0 transition-opacity group-hover:opacity-100 focus-visible:opacity-100"
              onClick={(e) => {
                e.stopPropagation();
                onUnlink();
              }}
            >
              <Unlink className="size-3.5" />
            </Button>
          )}

          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={`Open ${issue.identifier} in the browser`}
            className="text-muted-foreground"
            onClick={(e) => {
              e.stopPropagation();
              void openUrl(issue.url);
            }}
          >
            <ExternalLink className="size-3.5" />
          </Button>
        </div>
      </div>

      {open && <IssueBody detail={detail} loading={loading} />}
    </div>
  );
}

/// What is inside an opened issue: its status and people, then its description,
/// then what has been said on it.
///
/// The description is drawn here where the pull request panel deliberately
/// leaves the PR body out, and the difference is who wrote it. A PR body is the
/// reader's own text, restating what they can see in the diff beside it; an
/// issue's description is somebody else's, and it is the whole reason the tab
/// exists.
function IssueBody({ detail, loading }: { detail: IssueDetail | null; loading: boolean }) {
  if (!detail) {
    return (
      <p className="px-3 pb-3 text-ui text-muted-foreground">
        {loading ? "Reading the issue…" : "Could not read this issue."}
      </p>
    );
  }

  return (
    <div className="flex flex-col gap-3 px-3 pb-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1.5 text-ui text-muted-foreground">
        {detail.assignee && (
          <span className="flex items-center gap-1.5">
            <Avatar src={detail.assignee.avatar} name={detail.assignee.name} />
            {detail.assignee.name}
          </span>
        )}

        {detail.project && <span>{detail.project}</span>}

        {/* Last, because it is the least of the four and the one that keeps
            changing — a row that reflows as the clock moves is worse at the
            left edge than at the right. */}
        {detail.updatedAt && <span>Updated {relativeTime(detail.updatedAt)}</span>}
      </div>

      {detail.labels.length > 0 && (
        <div className="flex flex-wrap gap-1">
          {detail.labels.map((label) => (
            // The tracker's own colour, and the one place this panel uses it:
            // a label has no meaning apart from the colour somebody chose for
            // it, unlike a status, which folds onto a fixed vocabulary.
            <span
              key={label.name}
              className="rounded-full border px-1.5 py-px text-ui"
              style={{ borderColor: label.color || undefined, color: label.color || undefined }}
            >
              {label.name}
            </span>
          ))}
        </div>
      )}

      {detail.description ? (
        <div className="text-chat">
          <Markdown components={ASSETS}>{detail.description}</Markdown>
        </div>
      ) : (
        <p className="text-ui text-muted-foreground">No description.</p>
      )}

      {detail.comments.length > 0 && (
        <div className="flex flex-col gap-2 border-t border-border pt-3">
          {detail.comments.map((comment, i) => (
            <div key={i} className="flex flex-col gap-1">
              <div className="flex items-center gap-1.5 text-ui text-muted-foreground">
                <Avatar src={comment.author.avatar} name={comment.author.name} />
                <span className="text-foreground">{comment.author.name}</span>
                <span>{relativeTime(comment.createdAt)}</span>
              </div>
              <div className="text-chat">
                <Markdown>{comment.body}</Markdown>
              </div>
            </div>
          ))}
        </div>
      )}
    </div>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <p className="px-3 py-4 text-ui text-muted-foreground">{children}</p>;
}
