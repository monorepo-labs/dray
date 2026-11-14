import { cloudAccount, cloudUser, originOf } from "@/lib/cloud/account";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// The reader's Dray Cloud (#1021): plan, usage, machines, GitHub and agents.
/// The app's setup sheet asks with its own credential, the site with its
/// session. A 401 means signed out; the app shows that as the first step.
export async function GET(req: Request) {
  const user = await cloudUser(req);
  if (!user) return Response.json({ error: "unauthorized" }, { status: 401 });
  return Response.json(await cloudAccount(user, originOf(req.headers, new URL(req.url).origin)));
}
