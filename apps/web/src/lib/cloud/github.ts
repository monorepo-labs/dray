import { randomBytes } from "node:crypto";

import { appConfigured, canPush, installationFor, repoToken } from "./github-app";
import { account } from "./github-store";
import { sign, verify } from "./vault";

/// Repo access for Dray Cloud machines (#1013): at create, a machine is bound
/// to one user and one repo; afterwards it trades its credential for an
/// installation token on that repo alone.

/// `owner/name` as GitHub spells them. The name lands in a token request and
/// the slug in a URL path, so nothing else gets through.
const SLUG = /^[A-Za-z0-9-]+\/[A-Za-z0-9._-]+$/;
export const isSlug = (s: unknown): s is string => typeof s === "string" && SLUG.test(s) && !s.endsWith("/..") && !s.endsWith("/.");

/// What a machine's credential says about it. `n` is also a label on its
/// sandbox, which is how a deleted machine's credential stops working.
export type MachineClaims = { v: 1; u: string; i: number; r: string; n: string };

const PREFIX = "dmk1";
export const KEY_LABEL = "dray-key";

/// The repo is refused for a reason the user can fix, worded for the task.
export class RepoRefused extends Error {}

/// Checks `userId` may run `repo` on Cloud and mints the machine's credential.
/// Asked with the user's own token, so access lost on GitHub is lost here.
export async function bind(userId: string, repo: string, keySecret: string) {
  if (!appConfigured()) throw new RepoRefused("Dray Cloud has no GitHub App set up yet.");
  const who = await account(userId);
  if (!(await canPush(who.access, repo))) {
    throw new RepoRefused(`${who.login} can't push to ${repo}, or the Dray GitHub App isn't installed there.`);
  }
  const installation = await installationFor(repo);
  if (installation === null) {
    throw new RepoRefused(`The Dray GitHub App isn't installed on ${repo}. Add it on drayhq.com.`);
  }
  const nonce = randomBytes(12).toString("hex");
  const claims: MachineClaims = { v: 1, u: userId, i: installation, r: repo, n: nonce };
  return {
    nonce,
    key: sign(claims, keySecret, PREFIX),
    // Commits on the machine are the user's; pushes and PRs are the app's.
    author: { name: who.login, email: `${who.githubId}+${who.login}@users.noreply.github.com` },
  };
}

export const readKey = (key: string, keySecret: string) => {
  const c = verify<MachineClaims>(key, keySecret, PREFIX);
  return c?.v === 1 && typeof c.u === "string" && Number.isInteger(c.i) && isSlug(c.r) && typeof c.n === "string"
    ? c
    : null;
};

/// An hour-long token for the machine's one repo. Refused once the user has
/// disconnected GitHub (`account` finds no row) or lost push access, and when the app has left the repo.
export async function mint(c: MachineClaims) {
  const who = await account(c.u);
  if (!(await canPush(who.access, c.r))) throw new RepoRefused(`${who.login} can no longer push to ${c.r}.`);
  return repoToken(c.i, c.r);
}
