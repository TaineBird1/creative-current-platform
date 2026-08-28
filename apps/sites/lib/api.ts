import { makeFunctionReference } from "convex/server";

/**
 * THE ONE SEAM between this app and the backend.
 *
 * Normally these would come from `convex/_generated/api`, which infers arg and
 * return types straight from the function definitions. That directory is
 * produced by `npx convex dev`, which requires a Convex login — so until the
 * deployment exists, importing it makes the whole app unbuildable.
 *
 * makeFunctionReference is the supported escape hatch: the reference resolves
 * by path at runtime, and the types are declared here instead of inferred.
 * The cost is that these declarations can drift from the real signatures, so
 * they are kept in ONE file, mirrored from the source, and `api.test.ts`
 * asserts every path here exists as an exported function in convex/.
 *
 * AFTER `npx convex dev` runs once, this file can be deleted and every import
 * of it swapped for `convex/_generated/api`. Nothing else changes.
 */

export type ResolvedSite =
  | { kind: "site"; slug: string; config: unknown; isDemo: boolean }
  | { kind: "redirect"; to: string }
  | { kind: "holding"; reason: "unknown" | "unpublished" | "expired" | "invalid" };

/** convex/public/site.ts -> resolve */
export const resolveSite = makeFunctionReference<
  "query",
  { host?: string; slug?: string },
  ResolvedSite
>("public/site:resolve");

/** convex/public/site.ts -> redirectFor */
export const redirectFor = makeFunctionReference<
  "query",
  { slug: string; path: string },
  { to: string; statusCode: 301 | 302 | 308 } | null
>("public/site:redirectFor");

/** convex/public/quote.ts -> submit */
export const submitQuote = makeFunctionReference<
  "mutation",
  {
    slug: string;
    sectionId: string;
    name: string;
    phone: string;
    email?: string;
    answers: Record<string, string>;
    photoStorageIds?: string[];
    consentAccepted: boolean;
    userAgent?: string;
  },
  { ok: true; requestId: string }
>("public/quote:submit");

/** Every path declared above, for the drift test. */
export const FUNCTION_PATHS = [
  "public/site:resolve",
  "public/site:redirectFor",
  "public/quote:submit",
] as const;
