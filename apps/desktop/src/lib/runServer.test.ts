import { describe, expect, it } from "vitest";

import { RUN_SERVER_PROMPT } from "./runServer";

describe("RUN_SERVER_PROMPT", () => {
  // The clause the button rests on. Without it the CLI runs the server in a
  // foreground Bash, which times out and kills the thing it just started.
  it("asks for the background", () => {
    expect(RUN_SERVER_PROMPT).toContain("in the background");
  });

  // Vague on purpose: the agent picks the server by reading the repo, and
  // anything named here is a spec that is wrong for some other stack.
  it("names no command, port or URL", () => {
    expect(RUN_SERVER_PROMPT).not.toMatch(/localhost|https?:|pnpm|npm|yarn|cargo|:\d/);
  });
});
