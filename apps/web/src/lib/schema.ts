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
    // A user's Dray Cloud plan, mirrored from its Stripe subscription by the
    // webhook. The overage switch and cap are Dray's own and live only here.
    cloudBilling: {
      modelName: "cloud_billing",
      fields: {
        userId: {
          type: "string",
          required: true,
          unique: true,
          references: { model: "user", field: "id", onDelete: "cascade" },
        },
        stripeCustomerId: { type: "string", required: true, unique: true },
        stripeSubscriptionId: { type: "string", required: false, unique: true },
        plan: { type: "string", required: false },
        status: { type: "string", required: false },
        periodStart: { type: "date", required: false },
        periodEnd: { type: "date", required: false },
        cancelAtPeriodEnd: { type: "boolean", required: true, defaultValue: false },
        overage: { type: "boolean", required: true, defaultValue: false },
        overageCapCents: { type: "number", required: false },
        // Overage minutes Stripe confirmed for the period starting at
        // `reportedFor`, so each report sends only what is new.
        reportedMinutes: { type: "number", required: true, defaultValue: 0 },
        reportedFor: { type: "date", required: false },
        // The one report in flight, written before it is sent: `pendingTotal`
        // minutes for the period at `pendingFor` once it lands. Retried as is
        // until Stripe answers, so a lost answer is never sent twice.
        pendingTotal: { type: "number", required: false },
        pendingFor: { type: "date", required: false },
        pendingAt: { type: "date", required: false },
      },
    },
    // Boat's meter for one machine over one billing period, as last read.
    // Kept per period so a deleted machine's time still counts after boat
    // forgets it.
    cloudUsage: {
      modelName: "cloud_usage",
      fields: {
        sandboxId: { type: "string", required: true },
        userId: {
          type: "string",
          required: true,
          index: true,
          references: { model: "user", field: "id", onDelete: "cascade" },
        },
        periodStart: { type: "date", required: true },
        seconds: { type: "number", required: true },
        running: { type: "boolean", required: true },
        readAt: { type: "date", required: true },
      },
      indexes: [{ fields: ["sandboxId", "periodStart"], unique: true }],
    },
  },
} satisfies BetterAuthPlugin;
