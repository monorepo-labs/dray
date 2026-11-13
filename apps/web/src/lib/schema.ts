import type { BetterAuthPlugin } from "better-auth";

/// Dray's own tables, declared as a Better Auth plugin so `pnpm db:migrate`
/// creates them beside the auth tables and one command keeps the database
/// whole. Nothing here adds endpoints; the rows are read and written with SQL.
///
/// `server` is a Dray server linked to an org. `serverAccess` is its allow
/// list: who may connect an assistant to it. A row there says nothing about
/// membership, so a check must also find the user in `member` — removing
/// someone from an org leaves their rows behind on purpose.
export const drayTables = {
  id: "dray-tables",
  schema: {
    server: {
      modelName: "server",
      fields: {
        organizationId: {
          type: "string",
          required: true,
          index: true,
          references: { model: "organization", field: "id", onDelete: "cascade" },
        },
        name: { type: "string", required: true },
        linkedBy: {
          type: "string",
          required: false,
          references: { model: "user", field: "id", onDelete: "set null" },
        },
        linkedAt: { type: "date", required: true, defaultValue: () => new Date() },
        // The server's own credential, hashed. Lives on the row so deleting
        // the row — unlinking — revokes it with nothing else to remember.
        tokenHash: { type: "string", required: false, unique: true },
      },
    },
    // A device-code link in flight: made by a server asking to be linked,
    // approved at /link, claimed by the server's poll and then deleted.
    serverLink: {
      modelName: "server_link",
      fields: {
        deviceCodeHash: { type: "string", required: true, unique: true },
        userCode: { type: "string", required: true, unique: true },
        name: { type: "string", required: true },
        // The row this server already holds, found by the credential it sent,
        // so approving moves that row rather than making a second one.
        serverId: {
          type: "string",
          required: false,
          references: { model: "server", field: "id", onDelete: "set null" },
        },
        // The credential that row held when the code was made. A claim moves
        // the row only while it still holds it, so a code minted under a
        // credential since replaced can't move the server again.
        serverTokenHash: { type: "string", required: false },
        expiresAt: { type: "date", required: true },
        organizationId: {
          type: "string",
          required: false,
          references: { model: "organization", field: "id", onDelete: "cascade" },
        },
        approvedBy: {
          type: "string",
          required: false,
          references: { model: "user", field: "id", onDelete: "cascade" },
        },
        denied: { type: "boolean", required: true, defaultValue: false },
      },
    },
    serverAccess: {
      modelName: "server_access",
      fields: {
        serverId: {
          type: "string",
          required: true,
          references: { model: "server", field: "id", onDelete: "cascade" },
        },
        userId: {
          type: "string",
          required: true,
          references: { model: "user", field: "id", onDelete: "cascade" },
        },
      },
      indexes: [{ fields: ["serverId", "userId"], unique: true }],
    },
    // A user's link to the Dray GitHub App (#1013). Their user token is kept
    // only to ask GitHub, at each create and token mint, whether they can still
    // push to the repo; machines get installation tokens, never this one.
    // Deleting the row is disconnecting, and stops every machine's next mint.
    githubAccount: {
      modelName: "github_account",
      fields: {
        userId: {
          type: "string",
          required: true,
          unique: true,
          references: { model: "user", field: "id", onDelete: "cascade" },
        },
        githubId: { type: "number", required: true },
        login: { type: "string", required: true },
        // Sealed by `vault.ts`, bound to the user id.
        accessToken: { type: "string", required: true },
        accessExpiresAt: { type: "date", required: true },
        refreshToken: { type: "string", required: true },
        refreshExpiresAt: { type: "date", required: true },
        connectedAt: { type: "date", required: true, defaultValue: () => new Date() },
      },
    },
  },
} satisfies BetterAuthPlugin;
