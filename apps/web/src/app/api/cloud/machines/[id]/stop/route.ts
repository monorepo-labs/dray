import { route, stopMachine } from "@/lib/cloud/cloud";

export const runtime = "nodejs";

export const POST = route(
  "client",
  async (_req, _secrets, ctx: { params: Promise<{ id: string }> }) =>
    stopMachine((await ctx.params).id),
);
