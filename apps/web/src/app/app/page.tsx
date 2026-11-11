import { redirect } from "next/navigation";

import { createPersonalOrg } from "@/lib/auth";
import { listOrgs, requireSession } from "@/lib/session";

/// Opens the org the reader used last, else their first. An account left with
/// none — it left or lost every one — gets a fresh personal org here.
export default async function AppHome() {
  const { user, session } = await requireSession("/app");
  const orgs = await listOrgs();
  const last = orgs.find((o) => o.id === session.activeOrganizationId) ?? orgs[0];
  const { slug } = last ?? (await createPersonalOrg(user));
  redirect(`/app/${slug}/servers`);
}
