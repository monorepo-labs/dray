import { organizationClient } from "better-auth/client/plugins";
import { createAuthClient } from "better-auth/react";

/// The browser's half of `auth.ts`, talking to `/api/auth` on this origin.
export const authClient = createAuthClient({ plugins: [organizationClient()] });
