import { createHmac } from "node:crypto";

import { auth } from "@/lib/auth";
import { requestOrigin } from "@/lib/origin";

import { appConfigured, exchangeCode, githubUser, installUrl } from "./github-app";
import { deleteAccount, saveAccount } from "./github-store";
import { sign, verify } from "./vault";

/// Connecting a Dray account to the Dray GitHub App (#1013). The app asks for
/// user authorization during install, so the callback carries a `code`: the
/// only proof of who installed it, since an `installation_id` in a URL is
/// anyone's to type.

const PREFIX = "dgs1";
const STATE_LIFE_MS = 30 * 60 * 1000;
const ACCOUNT = "/app/account";

const stateSecret = () =>
  createHmac("sha256", process.env.DRAY_VAULT_KEY ?? "").update("github-state").digest("hex");

const to = (req: Request, path: string) => Response.redirect(`${requestOrigin(req)}${path}`, 302);
const signedIn = (req: Request) => auth.api.getSession({ headers: req.headers });

/// Sends the signed-in user to GitHub to install the app on the repos they pick.
export async function install(req: Request): Promise<Response> {
  if (!appConfigured()) return new Response(null, { status: 404 });
  const session = await signedIn(req);
  if (!session) return to(req, `/login?next=${encodeURIComponent("/api/github/install")}`);
  const state = sign({ u: session.user.id, exp: Date.now() + STATE_LIFE_MS }, stateSecret(), PREFIX);
  return Response.redirect(installUrl(state), 302);
}

/// GitHub's return from install. `state` must name the user signed in here, or
/// someone else's `code` could link their GitHub to this account.
export async function callback(req: Request): Promise<Response> {
  if (!appConfigured()) return new Response(null, { status: 404 });
  const session = await signedIn(req);
  if (!session) return to(req, `/login?next=${encodeURIComponent(ACCOUNT)}`);
  const query = new URL(req.url).searchParams;
  const code = query.get("code");
  // A change of repos made on github.com comes back with no state of ours;
  // the link it changes is already made.
  if (!code) return to(req, ACCOUNT);
  const state = verify<{ u: string; exp: number }>(query.get("state") ?? "", stateSecret(), PREFIX);
  if (!state || state.u !== session.user.id || state.exp < Date.now()) {
    return to(req, `${ACCOUNT}?github=retry`);
  }
  const token = await exchangeCode(code);
  const who = await githubUser(token.access);
  await saveAccount(session.user.id, who, token);
  return to(req, `${ACCOUNT}?github=connected`);
}

export async function disconnect(req: Request): Promise<Response> {
  const session = await signedIn(req);
  if (!session) return new Response(null, { status: 401 });
  await deleteAccount(session.user.id);
  return new Response(null, { status: 204 });
}
