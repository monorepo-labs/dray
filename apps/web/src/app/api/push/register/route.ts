import { callerOf, overLimit, pushReady, seal } from "@/lib/push";

/// The phone trades its APNs token for a sealed handle, the only thing it
/// gives a server. Open to anyone, which costs nothing: a handle reaches only
/// the token sealed in it, and only on Dray's own topic.
export async function POST(req: Request) {
  if (!pushReady()) return Response.json({ error: "push_off" }, { status: 503 });
  const body = (await req.json().catch(() => null)) as { token?: unknown; env?: unknown } | null;
  const token = typeof body?.token === "string" ? body.token.toLowerCase() : "";
  const env = body?.env;
  if (!/^[0-9a-f]{64,200}$/.test(token) || (env !== "sandbox" && env !== "production"))
    return Response.json({ error: "invalid_request" }, { status: 400 });
  if (await overLimit(`register:${callerOf(req)}`, 30, 3600))
    return Response.json({ error: "slow_down" }, { status: 429 });
  return Response.json({ handle: seal(token, env) });
}
