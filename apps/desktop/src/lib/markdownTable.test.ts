import { describe, expect, it } from "vitest";

import { serializeTable } from "./markdownTable";

const ROWS = [
  ["Theme", "Note"],
  ["Rosé Pine", "Muted, low-chroma"],
];

describe("serializeTable", () => {
  it("writes markdown with a delimiter row", () => {
    expect(serializeTable(ROWS, "markdown")).toBe(
      "| Theme | Note |\n| --- | --- |\n| Rosé Pine | Muted, low-chroma |",
    );
  });

  it("escapes a pipe in a markdown cell", () => {
    expect(serializeTable([["a|b"]], "markdown")).toBe("| a\\|b |\n| --- |");
  });

  it("quotes a csv field holding the delimiter, and doubles quotes", () => {
    expect(serializeTable([["a,b", 'say "hi"', "plain"]], "csv")).toBe(
      '"a,b","say ""hi""",plain',
    );
  });

  it("joins tsv with tabs", () => {
    expect(serializeTable(ROWS, "tsv")).toBe("Theme\tNote\nRosé Pine\tMuted, low-chroma");
  });

  it("answers empty for no rows", () => {
    expect(serializeTable([], "markdown")).toBe("");
  });
});
