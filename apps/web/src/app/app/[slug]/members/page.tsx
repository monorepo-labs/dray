import type { Metadata } from "next";

import { Avatar } from "@/components/account/AppNav";
import { LABEL, LEAD, MUTED, ROWS, TITLE } from "@/components/account/styles";
import { loadOrg } from "@/lib/session";

export const metadata: Metadata = { title: "Members - Dray" };

/// Who is in the org and in what role. Read-only until invites exist.
export default async function MembersPage({ params }: { params: Promise<{ slug: string }> }) {
  const { org, session } = await loadOrg((await params).slug);

  return (
    <>
      <h1 className={TITLE}>Members</h1>
      <p className={LEAD}>People in {org.name}.</p>
      <ul className={`mt-8 ${ROWS}`}>
        {org.members.map((m) => (
          <li key={m.id} className="flex items-center gap-3 px-4 py-3">
            <Avatar user={m.user} size={28} />
            <div className="min-w-0 flex-1">
              <p className="truncate text-[15px]">
                {m.user.name}
                {m.userId === session.user.id && <span className={MUTED}> (you)</span>}
              </p>
              <p className={`truncate text-[13px] ${MUTED}`}>{m.user.email}</p>
            </div>
            <span className={LABEL}>{m.role.split(",").join(", ")}</span>
          </li>
        ))}
      </ul>
    </>
  );
}
