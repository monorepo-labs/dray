// Probe: does an extension's `tool_call` hook plus `ctx.ui.confirm` give a
// working approval gate over RPC? This is the shape Dray would ship.
export default function (pi: any) {
  pi.on("tool_call", async (event: any, ctx: any) => {
    const ok = await ctx.ui.confirm(
      `Allow ${event.toolName}?`,
      JSON.stringify(event.input),
    );
    if (!ok) {
      return { block: true, reason: "Denied by Dray" };
    }
  });
}
