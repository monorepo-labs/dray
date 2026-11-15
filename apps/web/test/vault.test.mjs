import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { test } from "node:test";

process.env.DRAY_VAULT_KEY = randomBytes(32).toString("base64");
const { open, seal, sign, verify } = await import("../src/lib/cloud/vault.ts");

test("a sealed value opens only for the owner it was sealed for", () => {
  const sealed = seal("sk-ant-oat01-secret", "claude:user-1");
  assert.ok(!sealed.includes("secret"));
  assert.equal(open(sealed, "claude:user-1"), "sk-ant-oat01-secret");
  assert.throws(() => open(sealed, "claude:user-2"));
  const [v, iv, body, tag] = sealed.split(".");
  const flipped = Buffer.from(body, "base64url");
  flipped[0] ^= 1;
  assert.throws(() => open([v, iv, flipped.toString("base64url"), tag].join("."), "claude:user-1"));
  assert.notEqual(seal("x", "a"), seal("x", "a"), "a fresh iv every time");
});

test("a wrong or missing key refuses to seal or open", () => {
  const sealed = seal("x", "a");
  const held = process.env.DRAY_VAULT_KEY;
  process.env.DRAY_VAULT_KEY = randomBytes(32).toString("base64");
  assert.throws(() => open(sealed, "a"));
  process.env.DRAY_VAULT_KEY = "short";
  assert.throws(() => seal("x", "a"), /32 bytes/);
  process.env.DRAY_VAULT_KEY = held;
});

test("a signed token verifies under its own secret and prefix alone", () => {
  const t = sign({ u: "1" }, "s", "dmk1");
  assert.deepEqual(verify(t, "s", "dmk1"), { u: "1" });
  assert.equal(verify(t, "other", "dmk1"), null);
  assert.equal(verify(t.replace("dmk1", "dgs1"), "s", "dgs1"), null);
  assert.equal(verify("garbage", "s", "dmk1"), null);
});
