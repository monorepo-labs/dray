import { deleteMachine, route } from "@/lib/cloud/cloud";

export const runtime = "nodejs";

export const DELETE = route(
  "client",
  async (_req, _secrets, ctx: { params: Promise<{ id: string }> }) =>
    deleteMachine((await ctx.params).id),
);
