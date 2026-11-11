import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { organization } from "better-auth/plugins/organization";

import { pool } from "./db";
import { drayTables } from "./schema";
import { slugify, slugProblem } from "./slug";

function checkSlug(slug: string | undefined) {
  const problem = slug === undefined ? null : slugProblem(slug);
  if (problem) throw new APIError("BAD_REQUEST", { message: problem });
}

/// Better Auth for drayhq.com: Google sign-in, orgs and their members.
/// `nextCookies` lets a server action that signs in or out set its cookie.
export const auth = betterAuth({
  database: pool,
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      prompt: "select_account",
    },
  },
  databaseHooks: {
    user: {
      create: {
        after: async (user) => {
          await createPersonalOrg(user);
        },
      },
    },
  },
  plugins: [
    organization({
      organizationHooks: {
        beforeCreateOrganization: async ({ organization }) => checkSlug(organization.slug),
        beforeUpdateOrganization: async ({ organization }) => checkSlug(organization.slug),
        // Every account keeps at least one org, so linking a server never
        // has to ask the reader to make one first.
        beforeDeleteOrganization: async ({ user }) => {
          const { rows } = await pool.query<{ n: number }>(
            `select count(*)::int as n from member where "userId" = $1`,
            [user.id],
          );
          if (rows[0].n <= 1)
            throw new APIError("BAD_REQUEST", { message: "You can't delete your only org." });
        },
      },
    }),
    drayTables,
    nextCookies(),
  ],
});

/// Makes the org every account starts with: named after the reader's first
/// name, slugged from their email, a number appended where that slug is taken.
/// Called on sign-up and again by `/app` for an account left with no org.
export async function createPersonalOrg(user: {
  id: string;
  name: string;
  email: string;
}): Promise<{ slug: string }> {
  const local = user.email.split("@")[0];
  const name = user.name.trim().split(/\s+/)[0] || local;
  const base = slugify(local);
  const root = slugProblem(base) ? "org" : base;
  let slug = root;
  for (let n = 2; ; n++) {
    const { rowCount } = await pool.query(`select 1 from organization where slug = $1`, [slug]);
    if (!rowCount) break;
    slug = `${root.slice(0, 36)}-${n}`;
  }
  await auth.api.createOrganization({ body: { name, slug, userId: user.id } });
  return { slug };
}
