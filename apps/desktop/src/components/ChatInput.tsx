import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ArrowUp, CornerDownLeft, Paperclip, Square, X } from "lucide-react";

import AttachmentTray from "@/components/composer/AttachmentTray";
import FileMentionMenu from "@/components/composer/FileMentionMenu";
import IssueMentionMenu from "@/components/composer/IssueMentionMenu";
import SlashCommandMenu from "@/components/composer/SlashCommandMenu";
import { Button } from "@/components/ui/button";
import {
  addAttachmentPaths,
  clearAttachments,
  pickAttachments,
  removeAttachment,
  useAttachments,
} from "@/hooks/useAttachments";
import { useDraft } from "@/hooks/useDraft";
import { useFileSearch } from "@/hooks/useFileSearch";
import { useHotkey } from "@/hooks/useHotkey";
import { useIssueSearch } from "@/hooks/useIssueSearch";
import { useRecentCommands } from "@/hooks/useRecentCommands";
import { SEGMENT_COLOR, highlightSegments, splitMention } from "@/lib/highlight";
import { applyIssue, issueSpan } from "@/lib/issue";
import { applyMention, mentionSpan } from "@/lib/mention";
import {
  applyCommand,
  filterCommands,
  groupCommands,
  parseSlashCommand,
  slashQuery,
} from "@/lib/slash";
import { cn } from "@/lib/utils";
import type { FileMatch, Issue, QueuedMessage, SlashCommand } from "@/types/events";

type ChatInputProps = {
  /// `attachmentPaths` is what the tray held, as absolute paths. The backend
  /// re-reads each one — nothing but paths crosses the bridge, so a pinned
  /// screenshot is never uploaded twice.
  onSend: (message: string, attachmentPaths: string[]) => void;
  /// What the `/` picker offers. Empty until the backend's probe lands, and
  /// empty forever if it failed — the picker simply never opens, and a command
  /// typed by hand still works, since the CLI parses the text either way.
  commands?: SlashCommand[];
  /// Where the `@` picker searches for files. The session's own directory, so a
  /// worktree session mentions paths inside its tree — the CLI resolves `@path`
  /// against the directory it was spawned in, and those are the same one.
  cwd?: string | null;
  /// An issue tracker is connected, so `#` opens a picker. Drawn in the
  /// placeholder and nowhere else — the picker itself simply finds nothing
  /// without one.
  issuesConnected?: boolean;
  /// Interrupts the running turn. Reachable while `busy` and the box is empty —
  /// with something typed the same button sends, since a prompt written during a
  /// turn is queued onto it rather than refused.
  onStop?: () => void;
  /// Takes back the newest prompt still waiting on the CLI, resolving to it so
  /// its text can go back in the box. `null` when the flush got there first.
  onCancelQueued?: () => Promise<QueuedMessage | null>;
  /// How many prompts are waiting. Only decides whether Esc is bound — the rows
  /// themselves are drawn by the transcript, above this component.
  queuedCount?: number;
  /// Rendered outside the card — below it normally, above it on a new task. A
  /// node rather than the controls' own props, so this component keeps owning
  /// layout and measurement and nothing else.
  toolbar?: ReactNode;
  /// Drawn above the toolbar, and blocks sending while present.
  ///
  /// Separate from `error`: that reports something that was attempted and
  /// failed, this reports that nothing can be attempted yet. Only the second
  /// kind has a cure to offer, which is why it is a node and not a string.
  notice?: ReactNode;
  /// The "hand it back" actions, clipped to a sliver above the card and opening
  /// on hover. A node for the toolbar's reason, and placed here rather than by
  /// the shell so it sits inside the same `max-w-3xl` column and against the
  /// card's own top edge — it clips itself to that edge, so nothing can come
  /// between them. Absent on a new task: there is no session to send into.
  handoff?: ReactNode;
  busy?: boolean;
  /// Which session's draft is in the box, and what the composer refocuses on
  /// when the user switches. `null` is the new task's own draft, not the
  /// absence of one.
  sessionId?: string | null;
  /// No session yet, so the composer stands alone mid-window. Nothing sits
  /// behind it to separate it from: the card drops its fill, border, and
  /// padding, the toolbar moves above — reading order runs settings first, then
  /// the box they apply to — and the send button gives way to a keyboard hint.
  isNewTask?: boolean;
  /// A backend failure, shown above the composer. Lives here rather than in the
  /// shell so it inherits the form's `max-w-3xl` column and lines up with the
  /// input; the transcript is the wrong home for it, since most of these fail
  /// before any session exists to have a transcript.
  error?: string | null;
  onDismissError?: () => void;
  /// A settled session takes no new turns, so the composer is replaced by the one
  /// control that can change that. Handled here rather than in the shell so the
  /// bar inherits the form's column and sits exactly where the card would.
  archived?: boolean;
  onUnarchive?: () => void;
  /// Only set while the session still has a worktree on disk, which is what
  /// retires the button: the removal clears `worktreeName`, so the control
  /// goes away because the thing it acted on did.
  onRemoveWorktree?: () => void;
};

const MAX_ROWS = 10;
// The empty state has no transcript above it to crowd, so the box can take a lot
// more of the window before it starts scrolling. Capped rather than unbounded
// because this composer is centered: past the window's height it would overflow
// off both ends at once, putting the wordmark past the top edge with nothing to
// scroll it back.
const NEW_TASK_MAX_ROWS = 20;

// Everything that decides where a glyph lands. The textarea and the overlay that
// colours a command inside it must agree on all of it exactly, or the two copies
// of the text drift apart and show as ghosting — so they share one constant
// rather than two matching class lists. The horizontal padding varies by state
// and is applied at both call sites alongside this.
const TEXT_BOX = "py-1 text-composer";

// `String.raw` because the glyphs are drawn with backslashes; an ordinary
// template literal would eat them as escapes.
// const WORDMARK = String.raw` ___    ____    ____  __ __
// |   \  |    \  /    ||  |  |
// |    \ |  D  )|  o  ||  |  |
// |  D  ||    / |     ||  ~  |
// |     ||    \ |  _  ||___, |
// |     ||  .  \|  |  ||     |
// |_____||__|\_||__|__||____/`;

// The file is the source, so editing the logo needs no change here — but an
// <img> paints the file's own fill and this has to take the page's text color.
// So it is a mask over a `currentColor` background: the SVG supplies the shape,
// the CSS supplies the ink. Prefixed as well as not, for the older WebKit a
// Linux build runs on.
const WORDMARK_MASK = {
  maskImage: "url(/assets/dray-logo.svg)",
  WebkitMaskImage: "url(/assets/dray-logo.svg)",
  maskSize: "contain",
  WebkitMaskSize: "contain",
  maskRepeat: "no-repeat",
  WebkitMaskRepeat: "no-repeat",
  // `contain` + `left` is what makes the box tolerant of a redrawn logo: the
  // mark fits inside it at whatever aspect ratio the file has, rather than
  // being stretched to a ratio hardcoded here.
  maskPosition: "left",
  WebkitMaskPosition: "left",
} as const;

export default function ChatInput({
  onSend,
  commands = [],
  cwd = null,
  issuesConnected = false,
  onStop,
  onCancelQueued,
  queuedCount = 0,
  toolbar,
  notice,
  handoff,
  busy = false,
  sessionId = null,
  isNewTask = false,
  error = null,
  onDismissError,
  archived = false,
  onUnarchive,
  onRemoveWorktree,
}: ChatInputProps) {
  const [message, setMessage] = useDraft(sessionId);
  const [resizeTick, setResizeTick] = useState(0);
  const textareaRef = useRef<HTMLTextAreaElement>(null);
  const cardRef = useRef<HTMLDivElement>(null);
  const mirrorRef = useRef<HTMLDivElement>(null);

  // Where the caret is, tracked so the picker can tell a command being typed
  // from a slash that has already been left behind.
  const [caret, setCaret] = useState(0);
  // Escape shuts the picker without clearing what was typed. Cleared again as
  // soon as the caret leaves the command, so the next `/` reopens it.
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);
  // Set by a pick, applied once React has painted the new value — a controlled
  // textarea otherwise puts the caret at the end, which is wrong whenever the
  // completed command has arguments after it.
  const pendingCaretRef = useRef<number | null>(null);

  const [recent, recordCommand] = useRecentCommands();

  const attachments = useAttachments(sessionId);
  // Set while the OS is dragging files over the window. Tauri intercepts the
  // native drop before the webview sees it, so there are no HTML drag events to
  // read here — `onDragDropEvent` is the only source, and it reports paths
  // rather than `File` handles, which is exactly what the backend wants anyway.
  const [dragging, setDragging] = useState(false);

  // The runs that take a colour. Empty of anything but plain text most of the
  // time, which is what the overlay below checks before mounting at all.
  const segments = useMemo(() => highlightSegments(message), [message]);
  const highlighted = segments.some((segment) => segment.kind !== "text");

  // Two modes, and the difference is deliberate. With nothing typed this is
  // browsing, so the list is grouped — what you just used, then what shipped
  // with the harness, then what was installed. Once there is a query it is
  // searching, and headers would hide matches behind section chrome, so the
  // ranked list is drawn flat.
  const query = slashQuery(message, caret);
  const groups = useMemo(() => {
    if (query === null) return [];
    if (query === "") return groupCommands(commands, recent);

    const matches = filterCommands(commands, query);
    return matches.length ? [{ label: null, items: matches }] : [];
  }, [commands, query, recent]);

  // The two pickers are mutually exclusive without needing to be arbitrated:
  // the caret sits in exactly one token, and a token opening with `/` at
  // position zero is not one opening with `@`. Kept as two independent reads so
  // neither has to know the other exists.
  const mention = mentionSpan(message, caret);
  const files = useFileSearch(cwd, mention?.query ?? null);

  // The third of the same shape, and mutually exclusive with the other two for
  // the same reason: the caret sits in exactly one token, and a token opening
  // with `#` is neither one opening with `@` nor a command at position zero.
  const issue = issueSpan(message, caret);
  const issues = useIssueSearch(issue?.query ?? null);

  // Flattened in render order, so arrowing through the list and drawing it
  // can't disagree about which row an index names.
  const commandMatches = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  // Only the count is shared between the two pickers — the lists themselves stay
  // separate all the way to the pick, so nothing has to be narrowed back out of
  // a union that `mention` already decided.
  const rowCount = mention ? files.length : issue ? issues.length : commandMatches.length;
  const menuOpen =
    !dismissed && rowCount > 0 && (query !== null || mention !== null || issue !== null);
  // Clamped rather than trusted: both lists arrive asynchronously, so a list
  // that shrinks under an already-moved selection would otherwise index past
  // its end — and an undefined row only shows up as a crash on the keystroke
  // that picks it.
  const active = Math.min(activeIndex, Math.max(rowCount - 1, 0));

  // Keyed on the query text rather than on the span, which is a fresh object
  // every keystroke and would reset the selection on a bare cursor move.
  const mentionQuery = mention?.query ?? null;
  const issueQuery = issue?.query ?? null;
  useEffect(() => {
    setActiveIndex(0);
    if (query === null && mentionQuery === null && issueQuery === null) setDismissed(false);
  }, [query, mentionQuery, issueQuery]);

  const pickCommand = (command: SlashCommand) => {
    const next = applyCommand(message, command.name);
    pendingCaretRef.current = next.caret;
    setMessage(next.text);
    textareaRef.current?.focus();
  };

  const pickFile = (file: FileMatch) => {
    if (!mention) return;

    const next = applyMention(message, mention, file.path);
    pendingCaretRef.current = next.caret;
    setMessage(next.text);
    textareaRef.current?.focus();
  };

  const pickIssue = (picked: Issue) => {
    if (!issue) return;

    const next = applyIssue(message, issue, picked.identifier, picked.title);
    pendingCaretRef.current = next.caret;
    setMessage(next.text);
    textareaRef.current?.focus();
  };

  /// The keyboard's way into whichever list is drawn. A click calls the same
  /// functions directly, so the two routes cannot diverge.
  const pickRow = (index: number) => {
    if (mention) {
      const file = files[index];
      if (file) pickFile(file);
      return;
    }

    if (issue) {
      const picked = issues[index];
      if (picked) pickIssue(picked);
      return;
    }

    const command = commandMatches[index];
    if (command) pickCommand(command);
  };

  useLayoutEffect(() => {
    const pending = pendingCaretRef.current;
    if (pending === null) return;
    pendingCaretRef.current = null;

    textareaRef.current?.setSelectionRange(pending, pending);
    setCaret(pending);
  }, [message]);

  // Grow to fit, then scroll. Height must be cleared before scrollHeight is read
  // or it reports the current height and the box can never shrink back down.
  useLayoutEffect(() => {
    const el = textareaRef.current;
    // Referenced rather than reached via `parentElement`, so the freeze below
    // keeps working as the composer's nesting changes.
    const card = cardRef.current;
    if (!el || !card) return;

    const style = getComputedStyle(el);
    const lineHeight = parseFloat(style.lineHeight) || 20;
    const chrome =
      parseFloat(style.paddingTop) +
      parseFloat(style.paddingBottom) +
      parseFloat(style.borderTopWidth) +
      parseFloat(style.borderBottomWidth);

    // Freeze the card while measuring: reading scrollHeight forces a layout with
    // the textarea at 0px, and if that phantom layout reaches the flex column the
    // chat pane momentarily grows and the browser clamps its scrollTop — the
    // transcript ratchets up a few pixels on every value change.
    card.style.height = `${card.offsetHeight}px`;
    el.style.height = "0px";
    // scrollHeight includes padding, so the row cap has to as well.
    const rows = isNewTask ? NEW_TASK_MAX_ROWS : MAX_ROWS;
    el.style.height = `${Math.min(el.scrollHeight, lineHeight * rows + chrome)}px`;
    card.style.height = "";
  }, [message, resizeTick, isNewTask]);

  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    el.focus();
    // The draft that just came back is text this composer has never had a caret
    // in, so the picker state left over from the session being switched away
    // from describes nothing here. Landing at the end is also where typing
    // resumes: a draft is an unfinished sentence.
    const end = el.value.length;
    el.setSelectionRange(end, end);
    setCaret(end);
    setDismissed(false);
  }, [sessionId]);

  // The sizing effect first measures against fallback font metrics, which can
  // clamp an empty box to the row cap; nothing re-measures until the next
  // keystroke, so the composer opens ten rows tall with a scrollbar. Waiting on
  // document.fonts.ready isn't enough — the promise can resolve a frame before
  // the new metrics reach layout, and that one shot is all it gets. Observing
  // the box re-measures whenever its size actually changes, font swap included.
  useEffect(() => {
    const el = textareaRef.current;
    if (!el) return;

    const observer = new ResizeObserver(() => setResizeTick((t) => t + 1));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  // ⌥ as well as ⌘, so the chord can't collide with the webview's own ⌘O.
  useHotkey("o", () => void pickAttachments(sessionId), { alt: true });

  // What Esc does, wherever focus is. Held in a ref so the listener below can
  // register once and still read current state. Returns whether it consumed the
  // key, which is what decides if the webview ever sees it.
  //
  // Appended rather than assigned: whatever is half-typed here is the user's
  // too, and replacing it would trade one loss for another. Focus follows the
  // text back, since taking a prompt back is the start of editing it.
  const escapeRef = useRef<() => boolean>(() => false);
  escapeRef.current = () => {
    // Shuts the picker without clearing what was typed.
    if (menuOpen) {
      setDismissed(true);
      return true;
    }

    // Takes back the newest prompt still waiting on the CLI.
    if (onCancelQueued && queuedCount > 0) {
      const before = message;
      void onCancelQueued().then((cancelled) => {
        if (!cancelled) return;
        setMessage(before ? `${before}\n${cancelled.text}` : cancelled.text);
        textareaRef.current?.focus();
      });
      return true;
    }

    return false;
  };

  // Bound on the document, not on the textarea: on the textarea it only fired
  // while the box held focus, and every other press fell through to the webview,
  // where macOS reads a bare Esc as "leave fullscreen" — so the window resized
  // instead of cancelling. Swallowed only when it did something, or fullscreen
  // would lose its own exit for nothing.
  //
  // Bubble phase and skipped once handled, because Radix's layers listen in
  // capture and preventDefault when they dismiss — so an open dialog, menu or
  // lightbox spends the key before this sees it.
  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      if (e.key !== "Escape" || e.defaultPrevented) return;
      if (e.metaKey || e.ctrlKey || e.altKey || e.shiftKey) return;
      if (escapeRef.current()) e.preventDefault();
    };

    document.addEventListener("keydown", onKeyDown);
    return () => document.removeEventListener("keydown", onKeyDown);
  }, []);

  // The drop target is the whole window, not the card: a file aimed at the
  // composer while the transcript fills the screen would otherwise have to be
  // dropped on a 60px strip. The card is where the affordance is drawn, because
  // that is where the file is about to land.
  useEffect(() => {
    if (archived) return;

    let unlisten: (() => void) | null = null;
    let live = true;

    // `getCurrentWebview()` **throws** outside Tauri rather than rejecting, and
    // synchronously — so in a plain browser this took the whole effect down and
    // React unmounted the tree, leaving a blank page. Same trap `focus.ts`
    // already carries a `try` for. Costs the drop target under `pnpm dev` and
    // on the demo page, which is the one thing a browser could never do anyway.
    let webview;
    try {
      webview = getCurrentWebview();
    } catch {
      return;
    }

    void webview
      .onDragDropEvent((event) => {
        // `enter` and `over` are one state here — the drag is over the window
        // and hasn't been dropped. Treating `enter` as anything else flashes
        // the overlay off for the frame between it and the first `over`.
        if (event.payload.type === "enter" || event.payload.type === "over") {
          setDragging(true);
        } else if (event.payload.type === "drop") {
          setDragging(false);
          void addAttachmentPaths(sessionId, event.payload.paths);
        } else {
          setDragging(false);
        }
      })
      .then((off) => {
        // The listener is registered asynchronously, so an unmount can land
        // first — drop it straight away rather than leaking a handler that
        // writes into a session this composer has already left.
        if (live) unlisten = off;
        else off();
      });

    return () => {
      live = false;
      unlisten?.();
    };
  }, [sessionId, archived]);

  // `busy` no longer gates this: a prompt typed into a running turn is queued
  // rather than refused, and the CLI folds it into that turn on its own.
  //
  // A notice does gate it. Backend refuses the same send anyway, so this is not
  // the guard — it is what stops the reader finding that out by writing a
  // prompt and pressing a button that was never going to work.
  const canSend = !notice && (message.trim().length > 0 || attachments.length > 0);

  const submit = () => {
    // Enter has its own path into here, so the disabled button is not the
    // guard — without this, the one route that never touches the button still
    // sends.
    if (notice) return;

    const trimmed = message.trim();
    // An attachment on its own is a real prompt — dropping a screenshot and
    // pressing Enter is asking about the screenshot.
    if (!trimmed && !attachments.length) return;

    // Recorded on send rather than on pick: choosing a command from the list
    // and then deleting it is not using it. Taken from the text, so a command
    // typed by hand counts the same as one picked.
    const command = parseSlashCommand(trimmed);
    if (command) recordCommand(command.name);

    onSend(
      trimmed,
      attachments.map((a) => a.path),
    );
    setMessage("");
    clearAttachments(sessionId);
  };

  // Returns before the form, so there is no disabled textarea to focus and no
  // submit path to reach at all — a disabled input still reads as "type here,
  // but not now", and this session isn't waiting on anything.
  //
  // After the hooks above, which must stay unconditional: settling the open
  // session swaps this in under a mounted composer.
  //
  // The live composer is a card plus a 34px toolbar row beneath it. Only the card
  // has a settled counterpart, so that row's height is held below as empty space:
  // `pb-4` + 34px. Without it the bar sits 34px lower than every other session's
  // composer and the transcript shifts down with it.
  if (archived) {
    return (
      <div className="px-4 pb-[3.125rem]">
        {/* `px-3 py-3` is the live card's own padding, so the button's right edge
            lands where the submit button's does. The label carries the textarea's
            extra `px-1` itself — inside the card those two sit on different
            edges, and matching only one of them is what reads as a shift. */}
        <div className="mx-auto flex max-w-3xl items-center justify-between gap-3 rounded-2xl border border-hairline bg-card px-3 py-3">
          <span className="px-1 text-composer text-muted-foreground">
            Unsettle this task to send a follow-up.
          </span>

          {/* Unsettle keeps the right edge it has always had. Cleanup is the
              rarer of the two and reads as an aside to it, so it takes the
              ghost variant and sits inboard — the same "chrome doesn't lift"
              rule the toolbar's buttons follow. */}
          <span className="flex shrink-0 items-center gap-1">
            {onRemoveWorktree && (
              <Button variant="ghost" size="sm" onClick={onRemoveWorktree}>
                Delete worktree
              </Button>
            )}

            <Button variant="secondary" size="sm" onClick={onUnarchive}>
              Unsettle
            </Button>
          </span>
        </div>
      </div>
    );
  }

  return (
    <div className="px-4 pb-4">
      <form
        className="mx-auto max-w-3xl"
        onSubmit={(e) => {
          e.preventDefault();
          submit();
        }}
      >
        {/* Decoration, so it is hidden from assistive tech. Sits on the form
            edge like the toolbar and the text below it. Height-sized so the
            mark scales with the layout rather than with a viewBox nobody
            reading this file should have to hold in their head. */}
        {isNewTask && (
          <div
            aria-hidden
            style={WORDMARK_MASK}
            className="mb-4 h-10 w-full max-w-30 bg-current text-foreground/10"
          />
        )}

        {notice}

        {/* Above the toolbar in both states, so the failure reads before the
            controls rather than after them. `whitespace-pre-wrap` because these
            are raw messages from git and the CLI, which carry their own line
            breaks — flattening them runs the offending filenames together.

            The button is positioned out of flow and the first line cleared for
            it with `text-indent`, rather than floating it or giving it a flex
            column. Both of those reserve space per-line: a float clears after
            line one, so a message with its own `\n` breaks lands on three
            different left edges. This way every line shares one edge and only
            the first is inset. */}
        {error && (
          <div className="relative mb-2 px-1 text-ui break-words whitespace-pre-wrap text-destructive">
            {onDismissError && (
              <button
                type="button"
                onClick={onDismissError}
                aria-label="Dismiss error"
                className="absolute top-px left-1 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
              >
                <X className="size-3.5" strokeWidth={2} />
              </button>
            )}
            {/* Matches the button's 14px glyph plus its padding and the gap.
                Applied inline: an arbitrary Tailwind value would work, but the
                number has to track the icon size above and reads clearer next
                to it. */}
            <span style={onDismissError ? { textIndent: "1.5rem" } : undefined} className="block">
              {error}
            </span>
          </div>
        )}

        {/* Pulled left by the toolbar's own `px-1` plus the ghost button's 6px
            icon inset, so the `+` glyph — not the button box — lands on the
            same edge as the text below it. */}
        {isNewTask && <div className="-ml-2.5 pb-1.5">{toolbar}</div>}

        {/* Directly above the card and with no gap: the row runs on past its own
            reserve and behind the card, which is the opaque thing that hides it.
            Anything between the two would show the buttons through the gap and
            leave them floating rather than tucked. */}
        {!isNewTask && handoff}

        {/* The picker anchors to this wrapper rather than to the card, and it has
            to: an element carrying `backdrop-filter` is a backdrop root for
            everything inside it, so the list's own blur — nested in the card —
            sampled the card's empty interior instead of the transcript behind
            it, and did nothing at all. That is the same trap one layer out from
            the one that sends every menu through a portal. The wrapper's box is
            the card's, so `top-full`/`bottom-full` land where they always did.

            The ring lives on the card so the whole composer reads as one control.
            --input bakes in its own alpha, which makes Tailwind's /40-style opacity
            modifiers silently no-op, so both states set an explicit color.

            `bg-composer`, not `bg-card`, and that is a vibrancy fix rather than
            a colour change: the two tokens carry the same value, and they part
            on glass. `--card` becomes a 5.5% white veil, right for a surface
            sitting *in* the page; this one floats at the window's edge over a
            transcript that scrolls under it, so it takes `--veil-float` and the
            blur that makes it readable — the same pair every menu and dialog
            takes. It was the one raised surface that could never be glass, back
            when it hid the handoff row by being opaque; [HandoffRow] clips
            itself now, which is what freed it. */}
        <div className="relative">
          {/* Two separate consequences of the empty state, passed separately
              because they are separate things that happen to coincide. The
              toolbar sits above the input there and the window is empty below
              it, so the list opens downward — upward it would cover the controls
              it sits next to. And the card behind it has no fill or border, so
              the list drops its own to match. */}
          {menuOpen &&
            (mention ? (
              <FileMentionMenu
                files={files}
                activeIndex={active}
                onPick={pickFile}
                onHover={setActiveIndex}
                placement={isNewTask ? "below" : "above"}
                bare={isNewTask}
              />
            ) : issue ? (
              <IssueMentionMenu
                issues={issues}
                activeIndex={active}
                onPick={pickIssue}
                onHover={setActiveIndex}
                placement={isNewTask ? "below" : "above"}
                bare={isNewTask}
              />
            ) : (
              <SlashCommandMenu
                groups={groups}
                activeIndex={active}
                onPick={pickCommand}
                onHover={setActiveIndex}
                placement={isNewTask ? "below" : "above"}
                bare={isNewTask}
              />
            ))}

          <div
            ref={cardRef}
            className={cn(
              "relative rounded-2xl transition-colors",
              // `--edge-surface` and `--shadow-surface` are one pair, and exactly
              // one of them is drawn per mode. Light gets the shadow and a
              // transparent edge — under a shadow tuned this crisp, a border is a
              // second line saying the same thing. Dark gets the edge and no
              // shadow: a shadow under a dark card falls on something already
              // darker than itself, and the card is glass there, so being lighter
              // than the page does not draw the box on its own.
              !isNewTask &&
                "border border-edge-surface bg-composer shadow-(--shadow-surface) backdrop-blur-xl",
            )}
          >
            {/* Covers the card rather than replacing anything, so the text and
                the tray stay legible underneath and the box doesn't resize the
                moment a file crosses the window. Inert to pointer events — the
                drop is the OS's, and Tauri delivers it whatever is on top. */}
            {dragging && (
              <div className="pointer-events-none absolute inset-0 z-10 flex items-center justify-center gap-2 rounded-2xl border-2 border-muted-foreground/25 bg-background/70 text-ui text-muted-foreground">
                <Paperclip className="size-3.5" strokeWidth={2} />
                Drop to attach
              </div>
            )}

            {/* Inside the card and above the text, so an attachment reads as part
                of the message being composed rather than as a separate control.
                Padded on the same edges as the textarea below it. */}
            {attachments.length > 0 && (
              <div className={cn("pt-3", isNewTask ? "px-0" : "px-3")}>
                <AttachmentTray
                  attachments={attachments}
                  onRemove={(path) => removeAttachment(sessionId, path)}
                />
              </div>
            )}

            {/* Both buttons sit on the last line. At one line that reads as
                centered anyway, because the textarea's vertical padding below is
                tuned to match the buttons' own height — no `self-center` needed,
                and nothing drifts as the box grows. */}
            <div className={cn("flex items-end gap-1 py-3", isNewTask ? "px-0" : "px-3")}>
              <div className="relative min-w-0 flex-1">
                <textarea
                  ref={textareaRef}
                  rows={1}
                  autoFocus
                  value={message}
                  // Kept in step with the overlay below, which cannot scroll itself.
                  onScroll={(e) => {
                    const mirror = mirrorRef.current;
                    if (mirror) mirror.scrollTop = e.currentTarget.scrollTop;
                  }}
                  // Names `#` only where it would do something. An unconnected
                  // reader offered a tag they cannot use learns the app is
                  // missing a feature rather than that they haven't set one up.
                  placeholder={
                    isNewTask
                      ? issuesConnected
                        ? "Describe a task. #issues. @files. /skills and commands."
                        : "Describe a task. @files. /skills and commands."
                      : "Send follow-up"
                  }
                  onChange={(e) => {
                    setMessage(e.currentTarget.value);
                    setCaret(e.currentTarget.selectionStart);
                  }}
                  // Fires for arrow keys, clicks, and drags alike, so the picker
                  // follows the caret however it moved rather than only on typing.
                  onSelect={(e) => setCaret(e.currentTarget.selectionStart)}
                  onKeyDown={(e) => {
                    // Whichever picker is open owns these keys, and only while it
                    // is — Enter completes the highlighted row instead of sending,
                    // which is the one place the composer's usual rule gives way.
                    if (menuOpen && !e.nativeEvent.isComposing) {
                      if (e.key === "ArrowDown") {
                        e.preventDefault();
                        setActiveIndex((active + 1) % rowCount);
                        return;
                      }
                      if (e.key === "ArrowUp") {
                        e.preventDefault();
                        setActiveIndex((active - 1 + rowCount) % rowCount);
                        return;
                      }
                      if (e.key === "Enter" || e.key === "Tab") {
                        e.preventDefault();
                        pickRow(active);
                        return;
                      }
                    }

                    // Esc is not read here — it is the document listener's, so it
                    // works with the composer unfocused too.

                    // Shift+Enter is the only way to get a newline; plain Enter sends.
                    if (e.key === "Enter" && !e.shiftKey && !e.nativeEvent.isComposing) {
                      e.preventDefault();
                      submit();
                    }
                  }}
                  // `py-1` puts one line at 28px — the buttons' own height — so the
                  // first row looks centered against them without being. `min-w-0`
                  // moved to the wrapper, where it still stops one long unbroken
                  // token setting the flex item's floor and pushing the buttons off
                  // the row.
                  className={cn(
                    "block w-full resize-none overflow-y-auto bg-transparent placeholder:text-muted-foreground focus:outline-none",
                    TEXT_BOX,
                    isNewTask ? "px-0" : "px-1",
                    // Hands the glyphs to the overlay only while there is something
                    // to colour. Every other moment the textarea draws its own text
                    // as before, so the usual case keeps no dependency on the
                    // overlay rendering correctly.
                    highlighted ? "text-transparent caret-foreground" : "text-foreground",
                  )}
                />

                {/* Draws the text the textarea is hiding, so a command or a file
                    mention can take a colour — a textarea has no way to style part
                    of its value. Painted *over* the textarea rather than under it,
                    so a selection band sits behind these glyphs instead of covering
                    them; the caret still shows, since it falls between them.

                    Mounted only alongside `text-transparent` above, and built from
                    the same segments the transcript renders, so neither the two
                    copies of the text nor the two surfaces can disagree about what
                    is coloured. `TEXT_BOX` and the padding are shared with the
                    textarea for the same reason — any drift shows up as doubled
                    text. */}
                {highlighted && (
                  <div
                    ref={mirrorRef}
                    aria-hidden
                    className={cn(
                      "pointer-events-none absolute inset-0 overflow-hidden whitespace-pre-wrap break-words text-foreground",
                      TEXT_BOX,
                      isNewTask ? "px-0" : "px-1",
                    )}
                  >
                    {segments.map((segment, i) => {
                      // Every glyph the textarea lays out has to be laid out here
                      // too, so a mention is dimmed rather than shortened — the
                      // transcript is where it collapses to the filename.
                      if (segment.kind === "mention") {
                        const { dir, name } = splitMention(segment.text);

                        return (
                          <span key={i} className={SEGMENT_COLOR.mention}>
                            <span className="opacity-45">{dir}</span>
                            {name}
                          </span>
                        );
                      }

                      return (
                        <span key={i} className={SEGMENT_COLOR[segment.kind]}>
                          {segment.text}
                        </span>
                      );
                    })}
                  </div>
                )}
              </div>

              {/* One button, two jobs, and what is typed decides which. Stopping
                  is what an empty composer during a turn is for; with text in it
                  the prompt is queued onto the running turn instead, so Send has
                  to stay reachable — refusing it is the behaviour this replaced.
                  `type="button"` on Stop so pressing it can't also submit.

                  Enter-to-send lives in `onKeyDown`, not in this button being the
                  form's submitter, so the empty state can drop it for the hint
                  below without losing the keyboard path. Neither `busy` nor a
                  queue is reachable there — nothing runs before a session
                  exists. */}
              {!isNewTask &&
                (() => {
                  const stopping = busy && !canSend;

                  return (
                    <Button
                      type={stopping ? "button" : "submit"}
                      size="icon-sm"
                      disabled={stopping ? !onStop : !canSend}
                      onClick={stopping ? onStop : undefined}
                      title={stopping ? "Stop" : busy ? "Send — queued onto this turn" : "Send"}
                      className="rounded-full"
                    >
                      {stopping ? (
                        <Square className="fill-current" />
                      ) : (
                        <ArrowUp strokeWidth={2} />
                      )}
                    </Button>
                  );
                })()}
            </div>
          </div>
        </div>

        {isNewTask ? (
          // Gone while a picker is open, and the list sitting over this row is
          // the smaller half of why: Enter completes the highlighted row there
          // rather than sending, and the picker draws its own ↵ hint saying so.
          // Two Enter legends at once, one of them untrue.
          !menuOpen && (
            <div className="flex items-center gap-1 pt-2 text-ui text-muted-foreground/60">
              Press <CornerDownLeft className="size-3" strokeWidth={2} /> to send
            </div>
          )
        ) : (
          <div className="pt-1.5">{toolbar}</div>
        )}
      </form>
    </div>
  );
}
