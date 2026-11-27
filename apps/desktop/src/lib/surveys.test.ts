import { beforeEach, describe, expect, it, vi } from "vitest";

// Both of this module's dependencies are faked, and only they are: whether to
// start is decided in Rust and the SDK is somebody else's.
const identity = vi.fn();
vi.mock("@/lib/transport", () => ({ invoke: () => identity() }));

const posthog = {
  init: vi.fn(),
  set_config: vi.fn(),
  opt_in_capturing: vi.fn(),
  opt_out_capturing: vi.fn(),
};
vi.mock("posthog-js", () => ({ default: posthog }));

const allowed = {
  key: "phc_test",
  host: "https://us.i.posthog.com",
  distinctId: "2f1c",
  personProperties: { source: "app" },
};

// The module keeps the started SDK for the life of the process, so each case
// needs its own copy of it.
const load = async () => {
  vi.resetModules();
  return (await import("./surveys")).startSurveys;
};

beforeEach(() => {
  identity.mockReset();
  for (const fn of Object.values(posthog)) fn.mockReset();
});

describe("startSurveys", () => {
  it("starts nothing where Rust refuses", async () => {
    identity.mockResolvedValue(null);

    await (await load())();

    expect(posthog.init).not.toHaveBeenCalled();
  });

  it("joins the person Rust already posts as", async () => {
    identity.mockResolvedValue(allowed);

    await (await load())();

    expect(posthog.init).toHaveBeenCalledWith(
      "phc_test",
      expect.objectContaining({ bootstrap: { distinctID: "2f1c" } }),
    );
  });

  it("stops a running SDK when the switch goes off, and resumes it on", async () => {
    const start = await load();
    identity.mockResolvedValue(allowed);
    await start();

    identity.mockResolvedValue(null);
    await start();
    expect(posthog.opt_out_capturing).toHaveBeenCalledOnce();
    expect(posthog.set_config).toHaveBeenLastCalledWith({ disable_surveys: true });

    identity.mockResolvedValue(allowed);
    await start();
    expect(posthog.opt_in_capturing).toHaveBeenCalledWith({ captureEventName: false });
    expect(posthog.set_config).toHaveBeenLastCalledWith({ disable_surveys: false });
    expect(posthog.init).toHaveBeenCalledOnce();
  });

  it("lets the newest answer win when an older read lands last", async () => {
    const start = await load();
    let launchRead!: (v: unknown) => void;
    identity.mockReturnValueOnce(new Promise((r) => (launchRead = r)));
    const launch = start();

    identity.mockResolvedValueOnce(null);
    await start();
    launchRead(allowed);
    await launch;

    expect(posthog.init).not.toHaveBeenCalled();
  });
});
