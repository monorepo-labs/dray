import type { Metadata } from "next";

import { NewOrg } from "@/components/account/NewOrg";
import { H1, LEAD, PAGE } from "@/components/account/styles";
import { SiteNav } from "@/components/home/SiteNav";
import { requireSession } from "@/lib/session";

export const metadata: Metadata = { title: "New org - Dray" };

/// Makes another org, with the reader as its owner.
export default async function NewOrgPage() {
  await requireSession("/app/new");
  return (
    <div data-home className={PAGE}>
      <main className="px-5 pb-[120px] sm:px-8">
        <div className="mx-auto w-full max-w-[960px]">
          <SiteNav bare />
          <div className="lg:ml-[102px] lg:max-w-[756px]">
            <h1 className={H1}>New org.</h1>
            <p className={LEAD}>Servers are linked to an org. You'll be its owner.</p>
            <div className="mt-10">
              <NewOrg />
            </div>
          </div>
        </div>
      </main>
    </div>
  );
}
