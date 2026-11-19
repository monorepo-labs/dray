import { auth } from "@/lib/auth";
import { backToApp, mintAppCode, readAppAuth } from "@/lib/app-auth";

/// Where the desktop app's Sign in opens the browser. Anyone not yet
/// `confirmed` is sent to `/login`: signed out, to sign in with the provider
/// they picked; already signed in on this browser, to be asked whether that
/// is the account they want (#1277). Signing in there, or choosing Continue,
/// comes back here with `confirmed=1`, and the browser goes straight back to
/// the app's own server on this machine with a one-time code. A provider's
/// own Cancel lands here with `error`, which the app is told as `cancelled`.
export async function GET(req: Request) {
  const url = new URL(req.url);
  const request = readAppAuth(url.searchParams);
  if (!request) return new Response("This sign-in link is broken. Start again from Dray.", { status: 400 });

  if (url.searchParams.has("error")) return Response.redirect(backToApp(request, { error: "cancelled" }), 302);

  const session = await auth.api.getSession({ headers: req.headers });
  if (!session || url.searchParams.get("confirmed") !== "1") {
    // Without `confirmed`, so the page can add it once the reader has chosen.
    url.searchParams.delete("confirmed");
    const next = `${url.pathname}${url.search}`;
    return Response.redirect(
      new URL(`/login?next=${encodeURIComponent(next)}&via=${request.provider}`, url.origin).toString(),
      302,
    );
  }
  const code = await mintAppCode(session.user.id, request);
  return Response.redirect(backToApp(request, { code }), 302);
}
