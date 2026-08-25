import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";

import CodeView from "@/components/chat/CodeView";
import DiffView from "@/components/chat/DiffView";
import ImageRow from "@/components/chat/ImageRow";
import { cn } from "@/lib/utils";
import { countChanges, editSides, readRange } from "@/lib/diff";
import { formatToolInput, isRoutineError, toolLabel, toolSummary } from "@/lib/tools";
import type { ToolResult, ToolType } from "@/types/events";
import type { JsonValue } from "@/types/serde_json/JsonValue";

// Shown in the header, so the expanded body omits them to avoid repeating
// itself. `timeout` is here for a different reason: it is a ceiling the model
// sets on its own call, not a fact about what the call does, and it left the
// body of an otherwise fully-summarized Bash call reading `{"timeout": 300000}`
// — which looks like the only thing worth knowing about the command.
const SUMMARY_FIELDS = [
  "file_path",
  "path",
  "notebook_path",
  "command",
  "pattern",
  "query",
  "url",
  "description",
  "timeout",
];

// Dropped from the body when a diff stands in for it: the diff already shows
// both sides, and repeating them as raw JSON underneath doubles the row's
// height with the same content. `replace_all` goes too — it steers how the edit
// was applied, and the reader is looking at the result of applying it.
const EDIT_FIELDS = [
  ...SUMMARY_FIELDS,
  "old_string",
  "new_string",
  "content",
  "new_source",
  "edits",
  "replace_all",
];

// Same idea for a ranged read: the gutter already shows which lines these are.
const READ_FIELDS = [...SUMMARY_FIELDS, "offset", "limit"];

// Long results are the norm — reads come back in the thousands of characters —
// so expanding shows a head and the rest scrolls rather than pushing the
// composer off-screen.
const PREVIEW_CHARS = 4000;

type ToolCallProps = {
  name: string;
  toolType: ToolType;
  title: string | null;
  input: JsonValue;
  rawInput: string | null;
  /// Absent while the call is still in flight.
  result?: ToolResult;
  /// Set for a row inside a `ToolGroupRow`, whose header already names the tool
  /// — repeating "Edited" down all 30 rows is noise, and the path is the only
  /// thing that varies.
  hideLabel?: boolean;
  /// Starts the row expanded. Initial state only, so the reader's own closes
  /// stick. For a row the reader reached deliberately — the call a subagent
  /// panel row opens onto — where making them click a second time to see the
  /// thing they asked for is the click that says nothing.
  defaultOpen?: boolean;
};

export default function ToolCall({
  name,
  toolType,
  title,
  input,
  rawInput,
  result,
  hideLabel = false,
  defaultOpen = false,
}: ToolCallProps) {
  const [open, setOpen] = useState(defaultOpen);

  const summary = title ?? toolSummary(name, toolType, input);
  const pending = result === undefined;
  const failed = result?.isError ?? false;

  // Failed and worth interrupting the reader over are different questions. Most
  // errors here are the agent probing a path or a binary and moving on, so red
  // on every one of them is red on a resting transcript. The row still reads as
  // failed either way — the "Error:" body says so — this only decides the colour.
  const alarming = failed && !isRoutineError(result?.text);

  // Inside a group the label is redundant — except with no summary to stand in
  // its place, where dropping it would leave a blank, unclickable row.
  const showLabel = !hideLabel || !summary;

  // A file edit renders as a diff rather than as its raw arguments. `rawInput`
  // wins when present — it means the call is still streaming and the JSON has
  // not parsed yet, so there is nothing to diff.
  const sides = toolType === "file_edit" && !rawInput ? editSides(input) : null;

  // Shown on the collapsed row, so the size of an edit is legible without
  // opening it. Memoized because it parses the diff to stay consistent with the
  // viewer, and a streaming turn re-renders every row on each delta.
  // Keyed on the strings, not on `sides` — `editSides` builds a fresh object
  // every render, so an identity dependency would never hit.
  const changes = useMemo(
    () => (sides ? countChanges(sides) : null),
    [sides?.path, sides?.oldText, sides?.newText],
  );

  const output = result?.text.trim() ?? "";

  // A `Read` of a `.png` answers in pictures and in nothing else — no text, no
  // range, nothing the expander could hold — so the row would otherwise say only
  // that a file was read and give no way to see it. Drawn outside the button and
  // without waiting to be opened: this is the whole of what the call returned,
  // and a screenshot the agent just took is usually the most informative thing
  // in the turn. Uncropped and at reading size, unlike the reader's own
  // attachments — see `ImageRow`.
  const images = result?.images ?? [];

  // A *ranged* read renders its slice as highlighted code. A whole-file read
  // does not: that is the agent loading context, and hundreds of lines mid-
  // transcript bury the conversation the reader is following.
  const read = toolType === "file_read" && !rawInput && !failed;
  const range = read ? readRange(input, output) : null;

  // A successful whole-file read is a dead end on purpose: no diff, no code, no
  // arguments, and its result is the file itself — so the row collapses to the
  // tool name and the path with nothing to open. Anything else worth showing
  // (a failure, a still-streaming call) leaves `read` false and takes the
  // ordinary path.
  const inert = read && range === null;

  // The reader answered this on a card of its own, so its arguments are the
  // questions and options they just read — reprinting them as JSON tells them
  // nothing. What survives is the harness's own sentence naming each question
  // and the answer given, which is prose and reads as prose.
  const asked = name === "AskUserQuestion" && !rawInput;

  const omit = sides ? EDIT_FIELDS : range ? READ_FIELDS : SUMMARY_FIELDS;
  const body = inert || asked ? null : rawInput ?? formatToolInput(input, omit);

  // A successful edit's result is boilerplate ("The file ... has been updated
  // successfully") that the diff above already demonstrates, and a rendered
  // read repeats its own output verbatim. Failures always show — that text is
  // the only place the reason lives.
  const echoesViewer = (sides !== null || range !== null || inert) && !failed;
  const shownOutput = echoesViewer ? "" : output;
  const shown =
    shownOutput.length > PREVIEW_CHARS
      ? `${shownOutput.slice(0, PREVIEW_CHARS)}…`
      : shownOutput;

  // Output stays behind the expander regardless of length. Auto-showing short
  // results only made rows inconsistent — some opened, some didn't, with no
  // visible reason why.
  const expandable = Boolean(body) || Boolean(shown) || sides !== null || range !== null;

  return (
    <div className="group/tool flex flex-col gap-1.5">
      {/* The collapsed row is text on the page — no card, no padding. Chrome
          belongs to the expanded content, which is what needs the containment. */}
      <button
        type="button"
        disabled={!expandable}
        onClick={() => setOpen((prev) => !prev)}
        className="flex w-full items-center gap-2 text-left text-chat"
      >
        {/* The shimmer is the running state; it stops the moment the result
            lands, so a settled row is plain text again. The label carries the
            same information in its tense — "Reading" then "Read". */}
        {showLabel && (
          <span
            className={cn(
              "shrink-0",
              alarming ? "text-destructive" : "text-foreground/80",
              pending && "shimmer-text",
            )}
          >
            {toolLabel(name, pending)}
          </span>
        )}

        {/* `min-w-0` lets it shrink and `max-w-fit` stops it claiming the row's
            free space, which would push the caret out to the far right. With the
            label hidden this is the whole row, so it inherits the shimmer and
            the failure color the label would have carried. */}
        {summary && (
          <span
            className={cn(
              "min-w-0 max-w-fit truncate font-mono",
              !showLabel && alarming ? "text-destructive" : "text-muted-foreground",
              !showLabel && pending && "shimmer-text",
            )}
          >
            {summary}
          </span>
        )}

        {/* Sits with the path rather than at the row's end, so it reads as part
            of the filename the way `git --stat` prints it. A side with no lines
            is omitted instead of showing `+0`, which says nothing. */}
        {changes && (changes.added > 0 || changes.removed > 0) && (
          <span className="shrink-0 font-mono tabular-nums">
            {changes.added > 0 && <span className="text-emerald-400">+{changes.added}</span>}
            {changes.added > 0 && changes.removed > 0 && " "}
            {changes.removed > 0 && <span className="text-destructive">-{changes.removed}</span>}
          </span>
        )}

        {/* Trails the text rather than pinning to the far right, so it reads as
            part of the row instead of a column of its own. */}
        <ChevronRight
          className={cn(
            "size-3 shrink-0 text-muted-foreground transition-all",
            open ? "rotate-90 opacity-100" : "opacity-0 group-hover/tool:opacity-100",
            !expandable && "invisible",
          )}
        />

        {/* No pending dot — the shimmering label is the running state, and two
            indicators for one fact just competed with each other. A non-zero
            exit stays: that is an outcome, which the label never encodes. */}
        {result?.exitCode != null && result.exitCode !== 0 && (
          <span
            className={cn(
              "ml-auto shrink-0",
              alarming ? "text-destructive" : "text-muted-foreground",
            )}
          >
            exit {result.exitCode}
          </span>
        )}
      </button>

      <ImageRow images={images} />

      {open && sides && <DiffView sides={sides} />}

      {open && range && <CodeView range={range} />}

      {open && body && (
        <pre className="overflow-x-auto rounded-md bg-surface-raised px-2.5 py-2 font-mono text-tool text-muted-foreground">
          {body}
        </pre>
      )}

      {/* Two results drop the box and read at the row's own size. A failure,
          because an error is the reason to look at the row and should not be the
          smallest text on it; an answered question, because the harness writes
          it as a sentence and a code box would frame prose as output. Neither is
          tinted — the "Error:" lead-in names the text on its own, which is also
          what carries a routine failure that the label above left uncoloured. */}
      {open && shown && (
        <pre
          className={cn(
            "max-h-96 overflow-auto whitespace-pre-wrap",
            failed
              ? "font-mono text-chat text-foreground/90"
              : asked
                // Sans too, not just unboxed: this is the only result that is a
                // written sentence rather than a program's output. Stated, not
                // omitted — `pre` is monospace by default, so dropping the class
                // leaves the font unchanged.
                ? "font-sans text-chat text-foreground/90"
                : "rounded-md bg-surface-raised px-2.5 py-2 font-mono text-tool text-muted-foreground",
          )}
        >
          {failed && "Error: "}
          {shown}
        </pre>
      )}
    </div>
  );
}
