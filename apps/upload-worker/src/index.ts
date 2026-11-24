import { contributes, REPO } from "./contributor";
import { bearer, HEAD_BYTES, keyFor, MAX_BYTES, sniff } from "./files";
import { Limiter, type Window } from "./limiter";

export { Limiter };

export interface Env {
  BUCKET: R2Bucket;
  LIMITER: DurableObjectNamespace<Limiter>;
  /// Where the bucket is served publicly; each answer's URL is this plus the key.
  PUBLIC_URL: string;
  /// A stand-in for api.github.com, for tests. Unset in production.
  GITHUB_API_ORIGIN?: string;
  /// Dray's own token, a secret, for asking GitHub whether a caller
  /// contributes. Unset, nobody can upload.
  GITHUB_LOOKUP_TOKEN?: string;
}

const DOCS = `https://github.com/${REPO}/blob/main/CONTRIBUTING.md#screenshots-and-videos`;
const NOT_A_CONTRIBUTOR = `Uploads are for Dray contributors: collaborators of ${REPO}, members of its org, and authors of an open pull request there. Open your PR first, then upload.`;
const ACCEPTED = ["png", "jpg", "gif", "webp", "mp4", "webm", "mov"];
const PER_ADDRESS: Window[] = [{ max: 120, secs: 3600 }];
const PER_USER: Window[] = [
  { max: 30, secs: 3600 },
  { max: 200, secs: 86400 },
];

export default {
  /// One file for a Dray PR body (#1477, #1479), sent as the raw request body
  /// with the caller's GitHub token as a bearer. The token only says who is
  /// calling and is then dropped: never stored, logged or passed anywhere
  /// else. Whether they contribute is asked with Dray's own token (#1501).
  /// Answers the public URL.
  ///
  /// 401 a token GitHub refuses, 403 not a Dray contributor, 411 no
  /// Content-Length, 413 too big, 415 not a type taken, 429 the rate limit,
  /// 503 no public URL or lookup token configured, or the lookup token refused.
  async fetch(req: Request, env: Env): Promise<Response> {
    const path = new URL(req.url).pathname;
    if (path !== "/") return json({ error: "not_found" }, 404);
    if (req.method === "GET") return Response.redirect(DOCS, 302);
    if (req.method !== "POST") return json({ error: "method_not_allowed" }, 405, { Allow: "POST" });

    const publicUrl = (env.PUBLIC_URL ?? "").replace(/\/+$/, "");
    if (!publicUrl || !env.GITHUB_LOOKUP_TOKEN) return json({ error: "uploads_off" }, 503);
    const token = bearer(req.headers.get("authorization"));
    if (!token) return json({ error: "github_token_required" }, 401);
    // The write streams straight to R2, which wants the length up front.
    const length = Number(req.headers.get("content-length") ?? NaN);
    if (!Number.isSafeInteger(length) || length < 0) return json({ error: "length_required" }, 411);
    if (length > MAX_BYTES) return tooBig(MAX_BYTES);

    // Before GitHub hears of it, so a flood of bad tokens costs nothing there.
    const address = req.headers.get("cf-connecting-ip") ?? "unknown";
    if (await overLimit(env, `address:${address}`, PER_ADDRESS)) return slowDown();
    const user = await githubUser(token, env.GITHUB_API_ORIGIN);
    if (user === "refused") return json({ error: "github_token_invalid" }, 401);
    if (user === "unreachable") return json({ error: "github_unreachable" }, 502);
    // Counted before the lookup, so a stranger retrying costs our token little.
    if (await overLimit(env, `user:${user.id}`, PER_USER)) return slowDown();
    const verdict = await contributes(user, env.GITHUB_LOOKUP_TOKEN, env.GITHUB_API_ORIGIN || undefined);
    if (verdict === "stranger") return json({ error: "not_a_contributor", message: NOT_A_CONTRIBUTOR }, 403);
    if (verdict === "unreachable") return json({ error: "github_unreachable" }, 502);
    if (verdict === "lookup_refused") {
      console.error("[upload] GitHub refused the lookup token; renew GITHUB_LOOKUP_TOKEN");
      return json({ error: "contributor_check_failed" }, 503);
    }

    const reader = req.body?.getReader();
    const head = reader ? await readHead(reader, HEAD_BYTES) : [];
    const kind = sniff(concat(head));
    if (!kind) {
      if (reader) await drain(reader);
      return json({ error: "not_accepted", accepted: ACCEPTED }, 415);
    }
    if (length > kind.maxBytes) {
      if (reader) await drain(reader);
      return tooBig(kind.maxBytes);
    }

    const key = keyFor(kind);
    const body = new FixedLengthStream(length);
    const writer = body.writable.getWriter();
    const pump = (async () => {
      for (const chunk of head) await writer.write(chunk);
      for (;;) {
        const { done, value } = await reader!.read();
        if (done) break;
        await writer.write(value);
      }
      await writer.close();
    })().catch(async (e) => {
      // Or the write below waits forever on bytes that are not coming.
      await writer.abort(e).catch(() => {});
      throw e;
    });
    const put = env.BUCKET.put(key, body.readable, {
      httpMetadata: {
        contentType: kind.type,
        // The key is never reused, so its bytes never change.
        cacheControl: "public, max-age=31536000, immutable",
      },
      customMetadata: { "github-id": String(user.id) },
    });
    const [sent, stored] = await Promise.allSettled([pump, put]);
    if (sent.status === "rejected") return json({ error: "body_incomplete" }, 400);
    if (stored.status === "rejected") {
      console.error(`[upload] storage failed: ${stored.reason}`);
      return json({ error: "storage_failed" }, 502);
    }
    return json({ url: `${publicUrl}/${key}`, type: kind.type, size: length });
  },
} satisfies ExportedHandler<Env>;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });
const tooBig = (max: number) => json({ error: "too_large", max_bytes: max }, 413);
const slowDown = () => json({ error: "slow_down" }, 429);

/// Counts one call against `name` and answers whether it is over a limit.
function overLimit(env: Env, name: string, windows: Window[]): Promise<boolean> {
  return env.LIMITER.get(env.LIMITER.idFromName(name)).hit(windows);
}

/// Who GitHub says holds `token`. A token for an Actions run (`ghs_…`) is
/// refused here: it is no user.
async function githubUser(
  token: string,
  origin?: string,
): Promise<{ id: number; login: string } | "refused" | "unreachable"> {
  try {
    const res = await fetch(`${origin || "https://api.github.com"}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "dray-upload",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return "refused";
    if (!res.ok) return "unreachable";
    const { id, login } = (await res.json()) as { id?: unknown; login?: unknown };
    return typeof id === "number" && typeof login === "string" ? { id, login } : "unreachable";
  } catch {
    return "unreachable";
  }
}

/// Chunks off the front of the body until at least `want` bytes, or all of it.
async function readHead(reader: ReadableStreamDefaultReader<Uint8Array>, want: number): Promise<Uint8Array[]> {
  const chunks: Uint8Array[] = [];
  let size = 0;
  while (size < want) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    size += value.length;
  }
  return chunks;
}

/// Reads the rest of a refused body and drops it, so the answer goes out on a
/// connection that is still whole. A body cancelled, or merely left, once read
/// from has workerd close the socket with the upload still arriving: the client
/// gets a reset instead of the answer. Bounded by the `MAX_BYTES` check.
async function drain(reader: ReadableStreamDefaultReader<Uint8Array>): Promise<void> {
  try {
    while (!(await reader.read()).done);
  } catch {}
}

function concat(chunks: Uint8Array[]): Uint8Array {
  const out = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
  let at = 0;
  for (const c of chunks) {
    out.set(c, at);
    at += c.length;
  }
  return out;
}
