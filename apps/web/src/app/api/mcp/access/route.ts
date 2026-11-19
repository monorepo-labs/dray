import { bearer, serverForToken } from "@/lib/link";
import { mayConnect } from "@/lib/mcp";

/// A server asks whether someone who signed an assistant in may still use it.
/// It asks on every MCP call, so taking someone off the allow list, or out of
/// the org, cuts their assistants off at once. A 401 means the server itself
/// was unlinked.
export async function POST(req: Request) {
  const token = bearer(req);
  const server = token ? await serverForToken(token) : null;
  if (!server) return Response.json({ error: "invalid_token" }, { status: 401 });
  const body = (await req.json().catch(() => null)) as { userId?: unknown } | null;
  if (typeof body?.userId !== "string") return Response.json({ error: "invalid_request" }, { status: 400 });
  return Response.json({ allowed: await mayConnect(server.id, body.userId) });
}
