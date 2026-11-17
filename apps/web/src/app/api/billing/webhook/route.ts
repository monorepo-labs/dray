import { syncSubscription } from "@/lib/cloud/subscriptions";
import { stripe } from "@/lib/stripe";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// Stripe's webhook. Every subscription event re-reads that subscription and
/// mirrors it onto the org's `cloud_billing` row; nothing else is listened to.
/// Signed with `STRIPE_WEBHOOK_SECRET`, checked against the raw body.
export async function POST(req: Request) {
  const s = stripe();
  const secret = process.env.STRIPE_WEBHOOK_SECRET;
  if (!s || !secret) return new Response(null, { status: 404 });
  const body = await req.text();
  let event;
  try {
    event = await s.webhooks.constructEventAsync(body, req.headers.get("stripe-signature") ?? "", secret);
  } catch {
    return Response.json({ error: "bad_signature" }, { status: 400 });
  }
  switch (event.type) {
    case "customer.subscription.created":
    case "customer.subscription.updated":
    case "customer.subscription.deleted":
    case "customer.subscription.paused":
    case "customer.subscription.resumed":
      await syncSubscription(event.data.object.id);
      break;
  }
  return Response.json({ received: true });
}
