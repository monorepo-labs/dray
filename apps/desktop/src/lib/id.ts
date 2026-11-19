/// A fresh v4 uuid, on every page the app can be served from.
///
/// `crypto.randomUUID` exists only in a secure context (HTTPS or localhost).
/// The web build is reached over plain HTTP on the tailnet IP, where the
/// property is simply absent and the call throws; `getRandomValues` has no
/// such gate, so the same bytes are laid out by hand there.
export function newId(): string {
  if (typeof crypto.randomUUID === "function") return crypto.randomUUID();
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}
