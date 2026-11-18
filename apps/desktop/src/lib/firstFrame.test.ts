import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import { SEEK_GRACE_MS, showFirstFrame } from "@/lib/firstFrame";

/// Just enough of a `<video>` to drive: seeks fire `seeked` at once, and
/// `present()` stands in for a frame reaching the screen.
function fakeVideo({ start = 0, rvfc = true } = {}) {
  const listeners = new Map<string, () => void>();
  let frame: (() => void) | null = null;
  const v = {
    seekable: { length: 1, start: () => start },
    muted: false,
    paused: true,
    seeks: [] as number[],
    set currentTime(t: number) {
      v.seeks.push(t);
      listeners.get("seeked")?.();
    },
    addEventListener: (type: string, fn: () => void) => listeners.set(type, fn),
    removeEventListener: (type: string) => listeners.delete(type),
    play: vi.fn(() => {
      v.paused = false;
      return Promise.resolve();
    }),
    pause: vi.fn(() => {
      v.paused = true;
    }),
    cancelVideoFrameCallback: vi.fn(() => {
      frame = null;
    }),
    present: () => frame?.(),
    ...(rvfc && {
      requestVideoFrameCallback: (fn: () => void) => {
        frame = fn;
        return 1;
      },
    }),
  };
  return v;
}

const paint = (v: ReturnType<typeof fakeVideo>) => showFirstFrame(v as unknown as HTMLVideoElement);

describe("showFirstFrame", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("seeks just past where the media says it starts", () => {
    const v = fakeVideo({ start: 0.095 });
    paint(v);
    expect(v.seeks).toEqual([0.096]);
  });

  it("stops at the seek when a frame lands, playing nothing", () => {
    const v = fakeVideo();
    const p = paint(v);
    v.present();
    vi.advanceTimersByTime(SEEK_GRACE_MS * 2);
    expect(v.play).not.toHaveBeenCalled();
    expect(p.active()).toBe(false);
  });

  it("plays muted to the first frame when the seek paints none, then pauses and unmutes", () => {
    const v = fakeVideo();
    const p = paint(v);
    vi.advanceTimersByTime(SEEK_GRACE_MS);
    expect(v.play).toHaveBeenCalledOnce();
    expect(v.muted).toBe(true);
    expect(p.active()).toBe(true);

    v.present();
    expect(v.pause).toHaveBeenCalledOnce();
    expect(v.muted).toBe(false);
    expect(p.active()).toBe(false);
  });

  it("leaves a video muted by its owner muted", () => {
    const v = fakeVideo();
    v.muted = true;
    paint(v);
    vi.advanceTimersByTime(SEEK_GRACE_MS);
    v.present();
    expect(v.muted).toBe(true);
  });

  it("stopped before the grace runs out never plays", () => {
    const v = fakeVideo();
    paint(v).stop();
    vi.advanceTimersByTime(SEEK_GRACE_MS * 2);
    expect(v.play).not.toHaveBeenCalled();
  });

  it("falls back to the bare seek where frames cannot be watched", () => {
    const v = fakeVideo({ rvfc: false });
    const p = paint(v);
    vi.advanceTimersByTime(SEEK_GRACE_MS * 2);
    expect(v.seeks).toEqual([0.001]);
    expect(v.play).not.toHaveBeenCalled();
    expect(p.active()).toBe(false);
  });
});
