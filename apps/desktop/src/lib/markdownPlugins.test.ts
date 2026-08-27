import { describe, expect, it } from "vitest";

import { REHYPE_PLUGINS } from "./markdownPlugins";

type Hast = {
  type: string;
  tagName?: string;
  value?: string;
  properties?: Record<string, unknown>;
  children?: Hast[];
};

// The list's last entry is harden, and it is the only one under test — raw and
// sanitize both want a real unified pipeline around them.
function runHarden(tree: Hast) {
  const entry = (REHYPE_PLUGINS as unknown[]).at(-1) as [
    (options: Record<string, unknown>) => (tree: Hast) => void,
    Record<string, unknown>,
  ];
  const [plugin, options] = entry;
  plugin(options)(tree);
  return tree;
}

function text(tree: Hast): string {
  if (tree.type === "text") return tree.value ?? "";
  return (tree.children ?? []).map(text).join("");
}

function link(href: string, children: Hast[]): Hast {
  return { type: "root", children: [{ type: "element", tagName: "a", properties: { href }, children }] };
}

describe("REHYPE_PLUGINS", () => {
  // Greptile wraps every severity badge in `<a href="#">`, so this shape lands
  // in the PR panel on more or less every review.
  it("unwraps a bare fragment link without annotating it", () => {
    const badge: Hast = {
      type: "element",
      tagName: "img",
      properties: { alt: "P1", src: "https://greptile-static-assets.s3.amazonaws.com/badges/p1.svg" },
      children: [],
    };
    const out = runHarden(link("#", [badge]));

    expect(text(out)).toBe("");
    expect(out.children?.[0]?.children?.[0]).toMatchObject({ tagName: "img" });
  });

  it("leaves a relative path as its own text", () => {
    const out = runHarden(link("src/lib/pr.ts", [{ type: "text", value: "src/lib/pr.ts" }]));

    expect(text(out)).toBe("src/lib/pr.ts");
    expect(out.children?.[0]?.tagName).toBe("span");
  });

  it("keeps a real link a link", () => {
    const out = runHarden(link("https://example.com/x", [{ type: "text", value: "x" }]));

    expect(out.children?.[0]).toMatchObject({
      tagName: "a",
      properties: { href: "https://example.com/x", target: "_blank" },
    });
  });
});
