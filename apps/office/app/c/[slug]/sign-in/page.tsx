import { fetchQuery } from "convex/nextjs";
import { api } from "@cc/convex/api";
import { SignIn } from "@/components/SignIn";
import { accentStyle } from "@/lib/accent-css";

/**
 * The client's door, in their own brand.
 *
 * The brand is fetched BEFORE authentication, from a query that returns only
 * name and accent ramp — everything on it already appears on that client's
 * public website. An unknown slug falls back to unbranded rather than 404ing:
 * someone mistyping their own business name should still be able to sign in
 * once they fix it, not hit a dead end.
 */
export default async function ClientSignIn({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  const brand = await fetchQuery(api.public.brand.forSignIn, { slug }).catch(() => null);

  return (
    <SignIn
      world="client"
      businessName={brand?.name}
      accent={brand?.accent ? accentStyle(brand.accent) : undefined}
      redirectTo={`/c/${slug}`}
    />
  );
}
