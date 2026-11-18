import { deleteMachine, route } from "@/lib/cloud/cloud";

export const runtime = "nodejs";

export const DELETE = route(
  "client",
  async (_req, caller, ctx: { params: Promise<{ id: string }> }) =>
    deleteMachine((await ctx.params).id, caller),
);
