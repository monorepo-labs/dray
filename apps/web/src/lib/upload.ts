import { createHash, createHmac } from "node:crypto";

/// PR screenshot uploads (#1477): the pure half, so `test/upload.test.mjs`
/// imports it straight under Node's type stripping. Keep its imports to
/// `node:` builtins; an `@/` path breaks that.

/// The largest upload taken. Vercel refuses a function request body past
/// 4.5 MB before this code runs, so a bigger cap here would only move where
/// the refusal comes from.
export const MAX_BYTES = 4 * 1024 * 1024;

export type Kind = { ext: "png" | "jpg" | "gif" | "webp"; type: string };

/// What an upload is, read off its first bytes, or null for anything that is
/// not one of the four image formats. Never the name or the declared type: a
/// caller controls both, and SVG is left out on purpose, being a script carrier.
export function sniff(b: Uint8Array): Kind | null {
  const at = (off: number, sig: number[]) => b.length >= off + sig.length && sig.every((v, i) => b[off + i] === v);
  const ascii = (s: string) => [...s].map((c) => c.charCodeAt(0));
  if (at(0, [0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])) return { ext: "png", type: "image/png" };
  if (at(0, [0xff, 0xd8, 0xff])) return { ext: "jpg", type: "image/jpeg" };
  if (at(0, ascii("GIF87a")) || at(0, ascii("GIF89a"))) return { ext: "gif", type: "image/gif" };
  if (at(0, ascii("RIFF")) && at(8, ascii("WEBP"))) return { ext: "webp", type: "image/webp" };
  return null;
}

export type R2 = {
  endpoint: string;
  region: string;
  bucket: string;
  accessKey: string;
  secret: string;
  publicUrl: string;
};

/// The bucket, from env alone, or null while any piece is unset. `R2_ENDPOINT`
/// replaces the account's own endpoint, for a local S3 stand-in.
export function r2FromEnv(env: Record<string, string | undefined> = process.env): R2 | null {
  const account = env.R2_ACCOUNT_ID;
  const endpoint = env.R2_ENDPOINT || (account ? `https://${account}.r2.cloudflarestorage.com` : "");
  const r2 = {
    endpoint: endpoint.replace(/\/+$/, ""),
    region: env.R2_REGION || "auto",
    bucket: env.R2_BUCKET ?? "",
    accessKey: env.R2_ACCESS_KEY_ID ?? "",
    secret: env.R2_SECRET_ACCESS_KEY ?? "",
    publicUrl: (env.R2_PUBLIC_URL ?? "").replace(/\/+$/, ""),
  };
  return Object.values(r2).every(Boolean) ? r2 : null;
}

/// The object's name: its own hash, so two uploads can only ever share a key
/// by being the same bytes, and nothing can be overwritten with different ones.
export function keyFor(body: Uint8Array, kind: Kind): string {
  return `${sha256(body)}.${kind.ext}`;
}

const sha256 = (data: Uint8Array | string) => createHash("sha256").update(data).digest("hex");
const hmac = (key: Uint8Array | string, data: string) => createHmac("sha256", key).update(data).digest();

/// S3's path encoding: every byte but the unreserved set, `/` kept between segments.
function encodePath(path: string): string {
  return path
    .split("/")
    .map((seg) => encodeURIComponent(seg).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`))
    .join("/");
}

/// The SigV4 `Authorization` header for one request with no query string.
/// `headers` must already hold `x-amz-date` and `x-amz-content-sha256`; every
/// header given is signed, and `host` is added from the URL.
export function signV4(opts: {
  method: string;
  url: URL;
  headers: Record<string, string>;
  region: string;
  accessKey: string;
  secret: string;
  service?: string;
}): string {
  const service = opts.service ?? "s3";
  const headers: Record<string, string> = { host: opts.url.host };
  for (const [k, v] of Object.entries(opts.headers)) headers[k.toLowerCase()] = v.trim().replace(/\s+/g, " ");
  const names = Object.keys(headers).sort();
  const signed = names.join(";");
  const amzDate = headers["x-amz-date"];
  const day = amzDate.slice(0, 8);
  const canonical = [
    opts.method,
    encodePath(decodeURIComponent(opts.url.pathname)),
    "",
    names.map((n) => `${n}:${headers[n]}\n`).join(""),
    signed,
    headers["x-amz-content-sha256"],
  ].join("\n");
  const scope = `${day}/${opts.region}/${service}/aws4_request`;
  const toSign = ["AWS4-HMAC-SHA256", amzDate, scope, sha256(canonical)].join("\n");
  let key: Buffer = hmac(`AWS4${opts.secret}`, day);
  for (const part of [opts.region, service, "aws4_request"]) key = hmac(key, part);
  const signature = createHmac("sha256", key).update(toSign).digest("hex");
  return `AWS4-HMAC-SHA256 Credential=${opts.accessKey}/${scope}, SignedHeaders=${signed}, Signature=${signature}`;
}

/// Stores `body` at `key`, path-style, which R2 and MinIO both take. `meta`
/// lands as `x-amz-meta-*` and travels with the object, never in its URL.
export async function putObject(
  r2: R2,
  key: string,
  body: Uint8Array<ArrayBuffer>,
  type: string,
  meta: Record<string, string> = {},
): Promise<{ ok: boolean; status: number }> {
  const url = new URL(`${r2.endpoint}/${encodePath(`${r2.bucket}/${key}`)}`);
  const headers: Record<string, string> = {
    "content-type": type,
    // Content-addressed, so a key's bytes never change.
    "cache-control": "public, max-age=31536000, immutable",
    "x-amz-content-sha256": sha256(body),
    "x-amz-date": new Date().toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, ""),
  };
  for (const [k, v] of Object.entries(meta)) headers[`x-amz-meta-${k}`] = v;
  const authorization = signV4({ method: "PUT", url, headers, region: r2.region, accessKey: r2.accessKey, secret: r2.secret });
  const res = await fetch(url, {
    method: "PUT",
    headers: { ...headers, authorization },
    body,
    signal: AbortSignal.timeout(30_000),
  });
  await res.arrayBuffer().catch(() => {});
  return { ok: res.ok, status: res.status };
}
