import { headers } from "next/headers";
import { isConvexConfigured } from "@/lib/convex";
import { resolveSite } from "@/lib/site-cache";

/**
 * PER-TENANT sitemap.xml.
 *
 * Same root cause as robots.txt: `[[...slug]]` was answering /sitemap.xml with
 * a rendered page, so a crawler got HTML where XML should be.
 *
 * It lists ONLY what is actually served. Today that is the site root and
 * nothing else — `serviceAreas` sections carry `generatePage: true` and a
 * per-area LocalBusiness landing page is the local-SEO play, but those routes
 * do not exist yet. Listing URLs that 404 is worse than a short sitemap: it
 * teaches a crawler the site is unreliable. When the area routes land, add
 * them here in the same pass.
 *
 * Only a mapped custom domain gets entries. The shared demo origin returns an
 * empty urlset, matching its robots.txt, which disallows everything.
 */

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const EMPTY = '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9"></urlset>\n';

function body(xml: string) {
  return new Response(xml, {
    headers: {
      "content-type": "application/xml; charset=utf-8",
      "cache-control": "public, max-age=3600, s-maxage=3600",
    },
  });
}

export async function GET() {
  if (!isConvexConfigured()) return body(EMPTY);

  const headerList = await headers();
  const host = (headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "")
    .split(":")[0]
    ?.toLowerCase();

  if (!host) return body(EMPTY);

  const result = await resolveSite(host, undefined, false);
  if (!result || result.kind !== "site" || result.isDemo) return body(EMPTY);

  const config = result.config as { seo?: { noindex?: boolean } } | null;
  if (config?.seo?.noindex) return body(EMPTY);

  const url = `https://${host}/`;
  return body(
    '<?xml version="1.0" encoding="UTF-8"?>\n' +
      '<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n' +
      `  <url>\n    <loc>${url}</loc>\n    <changefreq>weekly</changefreq>\n    <priority>1.0</priority>\n  </url>\n` +
      "</urlset>\n",
  );
}
