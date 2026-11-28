import { describe, expect, it } from "vitest";

import {
  addPage,
  deletePage,
  describeCanvasPick,
  frameUrl,
  moveFrameToPage,
  movePage,
  parseCanvas,
  pinCanvasPick,
  readCanvasPicks,
  renamePage,
  sides,
  unpinCanvasPick,
  withCanvasPicks,
  type CanvasPick,
} from "./canvas";

// What `dray canvas add` writes, unknown fields included.
const CLI_FILE = JSON.stringify({
  version: 1,
  url: "http://localhost:5173",
  theme: "kept",
  pages: [
    {
      id: "p-1",
      name: "Page 1",
      frames: [{ id: "f-1", name: "/pricing", route: "/pricing", width: 1280, x: 0, y: 0 }],
    },
    {
      id: "p-2",
      name: "Explorations",
      frames: [
        { id: "f-2", name: "Bold", component: "src/canvas/Bold.tsx#Bold", props: { popular: true }, width: 400, x: 0, y: 0 },
      ],
    },
  ],
});

describe("parseCanvas", () => {
  it("reads what the CLI writes and keeps fields it does not know", () => {
    const doc = parseCanvas(CLI_FILE);
    expect(doc.pages.map((p) => p.name)).toEqual(["Page 1", "Explorations"]);
    expect(doc.theme).toBe("kept");
    expect(doc.pages[1].frames[0].props).toEqual({ popular: true });
  });

  it("answers a page for no file and for a broken one", () => {
    expect(parseCanvas(null).pages).toHaveLength(1);
    expect(parseCanvas("{nope").pages[0].name).toBe("Page 1");
  });

  it("fills a frame's missing place", () => {
    const doc = parseCanvas(JSON.stringify({ pages: [{ name: "A", frames: [{ route: "/" }, { route: "/x" }] }] }));
    expect(doc.pages[0].frames.map((f) => [f.x, f.width])).toEqual([
      [0, 1280],
      [480, 1280],
    ]);
  });
});

describe("pages", () => {
  it("adds, renames, reorders and deletes, keeping the last page", () => {
    let doc = parseCanvas(CLI_FILE);
    const added = addPage(doc);
    doc = added.doc;
    expect(doc.pages.at(-1)!.name).toBe("Page 3");
    doc = renamePage(doc, added.id, "  Final  ");
    expect(doc.pages.at(-1)!.name).toBe("Final");
    expect(renamePage(doc, added.id, " ")).toBe(doc);
    doc = movePage(doc, added.id, 0);
    expect(doc.pages.map((p) => p.name)).toEqual(["Final", "Page 1", "Explorations"]);
    doc = deletePage(deletePage(deletePage(doc, "p-1"), "p-2"), added.id);
    expect(doc.pages).toHaveLength(1);
  });

  it("moves a frame to another page, after its rightmost frame", () => {
    const doc = moveFrameToPage(parseCanvas(CLI_FILE), "f-1", "p-2");
    expect(doc.pages[0].frames).toHaveLength(0);
    const moved = doc.pages[1].frames.at(-1)!;
    expect([moved.id, moved.x, moved.y]).toEqual(["f-1", 480, 0]);
  });
});

describe("frameUrl", () => {
  it("loads a route as it is and a component through the harness", () => {
    const [route] = parseCanvas(CLI_FILE).pages[0].frames;
    const [comp] = parseCanvas(CLI_FILE).pages[1].frames;
    expect(frameUrl("http://localhost:5173/", route)).toBe("http://localhost:5173/pricing");
    const url = new URL(frameUrl("http://localhost:5173", comp));
    expect(url.pathname).toBe("/__dray/frame");
    expect(url.searchParams.get("c")).toBe("src/canvas/Bold.tsx");
    expect(url.searchParams.get("e")).toBe("Bold");
    expect(JSON.parse(url.searchParams.get("p")!)).toEqual({ popular: true });
  });
});

const PICK: CanvasPick = {
  key: "a",
  frame: "Bold",
  page: "Explorations",
  element: {
    tag: "button",
    id: null,
    classes: "h-10 px-4",
    text: "Choose Pro",
    source: "src/components/Button.tsx:13:5",
    sourceIsOwn: true,
    components: ["Bold", "Button"],
    rect: { x: 0, y: 0, width: 270, height: 40 },
    styles: {
      display: "inline-flex",
      flexDirection: "row",
      gap: "normal",
      padding: ["0px", "16px", "0px", "16px"],
      margin: ["0px", "0px", "0px", "0px"],
      borderWidth: ["0px", "0px", "0px", "0px"],
      borderStyle: "none",
      borderColor: "rgb(0, 0, 0)",
      borderRadius: ["8px", "8px", "8px", "8px"],
      fontFamily: "Inter, ui-sans-serif",
      fontSize: "14px",
      fontWeight: "600",
      lineHeight: "20px",
      letterSpacing: "normal",
      textAlign: "center",
      color: "rgb(255, 255, 255)",
      background: "rgb(40, 82, 224)",
      opacity: "1",
      boxShadow: "none",
    },
  },
};

describe("picks", () => {
  it("writes shorthand the way CSS does", () => {
    expect(sides(["1px", "1px", "1px", "1px"])).toBe("1px");
    expect(sides(["0px", "16px", "0px", "16px"])).toBe("0px 16px");
    expect(sides(["1px", "2px", "3px", "2px"])).toBe("1px 2px 3px");
    expect(sides(["1px", "2px", "3px", "4px"])).toBe("1px 2px 3px 4px");
  });

  it("describes the element with its source and styles", () => {
    const text = describeCanvasPick(PICK);
    expect(text).toContain("Source: src/components/Button.tsx:13:5");
    expect(text).toContain("Components: Bold > Button");
    expect(text).toContain("Padding 0px 16px");
    expect(text).toContain("Border none; radius 8px");
    expect(text).toContain("Background rgb(40, 82, 224)");
  });

  it("puts the reader's words first", () => {
    expect(withCanvasPicks("more padding", [PICK]).startsWith("more padding\n\nCanvas element")).toBe(true);
    expect(withCanvasPicks("hi", [])).toBe("hi");
  });

  it("replaces the last chip unless adding", () => {
    pinCanvasPick("s", PICK, false);
    pinCanvasPick("s", { ...PICK, key: "b" }, false);
    expect(readCanvasPicks("s").map((p) => p.key)).toEqual(["b"]);
    pinCanvasPick("s", { ...PICK, key: "c" }, true);
    expect(readCanvasPicks("s").map((p) => p.key)).toEqual(["b", "c"]);
    unpinCanvasPick("s", "b");
    unpinCanvasPick("s", "c");
    expect(readCanvasPicks("s")).toEqual([]);
  });
});
