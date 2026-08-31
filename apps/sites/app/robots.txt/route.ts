import { headers } from "next/headers";
import { isConvexConfigured } from "@/lib/convex";
import { resolveSite } from "@/lib/site-cache";

/**
 * PER-TENANT robots.txt.
 *
 * This exists because `[[...slug]]` was answering /robots.txt with a rendered
 * HTML page — a crawler asking for the file received `<!DOCTYPE html>`, which
 * Lighthouse reported as "robots.txt is not valid" and which every real
 * crawler would treat the same way. A static segment beats the catch-all, so
 * simply having this route fixes that.
 *
 * The rule that matters is the ORIGIN one. robots.txt is scoped to a host, not
 * a path, so on the shared origin — sites.thecreativecurrent.co.za, which
 * serves demos by path — there is no per-tenant answer to give. Every demo is
 * noindex by design and carries a real business's name, so the only correct
 * response for that origin is to disallow everything.
 *
 * A custom domain maps 1:1 to a tenant, so it gets a real answer: allow, and
 * point at that tenant's sitemap. A demo or an explicitly noindexed site on
 * its own domain is still disallowed.
 *
 * How we tell them apart costs nothing: resolving by host with no slug
 * succeeds only for a mapped custom domain. The shared origin, an unknown
 * host, and an unconfigured deployment all fall through to the same safe
 * answer.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const DISALLOW_ALL = "User-agent: *\nDisallow: /\n";

function body(text: string) {
  return new Response(text, {
    headers: {
      "content-type": "text/plain; charset=utf-8",
      // Crawlers re-fetch this rarely; an hour keeps a publish visible without
      // making it a per-request lookup.
      "cache-control": "public, max-age=3600, s-maxage=3600",
    },
  });
}

export async function GET() {
  if (!isConvexConfigured()) return body(DISALLOW_ALL);

  const headerList = await headers();
  const host = (headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "")
    .split(":")[0]
    ?.toLowerCase();

  if (!host) return body(DISALLOW_ALL);

  // No slug: this succeeds only when the host itself is a mapped custom domain.
  const result = await resolveSite(host, undefined, false);
  if (!result || result.kind !== "site") return body(DISALLOW_ALL);

  // A demo must never be indexed. It carries a real business's name and is not
  // theirs yet.
  if (result.isDemo) return body(DISALLOW_ALL);

  const config = result.config as { seo?: { noindex?: boolean } } | null;
  if (config?.seo?.noindex) return body(DISALLOW_ALL);

  return body(`User-agent: *\nAllow: /\n\nSitemap: https://${host}/sitemap.xml\n`);
}
