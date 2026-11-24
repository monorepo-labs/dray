import { callerOf, overLimit } from "@/lib/rate";
import { type Phone, pushReady, seal } from "@/lib/push";

/// The phone trades its push token for a sealed handle, the only thing it
/// gives a server: an iPhone's APNs token with its environment, or an Android
/// phone's FCM token with `platform: "android"`. Open to anyone, which costs
/// nothing: a handle reaches only the token sealed in it, and only Dray's app.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as { token?: unknown; env?: unknown; platform?: unknown } | null;
  const phone = readPhone(body);
  if (!phone) return Response.json({ error: "invalid_request" }, { status: 400 });
  if (!pushReady(phone.platform)) return Response.json({ error: "push_off" }, { status: 503 });
  if (await overLimit(`register:${callerOf(req)}`, 30, 3600))
    return Response.json({ error: "slow_down" }, { status: 429 });
  return Response.json({ handle: seal(phone) });
}

/// An iPhone sends hex and its environment; an FCM token is base64url with a colon, and has no environment.
function readPhone(body: { token?: unknown; env?: unknown; platform?: unknown } | null): Phone | null {
  if (typeof body?.token !== "string") return null;
  if (body.platform === "android")
    return /^[A-Za-z0-9_:-]{100,400}$/.test(body.token) ? { platform: "fcm", token: body.token } : null;
  const token = body.token.toLowerCase();
  const env = body.env;
  if (!/^[0-9a-f]{64,200}$/.test(token) || (env !== "sandbox" && env !== "production")) return null;
  return { platform: "apns", token, env };
}
