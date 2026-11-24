import { describe, expect, it } from "vitest";

import { spellChips } from "./chipCopy";

describe("spellChips", () => {
  it("copies a chip as the path it stands for", () => {
    const text = "Changed @Footer.js:12 and @fx today.";
    expect(
      spellChips(text, [
        { face: "@Footer.js:12", text: "src/Footer.js:12" },
        { face: "@fx", text: "/home/user/.local/bin/fx" },
      ]),
    ).toBe("Changed src/Footer.js:12 and /home/user/.local/bin/fx today.");
  });

  it("spells two chips of one face in order", () => {
    expect(
      spellChips("@a.ts then @a.ts", [
        { face: "@a.ts", text: "/x/a.ts" },
        { face: "@a.ts", text: "/y/a.ts" },
      ]),
    ).toBe("/x/a.ts then /y/a.ts");
  });

  it("leaves text with no chip alone", () => {
    expect(spellChips("ssh -t /a/fx", [])).toBe("ssh -t /a/fx");
  });
});
