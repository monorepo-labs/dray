import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { parseChangelog } from "../src/lib/changelog.ts";

/// The changelog parser, run on Node's own type stripping. Run with
/// `node --test test/changelog.test.mjs` from apps/web.

const md = `## 0.40.0 · 2026-12-01 · notify

### New

- **Bot routines.** A bot schedules its own checks.
  ![Routines](changelog/routines.mp4)
  <!-- highlight: desktop, ios · action: Set up a bot → new-bot -->
- **Push alerts.** On your phone.
  <!-- highlight: ios android -->
- A plain one-liner.
`;

test("reads a highlight's apps and action, and keeps it out of the text", () => {
  const [items] = parseChangelog(md, "https://x").map((r) => r.sections[0].items);
  assert.deepEqual(items[0], {
    title: "Bot routines",
    body: "A bot schedules its own checks.",
    media: [{ kind: "video", url: "https://x/changelog/routines.mp4", alt: "Routines" }],
    highlight: { apps: ["desktop", "ios"], action: { label: "Set up a bot", target: "new-bot" } },
  });
  assert.deepEqual(items[1].highlight, { apps: ["ios", "android"], action: null });
  assert.equal(items[1].body, "On your phone.");
  assert.equal(items[2].highlight, null);
});

test("takes -> for the arrow and an https target", () => {
  const out = parseChangelog(
    "## 1.0.0\n### New\n- **X.** Y.\n  <!-- highlight: desktop · action: Read more -> https://drayhq.com/docs -->\n",
  );
  assert.deepEqual(out[0].sections[0].items[0].highlight?.action, {
    label: "Read more",
    target: "https://drayhq.com/docs",
  });
});

test("refuses a highlight it cannot read", () => {
  const bad = (h) => () => parseChangelog(`## 1.0.0\n### New\n- **X.** Y.\n  <!-- highlight${h} -->\n`);
  assert.throws(bad(""), /no app named/);
  assert.throws(bad(": mac"), /unknown app "mac"/);
  assert.throws(bad(": desktop · action: Go"), /action reads/);
  assert.throws(bad(": desktop · action: Go → Settings/Bots"), /bad action target/);
});

test("the real CHANGELOG.md parses", () => {
  const releases = parseChangelog(readFileSync(new URL("../../desktop/CHANGELOG.md", import.meta.url), "utf8"));
  assert.ok(releases.length > 0);
});
