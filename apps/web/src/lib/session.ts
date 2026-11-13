import { headers } from "next/headers";
import { notFound, redirect } from "next/navigation";
import { cache } from "react";

import { auth } from "./auth";

/// The signed-in reader, or a trip to `/login` that comes back to `from`.
export const requireSession = cache(async (from: string) => {
  const session = await auth.api.getSession({ headers: await headers() });
  if (!session) redirect(`/login?next=${encodeURIComponent(from)}`);
  return session;
});

/// The org at `/app/<slug>` with its members, and the reader's own role in it.
/// Better Auth answers only to a member, so anyone else gets a 404 rather than
/// learning the org exists. Cached so the layout and its page share one read.
export const loadOrg = cache(async (slug: string) => {
  const session = await requireSession(`/app/${slug}`);
  const org = await auth.api
    .getFullOrganization({ headers: await headers(), query: { organizationSlug: slug } })
    .catch(() => null);
  if (!org) notFound();
  const me = org.members.find((m) => m.userId === session.user.id);
  if (!me) notFound();
  return {
    session,
    org,
    isOwner: me.role.split(",").includes("owner"),
    canManage: managesServers(me.role),
  };
});

/// Whether a member's role string, which Better Auth stores comma-separated,
/// lets them manage the org's servers.
export function managesServers(role: string): boolean {
  return role.split(",").some((r) => r === "owner" || r === "admin");
}

/// Every org the reader is a member of. Cached so the layout and a page share one read.
export const listOrgs = cache(async () =>
  auth.api.listOrganizations({ headers: await headers() }),
);
