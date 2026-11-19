import { betterAuth } from "better-auth";
import { APIError } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { jwt } from "better-auth/plugins/jwt";
import { organization } from "better-auth/plugins/organization";

import { pool } from "./db";
import { drayTables } from "./schema";
import { slugify, slugProblem, usernameFrom, usernameProblem } from "./slug";

function checkSlug(slug: string | undefined) {
  const problem = slug === undefined ? null : slugProblem(slug);
  if (problem) throw new APIError("BAD_REQUEST", { message: problem });
}

/// Better Auth for drayhq.com: Google sign-in, orgs and their members.
/// `nextCookies` lets a server action that signs in or out set its cookie.
export const auth = betterAuth({
  database: pool,
  user: {
    additionalFields: {
      // Written only by `setUsername`, which checks the format and reports a
      // taken one; `input: false` keeps `updateUser` from going around it.
      username: { type: "string", required: false, unique: true, input: false },
    },
  },
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
          await assignUsername(user);
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
    // Signs the assertion an MCP sign-in hands back to a server, which checks
    // it against `/api/auth/jwks`. Keys live in the `jwks` table, encrypted
    // with BETTER_AUTH_SECRET. The session-JWT header is off: nothing here
    // reads it, and every `getSession` would sign one.
    jwt({ jwks: { keyPairConfig: { alg: "EdDSA", crv: "Ed25519" } }, disableSettingJwtHeader: true }),
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
  const slug = await claimFree(slugProblem(base) ? "org" : base, 40, "-", async (slug) => {
    await auth.api.createOrganization({ body: { name, slug, userId: user.id } });
  });
  return { slug };
}

/// Gives a new account a username from its email, a number appended where
/// that one is taken. Called on sign-up and again by `/app` for an account
/// made before usernames existed. The reader can change it in account settings.
export async function assignUsername(user: { id: string; email: string }): Promise<void> {
  const base = usernameFrom(user.email.split("@")[0]);
  await claimFree(usernameProblem(base) ? "user" : base, 20, "_", async (username) => {
    await pool.query(`update "user" set username = $1 where id = $2`, [username, user.id]);
  });
}

/// Hands `claim` the root, then root plus 2–5, then random five-digit
/// suffixes, until one isn't taken. Try and retry rather than look first: two
/// sign-ups as sam@a and sam@b can both find `sam` free, and the loser must
/// move on, not fail. The random tail keeps a prefix as common as `admin`
/// from running out of room or walking a long line of taken names.
async function claimFree(
  root: string,
  maxLength: number,
  separator: string,
  claim: (candidate: string) => Promise<void>,
): Promise<string> {
  for (let n = 1; n <= 20; n++) {
    const suffix = n <= 5 ? n : 10_000 + Math.floor(Math.random() * 90_000);
    const candidate = n === 1 ? root : `${root.slice(0, maxLength - 6)}${separator}${suffix}`;
    try {
      await claim(candidate);
      return candidate;
    } catch (e) {
      if (!isTaken(e)) throw e;
    }
  }
  throw new Error(`Nothing free near ${root}`);
}

/// Better Auth's own "already exists", or Postgres refusing a unique value
/// when two writes pass the first check together.
export function isTaken(e: unknown): boolean {
  const err = e as { message?: string; code?: string; cause?: { code?: string } };
  return (
    err.message === "Organization already exists" ||
    err.code === "23505" ||
    err.cause?.code === "23505"
  );
}
