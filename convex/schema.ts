import { defineSchema } from "convex/server";
import { authTables } from "@convex-dev/auth/server";

import { identityTables } from "./tables/identity";
import { tenantTables } from "./tables/tenants";
import { siteTables } from "./tables/sites";
import { operationsTables } from "./tables/operations";
import { messagingTables } from "./tables/messaging";
import { moneyTables } from "./tables/money";
import { growthTables } from "./tables/growth";
import { opsTables } from "./tables/ops";
import { webhookTables } from "./tables/webhooks";
import { sourcingTables } from "./tables/sourcing";

/**
 * THE CREATIVE CURRENT — single Convex backend.
 *
 * Tenancy keying, in one paragraph:
 *   `clients` is the tenant. Every tenant-owned row carries `clientId` as its
 *   FIRST index field, so a scoped read cannot be written without naming the
 *   tenant. `memberships` maps userId -> clientId and is the only authority
 *   on access. Platform-owned rows (leads, geoAreas, sequences, deals) carry
 *   `ventureId` and never `clientId`. There is no third category.
 *
 *   `authTables` brings `users`. A user row with no `memberships` and no
 *   `platformMembers` row can reach nothing — that is what "no bare user
 *   rows" means in practice, and it is asserted in tenancy.test.ts.
 */
export default defineSchema({
  ...authTables,
  ...identityTables,
  ...tenantTables,
  ...siteTables,
  ...operationsTables,
  ...messagingTables,
  ...moneyTables,
  ...growthTables,
  ...opsTables,
  ...webhookTables,
  ...sourcingTables,
});

/** Tables whose rows belong to exactly one tenant. Asserted by the guard test. */
export const TENANT_SCOPED_TABLES = [
  "locations", "sites", "domains", "redirects", "services", "customers",
  "consents", "bookings", "blockouts", "quoteRequests", "quotes", "jobs",
  "reviewRequests", "clientSlugAliases",
  "journeyEnrolments", "queries", "queryMessages", "onboardingItems",
  "propertyUnits", "propertyBookings", "siteChecks",
] as const;

/** Tables owned by the platform. Reachable only via requirePlatform. */
export const PLATFORM_SCOPED_TABLES = [
  "ventures", "geoAreas", "leads", "suppressions", "companies", "contacts",
  "sequences", "sequenceEnrolments", "dispositions", "deals", "agents",
  "commissionPlans", "commissions", "platformMembers", "impersonationSessions",
] as const;

/** Append-only. No patch, no delete. Asserted by immutability tests. */
export const IMMUTABLE_TABLES = ["ledgerEntries", "auditLog", "consents", "webhookEvents", "apiSpend"] as const;
