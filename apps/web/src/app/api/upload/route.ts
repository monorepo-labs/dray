import { callerOf, overLimit } from "@/lib/rate";
import { keyFor, MAX_BYTES, putObject, r2FromEnv, sniff } from "@/lib/upload";

export const runtime = "nodejs";

/// One image for a PR body (#1477), sent as the raw request body with the
/// caller's GitHub token as a bearer. The token is checked against GitHub and
/// dropped: never stored, logged or passed anywhere else. Answers the public URL.
///
/// 401 a token GitHub refuses, 413 too big, 415 not an image, 429 the rate
/// limit, 503 no bucket configured.
export async function POST(req: Request) {
  const r2 = r2FromEnv();
  if (!r2) return Response.json({ error: "uploads_off" }, { status: 503 });
  const token = req.headers.get("authorization")?.match(/^Bearer\s+(\S+)$/i)?.[1];
  if (!token) return Response.json({ error: "github_token_required" }, { status: 401 });
  const declared = Number(req.headers.get("content-length") ?? NaN);
  if (declared > MAX_BYTES) return tooBig();

  // Before GitHub hears of it, so a flood of bad tokens costs this site's GitHub budget nothing.
  if (await overLimit(`upload-ip:${callerOf(req)}`, 120, 3600)) return slowDown();
  const user = await githubUser(token);
  if (user === "refused") return Response.json({ error: "github_token_invalid" }, { status: 401 });
  if (user === "unreachable") return Response.json({ error: "github_unreachable" }, { status: 502 });
  if ((await overLimit(`upload:${user.id}`, 30, 3600)) || (await overLimit(`upload:${user.id}`, 200, 86400)))
    return slowDown();

  const body = await readCapped(req, MAX_BYTES);
  if (body === "too_big") return tooBig();
  const kind = body && sniff(body);
  if (!kind) return Response.json({ error: "not_an_image", accepted: ["png", "jpg", "gif", "webp"] }, { status: 415 });

  const key = keyFor(body, kind);
  const put = await putObject(r2, key, body, kind.type, { "github-id": String(user.id) });
  if (!put.ok) {
    console.error(`[upload] storage answered ${put.status}`);
    return Response.json({ error: "storage_failed" }, { status: 502 });
  }
  return Response.json({ url: `${r2.publicUrl}/${key}`, type: kind.type, size: body.length });
}

const tooBig = () => Response.json({ error: "too_large", max_bytes: MAX_BYTES }, { status: 413 });
const slowDown = () => Response.json({ error: "slow_down" }, { status: 429 });

/// Who GitHub says holds `token`. `GITHUB_API_ORIGIN` points it at a stand-in,
/// for tests. A token for an Actions run (`ghs_…`) is refused here: it is no user.
async function githubUser(token: string): Promise<{ id: number } | "refused" | "unreachable"> {
  try {
    const res = await fetch(`${process.env.GITHUB_API_ORIGIN || "https://api.github.com"}/user`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "dray-upload",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      cache: "no-store",
      signal: AbortSignal.timeout(10_000),
    });
    if (res.status === 401 || res.status === 403) return "refused";
    if (!res.ok) return "unreachable";
    const id = ((await res.json()) as { id?: unknown }).id;
    return typeof id === "number" ? { id } : "unreachable";
  } catch {
    return "unreachable";
  }
}

/// The request body, stopped as soon as it passes `max` so a lying or absent
/// Content-Length never has more than that held in memory.
async function readCapped(req: Request, max: number): Promise<Uint8Array<ArrayBuffer> | null | "too_big"> {
  if (!req.body) return null;
  const parts: Uint8Array[] = [];
  let size = 0;
  const reader = req.body.getReader();
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.length;
    if (size > max) {
      await reader.cancel().catch(() => {});
      return "too_big";
    }
    parts.push(value);
  }
  return size ? Buffer.concat(parts) : null;
}
