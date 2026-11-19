import { apnsPayload, callerOf, deliver, overLimit, pushReady, readAlert, tokenGone, unseal } from "@/lib/push";

/// A Dray server sends one alert to one phone. The text passes straight
/// through to APNs and is never stored or logged.
///
/// 410 tells the server to forget the handle: one this relay cannot read, or a
/// token APNs says is gone. 429 is the rate limit, per phone and per caller.
export async function POST(req: Request) {
  if (!pushReady()) return Response.json({ error: "push_off" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const alert = body && readAlert(body);
  if (!alert || typeof body.handle !== "string") return Response.json({ error: "invalid_request" }, { status: 400 });
  const phone = unseal(body.handle);
  if (!phone) return Response.json({ gone: true }, { status: 410 });

  if (
    (await overLimit(`send:${callerOf(req)}`, 120, 60)) ||
    (await overLimit(`phone:${phone.token}`, 30, 60)) ||
    (await overLimit(`phone:${phone.token}`, 300, 3600))
  )
    return Response.json({ error: "slow_down" }, { status: 429 });

  // A Done replaces the last one for its chat; an ask is one alert per request.
  const sent = await deliver(phone.token, phone.env, apnsPayload(alert), (alert.request ?? `done-${alert.session}`).slice(0, 64));
  if (sent.status === 200) return Response.json({ ok: true });
  if (tokenGone(sent.status, sent.reason)) return Response.json({ gone: true }, { status: 410 });
  console.error(`[push] APNs ${sent.status} ${sent.reason ?? ""}`);
  return Response.json({ error: sent.reason ?? "apns_failed" }, { status: 502 });
}
