import { headers } from "next/headers";
import { permanentRedirect, redirect } from "next/navigation";
import type { Metadata } from "next";
import { safeParseSiteConfig } from "@cc/site-config";
import { isConvexConfigured } from "@/lib/convex";
import { resolveSite, redirectFor, type ResolvedSite } from "@/lib/site-cache";
import { SiteRenderer } from "@/components/SiteRenderer";
import { HoldingPage } from "@/components/HoldingPage";
import { NotConnected } from "@/components/NotConnected";
import { submitQuoteAction } from "../actions";

/**
 * MULTI-TENANT RESOLUTION (Part 1).
 *
 *   Host -> custom domain -> slug -> ?site= preview param.
 *
 * A client's domain serves only their public site. There is exactly one place
 * a tenant is chosen — `resolve` in convex/public/site.ts — and it returns
 * either a published config, a canonical redirect, or a holding reason. It
 * never returns a partial site, so this route has no path that could fall
 * through to another tenant's content.
 */

/**
 * There is deliberately no `dynamic = "force-dynamic"` here.
 *
 * Reading `headers()` for host-based tenancy makes this route render per
 * request regardless — but the Convex call underneath it is cached and
 * tag-invalidated (lib/site-cache.ts), so a busy site serves thousands of
 * pageviews on one round trip to Ireland. Convex spend scales with bookings
 * and admin usage, not with traffic. Do not reintroduce a per-request query
 * on this path.
 */

type Params = { params: Promise<{ slug?: string[] }>; searchParams: Promise<{ site?: string }> };

async function resolve(
  params: Params["params"],
  searchParams: Params["searchParams"],
): Promise<{ state: "unconfigured" } | { state: "resolved"; result: ResolvedSite; path: string }> {
  if (!isConvexConfigured()) return { state: "unconfigured" };

  const [{ slug: segments }, { site }, headerList] = await Promise.all([
    params,
    searchParams,
    headers(),
  ]);

  const host = (headerList.get("x-forwarded-host") ?? headerList.get("host") ?? "")
    .split(":")[0]
    ?.toLowerCase();

  // ?site= is a preview escape hatch; the path's first segment is the slug
  // when we are serving from the shared origin rather than a custom domain.
  const slug = site ?? segments?.[0];
  const path = "/" + (segments ?? []).join("/");

  // A preview must never be served from cache — the whole point of ?site= is
  // seeing the change you just made.
  const result = await resolveSite(host ?? "", slug, Boolean(site));
  if (!result) return { state: "unconfigured" };
  return { state: "resolved", result, path };
}

export async function generateMetadata({ params, searchParams }: Params): Promise<Metadata> {
  const resolved = await resolve(params, searchParams);
  if (resolved.state !== "resolved" || resolved.result.kind !== "site") {
    // A holding page must not inherit the last tenant's title.
    return { title: "Not available", robots: { index: false, follow: false } };
  }
  const parsed = safeParseSiteConfig(resolved.result.config);
  if (!parsed.success) return { title: "Not available", robots: { index: false } };

  const { seo, brand } = parsed.data;
  return {
    title: seo.title,
    description: seo.description,
    // A demo must never be indexed. It carries a real business's name.
    robots:
      seo.noindex || resolved.result.isDemo
        ? { index: false, follow: false }
        : { index: true, follow: true },
    openGraph: { title: seo.title, description: seo.description, siteName: brand.name },
  };
}

export default async function SitePage({ params, searchParams }: Params) {
  const resolved = await resolve(params, searchParams);

  if (resolved.state === "unconfigured") return <NotConnected />;

  const { result, path } = resolved;

  if (result.kind === "redirect") {
    // A retired slug is permanent — installed PWAs and printed QR codes
    // depend on it resolving forever.
    permanentRedirect(`/${result.to}${path === "/" ? "" : path}`);
  }

  if (result.kind === "holding") {
    return <HoldingPage reason={result.reason} />;
  }

  // Parse on read as well as on write. A config stored by an older deploy must
  // degrade to the holding page, never crash the render.
  const parsed = safeParseSiteConfig(result.config);
  if (!parsed.success) return <HoldingPage reason="invalid" />;

  // Legacy 301s from the site we replaced, checked only for paths we would
  // otherwise 404 on.
  if (path !== "/" && path !== `/${result.slug}`) {
    const hit = await redirectFor(result.slug, path);
    if (hit) redirect(hit.to);
  }

  return (
    <SiteRenderer
      config={parsed.data}
      slug={result.slug}
      onQuoteSubmit={async (payload) => {
        "use server";
        const outcome = await submitQuoteAction({
          slug: result.slug,
          sectionId: String(payload.sectionId),
          name: String(payload.name),
          phone: String(payload.phone),
          answers: (payload.answers ?? {}) as Record<string, string>,
          consentAccepted: Boolean(payload.consentAccepted),
        });
        if (!outcome.ok) throw new Error(outcome.message);
      }}
    />
  );
}
