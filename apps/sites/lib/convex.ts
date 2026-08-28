import "server-only";
import { ConvexHttpClient } from "convex/browser";

/**
 * Server-side Convex client. The public site is server-rendered, so no Convex
 * code reaches the browser bundle at all — that is most of the LCP budget on a
 * mid-range Android, and it means a client's site does not ship a websocket to
 * a customer who only wants a phone number.
 *
 * Returns null when the deployment is not configured yet, rather than throwing.
 * A missing env var should produce a clear notice in dev and a branded holding
 * page in production, never a stack trace on a client's live domain.
 */
export function convexClient(): ConvexHttpClient | null {
  const url = process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL;
  if (!url) return null;
  return new ConvexHttpClient(url);
}

export const isConvexConfigured = () =>
  Boolean(process.env.CONVEX_URL ?? process.env.NEXT_PUBLIC_CONVEX_URL);
