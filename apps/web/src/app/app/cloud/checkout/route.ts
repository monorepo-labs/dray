import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { originOf } from "@/lib/cloud/account";
import { checkoutUrl } from "@/lib/cloud/lanes";
import { isPlanId } from "@/lib/cloud/plans";

export const dynamic = "force-dynamic";

/// A pricing page's Choose button: sign in if need be, then on to Stripe
/// Checkout for that plan. A GET, so sign-in's `next` can bring the reader
/// straight back here; it only makes a Checkout session, which costs nothing.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const plan = url.searchParams.get("plan");
  if (!isPlanId(plan)) redirect("/cloud");
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) redirect(`/login?next=${encodeURIComponent(`/app/cloud/checkout?plan=${plan}`)}`);
  const origin = originOf(req.headers, url.origin);
  const to = await checkoutUrl(session.user.id, plan, `${origin}/app/cloud?chose=${plan}`);
  redirect(to ?? `/app/cloud?billing=soon`);
}
