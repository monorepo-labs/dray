import { createCipheriv, createDecipheriv, createHash, createPrivateKey, randomBytes, sign } from "node:crypto";
import http2 from "node:http2";

import { pool } from "./db";

/// The push relay (#1299). A Dray server hands an alert here and this sends it
/// through APNs, the one place the APNs key lives. A server never sees a
/// phone's APNs token: the phone trades it here for a sealed handle, and only
/// a handle this relay sealed can be sent to.

export type PushEnv = "sandbox" | "production";

/// The iPhone app's bundle id: every push is pinned to it, so a handle can only ever reach Dray.
const TOPIC = "com.yogesh.dray.ios";

/// Whether the relay is set up at all; without these it answers 503.
export function pushReady(): boolean {
  return !!(process.env.APNS_KEY && process.env.APNS_KEY_ID && process.env.PUSH_HANDLE_SECRET);
}

function sealKey(): Buffer {
  return createHash("sha256").update(process.env.PUSH_HANDLE_SECRET ?? "").digest();
}

/// A phone's APNs token, encrypted and authenticated under the relay's own secret.
export function seal(token: string, env: PushEnv): string {
  const iv = randomBytes(12);
  const c = createCipheriv("aes-256-gcm", sealKey(), iv);
  const body = Buffer.concat([c.update(`${env === "sandbox" ? "s" : "p"}${token}`), c.final()]);
  return "dph_" + Buffer.concat([iv, body, c.getAuthTag()]).toString("base64url");
}

/// The token inside a handle, or null for one this relay did not seal.
export function unseal(handle: string): { token: string; env: PushEnv } | null {
  if (!handle.startsWith("dph_")) return null;
  const raw = Buffer.from(handle.slice(4), "base64url");
  if (raw.length < 12 + 16 + 2) return null;
  try {
    const d = createDecipheriv("aes-256-gcm", sealKey(), raw.subarray(0, 12));
    d.setAuthTag(raw.subarray(raw.length - 16));
    const text = Buffer.concat([d.update(raw.subarray(12, raw.length - 16)), d.final()]).toString();
    return { env: text[0] === "s" ? "sandbox" : "production", token: text.slice(1) };
  } catch {
    return null;
  }
}

/// Counts one call against `what` in a fixed window and answers whether it is
/// over `max`. Postgres, since a serverless instance's memory is not shared.
export async function overLimit(what: string, max: number, windowSecs: number): Promise<boolean> {
  const id = createHash("sha256").update(`${windowSecs}:${what}`).digest("hex");
  const now = Math.floor(Date.now() / 1000);
  const start = now - (now % windowSecs);
  const { rows } = await pool.query<{ count: number }>(
    `insert into push_rate (id, "windowStart", count) values ($1, $2, 1)
     on conflict (id) do update set
       count = case when push_rate."windowStart" = excluded."windowStart" then push_rate.count + 1 else 1 end,
       "windowStart" = excluded."windowStart"
     returning count`,
    [id, start],
  );
  if (Math.random() < 0.01) await pool.query(`delete from push_rate where "windowStart" < $1`, [now - 86400]);
  return rows[0].count > max;
}

/// The caller's address as Vercel's edge reports it.
export function callerOf(req: Request): string {
  return req.headers.get("x-forwarded-for")?.split(",")[0]?.trim() || "unknown";
}

let held: { jwt: string; at: number } | null = null;

/// APNs' provider token: ES256 over the team and time, good for an hour, renewed at 50 minutes.
function providerToken(): string {
  const now = Math.floor(Date.now() / 1000);
  if (held && now - held.at < 50 * 60) return held.jwt;
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "ES256", kid: process.env.APNS_KEY_ID })}.${part({
    iss: process.env.APNS_TEAM_ID || "7WYP3LRDL8",
    iat: now,
  })}`;
  // An env var often carries the .p8's newlines escaped.
  const key = createPrivateKey((process.env.APNS_KEY ?? "").replace(/\\n/g, "\n"));
  const sig = sign("sha256", Buffer.from(unsigned), { key, dsaEncoding: "ieee-p1363" }).toString("base64url");
  held = { jwt: `${unsigned}.${sig}`, at: now };
  return held.jwt;
}

const clients = new Map<string, http2.ClientHttp2Session>();

/// One HTTP/2 connection per APNs host, kept while the instance lives: APNs asks for reuse.
function client(origin: string): http2.ClientHttp2Session {
  const open = clients.get(origin);
  if (open && !open.closed && !open.destroyed) return open;
  const c = http2.connect(origin);
  c.on("error", () => clients.delete(origin));
  c.on("close", () => clients.delete(origin));
  c.unref();
  clients.set(origin, c);
  return c;
}

/// Sends one alert. `APNS_ORIGIN` points every send at a stand-in, for tests.
export function deliver(
  token: string,
  env: PushEnv,
  payload: object,
  collapseId?: string,
): Promise<{ status: number; reason?: string }> {
  const origin =
    process.env.APNS_ORIGIN || (env === "sandbox" ? "https://api.sandbox.push.apple.com" : "https://api.push.apple.com");
  return new Promise((resolve) => {
    const req = client(origin).request({
      ":method": "POST",
      ":path": `/3/device/${token}`,
      authorization: `bearer ${providerToken()}`,
      "apns-topic": TOPIC,
      "apns-push-type": "alert",
      "apns-priority": "10",
      ...(collapseId ? { "apns-collapse-id": collapseId } : {}),
    });
    let status = 0;
    let body = "";
    req.setTimeout(10_000, () => req.close(http2.constants.NGHTTP2_CANCEL));
    req.on("response", (h) => (status = Number(h[":status"])));
    req.on("data", (d) => (body += d));
    req.on("error", (e) => resolve({ status: 0, reason: e.message }));
    req.on("close", () => {
      let reason: string | undefined;
      try {
        reason = body ? JSON.parse(body).reason : undefined;
      } catch {}
      resolve({ status, reason });
    });
    req.end(JSON.stringify(payload));
  });
}

/// Whether APNs said the token is dead for good, so the server holding its handle should forget it.
export function tokenGone(status: number, reason?: string): boolean {
  return status === 410 || reason === "BadDeviceToken" || reason === "DeviceTokenNotForTopic";
}

export type Alert = {
  kind: "done" | "permission" | "question";
  /// The phone's own id for the server, echoed back so a tap opens the right chat.
  server: string;
  session: string;
  title: string;
  body: string;
  request?: string;
  allow?: string;
  deny?: string;
  question?: { text: string; options: string[]; freeText: boolean };
  bot?: { id: string; shape?: string; hue?: number };
};

const str = (v: unknown, max: number) => (typeof v === "string" ? v.slice(0, max) : undefined);

/// A server's alert as the relay will send it, every field typed and capped,
/// or null where something it needs is missing.
export function readAlert(v: Record<string, unknown>): Alert | null {
  const kind = v.kind;
  if (kind !== "done" && kind !== "permission" && kind !== "question") return null;
  const server = str(v.server, 64);
  const session = str(v.session, 128);
  if (!server || !session) return null;
  const alert: Alert = {
    kind,
    server,
    session,
    title: str(v.title, 100) || "Dray",
    body: str(v.body, 240) ?? "",
  };
  if (kind !== "done") {
    alert.request = str(v.request, 128);
    if (!alert.request) return null;
  }
  if (kind === "permission") {
    alert.allow = str(v.allow, 128);
    alert.deny = str(v.deny, 128);
  }
  const q = v.question as Record<string, unknown> | undefined;
  if (kind === "question" && q && typeof q.text === "string") {
    alert.question = {
      text: q.text.slice(0, 300),
      options: (Array.isArray(q.options) ? q.options : [])
        .filter((o): o is string => typeof o === "string")
        .slice(0, 4)
        .map((o) => o.slice(0, 60)),
      freeText: q.freeText === true,
    };
  }
  const bot = v.bot as Record<string, unknown> | undefined;
  if (bot && typeof bot.id === "string") {
    alert.bot = {
      id: bot.id.slice(0, 64),
      shape: str(bot.shape, 32),
      hue: typeof bot.hue === "number" ? bot.hue : undefined,
    };
  }
  return alert;
}

/// The APNs payload: `aps` for the system, `dray` for the app's extension and its actions.
/// `mutable-content` lets the extension put a bot's face on and a question's options in.
export function apnsPayload(a: Alert): object {
  const { kind, title, body, ...dray } = a;
  return {
    aps: {
      alert: { title, body },
      sound: "default",
      "thread-id": a.session,
      "mutable-content": 1,
      category: `dray.${kind}`,
    },
    dray: { kind, ...dray },
  };
}
