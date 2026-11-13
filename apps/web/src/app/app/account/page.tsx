import type { Metadata } from "next";
import { redirect } from "next/navigation";

import { revokeAppSession, unlinkOwnServer } from "@/app/app/account/actions";
import { AccountForm } from "@/components/account/AccountForm";
import { AppShell } from "@/components/account/AppShell";
import { RevokeRow } from "@/components/account/RevokeRow";
import { BOX, LEAD, MUTED, ROWS, TITLE } from "@/components/account/styles";
import { pool } from "@/lib/db";
import { listOrgs, requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Account - Dray" };

const day = (d: Date) => d.toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" });

/// The reader's own settings, apart from any org's, and every credential
/// acting for them: apps signed in and servers they linked.
export default async function AccountPage() {
  const { user, session } = await requireSession("/app/account");
  const orgs = await listOrgs();
  const org = orgs.find((o) => o.id === session.activeOrganizationId) ?? orgs[0];
  // The bar needs an org to show; `/app` makes one for an account left with none.
  if (!org) redirect("/app");

  const [{ rows: apps }, { rows: servers }] = await Promise.all([
    pool.query<{ id: string; name: string; createdAt: Date }>(
      `select id, name, "createdAt" from app_session where "userId" = $1 order by "createdAt" desc`,
      [user.id],
    ),
    pool.query<{ id: string; name: string; linkedAt: Date; orgName: string }>(
      `select s.id, s.name, s."linkedAt", o.name as "orgName"
         from server s join organization o on o.id = s."organizationId"
        where s."linkedBy" = $1 order by s."linkedAt" desc`,
      [user.id],
    ),
  ]);

  return (
    <AppShell org={org} orgs={orgs} user={user}>
      <h1 className={TITLE}>Account</h1>
      <AccountForm user={{ name: user.name, email: user.email, username: user.username ?? "" }} />

      <h2 className={TITLE}>Signed-in apps</h2>
      <p className={LEAD}>The Dray app on each machine you signed in from. Signing one out leaves its machine linked.</p>
      <div className="mt-8">
        {apps.length === 0 ? (
          <Empty>No apps signed in. Choose Sign in under Settings → Account in the Dray app.</Empty>
        ) : (
          <ul className={ROWS}>
            {apps.map((a) => (
              <RevokeRow
                key={a.id}
                title={a.name}
                detail={`Signed in on ${day(a.createdAt)}`}
                verb="Sign out"
                revoke={revokeAppSession.bind(null, a.id)}
              />
            ))}
          </ul>
        )}
      </div>

      <h2 className={TITLE}>Linked servers</h2>
      <p className={LEAD}>Servers you linked to an org. Unlinking one takes it out of that org, whatever your role there.</p>
      <div className="mt-8">
        {servers.length === 0 ? (
          <Empty>No servers linked by you.</Empty>
        ) : (
          <ul className={ROWS}>
            {servers.map((s) => (
              <RevokeRow
                key={s.id}
                title={s.name}
                detail={`In ${s.orgName} · linked on ${day(s.linkedAt)}`}
                verb="Unlink"
                revoke={unlinkOwnServer.bind(null, s.id)}
              />
            ))}
          </ul>
        )}
      </div>
    </AppShell>
  );
}

function Empty({ children }: { children: React.ReactNode }) {
  return <div className={`${BOX} px-4 py-10 text-center text-[14px] ${MUTED}`}>{children}</div>;
}
