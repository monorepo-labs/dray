import type { Metadata } from "next";

import { OrgSettings } from "@/components/account/OrgSettings";
import { TITLE } from "@/components/account/styles";
import { listOrgs, loadOrg } from "@/lib/session";

export const metadata: Metadata = { title: "Org settings - Dray" };

/// Rename the org or move its URL, leave it, or delete it.
export default async function SettingsPage({ params }: { params: Promise<{ slug: string }> }) {
  const { org, isOwner, canManage } = await loadOrg((await params).slug);
  const orgs = await listOrgs();

  return (
    <>
      <h1 className={TITLE}>Settings</h1>
      <OrgSettings
        org={{ id: org.id, name: org.name, slug: org.slug }}
        isOwner={isOwner}
        canManage={canManage}
        onlyOrg={orgs.length <= 1}
      />
    </>
  );
}
