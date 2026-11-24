/// Who may upload (#1501): Dray's own contributors, so the bucket holds PR
/// media for this repo and nothing from anybody else's, often private, work.

export const REPO = "monorepo-labs/dray";
const ORG = REPO.split("/")[0];
/// Open PRs read before giving up on an author, 100 a page.
const MAX_PR_PAGES = 10;

export type Verdict = "contributor" | "stranger" | "lookup_refused" | "unreachable";

/// Whether `user` contributes to `REPO`: a collaborator of it (which takes in
/// org members through teams and the org's base permission), a member of its
/// org, or the author of a PR open there, so an outside contributor can attach
/// media to their own PR. Asked with Dray's `token`, never the caller's.
export async function contributes(
  user: { id: number; login: string },
  token: string,
  origin = "https://api.github.com",
): Promise<Verdict> {
  const ask = (path: string) =>
    fetch(`${origin}${path}`, {
      headers: {
        Authorization: `Bearer ${token}`,
        Accept: "application/vnd.github+json",
        "User-Agent": "dray-upload",
        "X-GitHub-Api-Version": "2022-11-28",
      },
      // GitHub's 302 here means the token cannot see private org members.
      redirect: "manual",
      signal: AbortSignal.timeout(10_000),
    });
  const login = encodeURIComponent(user.login);
  try {
    for (const path of [`/repos/${REPO}/collaborators/${login}`, `/orgs/${ORG}/members/${login}`]) {
      const res = await ask(path);
      if (res.status === 204) return "contributor";
      if (res.status !== 404) return failure(res.status);
    }
    for (let page = 1; page <= MAX_PR_PAGES; page++) {
      const res = await ask(`/repos/${REPO}/pulls?state=open&per_page=100&page=${page}`);
      if (!res.ok) return failure(res.status);
      const pulls = (await res.json()) as { user?: { id?: unknown } | null }[];
      // By id, not login: a login can be renamed and then taken by someone else.
      if (pulls.some((p) => p.user?.id === user.id)) return "contributor";
      if (pulls.length < 100) break;
    }
    return "stranger";
  } catch {
    return "unreachable";
  }
}

/// A lookup answer other than yes or no: our token refused or short of a
/// scope, which no retry fixes, or GitHub having a bad minute.
function failure(status: number): Verdict {
  return status === 401 || status === 403 || status === 302 ? "lookup_refused" : "unreachable";
}
