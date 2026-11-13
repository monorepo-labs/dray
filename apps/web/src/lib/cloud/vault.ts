import { createCipheriv, createDecipheriv, createHmac, randomBytes, timingSafeEqual } from "node:crypto";

/// Per-user secrets at rest (#1013): AES-256-GCM under `DRAY_VAULT_KEY`, 32
/// bytes in base64. Local dev and drayhq.com share one database, so they share
/// this key too. No `@/` imports, so `node --test` can load this file as is.

const VERSION = "v1";

function key(): Buffer {
  const raw = process.env.DRAY_VAULT_KEY ?? "";
  const key = Buffer.from(raw, "base64");
  if (key.length !== 32) throw new Error("DRAY_VAULT_KEY must be 32 bytes in base64");
  return key;
}

const b64 = (b: Buffer) => b.toString("base64url");
const unb64 = (s: string) => Buffer.from(s, "base64url");

/// Seals `plain` for one owner and purpose. `bound` is authenticated, not
/// stored, so a value copied onto another user's row fails to open there.
export function seal(plain: string, bound: string): string {
  const iv = randomBytes(12);
  const cipher = createCipheriv("aes-256-gcm", key(), iv);
  cipher.setAAD(Buffer.from(bound));
  const body = Buffer.concat([cipher.update(plain, "utf8"), cipher.final()]);
  return [VERSION, b64(iv), b64(body), b64(cipher.getAuthTag())].join(".");
}

/// Opens what `seal` made under the same `bound`. Throws on any tampering, a
/// wrong key or a wrong owner.
export function open(sealed: string, bound: string): string {
  const [version, iv, body, tag] = sealed.split(".");
  if (version !== VERSION || !iv || !body || !tag) throw new Error("not a sealed value");
  const decipher = createDecipheriv("aes-256-gcm", key(), unb64(iv));
  decipher.setAAD(Buffer.from(bound));
  decipher.setAuthTag(unb64(tag));
  return Buffer.concat([decipher.update(unb64(body)), decipher.final()]).toString("utf8");
}

/// A signed, readable token: `claims` in the clear, an HMAC over them. For
/// values that must round-trip through a browser or a machine's disk without
/// a row of their own — the install `state`, a machine's credential.
export function sign(claims: object, secret: string, prefix: string): string {
  const body = b64(Buffer.from(JSON.stringify(claims)));
  const mac = createHmac("sha256", secret).update(`${prefix}.${body}`).digest();
  return `${prefix}.${body}.${b64(mac)}`;
}

/// The claims of a `sign`ed token, or null where the prefix, signature or
/// shape is wrong. The caller checks expiry and meaning.
export function verify<T>(token: string, secret: string, prefix: string): T | null {
  const [p, body, mac] = token.split(".");
  if (p !== prefix || !body || !mac) return null;
  const want = createHmac("sha256", secret).update(`${prefix}.${body}`).digest();
  const got = unb64(mac);
  if (got.length !== want.length || !timingSafeEqual(got, want)) return null;
  try {
    return JSON.parse(unb64(body).toString("utf8")) as T;
  } catch {
    return null;
  }
}
