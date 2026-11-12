import { AppNav } from "./AppNav";
import { PAGE } from "./styles";

type Org = { id: string; name: string; slug: string };

/// The frame of every signed-in page: the bar, then the page in the site's column.
export function AppShell({
  org,
  orgs,
  user,
  children,
}: {
  org: Org;
  orgs: Org[];
  user: { name: string; email: string; image?: string | null };
  children: React.ReactNode;
}) {
  return (
    <div data-home className={PAGE}>
      <main className="px-5 pb-[120px] sm:px-8">
        <div className="mx-auto w-full max-w-[960px]">
          <AppNav
            org={{ id: org.id, name: org.name, slug: org.slug }}
            orgs={orgs.map((o) => ({ id: o.id, name: o.name, slug: o.slug }))}
            user={user}
          />
          <div className="mt-16 lg:ml-[102px] lg:max-w-[756px]">{children}</div>
        </div>
      </main>
    </div>
  );
}
