/// Serializes a rendered table's rows for the copy control in
/// [MarkdownTable](../components/chat/MarkdownTable.tsx). Pure and here rather
/// than in the component because a wrong escape is invisible on screen — it
/// only shows when the paste lands somewhere that parses it.

export type TableFormat = "markdown" | "csv" | "tsv";

function toMarkdown(rows: string[][]): string {
  const line = (r: string[]) => `| ${r.map((c) => c.replaceAll("|", "\\|")).join(" | ")} |`;
  const [head, ...body] = rows;
  return [line(head), line(head.map(() => "---")), ...body.map(line)].join("\n");
}

/// A field is quoted only when it holds its own format's delimiter, a quote
/// or a newline — a comma is ordinary text in TSV and quoting it there wraps
/// most prose cells for nothing.
function toDelimited(rows: string[][], sep: string): string {
  const needsQuote = new RegExp(`["\n${sep}]`);
  const field = (c: string) => (needsQuote.test(c) ? `"${c.replaceAll('"', '""')}"` : c);
  return rows.map((r) => r.map(field).join(sep)).join("\n");
}

export function serializeTable(rows: string[][], format: TableFormat): string {
  if (rows.length === 0) return "";
  if (format === "markdown") return toMarkdown(rows);
  return toDelimited(rows, format === "csv" ? "," : "\t");
}
