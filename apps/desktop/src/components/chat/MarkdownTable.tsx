import { Check, Copy } from "lucide-react";
import { memo, useRef, useState, type ComponentProps } from "react";

import { Button } from "@/components/ui/button";
import { serializeTable, type TableFormat } from "@/lib/markdownTable";

/// The copy control's formats, in menu order. Markdown first because it is
/// also what the trigger itself copies.
const FORMATS: { format: TableFormat; label: string }[] = [
  { format: "markdown", label: "Markdown" },
  { format: "csv", label: "CSV" },
  { format: "tsv", label: "TSV" },
];

/// Reads the rendered table rather than re-parsing markdown — the DOM is the
/// one place the rows already sit resolved, whatever plugins rewrote them.
function cells(table: HTMLTableElement): string[][] {
  return Array.from(table.rows, (row) =>
    Array.from(row.cells, (cell) => (cell.textContent ?? "").trim().replace(/\s+/g, " ")),
  );
}

/// The table renderer, replacing Streamdown's wrapper whole. Ours for two
/// reasons: the scroll box is horizontal-only with its width story in one
/// place, and the copy control opens its format menu on hover — Streamdown's
/// holds the menu behind React state only a click reaches.
function MarkdownTableImpl({ children, ...props }: ComponentProps<"table"> & { node?: unknown }) {
  const table = useRef<HTMLTableElement>(null);
  const [copied, setCopied] = useState<TableFormat | null>(null);
  const timer = useRef(0);
  const { node: _node, ...rest } = props;

  const copy = async (format: TableFormat) => {
    if (!table.current) return;
    // A failed write shows no check mark and nothing else — a transcript row
    // has nowhere to put an error sentence.
    try {
      await navigator.clipboard.writeText(serializeTable(cells(table.current), format));
      setCopied(format);
      window.clearTimeout(timer.current);
      timer.current = window.setTimeout(() => setCopied(null), 2000);
    } catch {}
  };

  return (
    <div className="group/table relative my-4">
      {/* `w-max` lets a wide table keep its measured width, with the excess
          scrolling here rather than squeezing the columns; `min-w-full` keeps
          a narrow one filling the line. Cell width bounds ride the blocks
          `rehypeTableCells` puts inside every cell, styled in Markdown. */}
      <div className="md-table-scroll">
        <table ref={table} className="w-max min-w-full border-collapse" {...rest}>
          {children}
        </table>
      </div>
      <div className="absolute top-0 right-0 opacity-0 transition-opacity duration-150 focus-within:opacity-100 group-hover/table:opacity-100">
        <div className="group/copy relative">
          <Button
            variant="ghost"
            size="icon-xs"
            aria-label="Copy table"
            onClick={() => void copy("markdown")}
          >
            {copied ? <Check /> : <Copy />}
          </Button>
          {/* Hover opens it — the trigger already costs a hover to appear, and
              a click on top of that to see the formats made three gestures of
              one copy. Padding, not margin, bridges the gap to the trigger so
              the hover never breaks crossing it. */}
          {/* The surface matches DropdownMenuContent: `--popover` is glass, so
              `backdrop-blur-xl` is what keeps it readable over the table's
              text, and the edge is a ring like every other menu's. */}
          <div className="absolute top-full right-0 z-10 hidden pt-1 group-focus-within/copy:block group-hover/copy:block">
            <div className="min-w-36 rounded-lg bg-popover p-1 text-popover-foreground shadow-md ring-1 ring-foreground/10 backdrop-blur-xl">
              {FORMATS.map(({ format, label }) => (
                <button
                  key={format}
                  type="button"
                  className="flex w-full cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-1 text-left text-sm hover:bg-accent hover:text-accent-foreground"
                  onClick={() => void copy(format)}
                >
                  {copied === format ? (
                    <Check className="size-3.5" />
                  ) : (
                    <Copy className="size-3.5 opacity-60" />
                  )}
                  {label}
                </button>
              ))}
            </div>
          </div>
        </div>
      </div>
    </div>
  );
}

export const MarkdownTable = memo(MarkdownTableImpl);
