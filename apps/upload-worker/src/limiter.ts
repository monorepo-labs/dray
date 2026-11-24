import { DurableObject } from "cloudflare:workers";

export type Window = { max: number; secs: number };

/// One caller's counters, one object per caller (a GitHub user or an address),
/// in fixed windows. A Durable Object rather than Cloudflare's Rate Limiting
/// binding, which only counts over 10 or 60 seconds and only approximately.
export class Limiter extends DurableObject {
  /// Counts one call in every window and answers whether any is past its max.
  async hit(windows: Window[]): Promise<boolean> {
    const now = Math.floor(Date.now() / 1000);
    let over = false;
    for (const w of windows) {
      const start = now - (now % w.secs);
      const saved = await this.ctx.storage.get<{ start: number; count: number }>(`w${w.secs}`);
      const count = saved?.start === start ? saved.count + 1 : 1;
      await this.ctx.storage.put(`w${w.secs}`, { start, count });
      if (count > w.max) over = true;
    }
    // Pushed back on every hit: once it fires, every window counted has closed.
    await this.ctx.storage.setAlarm(Date.now() + Math.max(...windows.map((w) => w.secs)) * 1000);
    return over;
  }

  async alarm() {
    await this.ctx.storage.deleteAll();
  }
}
