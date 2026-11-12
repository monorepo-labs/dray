import { redirect } from "next/navigation";

import { assignUsername, createPersonalOrg } from "@/lib/auth";
import { listOrgs, requireSession } from "@/lib/session";

/// Opens the org the reader used last, else their first. An account left with
/// none — it left or lost every one — gets a fresh personal org here, and one
/// made before usernames existed gets its username.
export default async function AppHome() {
  const { user, session } = await requireSession("/app");
  if (!user.username) await assignUsername(user);
  const orgs = await listOrgs();
  const last = orgs.find((o) => o.id === session.activeOrganizationId) ?? orgs[0];
  const { slug } = last ?? (await createPersonalOrg(user));
  redirect(`/app/${slug}/servers`);
}
