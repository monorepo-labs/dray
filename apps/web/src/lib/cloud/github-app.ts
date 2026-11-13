import { createSign } from "node:crypto";

/// The Dray GitHub App's calls (#1013). A machine never sees the app's key or
/// a user's token: it gets an installation token for its one repo, an hour long.

const api = () => process.env.GITHUB_API_URL || "https://api.github.com";
const web = () => process.env.GITHUB_WEB_URL || "https://github.com";

/// What every machine token carries. The app must hold each of these; a
/// request asking for one it lacks is refused outright. No `workflows`: with
/// it a prompt-injected agent could add a workflow that reads repo secrets.
export const MACHINE_PERMISSIONS = {
  contents: "write",
  pull_requests: "write",
  issues: "write",
  checks: "read",
  statuses: "read",
  actions: "read",
  metadata: "read",
} as const;

export class GitHubError extends Error {
  constructor(
    readonly status: number,
    message: string,
  ) {
    super(message);
  }
}

/// Every value the app and the vault need. The vault key is among them: it
/// seals user tokens and signs install `state`, and an empty one would sign
/// with no secret at all.
export const appConfigured = () =>
  Boolean(
    process.env.DRAY_VAULT_KEY &&
      process.env.GITHUB_APP_ID &&
      process.env.GITHUB_APP_SLUG &&
      process.env.GITHUB_APP_CLIENT_ID &&
      process.env.GITHUB_APP_CLIENT_SECRET &&
      process.env.GITHUB_APP_PRIVATE_KEY,
  );

/// Where a user installs the app, or changes which repos it reaches.
export const installUrl = (state: string) =>
  `${web()}/apps/${process.env.GITHUB_APP_SLUG}/installations/new?state=${encodeURIComponent(state)}`;

const b64url = (s: string | Buffer) => Buffer.from(s).toString("base64url");

/// The app's own JWT, ten minutes at most by GitHub's rule. Backdated a minute
/// for clock drift, as GitHub's docs advise.
function appJwt(): string {
  const now = Math.floor(Date.now() / 1000);
  const head = b64url(JSON.stringify({ alg: "RS256", typ: "JWT" }));
  const body = b64url(JSON.stringify({ iat: now - 60, exp: now + 540, iss: process.env.GITHUB_APP_ID }));
  // Env stores often flatten the PEM's newlines to `\n`.
  const pem = (process.env.GITHUB_APP_PRIVATE_KEY ?? "").replace(/\\n/g, "\n");
  const sig = createSign("RSA-SHA256").update(`${head}.${body}`).sign(pem);
  return `${head}.${body}.${b64url(sig)}`;
}

async function call<T>(method: string, url: string, auth: string, body?: unknown): Promise<T> {
  const res = await fetch(url, {
    method,
    headers: {
      Authorization: auth,
      Accept: "application/vnd.github+json",
      "X-GitHub-Api-Version": "2022-11-28",
      "User-Agent": "dray-cloud",
      ...(body === undefined ? {} : { "Content-Type": "application/json" }),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
    cache: "no-store",
  }).catch((e: Error) => {
    throw new GitHubError(502, `GitHub out of reach: ${e.message}`);
  });
  const json = await res.json().catch(() => ({}));
  if (!res.ok) throw new GitHubError(res.status, json.message ?? res.statusText);
  return json as T;
}

/// The installation that covers `repo`, or null where the app isn't on it.
export async function installationFor(repo: string): Promise<number | null> {
  try {
    const { id } = await call<{ id: number }>("GET", `${api()}/repos/${repo}/installation`, `Bearer ${appJwt()}`);
    return id;
  } catch (e) {
    if (e instanceof GitHubError && e.status === 404) return null;
    throw e;
  }
}

/// A token for `repo` alone, with `MACHINE_PERMISSIONS`, valid an hour.
export async function repoToken(installation: number, repo: string) {
  const res = await call<{ token: string; expires_at: string }>(
    "POST",
    `${api()}/app/installations/${installation}/access_tokens`,
    `Bearer ${appJwt()}`,
    { repositories: [repo.split("/")[1]], permissions: MACHINE_PERMISSIONS },
  );
  return { token: res.token, expiresAt: res.expires_at };
}

export type UserToken = {
  access: string;
  accessExpiresAt: Date;
  refresh: string;
  refreshExpiresAt: Date;
};

/// GitHub's token endpoint answers 200 with an `error` field for a bad code or
/// a used refresh token, so success is the token being there.
async function tokenEndpoint(params: Record<string, string>): Promise<UserToken> {
  const res = await fetch(`${web()}/login/oauth/access_token`, {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/json", "User-Agent": "dray-cloud" },
    body: JSON.stringify({
      client_id: process.env.GITHUB_APP_CLIENT_ID,
      client_secret: process.env.GITHUB_APP_CLIENT_SECRET,
      ...params,
    }),
    cache: "no-store",
  }).catch((e: Error) => {
    throw new GitHubError(502, `GitHub out of reach: ${e.message}`);
  });
  const json = await res.json().catch(() => ({}));
  if (!json.access_token) throw new GitHubError(401, json.error_description ?? json.error ?? "no token");
  // A token with expiry turned off carries no `expires_in`; treat it as long.
  const at = (s?: number) => new Date(Date.now() + (s ?? 365 * 86400) * 1000);
  return {
    access: json.access_token,
    accessExpiresAt: at(json.expires_in),
    refresh: json.refresh_token ?? "",
    refreshExpiresAt: at(json.refresh_token_expires_in),
  };
}

export const exchangeCode = (code: string) => tokenEndpoint({ code });

/// GitHub's refresh tokens are single-use: the old one dies on this call, so
/// two callers refreshing at once leaves one of them holding nothing.
export const refreshUserToken = (refresh: string) =>
  tokenEndpoint({ grant_type: "refresh_token", refresh_token: refresh });

export const githubUser = (access: string) =>
  call<{ id: number; login: string }>("GET", `${api()}/user`, `Bearer ${access}`);

/// Whether the user can push to `repo` today. Asked with their own token, so
/// someone removed from an org stops getting machine tokens for its repos.
export async function canPush(access: string, repo: string): Promise<boolean> {
  try {
    const r = await call<{ permissions?: { push?: boolean } }>("GET", `${api()}/repos/${repo}`, `Bearer ${access}`);
    return r.permissions?.push === true;
  } catch (e) {
    if (e instanceof GitHubError && (e.status === 404 || e.status === 403)) return false;
    throw e;
  }
}

/// Ends the user's grant on GitHub's side, so the app no longer reads as
/// authorized in their settings. Best effort: the row is gone either way.
export async function revokeGrant(access: string): Promise<void> {
  const basic = Buffer.from(`${process.env.GITHUB_APP_CLIENT_ID}:${process.env.GITHUB_APP_CLIENT_SECRET}`).toString("base64");
  await call("DELETE", `${api()}/applications/${process.env.GITHUB_APP_CLIENT_ID}/grant`, `Basic ${basic}`, {
    access_token: access,
  }).catch(() => {});
}
