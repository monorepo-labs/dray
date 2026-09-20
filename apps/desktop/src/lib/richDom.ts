/// The composer's tree: built from [placed runs], read back as the string that
/// built it, and addressed by index rather than by node.
///
/// Split from [richText.ts] because of what can be tested. `pnpm test` runs in a
/// node environment with no DOM, so everything below that touches one is
/// exercised on the demo page instead — in the WebKit the app actually ships on
/// rather than in a simulation of it. That is the same bargain dictation makes.
/// [`diffRange`] is the exception and is pinned by test: it is pure, and it is
/// the piece whose being wrong would send words nobody typed.
///
/// The property everything here rests on: **[`readValue`] of a tree built by
/// [`renderInto`] is the string it was built from, exactly.** A chip shortens
/// its face and never its `data-tag`.
///
/// [placed runs]: ./richText.ts
/// [richText.ts]: ./richText.ts
import { FILLER_ATTR, TAG_ATTR, type Placed } from "@/lib/richText";

/// Whether an element starts a line of its own.
///
/// [`renderInto`] only ever makes `span`s and `br`s, so everything else in this
/// tree was put there by the browser — and what the browser makes when a line is
/// broken is a block, `div` in WebKit. Asked by tag rather than by computed
/// style, which would be a layout read per node on a walk that runs on every
/// keystroke.
function isBlock(el: HTMLElement): boolean {
  return el.tagName !== "SPAN" && el.tagName !== "BR";
}

/// Every node contributing text, in document order.
///
/// The cases are everything the tree can hold. A chip is worth its whole
/// `data-tag` and is never descended into. A `<br>` is worth a newline **unless
/// it closes its container**, where it is the filler every browser adds so that
/// an empty line has something to draw — which is also why a value ending in a
/// newline comes back as `text<br><br>` and reads correctly here. A block is
/// worth a newline *before* it, since that is the whole of what a block means in
/// a text box. Everything else is descended through.
///
/// The block rule is not defensive: `insertText` with a newline in it makes
/// blocks in WebKit, so the composer's own ⇧⏎ and its paste handler both produce
/// them. Without it those newlines are simply absent from the value — the text
/// draws on two lines and sends as one.
function* pieces(root: Node): Generator<{ node: Node; text: string }> {
  let first = true;

  for (const node of Array.from(root.childNodes)) {
    if (node.nodeType === Node.TEXT_NODE) {
      yield { node, text: (node as Text).data };
      first = false;
      continue;
    }

    if (!(node instanceof HTMLElement)) continue;
    if (node.hasAttribute(FILLER_ATTR)) continue;

    const tag = node.getAttribute(TAG_ATTR);
    if (tag !== null) {
      yield { node, text: tag };
      first = false;
      continue;
    }

    if (node.tagName === "BR") {
      if (node === root.lastChild) continue;
      yield { node, text: "\n" };
      first = false;
      continue;
    }

    if (isBlock(node) && !first) yield { node, text: "\n" };
    yield* pieces(node);
    first = false;
  }
}

/// The tree as the string that built it.
export function readValue(root: Node): string {
  let out = "";
  for (const piece of pieces(root)) out += piece.text;
  return out;
}

/// A DOM position as an index into the string.
///
/// Measured by cloning the range rather than by walking to it, so the two
/// directions cannot disagree about what a node is worth: the clone is read by
/// the same [`readValue`] that produces the canonical string.
export function offsetOf(root: HTMLElement, node: Node, offset: number): number {
  const range = document.createRange();
  range.selectNodeContents(root);

  try {
    range.setEnd(node, offset);
  } catch {
    // A selection left over from a tree that has since been rebuilt. The end of
    // the text is where the caret goes when nothing better is known — the same
    // answer arriving at a session with a draft already gives.
    return readValue(root).length;
  }

  return readValue(range.cloneContents()).length;
}

/// An index into the string as a DOM position.
///
/// A chip has no interior the caret can reach, being `contenteditable=false`, so
/// an index landing inside one resolves to one of its edges — the trailing one
/// once the index has reached its end, which is where the caret was going anyway.
export function locate(root: HTMLElement, index: number): { node: Node; offset: number } {
  let start = 0;

  for (const { node, text } of pieces(root)) {
    const end = start + text.length;

    if (index <= end) {
      if (node.nodeType === Node.TEXT_NODE) return { node, offset: index - start };

      const parent = node.parentNode;
      if (!parent) break;

      const at = Array.prototype.indexOf.call(parent.childNodes, node);
      return { node: parent, offset: index >= end ? at + 1 : at };
    }

    start = end;
  }

  return { node: root, offset: root.childNodes.length };
}

/// Where the caret is as an index, or `null` when it is not in this box.
export function caretOf(root: HTMLElement): number | null {
  const selection = window.getSelection();
  if (!selection || selection.rangeCount === 0) return null;

  const range = selection.getRangeAt(0);
  if (!root.contains(range.startContainer)) return null;

  return offsetOf(root, range.startContainer, range.startOffset);
}

/// Puts the caret at an index.
export function placeCaret(root: HTMLElement, index: number): void {
  const { node, offset } = locate(root, index);

  const range = document.createRange();
  range.setStart(node, offset);
  range.collapse(true);

  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

/// Rebuilds the tree from the placed runs.
///
/// Called only when the chips move, never on ordinary typing — see
/// `chipSignature`. That restraint is the whole design: between rebuilds the
/// browser owns this subtree outright, so typing keeps the browser's own caret
/// handling and its own undo, neither of which is something this file would want
/// to reimplement.
export function renderInto(
  root: HTMLElement,
  placed: Placed[],
  classOf: (placed: Placed) => string,
): void {
  const doc = root.ownerDocument;
  const children: Node[] = [];
  let tail = "";

  for (const entry of placed) {
    const className = classOf(entry);

    if (entry.label !== null) {
      const chip = doc.createElement("span");
      // The run back whole, and the round trip rests on it: shortening this
      // rather than the face is what would send a prompt nobody wrote.
      chip.setAttribute(TAG_ATTR, entry.segment.text);
      chip.contentEditable = "false";
      chip.className = className;
      // Before the face, and inside the chip so it goes when the chip goes.
      // `align` rather than a flex row: an inline-flex takes its baseline from
      // its first item, and an image's baseline is its bottom edge — which would
      // hang the whole chip below the line of prose it sits in.
      if (entry.icon) {
        const icon = doc.createElement("img");
        icon.src = entry.icon;
        icon.alt = "";
        icon.ariaHidden = "true";
        icon.draggable = false;
        icon.className = "mr-1 inline-block size-[1em] align-[-0.15em]";
        chip.append(icon);
      }

      // No `title`: what a chip hides is one caret press away — putting the
      // caret in it draws the run back as text — and a native tooltip is the
      // one kind this app doesn't use.
      chip.append(doc.createTextNode(entry.label));

      children.push(chip);
      tail = entry.label;
      continue;
    }

    // A bare text node where the run takes no colour, which is most of them —
    // one fewer element for the browser to split, merge and leave behind as the
    // reader types inside it.
    if (!className) {
      children.push(doc.createTextNode(entry.segment.text));
      tail = entry.segment.text;
      continue;
    }

    const span = doc.createElement("span");
    span.className = className;
    span.textContent = entry.segment.text;
    children.push(span);
    tail = entry.segment.text;
  }

  // A `pre-wrap` box does not draw the last newline in its content, so ⇧⏎ at the
  // end would leave the caret on a line that is not on screen. `pieces` skips
  // the filler, or it would add a newline to the value on every render.
  if (tail.endsWith("\n")) {
    const filler = doc.createElement("br");
    filler.setAttribute(FILLER_ATTR, "");
    children.push(filler);
  }

  root.replaceChildren(...children);
}

/// Types `text` in at the selection, as the browser's own editing commands.
///
/// **A newline is `insertLineBreak`, never `insertText`.** Handed a `\n`,
/// WebKit splits the current block and makes a `div` — which `pieces` now reads
/// correctly, but which puts a shape into the tree that nothing here builds and
/// that browsers disagree about. `insertLineBreak` makes the `<br>` this file
/// already speaks, so the tree the reader edits stays the tree `renderInto`
/// makes. Split rather than done in one pass because the two commands are the
/// only way to say each half.
export function insertText(text: string): boolean {
  let ok = true;
  const lines = text.split("\n");

  lines.forEach((line, i) => {
    if (i > 0) ok = document.execCommand("insertLineBreak") && ok;
    if (line) ok = document.execCommand("insertText", false, line) && ok;
  });

  return ok;
}

/// The one range two strings differ over — common prefix and common suffix cut
/// away.
///
/// Every programmatic change to the composer arrives as a whole new string: a
/// pick, a newline, a dictated sentence. Applied by rebuilding the tree it would
/// take the browser's undo stack with it, so it goes in as a range and a
/// replacement through [`insertText`], which the browser records as an undoable
/// edit. Reduced this way a pick is the tag alone rather than the prompt.
export function diffRange(
  prev: string,
  next: string,
): { start: number; end: number; text: string } {
  let start = 0;
  while (start < prev.length && start < next.length && prev[start] === next[start]) start += 1;

  let tail = 0;
  while (
    tail < prev.length - start &&
    tail < next.length - start &&
    prev[prev.length - 1 - tail] === next[next.length - 1 - tail]
  ) {
    tail += 1;
  }

  return { start, end: prev.length - tail, text: next.slice(start, next.length - tail) };
}
