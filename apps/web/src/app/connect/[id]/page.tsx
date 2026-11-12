import type { Metadata } from "next";

import { ConnectApprove, OtherAccount } from "@/components/account/ConnectApprove";
import { H1, LEAD, PAGE } from "@/components/account/styles";
import { SiteNav } from "@/components/home/SiteNav";
import { pool } from "@/lib/db";
import { mayConnect } from "@/lib/mcp";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "Connect an assistant - Dray" };

/// Where a Dray server's MCP sign-in lands: the server pushed the request,
/// the reader signs in, and someone on that server's allow list says Allow.
/// Anyone else learns nothing about the server, not even its name.
export default async function ConnectPage({ params }: { params: Promise<{ id: string }> }) {
  const { id } = await params;
  const session = await requireSession(`/connect/${id}`);
  const { rows } = await pool.query<{
    serverId: string;
    serverName: string;
    orgName: string;
    client: string;
    redirectHost: string;
  }>(
    `select c."serverId", s.name as "serverName", o.name as "orgName", c.client, c."redirectHost"
       from mcp_sign_in c
       join server s on s.id = c."serverId"
       join organization o on o.id = s."organizationId"
      where c.id = $1 and c."expiresAt" > now()`,
    [id],
  );
  const signIn = rows[0];
  const allowed = signIn ? await mayConnect(signIn.serverId, session.user.id) : false;

  return (
    <div data-home className={PAGE}>
      <main className="px-5 pb-[120px] sm:px-8">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav bare />
          <div className="lg:ml-[102px] lg:max-w-[756px]">
            {!signIn ? (
              <>
                <h1 className={H1}>This sign-in has expired.</h1>
                <p className={LEAD}>Start again from your assistant.</p>
              </>
            ) : !allowed ? (
              <>
                <h1 className={H1}>Can&apos;t connect.</h1>
                <p className={LEAD}>
                  {session.user.email} can&apos;t connect an assistant to that server.
                </p>
                <div className="mt-10">
                  <OtherAccount id={id} />
                </div>
              </>
            ) : (
              <ConnectApprove
                id={id}
                client={signIn.client}
                server={signIn.serverName}
                org={signIn.orgName}
                email={session.user.email}
                redirectHost={signIn.redirectHost}
              />
            )}
          </div>
        </div>
      </main>
    </div>
  );
}
