import { betterAuth } from "better-auth";
import { APIError, createAuthMiddleware } from "better-auth/api";
import { nextCookies } from "better-auth/next-js";
import { lastLoginMethod } from "better-auth/plugins";
import { emailOTP } from "better-auth/plugins/email-otp";
import { organization } from "better-auth/plugins/organization";

import { pool } from "./db";
import { sendMail } from "./mail";
import { drayTables } from "./schema";
import { slugify, slugProblem, usernameFrom, usernameProblem } from "./slug";

function checkSlug(slug: string | undefined) {
  const problem = slug === undefined ? null : slugProblem(slug);
  if (problem) throw new APIError("BAD_REQUEST", { message: problem });
}

const OTP_SUBJECT = {
  "email-verification": "Your Dray sign-up code",
  "forget-password": "Your Dray password reset code",
  "sign-in": "Your Dray sign-in code",
  "change-email": "Your Dray email change code",
} as const;

/// Email sign-in and sign-up, off until Bento approves our sending (#1298):
/// no code can go out, so no address can be verified. `EMAIL_SIGN_IN=on`
/// turns it back on, the server's endpoints and the page's Email card alike.
export const emailSignIn = process.env.EMAIL_SIGN_IN === "on";

const emailCodes = emailOTP({
  overrideDefaultEmailVerification: true,
  sendVerificationOnSignUp: true,
  sendVerificationOTP: ({ email, otp, type }) =>
    sendMail({
      to: email,
      subject: OTP_SUBJECT[type],
      text: `Your code is ${otp}. It works for 5 minutes.\n\nIf you didn't ask for it, you can ignore this email.`,
    }),
});

/// The cookie naming how this browser last signed in, read by `/login` to
/// tag that card. Set only alongside a new session, so a cancelled or failed
/// try never moves it; never stored on the account.
export const LAST_METHOD_COOKIE = "dray.last_sign_in";

const lastMethod = lastLoginMethod({
  cookieName: LAST_METHOD_COOKIE,
  // The longest a browser keeps a cookie; the session itself lapses sooner.
  maxAge: 60 * 60 * 24 * 400,
  // A verified code signs in too (`autoSignInAfterVerification`), and every
  // email path is one card.
  customResolveMethod: (ctx) =>
    ctx.path === "/email-otp/verify-email" || ctx.path === "/sign-in/email-otp" ? "email" : null,
});

/// Better Auth for drayhq.com: GitHub, Google, and email with a password
/// whose address is proved by an emailed code; orgs and their members.
/// `nextCookies` lets a server action that signs in or out set its cookie.
export const auth = betterAuth({
  database: pool,
  user: {
    additionalFields: {
      // Written only by `setUsername`, which checks the format and reports a
      // taken one; `input: false` keeps `updateUser` from going around it.
      username: { type: "string", required: false, unique: true, input: false },
      // Taken from the GitHub profile at sign-up, so the app can tell a name
      // that is only the login (a profile with no name) from one typed. Input
      // stays on, or the provider's profile never reaches it; a reader setting
      // their own changes nothing but whether their bots ask their name.
      githubLogin: { type: "string", required: false },
    },
  },
  // Verified before it can sign in, so an address someone merely typed is
  // never merged into the Google or GitHub account that really owns it.
  emailAndPassword: { enabled: emailSignIn, requireEmailVerification: true, minPasswordLength: 8 },
  emailVerification: { sendOnSignIn: true, autoSignInAfterVerification: true },
  account: { accountLinking: { enabled: true, trustedProviders: ["google", "github"] } },
  // A failed provider sign-in lands back on the sign-in page, which says so,
  // rather than on Better Auth's own unstyled error page.
  onAPIError: { errorURL: "/login" },
  socialProviders: {
    google: {
      clientId: process.env.GOOGLE_CLIENT_ID!,
      clientSecret: process.env.GOOGLE_CLIENT_SECRET!,
      prompt: "select_account",
    },
    // Only where its OAuth app is configured, so a site without keys still starts.
    ...(process.env.GITHUB_CLIENT_ID && {
      github: {
        clientId: process.env.GITHUB_CLIENT_ID,
        clientSecret: process.env.GITHUB_CLIENT_SECRET!,
        mapProfileToUser: (profile) => ({ githubLogin: profile.login }),
      },
    }),
  },
  // The page trims the name too; this holds for a sign-up posted straight here.
  hooks: {
    before: createAuthMiddleware(async (ctx) => {
      if (ctx.path !== "/sign-up/email") return;
      const name = typeof ctx.body?.name === "string" ? ctx.body.name.trim() : "";
      if (!name) throw new APIError("BAD_REQUEST", { message: "Enter your name" });
      return { context: { ...ctx, body: { ...ctx.body, name } } };
    }),
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
    // Left out while email is off, or its sign-in route would make accounts.
    ...(emailSignIn ? [emailCodes] : []),
    drayTables,
    lastMethod,
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
