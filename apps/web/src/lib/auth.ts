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
  // Try and retry rather than look first: two sign-ups as sam@a and sam@b can
  // both find `sam` free, and the loser must move on to `sam-2`, not fail.
  // Past a few small numbers the suffix turns random, so a prefix as common
  // as `admin` never runs out of room or walks a long line of taken slugs.
  for (let n = 1; n <= 20; n++) {
    const suffix = n <= 5 ? n : 10_000 + Math.floor(Math.random() * 90_000);
    const slug = n === 1 ? root : `${root.slice(0, 34)}-${suffix}`;
    try {
      await auth.api.createOrganization({ body: { name, slug, userId: user.id } });
      return { slug };
    } catch (e) {
      if (!slugTaken(e)) throw e;
    }
  }
  throw new Error(`No free slug for ${root}`);
}

/// Better Auth's own "already exists", or Postgres refusing the unique slug
/// when two creations pass that check together.
function slugTaken(e: unknown): boolean {
  const err = e as { message?: string; code?: string; cause?: { code?: string } };
  return (
    err.message === "Organization already exists" ||
    err.code === "23505" ||
    err.cause?.code === "23505"
  );
}
