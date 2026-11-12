import { OrgTabs } from "@/components/account/AppNav";
import { AppShell } from "@/components/account/AppShell";
import { pool } from "@/lib/db";
import { listOrgs, loadOrg } from "@/lib/session";

/// Every `/app/<slug>` page: the bar, the org's tabs, and the page below.
export default async function OrgLayout({
  children,
  params,
}: {
  children: React.ReactNode;
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const { session, org } = await loadOrg(slug);
  const orgs = await listOrgs();

  // The org opened last is what bare `/app` returns to. Written straight to
  // the session row: Better Auth's setter wants to send a cookie, which a
  // render can't.
  if (session.session.activeOrganizationId !== org.id)
    await pool.query(`update session set "activeOrganizationId" = $1 where id = $2`, [
      org.id,
      session.session.id,
    ]);

  return (
    <AppShell org={org} orgs={orgs} user={session.user}>
      <OrgTabs slug={org.slug} />
      {children}
    </AppShell>
  );
}
