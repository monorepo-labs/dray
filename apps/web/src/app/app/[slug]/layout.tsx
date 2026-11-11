import { AppNav, OrgTabs } from "@/components/account/AppNav";
import { PAGE } from "@/components/account/styles";
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
    <div data-home className={PAGE}>
      <main className="px-5 pb-[120px] sm:px-8">
        <div className="mx-auto w-full max-w-[960px]">
          <AppNav
            org={{ id: org.id, name: org.name, slug: org.slug }}
            orgs={orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug }))}
            user={session.user}
          />
          <div className="mt-16 lg:ml-[102px] lg:max-w-[756px]">
            <OrgTabs slug={org.slug} />
            {children}
          </div>
        </div>
      </main>
    </div>
  );
}
