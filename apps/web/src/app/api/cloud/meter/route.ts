import { timingSafeEqual } from "node:crypto";

import { sweep } from "@/lib/cloud/cloud";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/// The metering sweep, run by Vercel cron (`vercel.json`), which sends
/// `CRON_SECRET` as the bearer. 404 while either secret is unset, like every
/// other cloud route.
export async function GET(req: Request) {
  const secret = process.env.CRON_SECRET;
  if (!secret || !process.env.DRAY_CLOUD_KEY) return new Response(null, { status: 404 });
  const got = Buffer.from(req.headers.get("authorization") ?? "");
  const want = Buffer.from(`Bearer ${secret}`);
  if (got.length !== want.length || !timingSafeEqual(got, want)) {
    return Response.json({ error: "unauthorized" }, { status: 401 });
  }
  return Response.json(await sweep());
}
