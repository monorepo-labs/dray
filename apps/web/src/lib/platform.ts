import { DOWNLOAD, DOWNLOAD_LINUX } from "@/lib/links";

/// Whether this browser runs on x86_64 Linux, the one Linux build there is.
/// An ARM machine says `aarch64` and is left on the Mac's, rather than handed
/// an AppImage it cannot run.
export function onLinux(): boolean {
  const ua = navigator.userAgent;
  return /Linux (x86_64|amd64)/.test(ua) && !/Android/.test(ua);
}

/// The file `/download` starts for this browser.
export function downloadFor(linux: boolean): string {
  return linux ? DOWNLOAD_LINUX : DOWNLOAD;
}
