import { machines, route, startMachine } from "@/lib/cloud/cloud";

export const runtime = "nodejs";
// Without it a GET that answers 404 before touching the request is prerendered
// at build, and stays a 404 after Dray Cloud is turned on.
export const dynamic = "force-dynamic";

export const GET = route("client", async (_req, caller) => Response.json(await machines(caller)));

export const POST = route("client", async (req, caller) => startMachine(origin(req), caller));

/// The origin the client reached, which a new machine heartbeats back to.
/// Read off the headers: Next rewrites `req.url`'s host to its own idea of it.
function origin(req: Request) {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0] ?? url.protocol.slice(0, -1);
  return `${proto}://${host}`;
}
