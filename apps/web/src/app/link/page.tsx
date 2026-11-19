import type { Metadata } from "next";

import { LinkApprove } from "@/components/account/LinkApprove";
import { BlueCard, Cards, FIELD, FieldCard, Heading, Label } from "@/components/account/SignInParts";
import { SignInShell } from "@/components/account/SignInShell";
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
    <SignInShell>
      {code ? (
        <Approve code={code} userId={session.user.id} activeOrgId={session.session.activeOrganizationId} />
      ) : (
        <CodeForm />
      )}
    </SignInShell>
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
  const { rows } = await pool.query<{ name: string; currentOrg: string | null; open: boolean }>(
    `select l.name, s."organizationId" as "currentOrg",
            l."organizationId" is null and not l.denied and l."expiresAt" > now() as open
       from server_link l left join server s on s.id = l."serverId"
      where l."userCode" = $1`,
    [code],
  );
  const link = rows[0];
  if (!link?.open) return <CodeForm problem="That code has expired or was already used" />;

  const { rows: memberships } = await pool.query<{ id: string; name: string; slug: string; role: string }>(
    `select o.id, o.name, o.slug, m.role from member m join organization o on o.id = m."organizationId"
      where m."userId" = $1 order by o.name`,
    [userId],
  );
  const orgs = memberships.filter((m) => managesServers(m.role)).map(({ id, name, slug }) => ({ id, name, slug }));
  if (orgs.length === 0)
    return (
      <>
        <Label danger>You aren&apos;t an owner or admin in any org</Label>
        <Heading>Only an org&apos;s owners and admins can link servers to it.</Heading>
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
    />
  );
}

/// A plain GET form, so the code lands in the address and survives sign-in.
function CodeForm({ problem }: { problem?: string }) {
  return (
    <form action="/link">
      {problem ? <Label danger>{problem}</Label> : <Label>Link a server</Label>}
      <Heading>{problem ? "Run dray login again for a new code." : "Enter the code your server printed."}</Heading>
      <Cards>
        <FieldCard label="Code">
          <input
            name="code"
            required
            autoFocus
            autoComplete="off"
            spellCheck={false}
            placeholder="ABCD-EFGH"
            maxLength={12}
            className={`${FIELD} font-mono tracking-[0.12em] uppercase`}
          />
        </FieldCard>
        <BlueCard label="Continue" />
      </Cards>
    </form>
  );
}
