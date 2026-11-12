import type { Metadata } from "next";

import { LinkApprove } from "@/components/account/LinkApprove";
import { ERROR, H1, INPUT, LEAD, PAGE, PRIMARY } from "@/components/account/styles";
import { SiteNav } from "@/components/home/SiteNav";
import { pool } from "@/lib/db";
import { normalizeCode, showCode } from "@/lib/link";
import { managesServers, requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Link a server - Dray" };

/// Where a server's link code is approved: `dray login` prints this page's
/// address with the code, or the bare page and the code to type here.
export default async function LinkPage({
  searchParams,
}: {
  searchParams: Promise<{ code?: string | string[] }>;
}) {
  const given = (await searchParams).code;
  const code = typeof given === "string" ? normalizeCode(given) : "";
  const session = await requireSession(code ? `/link?code=${showCode(code)}` : "/link");

  return (
    <div data-home className={PAGE}>
      <main className="px-5 pb-[120px] sm:px-8">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav bare />
          <div className="lg:ml-[102px] lg:max-w-[756px]">
            {code ? (
              <Approve code={code} userId={session.user.id} activeOrgId={session.session.activeOrganizationId} />
            ) : (
              <>
                <h1 className={H1}>Link a server.</h1>
                <p className={LEAD}>Enter the code your server printed.</p>
                <CodeForm />
              </>
            )}
          </div>
        </div>
      </main>
    </div>
  );
}

async function Approve({
  code,
  userId,
  activeOrgId,
}: {
  code: string;
  userId: string;
  activeOrgId?: string | null;
}) {
  const { rows } = await pool.query<{ name: string; currentOrg: string | null; open: boolean; signIn: boolean | null }>(
    `select l.name, s."organizationId" as "currentOrg", l."signIn",
            l."organizationId" is null and not l.denied and l."expiresAt" > now() as open
       from server_link l left join server s on s.id = l."serverId"
      where l."userCode" = $1`,
    [code],
  );
  const link = rows[0];
  if (!link?.open)
    return (
      <>
        <h1 className={H1}>Link a server.</h1>
        <p className={LEAD}>Enter the code your server printed.</p>
        <CodeForm problem="That code has expired or was already used. Run dray login again for a new one." />
      </>
    );

  const { rows: memberships } = await pool.query<{ id: string; name: string; slug: string; role: string }>(
    `select o.id, o.name, o.slug, m.role from member m join organization o on o.id = m."organizationId"
      where m."userId" = $1 order by o.name`,
    [userId],
  );
  const orgs = memberships.filter((m) => managesServers(m.role)).map(({ id, name, slug }) => ({ id, name, slug }));
  if (orgs.length === 0)
    return (
      <>
        <h1 className={H1}>{link.signIn ? "Sign in to Dray." : "Link a server."}</h1>
        <p className={LEAD}>Only an org&apos;s owners and admins can link servers to it, and you aren&apos;t one in any org.</p>
      </>
    );

  // Only the reader's own orgs are named; one held elsewhere stays anonymous.
  const currentOrgId = orgs.some((o) => o.id === link.currentOrg) ? link.currentOrg : null;
  const preferred = currentOrgId ?? (orgs.some((o) => o.id === activeOrgId) ? activeOrgId! : orgs[0].id);
  return (
    <LinkApprove
      code={showCode(code)}
      name={link.name}
      orgs={orgs}
      initialOrgId={preferred}
      linkedElsewhere={link.currentOrg !== null}
      currentOrgId={currentOrgId}
      signIn={link.signIn === true}
    />
  );
}

/// A plain GET form, so the code lands in the address and survives sign-in.
function CodeForm({ problem }: { problem?: string }) {
  return (
    <form action="/link" className="mt-10 flex max-w-[360px] flex-col gap-3">
      <div className="flex gap-2">
        <input
          name="code"
          required
          autoFocus
          autoComplete="off"
          spellCheck={false}
          placeholder="ABCD-EFGH"
          aria-label="Code"
          maxLength={12}
          className={`${INPUT} font-mono tracking-[0.12em] uppercase`}
        />
        <button type="submit" className={PRIMARY}>
          Continue
        </button>
      </div>
      {problem && <p className={ERROR}>{problem}</p>}
    </form>
  );
}
