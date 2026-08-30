import { revalidateTag } from "next/cache";
import { NextResponse } from "next/server";
import { timingSafeEqual } from "node:crypto";

/**
 * REVALIDATION HOOK. Called by Convex after a site config, domain or redirect
 * map is written (see `convex/siteRevalidate.ts`).
 *
 * This is the mechanism that lets `apps/sites` cache resolution without
 * serving stale content: writes push, reads never poll. The fallback
 * `revalidate` in site-cache.ts covers a dropped call; this covers the other
 * 99.9%.
 *
 * Unauthenticated callers must not be able to flush a tenant's cache at will,
 * so it takes a shared secret. Not sensitive data, but a trivially cheap
 * denial-of-service against our Convex bill if left open.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

function secretMatches(supplied: string | null, expected: string): boolean {
  if (!supplied) return false;
  const a = Buffer.from(supplied);
  const b = Buffer.from(expected);
  // timingSafeEqual throws on a length mismatch, which would itself leak length
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export async function POST(request: Request) {
  const expected = process.env.REVALIDATE_SECRET;

  // Fail closed. An unset secret must not mean "anyone may flush the cache".
  if (!expected) {
    console.error("[revalidate] REVALIDATE_SECRET is not set; refusing to revalidate");
    return NextResponse.json({ ok: false, error: "not configured" }, { status: 503 });
  }

  if (!secretMatches(request.headers.get("x-revalidate-secret"), expected)) {
    return NextResponse.json({ ok: false }, { status: 401 });
  }

  let tags: unknown;
  try {
    ({ tags } = (await request.json()) as { tags?: unknown });
  } catch {
    return NextResponse.json({ ok: false, error: "invalid json" }, { status: 400 });
  }

  if (!Array.isArray(tags) || tags.some((t) => typeof t !== "string")) {
    return NextResponse.json({ ok: false, error: "tags must be string[]" }, { status: 400 });
  }

  // Only our own namespace, so a compromised secret cannot flush unrelated
  // caches, and a typo upstream fails loudly instead of silently doing nothing.
  const ours = (tags as string[]).filter((t) => t.startsWith("site:"));
  if (ours.length !== tags.length) {
    return NextResponse.json({ ok: false, error: "tags must start with site:" }, { status: 400 });
  }

  for (const tag of ours) revalidateTag(tag);

  return NextResponse.json({ ok: true, revalidated: ours.length, tags: ours });
}
