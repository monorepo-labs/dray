import {
  useEffect,
  useMemo,
  useRef,
  useState,
  useSyncExternalStore,
  type ReactNode,
} from "react";
import { getCurrentWebview } from "@tauri-apps/api/webview";
import { ArrowUp, CornerDownLeft, Paperclip, Square, X } from "lucide-react";

import AttachmentTray from "@/components/composer/AttachmentTray";
import FileMentionMenu from "@/components/composer/FileMentionMenu";
import IssueMentionMenu from "@/components/composer/IssueMentionMenu";
import RichInput from "@/components/composer/RichInput";
import SessionMentionMenu from "@/components/composer/SessionMentionMenu";
import SlashCommandMenu from "@/components/composer/SlashCommandMenu";
import { Button } from "@/components/ui/button";
import {
  addAttachmentPaths,
  clearAttachments,
  pasteAttachments,
  pickAttachments,
  removeAttachment,
  useAttachments,
} from "@/hooks/useAttachments";
import { useDraft } from "@/hooks/useDraft";
import { useFileSearch } from "@/hooks/useFileSearch";
import { useHotkey } from "@/hooks/useHotkey";
import { useIssueSearch } from "@/hooks/useIssueSearch";
import { useRecentCommands } from "@/hooks/useRecentCommands";
import { applyIssue, issueSpan, rememberIssueTitle } from "@/lib/issue";
import {
  canSwitchTracker,
  effectiveTracker,
  readIssueTracker,
  subscribeIssueTracker,
  type Connected,
} from "@/lib/issueTracker";
import { registerComposer } from "@/lib/composerFocus";
import { continueList } from "@/lib/list";
import { selectionRange } from "@/lib/richDom";
import { applyMention, mentionSpan } from "@/lib/mention";
import { applySession, filterSessions, sessionSpan } from "@/lib/sessionTag";
import {
  applyCommand,
  filterCommands,
  groupCommands,
  parseSlashCommand,
  slashQuery,
} from "@/lib/slash";
import { cn } from "@/lib/utils";
import type {
  Attachment,
  FileMatch,
  Issue,
  QueuedMessage,
  SessionIndexItem,
  SlashCommand,
} from "@/types/events";

type ChatInputProps = {
  /// `attachments` is what the tray held. Only paths cross the bridge — the
  /// backend re-reads each one, so a pinned screenshot is never uploaded twice —
  /// but a prompt that ends up *queued* is drawn from these, rather than having
  /// its paths described a second time.
  onSend: (message: string, attachments: Attachment[]) => void;
  /// What the `/` picker offers. Empty until the backend's probe lands, and
  /// empty forever where the harness publishes none — fx, and Codex with no
  /// skills installed. A command typed by hand still works either way, since
  /// the CLI parses the text rather than the picker.
  commands?: SlashCommand[];
  /// Whether that probe is still out. The picker draws "this agent publishes no
  /// slash commands" on an empty list, which is only true once it has answered.
  commandsLoading?: boolean;
  /// Where the `@` picker searches for files. The session's own directory, so a
  /// worktree session mentions paths inside its tree — the CLI resolves `@path`
  /// against the directory it was spawned in, and those are the same one.
  cwd?: string | null;
  /// An issue tracker is connected, so `#` opens a picker. Drawn in the
  /// placeholder and nowhere else — the picker itself simply finds nothing
  /// without one.
  issuesConnected?: boolean;
  /// *Which* trackers are connected, which is a different question: it decides
  /// whether the picker's header offers a switch, and which tracker the pick
  /// resolves to where the stored one has nothing behind it. Only `App`'s own
  /// read can answer it.
  issueTrackers?: Connected;
  /// What the `&` picker offers: the sessions the sidebar is currently drawing,
  /// already narrowed by space and project filter there so that one array
  /// answers for the list, the chords and this.
  sessions?: SessionIndexItem[];
  /// Interrupts the running turn. Reachable while `busy` and the box is empty —
  /// with something typed the same button sends, since a prompt written during a
  /// turn is queued onto it rather than refused.
  onStop?: () => void;
  /// Takes back the newest prompt still waiting on the CLI, resolving to it so
  /// its text can go back in the box. `null` when the flush got there first.
  onCancelQueued?: () => Promise<QueuedMessage | null>;
  /// Throws away a recording in flight, answering whether there was one.
  ///
  /// A prop rather than a hook here because the recorder lives in `App`, beside
  /// the settings page a first press has to open. Escape is bound in this
  /// component because that is where the one document-level handler lives.
  onCancelRecording?: () => boolean;
  /// How many prompts are waiting. Only decides whether Esc is bound — the rows
  /// themselves are drawn by the transcript, above this component.
  queuedCount?: number;
  /// Rendered outside the card — below it normally, above it on a new task. A
  /// node rather than the controls' own props, so this component keeps owning
  /// layout and measurement and nothing else.
  toolbar?: ReactNode;
  /// The dictate button and, while recording, the level and its two buttons.
  ///
  /// A node like `toolbar`, and for the same reason: the recorder lives in
  /// `App`, beside the settings page a first press has to open. It sits
  /// immediately left of Send, since both act on the message being written.
  dictation?: ReactNode;
  /// A recording or a transcription is under way, which **hides Send**.
  ///
  /// Dictation takes the row over while it runs: recording already offers a
  /// stop and a discard, and a third button that sends whatever is in the box
  /// is one the reader has to think about. Sent as a flag rather than read off
  /// `dictation`, which is an opaque node this component cannot inspect.
  dictating?: boolean;
  /// Drawn above the toolbar, and blocks sending while present.
  ///
  /// Separate from `error`: that reports something that was attempted and
  /// failed, this reports that nothing can be attempted yet. Only the second
  /// kind has a cure to offer, which is why it is a node and not a string.
  notice?: ReactNode;
  /// Drawn under the new-task composer, below the send hint. Informational
  /// only, unlike `notice`: it never blocks sending.
  agentUpdate?: ReactNode;
  /// Why sending is held, or `null`. Blocks like `notice` but is no failure:
  /// the agent's CLI is updating, and a session should start on the new one.
  held?: string | null;
  /// Whether the picked model can be handed an image at all.
  ///
  /// `true` where nothing says otherwise, which covers the model list not
  /// having landed and pi picking a model for itself — Dray has no answer in
  /// either case, and a warning drawn on a guess is worse than none.
  modelTakesImages?: boolean;
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
  /// The title of the session this box sends into, named in the placeholder.
  /// Only while a split view is up: one composer under several transcripts is
  /// one box that can send into the wrong session, so the box says where
  /// before anything is typed — and in the placeholder rather than a row of
  /// its own, which grew the card. Single view leaves it unset; the header
  /// above already names the session.
  target?: string | null;
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

/// What the `/` picker says instead of nothing. Names no agent: it is drawn for
/// fx, which publishes none at all, and for a Codex session with no skills
/// installed, and the reader's question — is this list empty or is the app
/// broken — has the same answer both times.
const NO_COMMANDS_NOTE = "This agent publishes no slash commands";

/// What the `&` picker says instead of nothing. Says *other* out loud, since
/// the reader is sitting in one: "no tasks" would read as the sidebar being
/// empty, which it plainly is not.
const NO_SESSIONS_NOTE = "No other tasks in this project";

export default function ChatInput({
  onSend,
  commands = [],
  commandsLoading = false,
  cwd = null,
  issuesConnected = false,
  issueTrackers = { linear: false, github: false },
  sessions = [],
  onStop,
  onCancelQueued,
  onCancelRecording,
  queuedCount = 0,
  toolbar,
  dictation,
  dictating = false,
  notice,
  agentUpdate,
  held = null,
  modelTakesImages = true,
  handoff,
  busy = false,
  sessionId = null,
  isNewTask = false,
  target = null,
  error = null,
  onDismissError,
  archived = false,
  onUnarchive,
  onRemoveWorktree,
}: ChatInputProps) {
  const [message, setMessage] = useDraft(sessionId);
  const editorRef = useRef<HTMLDivElement | null>(null);
  // Read by the session-switch effect below, which must stay keyed on the
  // session alone: the draft it wants is the one that arrived *with* that
  // switch, and depending on `message` would rerun it on every keystroke and
  // drag the caret back to the end mid-sentence.
  const messageRef = useRef(message);
  messageRef.current = message;

  // Where the caret is, tracked so the picker can tell a command being typed
  // from a slash that has already been left behind.
  const [caret, setCaret] = useState(0);
  // Escape shuts the picker without clearing what was typed. Cleared again as
  // soon as the caret leaves the command, so the next `/` reopens it.
  const [dismissed, setDismissed] = useState(false);
  const [activeIndex, setActiveIndex] = useState(0);

  const [recent, recordCommand] = useRecentCommands();

  const attachments = useAttachments(sessionId);
  // Set while the OS is dragging files over the window. Tauri intercepts the
  // native drop before the webview sees it, so there are no HTML drag events to
  // read here — `onDragDropEvent` is the only source, and it reports paths
  // rather than `File` handles, which is exactly what the backend wants anyway.
  const [dragging, setDragging] = useState(false);

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
  // The pick is read here rather than passed down: it is a module store every
  // issue surface subscribes to, so the chips in this menu's own header move
  // the page's too without a prop between them. What *is* passed down is which
  // trackers are connected, which only `App`'s own read can answer.
  const trackerPick = useSyncExternalStore(subscribeIssueTracker, readIssueTracker);
  const tracker = effectiveTracker(trackerPick, issueTrackers);
  const {
    issues,
    loading: issuesLoading,
    emptyNote: issuesNote,
  } = useIssueSearch(issue?.query ?? null, tracker, cwd);

  // The fourth, and exclusive with the other three for the same reason again:
  // the caret sits in one token, and a token opening with `&` is none of them.
  // Reads memory the app already holds, so unlike the `#` picker there is no
  // waiting state to draw.
  // Not memoized, unlike the command list beside it: this is one pass over the
  // sidebar's own array, where that one groups and ranks.
  const session = sessionSpan(message, caret);
  const sessionMatches = session ? filterSessions(sessions, sessionId, session.query) : [];
  // Whether `&` is worth naming in the placeholder. The same question the
  // picker answers, asked of the unfiltered list — one session in a project is
  // every project's first state, and a tag pointing at nothing but itself is a
  // feature the reader would go looking for and not find.
  const canMentionSession = filterSessions(sessions, sessionId, "").length > 0;
  // A project with nothing else in it, as against a query matching none of what
  // is there. The `/` picker's distinction exactly: a query that finds nothing
  // closes quietly, because the reader can see the list it failed against,
  // where a list that is empty *for good* has to say so or the key reads as
  // Dray being broken. The placeholder already withholds `&` here, so this is
  // for somebody who reached for it anyway.
  const noSessions = session !== null && !canMentionSession;

  // Flattened in render order, so arrowing through the list and drawing it
  // can't disagree about which row an index names.
  const commandMatches = useMemo(() => groups.flatMap((group) => group.items), [groups]);

  // Only the count is shared between the two pickers — the lists themselves stay
  // separate all the way to the pick, so nothing has to be narrowed back out of
  // a union that `mention` already decided.
  const rowCount = mention
    ? files.length
    : issue
      ? issues.length
      : session
        ? sessionMatches.length
        : commandMatches.length;
  // A harness that publishes none at all, as against a query matching none of
  // the ones it does — `/xyzzy` in a Claude session still shuts the picker
  // quietly, since there the reader can see what the list holds. Silence is
  // only wrong where the list is empty for good: three of the four harnesses
  // fill it, so a `/` that does nothing reads as Dray being broken rather than
  // as fx having no commands. Waits on the probe, and on there being a
  // directory to probe in — with no project attached the honest answer is
  // "nobody has been asked" rather than "there are none".
  const noCommands = query !== null && cwd !== null && !commandsLoading && commands.length === 0;
  // The `#` picker's own version of that, and it has to be counted here for the
  // same reason: a tracker with nothing to list answers no rows, no loading and
  // a sentence — so a menu opened on rows alone never opened at all, taking its
  // tracker-switch header with it. Which is the one control that gets the
  // reader to the tracker that *does* have issues.
  const noIssues = issue !== null && issuesNote !== undefined;
  // Rows, or one of the two cases a picker is worth drawing empty: the `#`
  // picker waiting on Linear, where placeholder rows say the list is coming
  // rather than absent, and the `/` picker on a harness with none, where one
  // sentence says the list is never coming. The `@` picker reads an index and
  // has neither state.
  const menuOpen =
    !dismissed &&
    (rowCount > 0 || issuesLoading || noCommands || noSessions || noIssues) &&
    (query !== null || mention !== null || issue !== null || session !== null);
  // Clamped rather than trusted: both lists arrive asynchronously, so a list
  // that shrinks under an already-moved selection would otherwise index past
  // its end — and an undefined row only shows up as a crash on the keystroke
  // that picks it.
  const active = Math.min(activeIndex, Math.max(rowCount - 1, 0));

  // Keyed on the query text rather than on the span, which is a fresh object
  // every keystroke and would reset the selection on a bare cursor move.
  const mentionQuery = mention?.query ?? null;
  const issueQuery = issue?.query ?? null;
  const sessionQuery = session?.query ?? null;
  useEffect(() => {
    setActiveIndex(0);
    if (query === null && mentionQuery === null && issueQuery === null && sessionQuery === null) {
      setDismissed(false);
    }
  }, [query, mentionQuery, issueQuery, sessionQuery]);

  const pickCommand = (command: SlashCommand) => {
    const next = applyCommand(message, command.name);
    setMessage(next.text);
    setCaret(next.caret);
    editorRef.current?.focus();
  };

  const pickFile = (file: FileMatch) => {
    if (!mention) return;

    const next = applyMention(message, mention, file.path);
    setMessage(next.text);
    setCaret(next.caret);
    editorRef.current?.focus();
  };

  const pickIssue = (picked: Issue) => {
    if (!issue) return;

    // Nothing closes a title in the text, so the chip cannot find its end on its
    // own — this is the one place that knows where the title stops, because it
    // is the place that wrote it.
    rememberIssueTitle(picked.identifier, picked.title);

    const next = applyIssue(message, issue, picked.identifier, picked.title);
    setMessage(next.text);
    setCaret(next.caret);
    editorRef.current?.focus();
  };

  const pickSession = (picked: SessionIndexItem) => {
    if (!session) return;

    const next = applySession(message, session, picked.title, picked.sessionId);
    setMessage(next.text);
    setCaret(next.caret);
    editorRef.current?.focus();
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

    if (session) {
      const picked = sessionMatches[index];
      if (picked) pickSession(picked);
      return;
    }

    const command = commandMatches[index];
    if (command) pickCommand(command);
  };

  useEffect(() => {
    editorRef.current?.focus();
    // The draft that just came back is text this composer has never had a caret
    // in, so the picker state left over from the session being switched away
    // from describes nothing here. Landing at the end is also where typing
    // resumes: a draft is an unfinished sentence.
    setCaret(messageRef.current.length);
    setDismissed(false);
  }, [sessionId]);

  // ⌥ as well as ⌘, so the chord can't collide with the webview's own ⌘O.
  useHotkey("attach", () => void pickAttachments(sessionId));

  // What Esc does, wherever focus is. Held in a ref so the listener below can
  // register once and still read current state. Returns whether it consumed the
  // key, which is what decides if the webview ever sees it.
  //
  // Appended rather than assigned: whatever is half-typed here is the user's
  // too, and replacing it would trade one loss for another. Focus follows the
  // text back, since taking a prompt back is the start of editing it.
  const escapeRef = useRef<() => boolean>(() => false);
  escapeRef.current = () => {
    // First, because it is the only state here holding a device open. Losing
    // the words is the point — a recording escaped is one the reader has
    // decided against.
    if (onCancelRecording?.()) return true;

    // Shuts the picker without clearing what was typed.
    if (menuOpen) {
      setDismissed(true);
      return true;
    }

    // Takes back the newest prompt still waiting on the CLI.
    if (onCancelQueued && queuedCount > 0) {
      const before = message;
      // The attachments come back with it, pinned by `onCancelQueued` itself —
      // synchronously, so an Enter straight after this cannot send the sentence
      // without them.
      void onCancelQueued().then((cancelled) => {
        if (!cancelled) return;
        const restored = before ? `${before}\n${cancelled.text}` : cancelled.text;
        setMessage(restored);
        // Taking a prompt back is the start of editing it, so the caret lands
        // where the writing resumes rather than where it sat before the send.
        setCaret(restored.length);
        editorRef.current?.focus();
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
  const canSend = !notice && !held && (message.trim().length > 0 || attachments.length > 0);

  /// Dictation and Send, drawn in exactly one of two places.
  ///
  /// Built once and placed by `singleLine` rather than written out twice: two
  /// copies of a submit button is two things to keep in step, and the one that
  /// is wrong is the one nobody is looking at.
  const controls = (
    <div className="flex shrink-0 items-center gap-1">
      {dictation}

      {/* One button, two jobs, and what is typed decides which. Stopping is what
          an empty composer during a turn is for; with text in it the prompt is
          queued onto the running turn instead, so Send has to stay reachable —
          refusing it is the behaviour this replaced. `type="button"` on Stop so
          pressing it can't also submit.

          Enter-to-send lives in `onKeyDown`, not in this button being the form's
          submitter, so the empty state can drop it for the hint below without
          losing the keyboard path. Neither `busy` nor a queue is reachable
          there — nothing runs before a session exists. */}
      {!isNewTask &&
        !dictating &&
        (() => {
          const stopping = busy && !canSend;

          return (
            <Button
              type={stopping ? "button" : "submit"}
              size="icon-sm"
              disabled={stopping ? !onStop : !canSend}
              onClick={stopping ? onStop : undefined}
              title={stopping ? "Stop" : held ? held : busy ? "Send — queued onto this turn" : "Send"}
              // The one filled button that keeps `--primary`. Everywhere but
              // Default light the two tokens are the same value, so this says
              // nothing there; on that palette it is what makes Send the
              // branded control and leaves every other filled button dark.
              className="rounded-full bg-primary text-primary-foreground hover:bg-primary/90 disabled:bg-muted disabled:text-muted-foreground disabled:shadow-none disabled:opacity-100"
            >
              {/* Both icons are mounted and stacked in one grid cell, so the
                  swap is a transition rather than a remount — React would
                  otherwise tear one out and put the other in with nothing to
                  animate between them.

                  Both directions run the same length. Shortening the return to
                  Send was tried and read as a flinch — the two icons are one
                  control changing its mind, and a swap that goes out slower
                  than it comes back stops looking like one movement. */}
              <span className="grid size-4 place-items-center">
                <ArrowUp
                  strokeWidth={2}
                  className={cn(
                    "col-start-1 row-start-1 transition-all duration-200 ease-out motion-reduce:transition-none",
                    stopping
                      ? "scale-50 rotate-90 opacity-0"
                      : "scale-100 rotate-0 opacity-100",
                  )}
                />
                <Square
                  className={cn(
                    "col-start-1 row-start-1 fill-current transition-all duration-200 ease-out motion-reduce:transition-none",
                    stopping
                      ? "scale-100 rotate-0 opacity-100"
                      : "scale-50 -rotate-90 opacity-0",
                  )}
                />
              </span>
            </Button>
          );
        })()}
    </div>
  );

  const submit = () => {
    // Enter has its own path into here, so the disabled button is not the
    // guard — without this, the one route that never touches the button still
    // sends.
    if (notice || held) return;

    const trimmed = message.trim();
    // An attachment on its own is a real prompt — dropping a screenshot and
    // pressing Enter is asking about the screenshot.
    if (!trimmed && !attachments.length) return;

    // Recorded on send rather than on pick: choosing a command from the list
    // and then deleting it is not using it. Taken from the text, so a command
    // typed by hand counts the same as one picked.
    const command = parseSlashCommand(trimmed);
    if (command) recordCommand(command.name);

    onSend(trimmed, attachments);
    setMessage("");
    // The box is empty, so the caret has nowhere else to be — and left where it
    // was it would name a position past the end of whatever is typed next.
    setCaret(0);
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
          <span className="px-1 text-prompt text-muted-foreground">
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

            Dismiss sits at the right, out of the text's way entirely. It was on
            the left, which put it between the reader and the first word of
            every message and needed a `text-indent` on the first line to make
            room. A flex row with the button after the text costs neither. */}
        {error && (
          <div className="mb-2 flex items-start gap-2 px-1 text-ui text-destructive">
            <span className="min-w-0 flex-1 break-words whitespace-pre-wrap">{error}</span>
            {onDismissError && (
              <button
                type="button"
                onClick={onDismissError}
                aria-label="Dismiss error"
                className="mt-px shrink-0 rounded p-0.5 opacity-70 transition-opacity hover:opacity-100"
              >
                <X className="size-3.5" strokeWidth={2} />
              </button>
            )}
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
                bare={isNewTask}
              />
            ) : issue ? (
              <IssueMentionMenu
                issues={issues}
                activeIndex={active}
                onPick={pickIssue}
                onHover={setActiveIndex}
                bare={isNewTask}
                loading={issuesLoading}
                emptyNote={issuesNote}
                tracker={tracker}
                canSwitch={canSwitchTracker(issueTrackers)}
              />
            ) : session ? (
              <SessionMentionMenu
                sessions={sessionMatches}
                emptyNote={noSessions ? NO_SESSIONS_NOTE : undefined}
                activeIndex={active}
                onPick={pickSession}
                onHover={setActiveIndex}
                bare={isNewTask}
              />
            ) : (
              <SlashCommandMenu
                groups={groups}
                activeIndex={active}
                onPick={pickCommand}
                onHover={setActiveIndex}
                bare={isNewTask}
                emptyNote={noCommands ? NO_COMMANDS_NOTE : undefined}
              />
            ))}

          <div
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
                  modelTakesImages={modelTakesImages}
                />
              </div>
            )}

            {/* Controls ride the text's own row, always. Measuring the box and
                dropping them to a second row once the text wrapped was tried
                and reverted: the measurement lands a frame after the keystroke,
                so the row appeared and vanished as the text crossed a line
                boundary, and every wrap flickered. `items-end` is what makes
                one row read correctly at both heights — at one line the buttons
                sit beside the text, and past it they stay at the bottom. */}
            <div className={cn("flex items-end gap-1 py-3", isNewTask ? "px-0" : "px-3")}>
              <div className="relative min-w-0 flex-1">
                <RichInput
                  // **One editor per session, because the undo stack lives in
                  // the editor.** Kept across a session switch, ⌘Z in the
                  // session moved to would restore the text of the one left, and
                  // the input event would write it into *this* session's draft.
                  // A remount is what ends a stack; the cost is focus, which a
                  // switch was not keeping anyway.
                  key={sessionId ?? "new"}
                  // Registered as well as held, so dictation can hand focus
                  // back from `App`, which has no route to this element.
                  innerRef={(el) => {
                    editorRef.current = el;
                    registerComposer(el);
                  }}
                  value={message}
                  caret={caret}
                  onChange={(next, at) => {
                    setMessage(next);
                    setCaret(at);
                  }}
                  onCaretChange={setCaret}
                  onPasteFiles={() => pasteAttachments(sessionId)}
                  maxRows={isNewTask ? NEW_TASK_MAX_ROWS : MAX_ROWS}
                  // The two that are always there lead, and the two that come
                  // and go trail — so the line grows and shrinks at its end
                  // rather than reshuffling. `&` and `#` are named only where
                  // they would do something: a reader offered a tag they cannot
                  // use learns the app is missing a feature rather than that
                  // they haven't set one up.
                  //
                  // `&tasks`, not `&sessions`. Task is the word this app says
                  // out loud — the sidebar's own button is New task — where
                  // session is what the index, the CLI and this file call the
                  // same thing.
                  placeholder={
                    isNewTask
                      ? [
                          "Describe a task.",
                          "@files.",
                          "/skills.",
                          canMentionSession && "&tasks.",
                          issuesConnected && "#issues.",
                        ]
                          .filter(Boolean)
                          .join(" ")
                      : target
                        ? target
                        : "Send follow-up"
                  }
                  onKeyDown={(e) => {
                    // Enter is the composer's on its own and with Shift, and
                    // nobody else's: a modified one belongs to whatever document
                    // binding claims it — `queue.send` is CmdEnter by default and
                    // the reader may rebind it onto any modifier. Those listeners
                    // run *after* this one, so anything done here happens as well
                    // as the chord: picking a row, sending the draft, or growing a
                    // list marker behind a flush.
                    const plainEnter = !e.metaKey && !e.ctrlKey && !e.altKey;

                    // Whichever picker is open owns these keys, and only while it
                    // is — Enter completes the highlighted row instead of sending,
                    // which is the one place the composer's usual rule gives way.
                    //
                    // Gated on there being *rows*, not on the menu being drawn:
                    // a picker showing placeholders has nothing to highlight, so
                    // `% rowCount` is a division by zero and Enter would be
                    // swallowed by a pick that can only land on nothing.
                    if (menuOpen && rowCount > 0 && !e.nativeEvent.isComposing) {
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
                      if ((e.key === "Enter" && plainEnter) || e.key === "Tab") {
                        e.preventDefault();
                        pickRow(active);
                        return;
                      }
                    }

                    // Esc is not read here — it is the document listener's, so it
                    // works with the composer unfocused too.

                    // Shift+Enter is the only way to get a newline; plain Enter sends.
                    if (e.key === "Enter" && plainEnter && !e.nativeEvent.isComposing) {
                      if (!e.shiftKey) {
                        e.preventDefault();
                        submit();
                        return;
                      }

                      // Always handled, never left to the browser, and put in
                      // as a *string* rather than as an edit. A contenteditable's
                      // own Enter inserts a block or a break of its choosing, and
                      // `execCommand` is no better: `insertLineBreak` under
                      // `pre-wrap` adds a second newline so the opened line has
                      // something to draw, which is a character nobody typed and
                      // leaves the caret a line above the text. One character, at
                      // one index, and `RichInput` draws what that says.
                      e.preventDefault();

                      // A newline inside a list carries the marker with it. Only
                      // with the selection collapsed: over a range the newline
                      // replaces the selection, which this cannot.
                      const next = window.getSelection()?.isCollapsed
                        ? continueList(message, caret)
                        : null;

                      if (next) {
                        setMessage(next.text);
                        setCaret(next.caret);
                        return;
                      }

                      // **Both ends, since a newline typed over a selection
                      // replaces it.** `caret` is the selection's start alone, so
                      // slicing on it would leave the selected text sitting after
                      // the break the reader meant to put in its place — and
                      // send it. The editor is the only thing that can answer
                      // where the selection ends.
                      const box = editorRef.current;
                      const at = (box && selectionRange(box)) ?? { start: caret, end: caret };

                      setMessage(`${message.slice(0, at.start)}\n${message.slice(at.end)}`);
                      setCaret(at.start + 1);
                    }
                  }}
                  className={cn("py-1 text-prompt", isNewTask ? "px-0" : "px-1")}
                />
              </div>

              {controls}
            </div>
          </div>
        </div>

        {isNewTask ? (
          // Gone while a picker is open, and the list sitting over this row is
          // the smaller half of why: Enter completes the highlighted row there
          // rather than sending, and the picker draws its own ↵ hint saying so.
          // Two Enter legends at once, one of them untrue.
          //
          // The menu, not its rows — including while it is still placeholders.
          // Enter does send there, so the legend would be *true*; it is dropped
          // anyway, because a send hint under an open picker reads as belonging
          // to the list and there is nothing in the list to send. Omitting a
          // hint costs less than drawing one that looks like it means the row
          // above it.
          !menuOpen && (
            <div className="flex items-center justify-between gap-3 pt-2">
              <div className="flex shrink-0 items-center gap-1 text-ui text-muted-foreground/60">
                {held ?? (
                  <>
                    Press <CornerDownLeft className="size-3" strokeWidth={2} /> to send
                  </>
                )}
              </div>
              {agentUpdate}
            </div>
          )
        ) : (
          <div className="pt-1.5">{toolbar}</div>
        )}
      </form>
    </div>
  );
}
