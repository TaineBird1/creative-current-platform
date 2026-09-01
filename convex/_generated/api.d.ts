/* eslint-disable */
/**
 * Generated `api` utility.
 *
 * THIS CODE IS AUTOMATICALLY GENERATED.
 *
 * To regenerate, run `npx convex dev`.
 * @module
 */

import type * as auth from "../auth.js";
import type * as bookings from "../bookings.js";
import type * as bootstrap from "../bootstrap.js";
import type * as clients from "../clients.js";
import type * as customers from "../customers.js";
import type * as domains from "../domains.js";
import type * as expenses from "../expenses.js";
import type * as finance from "../finance.js";
import type * as health from "../health.js";
import type * as http from "../http.js";
import type * as income from "../income.js";
import type * as invites from "../invites.js";
import type * as jobs from "../jobs.js";
import type * as ledger from "../ledger.js";
import type * as lib_consent from "../lib/consent.js";
import type * as lib_dns from "../lib/dns.js";
import type * as lib_functions from "../lib/functions.js";
import type * as lib_invites from "../lib/invites.js";
import type * as lib_ledger from "../lib/ledger.js";
import type * as lib_messaging from "../lib/messaging.js";
import type * as lib_money from "../lib/money.js";
import type * as lib_ordering from "../lib/ordering.js";
import type * as lib_places from "../lib/places.js";
import type * as lib_placesBudget from "../lib/placesBudget.js";
import type * as lib_reseller from "../lib/reseller.js";
import type * as lib_suppression from "../lib/suppression.js";
import type * as lib_tenancy from "../lib/tenancy.js";
import type * as lib_vercel from "../lib/vercel.js";
import type * as lib_webhookVerify from "../lib/webhookVerify.js";
import type * as messages from "../messages.js";
import type * as platform from "../platform.js";
import type * as public_brand from "../public/brand.js";
import type * as public_quote from "../public/quote.js";
import type * as public_site from "../public/site.js";
import type * as quoteRequests from "../quoteRequests.js";
import type * as quotes from "../quotes.js";
import type * as seed from "../seed.js";
import type * as services from "../services.js";
import type * as siteConfigs from "../siteConfigs.js";
import type * as siteRevalidate from "../siteRevalidate.js";
import type * as tables_growth from "../tables/growth.js";
import type * as tables_identity from "../tables/identity.js";
import type * as tables_messaging from "../tables/messaging.js";
import type * as tables_money from "../tables/money.js";
import type * as tables_operations from "../tables/operations.js";
import type * as tables_ops from "../tables/ops.js";
import type * as tables_sites from "../tables/sites.js";
import type * as tables_sourcing from "../tables/sourcing.js";
import type * as tables_tenants from "../tables/tenants.js";
import type * as tables_webhooks from "../tables/webhooks.js";
import type * as ventures from "../ventures.js";
import type * as webhooks from "../webhooks.js";

import type {
  ApiFromModules,
  FilterApi,
  FunctionReference,
} from "convex/server";

declare const fullApi: ApiFromModules<{
  auth: typeof auth;
  bookings: typeof bookings;
  bootstrap: typeof bootstrap;
  clients: typeof clients;
  customers: typeof customers;
  domains: typeof domains;
  expenses: typeof expenses;
  finance: typeof finance;
  health: typeof health;
  http: typeof http;
  income: typeof income;
  invites: typeof invites;
  jobs: typeof jobs;
  ledger: typeof ledger;
  "lib/consent": typeof lib_consent;
  "lib/dns": typeof lib_dns;
  "lib/functions": typeof lib_functions;
  "lib/invites": typeof lib_invites;
  "lib/ledger": typeof lib_ledger;
  "lib/messaging": typeof lib_messaging;
  "lib/money": typeof lib_money;
  "lib/ordering": typeof lib_ordering;
  "lib/places": typeof lib_places;
  "lib/placesBudget": typeof lib_placesBudget;
  "lib/reseller": typeof lib_reseller;
  "lib/suppression": typeof lib_suppression;
  "lib/tenancy": typeof lib_tenancy;
  "lib/vercel": typeof lib_vercel;
  "lib/webhookVerify": typeof lib_webhookVerify;
  messages: typeof messages;
  platform: typeof platform;
  "public/brand": typeof public_brand;
  "public/quote": typeof public_quote;
  "public/site": typeof public_site;
  quoteRequests: typeof quoteRequests;
  quotes: typeof quotes;
  seed: typeof seed;
  services: typeof services;
  siteConfigs: typeof siteConfigs;
  siteRevalidate: typeof siteRevalidate;
  "tables/growth": typeof tables_growth;
  "tables/identity": typeof tables_identity;
  "tables/messaging": typeof tables_messaging;
  "tables/money": typeof tables_money;
  "tables/operations": typeof tables_operations;
  "tables/ops": typeof tables_ops;
  "tables/sites": typeof tables_sites;
  "tables/sourcing": typeof tables_sourcing;
  "tables/tenants": typeof tables_tenants;
  "tables/webhooks": typeof tables_webhooks;
  ventures: typeof ventures;
  webhooks: typeof webhooks;
}>;

/**
 * A utility for referencing Convex functions in your app's public API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = api.myModule.myFunction;
 * ```
 */
export declare const api: FilterApi<
  typeof fullApi,
  FunctionReference<any, "public">
>;

/**
 * A utility for referencing Convex functions in your app's internal API.
 *
 * Usage:
 * ```js
 * const myFunctionReference = internal.myModule.myFunction;
 * ```
 */
export declare const internal: FilterApi<
  typeof fullApi,
  FunctionReference<any, "internal">
>;

export declare const components: {};
