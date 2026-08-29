import { useMemo, useState } from "react";
import { ChevronRight } from "lucide-react";

import CodeView from "@/components/chat/CodeView";
import DiffView from "@/components/chat/DiffView";
import ImageRow from "@/components/chat/ImageRow";
import { cn } from "@/lib/utils";
import { countChanges, countUnifiedChanges, editSides, readRange } from "@/lib/diff";
import {
  fileName,
  fileTarget,
  formatToolInput,
  mcpCall,
  isRoutineError,
  skillBrief,
  toolLabel,
  toolSummary,
} from "@/lib/tools";
import { revealItemInDir } from "@tauri-apps/plugin-opener";
import type { FileEdit, ToolResult, ToolType } from "@/types/events";
import FileEdits from "@/components/chat/FileEdits";
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

// A `Skill` call carries two fields and the row already draws both — the name in
// the header, the brief as prose beneath it — so its argument body would be the
// same call written out twice. Anything the tool grows later still shows.
const SKILL_FIELDS = [...SUMMARY_FIELDS, "skill", "args"];

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
  /// The files this call changed, where the harness reports them first-class.
  ///
  /// Codex does; Claude Code does not, and its edits arrive inside `input` for
  /// `editSides` to pull apart instead. Drawn inside this row rather than
  /// beside it, because a patch is one action — two rows put the filename on
  /// screen twice and made the reader work out that they were the same thing.
  edits?: FileEdit[];
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
  edits,
  hideLabel = false,
  defaultOpen = false,
}: ToolCallProps) {
  const [open, setOpen] = useState(defaultOpen);

  // An MCP call names a server and a method, and both harnesses spell that for
  // a machine. The label becomes "MCP" the way a shell row's is "Bash", and the
  // method sits beside it as something readable.
  const mcp = toolType === "mcp" ? mcpCall(name, title) : null;

  const summary = mcp
    ? mcp.label
    : // A skill names itself. Its title is the command that read it, which is
      // machinery rather than the thing — and preferring the field here is what
      // makes a row logged *before* the mapper stopped titling them that way
      // draw right, since the title on disk cannot be changed.
      name === "Skill"
      ? (toolSummary(name, toolType, input) ?? title)
      : (title ?? toolSummary(name, toolType, input));
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

  // The same figure for a harness that reports a unified diff rather than two
  // sides. Without it a Codex edit drew no size beside it while the identical
  // edit from Claude drew `+22 -12`.
  const editChanges = useMemo(
    () => (edits?.length ? countUnifiedChanges(edits.map((e) => e.unifiedDiff)) : null),
    [edits],
  );

  const shownChanges = changes ?? editChanges;

  // Resolved from the call's own arguments rather than read off `title`, so a
  // row logged before the mapper shortened its title draws the same as one
  // logged after it. The full path stays on the tooltip and is what opens.
  const target = rawInput ? null : fileTarget(toolType, input);

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

  // A `Skill` call hands the skill a brief in the model's own words, so it reads
  // as prose and not as arguments. Null is the common case — a skill named with
  // nothing beside it — and then the row has nothing to open at all.
  const brief = name === "Skill" && !rawInput ? skillBrief(input) : null;

  const omit = sides
    ? EDIT_FIELDS
    : range
      ? READ_FIELDS
      : name === "Skill"
        ? SKILL_FIELDS
        : SUMMARY_FIELDS;
  const body = inert || asked ? null : rawInput ?? formatToolInput(input, omit);

  // A successful edit's result is boilerplate ("The file ... has been updated
  // successfully") that the diff above already demonstrates, and a rendered
  // read repeats its own output verbatim. Failures always show — that text is
  // the only place the reason lives.
  const echoesViewer = (sides !== null || range !== null || inert) && !failed;

  // A `Skill` launch answers "Launching skill: <name>", which is the row's own
  // label and summary read back. A refusal still shows — that text is the only
  // place the reason lives.
  const echoesHeader = name === "Skill" && !failed;
  const shownOutput = echoesViewer || echoesHeader ? "" : output;
  const shown =
    shownOutput.length > PREVIEW_CHARS
      ? `${shownOutput.slice(0, PREVIEW_CHARS)}…`
      : shownOutput;

  // Output stays behind the expander regardless of length. Auto-showing short
  // results only made rows inconsistent — some opened, some didn't, with no
  // visible reason why.
  const expandable =
    Boolean(body) ||
    Boolean(shown) ||
    Boolean(brief) ||
    sides !== null ||
    range !== null ||
    Boolean(edits?.length);

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
            {mcp ? "MCP" : toolLabel(name, pending)}
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
            title={mcp?.detail ?? target ?? undefined}
          >
            {/* A span, not an anchor: this sits inside the row's own expand
                button, so nesting a second interactive element would be
                invalid markup and the click would toggle the row instead of
                opening anything. `stopPropagation` is what keeps the two
                apart. */}
            {target ? (
              <span
                role="link"
                tabIndex={0}
                onClick={(e) => {
                  e.stopPropagation();
                  void revealItemInDir(target).catch(() => {});
                }}
                onKeyDown={(e) => {
                  if (e.key !== "Enter" && e.key !== " ") return;
                  e.stopPropagation();
                  e.preventDefault();
                  void revealItemInDir(target).catch(() => {});
                }}
                className="underline decoration-transparent underline-offset-2 transition-colors hover:decoration-current"
              >
                {fileName(target)}
              </span>
            ) : (
              summary
            )}
          </span>
        )}

        {/* Sits with the path rather than at the row's end, so it reads as part
            of the filename the way `git --stat` prints it. A side with no lines
            is omitted instead of showing `+0`, which says nothing. */}
        {shownChanges && (shownChanges.added > 0 || shownChanges.removed > 0) && (
          <span className="shrink-0 font-mono tabular-nums">
            {shownChanges.added > 0 && (
              <span className="text-emerald-400">+{shownChanges.added}</span>
            )}
            {shownChanges.added > 0 && shownChanges.removed > 0 && " "}
            {shownChanges.removed > 0 && (
              <span className="text-destructive">-{shownChanges.removed}</span>
            )}
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

      {/* The harness reported the change itself, so this is a real unified diff
          rather than two sides reconstructed from the call's arguments. */}
      {open && edits && edits.length > 0 && <FileEdits edits={edits} />}

      {open && range && <CodeView range={range} />}

      {/* Unboxed and sans, for the reason an answered question is: this is a
          sentence somebody wrote, and a code box frames prose as output. */}
      {open && brief && (
        <p className="whitespace-pre-wrap text-chat text-foreground/90">{brief}</p>
      )}

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
