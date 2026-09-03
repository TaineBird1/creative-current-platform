import { SignIn } from "@/components/SignIn";

/**
 * THE CLIENT'S DOOR — AND IT LOOKS THE SAME FOR EVERY SLUG, INCLUDING ONES
 * THAT DO NOT EXIST.
 *
 * This page used to fetch the client's name and accent ramp before
 * authenticating and render their brand on the sign-in screen. It was a nice
 * touch and it leaked the client roster.
 *
 * The reasoning that allowed it considered only the per-item disclosure: a
 * business's name and brand colour are already on their own public website,
 * so showing them here discloses nothing new. That is true and it is the
 * wrong unit of analysis. What a branded door discloses is MEMBERSHIP — that
 * this particular business is a Creative Current client — and the aggregate
 * of those answers is the client roster. Anybody could build it: point a
 * wordlist of KZN solar installers at `/c/<slug>/sign-in` and read which ones
 * come back branded. That list is precisely the asset the outreach engine
 * exists to construct, and it is the one a competitor would most like to have.
 *
 * A branded pre-auth door and an unenumerable one are mutually exclusive, so
 * this is a real trade and the branding is what goes. The back office itself
 * is still fully white-labelled — see `clients.brand`, which is tenant-scoped
 * and answers only for a caller who already has a membership.
 *
 * IT MAKES NO QUERY, and that is the whole change. The slug is still read —
 * but only to say where to go AFTER signing in, which discloses nothing: the
 * visitor typed that URL, and being redirected to it proves only that they
 * typed it. What is gone is every branch whose OUTPUT differs by slug. The
 * page a stranger sees is byte-identical whether the business is a client,
 * was never a client, or does not exist.
 *
 * `businessName` and `accent` are deliberately not passed. SignIn falls back
 * to "The Creative Current", which is the correct thing for a door on our own
 * origin to say.
 */
export default async function ClientSignIn({
  params,
}: {
  params: Promise<{ slug: string }>;
}) {
  const { slug } = await params;
  return <SignIn world="client" redirectTo={`/c/${slug}`} />;
}
