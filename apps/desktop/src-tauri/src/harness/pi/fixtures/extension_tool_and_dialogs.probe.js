export default function (pi) {
  pi.registerTool({
    name: "probe_tool",
    description: "A probe tool registered by an extension. Call it when asked.",
    parameters: {
      type: "object",
      properties: { note: { type: "string" } },
      required: ["note"],
    },
    async execute(args) {
      return { output: `probe_tool ran with note=${args?.note}` };
    },
  });

  pi.on("tool_call", async (event, ctx) => {
    if (event.toolName !== "probe_tool") return;

    ctx.ui.setStatus("dray-probe", "probing");
    ctx.ui.notify("a notify from the probe extension", "info");

    const picked = await ctx.ui.select("Allow probe_tool?", [
      "Allow once",
      "Allow always",
      "Deny",
    ]);
    const confirmed = await ctx.ui.confirm("Confirm?", "Really run probe_tool?");
    const typed = await ctx.ui.input("Name it", "a placeholder");

    ctx.ui.notify(
      `select=${picked} confirm=${confirmed} input=${typed}`,
      "info",
    );
  });
}
