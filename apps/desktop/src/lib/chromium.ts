import { formatBytes } from "@/lib/format";
import type { ChromiumStatus } from "@/types/events";

/// How far along a download is, 0–100. Only a `downloading` status has one.
export function chromiumPercent(status: ChromiumStatus): number {
  if (status.state !== "downloading" || status.total === 0) return 0;
  return Math.floor((status.received / status.total) * 100);
}

/// The one sentence both the settings row and the browser's empty state
/// draw, so the two cannot describe the same download differently.
export function describeChromium(status: ChromiumStatus): string {
  switch (status.state) {
    case "downloading":
      return `Downloading Chromium for the browser… ${chromiumPercent(status)}%`;
    case "extracting":
      return "Unpacking Chromium…";
    case "ready":
      return `Chromium ${status.version}, ${formatBytes(status.sizeBytes)} on disk.`;
    case "failed":
      return `Chromium could not be downloaded: ${status.message}`;
    case "absent":
      return "Chromium isn't downloaded, so the browser is off.";
  }
}

/// Whether a download is in flight — nothing to press, only to wait for.
export function chromiumBusy(status: ChromiumStatus): boolean {
  return status.state === "downloading" || status.state === "extracting";
}
