import { beforeEach, describe, expect, it, vi } from "vitest";

// Both of this module's dependencies are faked, and only they are: consent is
// decided in Rust and the SDK is somebody else's, so the rules under test are
// the ordering ones this module adds between them.
const identity = vi.fn();
vi.mock("@tauri-apps/api/core", () => ({ invoke: () => identity() }));

const posthog = { init: vi.fn(), opt_in_capturing: vi.fn(), opt_out_capturing: vi.fn() };
vi.mock("posthog-js", () => ({ default: posthog }));

const consented = {
  key: "phc_test",
  host: "https://us.i.posthog.com",
  distinctId: "2f1c",
  personProperties: { source: "app" },
};

// The module keeps `started` and `generation` for the life of the process, so
// each case needs its own copy of it.
const load = async () => (await import("./surveys")).startSurveys;

beforeEach(() => {
  vi.resetModules();
  identity.mockReset();
  posthog.init.mockReset();
  posthog.opt_in_capturing.mockReset();
  posthog.opt_out_capturing.mockReset();
});

describe("startSurveys", () => {
  it("starts nothing where the install has opted out", async () => {
    identity.mockResolvedValue(null);

    await (await load())();

    expect(posthog.init).not.toHaveBeenCalled();
  });

  it("joins the person Rust already posts as", async () => {
    identity.mockResolvedValue(consented);

    await (await load())();

    expect(posthog.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({ bootstrap: { distinctID: "2f1c" } }),
    );
  });

  /// The whole reason `generation` exists. The startup call is fire-and-forget,
  /// so it can still be waiting on its own read when the reader opts out and
  /// the settings toggle makes a second one — and the answers can land in
  /// either order. An older answer landing last must not start the SDK under
  /// an identity consent has since withdrawn.
  it("refuses an identity a later read has already overruled", async () => {
    const startSurveys = await load();

    let answerStartup: (value: unknown) => void = () => {};
    identity.mockReturnValueOnce(new Promise((resolve) => (answerStartup = resolve)));
    const startup = startSurveys();

    // The reader opts out. This read is the newer one and answers first.
    identity.mockResolvedValueOnce(null);
    await startSurveys();

    // Only now does the launch-time read come back, carrying consent as it was.
    answerStartup(consented);
    await startup;

    expect(posthog.init).not.toHaveBeenCalled();
  });
});
