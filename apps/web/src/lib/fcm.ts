import { createPrivateKey, sign } from "node:crypto";

import type { Alert } from "./push";

/// The Android half of the push relay: FCM's HTTP v1 API, signed in as the
/// Firebase project's service account. `FCM_SERVICE_ACCOUNT` is the key file
/// Firebase hands out, whole, as JSON or base64 of it.

type Account = { project_id: string; client_email: string; private_key: string; token_uri?: string };

function account(): Account {
  const raw = (process.env.FCM_SERVICE_ACCOUNT ?? "").trim();
  return JSON.parse(raw.startsWith("{") ? raw : Buffer.from(raw, "base64").toString());
}

let held: { token: string; until: number } | null = null;

/// An OAuth access token for FCM, from a JWT the service account signs. Google
/// gives an hour; it is renewed ten minutes early.
async function accessToken(): Promise<string> {
  const now = Math.floor(Date.now() / 1000);
  if (held && now < held.until) return held.token;
  const a = account();
  const tokenUri = a.token_uri || "https://oauth2.googleapis.com/token";
  const part = (o: object) => Buffer.from(JSON.stringify(o)).toString("base64url");
  const unsigned = `${part({ alg: "RS256", typ: "JWT" })}.${part({
    iss: a.client_email,
    scope: "https://www.googleapis.com/auth/firebase.messaging",
    aud: tokenUri,
    iat: now,
    exp: now + 3600,
  })}`;
  const key = createPrivateKey(a.private_key.replace(/\\n/g, "\n"));
  const jwt = `${unsigned}.${sign("sha256", Buffer.from(unsigned), key).toString("base64url")}`;
  const res = await fetch(tokenUri, {
    method: "POST",
    headers: { "Content-Type": "application/x-www-form-urlencoded" },
    body: new URLSearchParams({ grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer", assertion: jwt }),
  });
  const body = (await res.json().catch(() => ({}))) as { access_token?: string; expires_in?: number };
  if (!res.ok || !body.access_token) throw new Error(`token exchange answered ${res.status}`);
  held = { token: body.access_token, until: now + Math.max(60, (body.expires_in ?? 3600) - 600) };
  return held.token;
}

/// The FCM message: data alone, never a `notification` block, so the app
/// draws every alert itself — its actions, and nothing for the chat on screen.
/// FCM takes only strings in `data`, so the alert rides as one JSON string,
/// the same object an iPhone reads under `dray`. `tag` is what a newer alert
/// replaces on the phone.
export function fcmMessage(token: string, a: Alert, tag: string): object {
  const { title, body, ...dray } = a;
  return {
    message: {
      token,
      data: { title, body, tag, dray: JSON.stringify(dray) },
      android: { priority: "HIGH", collapse_key: tag, ttl: "86400s" },
    },
  };
}

/// Sends one alert. `FCM_ORIGIN` points every send at a stand-in, for tests.
export async function deliverFcm(token: string, a: Alert, tag: string): Promise<{ status: number; reason?: string }> {
  try {
    const origin = process.env.FCM_ORIGIN || "https://fcm.googleapis.com";
    const res = await fetch(`${origin}/v1/projects/${account().project_id}/messages:send`, {
      method: "POST",
      headers: { Authorization: `Bearer ${await accessToken()}`, "Content-Type": "application/json" },
      body: JSON.stringify(fcmMessage(token, a, tag)),
      signal: AbortSignal.timeout(10_000),
    });
    if (res.ok) return { status: 200 };
    // FCM's own reason sits in the error's details, beside Google's generic status.
    const err = ((await res.json().catch(() => ({}))) as { error?: { status?: string; details?: { errorCode?: string }[] } }).error;
    return { status: res.status, reason: err?.details?.find((d) => d.errorCode)?.errorCode ?? err?.status };
  } catch (e) {
    return { status: 0, reason: e instanceof Error ? e.message : String(e) };
  }
}

/// Whether FCM said the token is dead for good: the app was uninstalled or
/// its data cleared, or the token belongs to another Firebase project.
export function fcmTokenGone(status: number, reason?: string): boolean {
  return status === 404 || reason === "UNREGISTERED" || reason === "SENDER_ID_MISMATCH";
}
