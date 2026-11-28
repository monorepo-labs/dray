/// Set on a chip drawn in place of text — a path in prose drawn as `@name` —
/// holding the text it stands for, so a copy carries that and not the face.
/// Spelled as `data-copy` in JSX, where a computed name would lose its type.
const COPY_ATTR = "data-copy";

type Chip = { face: string; text: string };

/// `selected` with each chip's face, in order, spelled as its text.
///
/// Matched by face from where the last one ended, since the selection's text
/// is the browser's own and keeps no node boundaries to splice at.
// ponytail: a literal `@name` typed in prose ahead of a chip of the same face
// takes its place; walk the selection's text nodes if that ever shows up.
export function spellChips(selected: string, chips: Chip[]): string {
  let out = "";
  let at = 0;
  for (const { face, text } of chips) {
    const i = selected.indexOf(face, at);
    if (i < 0) continue;
    out += selected.slice(at, i) + text;
    at = i + face.length;
  }
  return out + selected.slice(at);
}

/// Swaps every chip under `root` for its text, in place. For a detached copy.
function spellChipsIn(root: ParentNode) {
  for (const chip of root.querySelectorAll(`[${COPY_ATTR}]`)) {
    chip.replaceWith(chip.getAttribute(COPY_ATTR) ?? "");
  }
}

/// `el`'s text with its chips spelled out.
export function textWithChips(el: Element): string {
  const copy = el.cloneNode(true) as Element;
  spellChipsIn(copy);
  return copy.textContent ?? "";
}

/// Whether the whole of `el` is inside `range`. A chip cut in half by the
/// selection copies the half the reader took.
function covers(range: Range, el: Element): boolean {
  const own = document.createRange();
  own.selectNodeContents(el);
  if (range.compareBoundaryPoints(Range.START_TO_START, own) > 0) {
    own.setStart(range.startContainer, range.startOffset);
  }
  if (range.compareBoundaryPoints(Range.END_TO_END, own) < 0) {
    own.setEnd(range.endContainer, range.endOffset);
  }
  return own.toString() === el.textContent;
}

/// The document's `copy` handler: a selection holding a chip copies the path
/// the chip stands for. Anything else is left to the browser.
export function copyChipText(e: ClipboardEvent) {
  const selection = document.getSelection();
  if (!e.clipboardData || !selection || selection.isCollapsed || selection.rangeCount === 0) return;
  const range = selection.getRangeAt(0);
  const common = range.commonAncestorContainer;
  const scope = common instanceof Element ? common : common.parentElement;
  if (!scope) return;
  const inside = scope.closest(`[${COPY_ATTR}]`);
  const chips = (inside ? [inside] : [...scope.querySelectorAll(`[${COPY_ATTR}]`)]).filter(
    (el) => range.intersectsNode(el) && covers(range, el),
  );
  if (chips.length === 0) return;

  e.clipboardData.setData(
    "text/plain",
    spellChips(
      selection.toString(),
      chips.map((el) => ({ face: el.textContent ?? "", text: el.getAttribute(COPY_ATTR) ?? "" })),
    ),
  );
  // A selection inside one chip clones its text and not the chip, so it
  // carries plain text alone.
  if (!inside) {
    const html = document.createElement("div");
    html.append(range.cloneContents());
    spellChipsIn(html);
    e.clipboardData.setData("text/html", html.innerHTML);
  }
  e.preventDefault();
}
