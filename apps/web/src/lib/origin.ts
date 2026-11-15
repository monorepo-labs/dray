/// The origin the caller reached. Read off the headers: Next rewrites
/// `req.url`'s host to its own idea of it.
export function requestOrigin(req: Request) {
  const url = new URL(req.url);
  const host = req.headers.get("x-forwarded-host") ?? req.headers.get("host") ?? url.host;
  const proto = req.headers.get("x-forwarded-proto")?.split(",")[0] ?? url.protocol.slice(0, -1);
  return `${proto}://${host}`;
}
