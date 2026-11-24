import { deliverFcm, fcmTokenGone } from "@/lib/fcm";
import { apnsPayload, deliver, pushReady, readAlert, tokenGone, unseal } from "@/lib/push";
import { callerOf, overLimit } from "@/lib/rate";

/// A Dray server sends one alert to one phone. The text passes straight
/// through to APNs or FCM and is never stored or logged.
///
/// 410 tells the server to forget the handle: one this relay cannot read, or a
/// token APNs or FCM says is gone. 429 is the rate limit, per phone and per caller.
export async function POST(req: Request) {
  const body = (await req.json().catch(() => null)) as Record<string, unknown> | null;
  const alert = body && readAlert(body);
  if (!alert || typeof body.handle !== "string") return Response.json({ error: "invalid_request" }, { status: 400 });
  const phone = unseal(body.handle);
  if (!phone) return Response.json({ gone: true }, { status: 410 });
  if (!pushReady(phone.platform)) return Response.json({ error: "push_off" }, { status: 503 });

  if (
    (await overLimit(`send:${callerOf(req)}`, 120, 60)) ||
    (await overLimit(`phone:${phone.token}`, 30, 60)) ||
    (await overLimit(`phone:${phone.token}`, 300, 3600))
  )
    return Response.json({ error: "slow_down" }, { status: 429 });

  // A Done or a Ready to merge replaces the last of its kind for its chat; an ask is one alert per request.
  const tag = (alert.request ?? `${alert.kind}-${alert.session}`).slice(0, 64);
  const sent =
    phone.platform === "fcm"
      ? await deliverFcm(phone.token, alert, tag)
      : await deliver(phone.token, phone.env, apnsPayload(alert), tag);
  if (sent.status === 200) return Response.json({ ok: true });
  const gone = phone.platform === "fcm" ? fcmTokenGone(sent.status, sent.reason) : tokenGone(sent.status, sent.reason);
  if (gone) return Response.json({ gone: true }, { status: 410 });
  console.error(`[push] ${phone.platform} ${sent.status} ${sent.reason ?? ""}`);
  return Response.json({ error: sent.reason ?? "push_failed" }, { status: 502 });
}
