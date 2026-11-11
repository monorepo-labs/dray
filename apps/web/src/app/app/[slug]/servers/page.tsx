import type { Metadata } from "next";

import { ServerRow } from "@/components/account/ServerRow";
import { BOX, LEAD, MUTED, ROWS, TITLE } from "@/components/account/styles";
import { pool } from "@/lib/db";
import { loadOrg } from "@/lib/session";

export const metadata: Metadata = { title: "Servers - Dray" };

/// The org's linked servers, renamed and unlinked here by owners and admins.
export default async function ServersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { org, canManage } = await loadOrg((await params).slug);
  const { rows } = await pool.query<{
    id: string;
    name: string;
    linkedAt: Date;
    linkedBy: string | null;
  }>(
    `select s.id, s.name, s."linkedAt", u.name as "linkedBy"
       from server s left join "user" u on u.id = s."linkedBy"
      where s."organizationId" = $1
      order by s."linkedAt" desc`,
    [org.id],
  );

  return (
    <>
      <h1 className={TITLE}>Servers</h1>
      <p className={LEAD}>Dray servers linked to {org.name}.</p>
      <div className="mt-8">
        {rows.length === 0 ? (
          <div className={`${BOX} px-4 py-10 text-center text-[14px] ${MUTED}`}>
            No servers yet. Run <code className="font-mono text-white light:text-[#0A0A0A]">dray login</code> on a
            server to link it.
          </div>
        ) : (
          <ul className={ROWS}>
            {rows.map((s) => (
              <ServerRow
                key={s.id}
                server={{
                  id: s.id,
                  name: s.name,
                  linked: `Linked ${s.linkedBy ? `by ${s.linkedBy} ` : ""}on ${s.linkedAt.toLocaleDateString("en-US", { dateStyle: "medium", timeZone: "UTC" })}`,
                }}
                canManage={canManage}
              />
            ))}
          </ul>
        )}
      </div>
    </>
  );
}
