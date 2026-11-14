import type { BetterAuthPlugin } from "better-auth";

/// Dray's own tables, declared as a Better Auth plugin so `pnpm db:migrate`
/// creates them beside the auth tables and one command keeps the database
/// whole. Nothing here adds endpoints; the rows are read and written with SQL.
///
/// `server` is a Dray server linked to an org. `serverAccess` is its allow
/// list: who may connect an assistant to it, checked at sign-in and again by
/// the server on every MCP call. A row there says nothing about
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
    // An assistant's MCP sign-in, pushed here by the server with its own
    // credential before the browser arrives at /connect/<id>. Pushing is what
    // makes `returnUrl` trustworthy: only the server could have named it.
    // Deleted when answered.
    mcpSignIn: {
      modelName: "mcp_sign_in",
      fields: {
        serverId: {
          type: "string",
          required: true,
          references: { model: "server", field: "id", onDelete: "cascade" },
        },
        returnUrl: { type: "string", required: true },
        // The server's own handle on its waiting flow, signed into the
        // assertion as `nonce` so it can't be spent on another.
        state: { type: "string", required: true },
        client: { type: "string", required: true },
        redirectHost: { type: "string", required: true },
        expiresAt: { type: "date", required: true },
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
  },
} satisfies BetterAuthPlugin;
