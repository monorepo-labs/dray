import { redirect } from "next/navigation";

import { auth } from "@/lib/auth";
import { originOf } from "@/lib/cloud/account";
import { billingPortalUrl } from "@/lib/cloud/lanes";

export const dynamic = "force-dynamic";

/// Manage billing: Stripe's customer portal. Made per click, since a portal
/// session's URL lives minutes.
export async function GET(req: Request) {
  const session = await auth.api.getSession({ headers: req.headers });
  if (!session) redirect(`/login?next=${encodeURIComponent("/app/cloud/billing")}`);
  const origin = originOf(req.headers, new URL(req.url).origin);
  const to = await billingPortalUrl(session.user.id, `${origin}/app/cloud`);
  redirect(to ?? "/app/cloud?billing=soon");
}
