/// Whether this browser runs on desktop Linux, x86_64 or arm64 alike. Call it
/// in an effect, never at render, so the server's HTML and the first client
/// render agree on the Mac's.
export function onLinux(): boolean {
  const ua = navigator.userAgent;
  return /Linux/.test(ua) && !/Android/.test(ua);
}
