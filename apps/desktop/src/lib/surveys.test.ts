import { beforeEach, describe, expect, it, vi } from "vitest";

// Both of this module's dependencies are faked, and only they are: whether to
// start is decided in Rust and the SDK is somebody else's.
const identity = vi.fn();
vi.mock("@/lib/transport", () => ({ invoke: () => identity() }));

const posthog = { init: vi.fn() };
vi.mock("posthog-js", () => ({ default: posthog }));

const allowed = {
  key: "phc_test",
  host: "https://us.i.posthog.com",
  distinctId: "2f1c",
  personProperties: { source: "app" },
};

beforeEach(() => {
  identity.mockReset();
  posthog.init.mockReset();
});

describe("startSurveys", () => {
  it("starts nothing where Rust refuses", async () => {
    identity.mockResolvedValue(null);

    await (await import("./surveys")).startSurveys();

    expect(posthog.init).not.toHaveBeenCalled();
  });

  it("joins the person Rust already posts as", async () => {
    identity.mockResolvedValue(allowed);

    await (await import("./surveys")).startSurveys();

    expect(posthog.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({ bootstrap: { distinctID: "2f1c" } }),
    );
  });
});
