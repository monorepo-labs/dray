import { origin, route, resumeMachine } from "@/lib/cloud/cloud";

export const runtime = "nodejs";

export const POST = route(
  "client",
  async (req, _secrets, ctx: { params: Promise<{ id: string }> }) =>
    resumeMachine((await ctx.params).id, origin(req)),
);
