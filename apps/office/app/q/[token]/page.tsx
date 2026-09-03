import type { Metadata } from "next";
import { fetchQuery } from "convex/nextjs";
import { api } from "@cc/convex/api";
import { QuoteDocument, QuoteRefusal } from "./QuoteDocument";

/**
 * ONE QUOTE, TO WHOEVER HOLDS THE LINK.
 *
 * The customer-facing half of quoting, and it did not exist: `public/quote.
 * accept` shipped with no page, so the only thing a customer could do with a
 * quote link was agree to a number they had never seen. In practice that meant
 * the quote flow stopped in the back office and the client sent prices over
 * WhatsApp by hand.
 *
 * NO AUTHENTICATION, and the reasoning is the invoice page's exactly: the
 * reader has no account here and never will, the token in the URL is the
 * credential, and `/q/:token` is a declared entry in `lib/public-routes.ts`
 * rather than a gap in the middleware. `office-routes.test.ts` pins that set
 * by equality, so this route had to be added there on purpose.
 *
 * IT PRINTS, like the invoice — same print stylesheet strategy, so a customer
 * who wants a copy for a file or an insurer gets one from their browser and
 * nothing renders a PDF anywhere.
 */

export const metadata: Metadata = {
  title: "Quote",
  /*
   * A tokenised document is not a page anybody should find. `noindex` binds
   * only crawlers that honour it — the token does the real work — but a link
   * pasted into a chat should not also end up in an index.
   */
  robots: { index: false, follow: false },
};

export default async function QuotePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const quote = await fetchQuery(api.public.quote.view, { token }).catch(
    (error: unknown) => {
      /*
       * The refusal sentence is the BACKEND'S. Only it knows whether a link is
       * unknown, withdrawn, or not yet sent, and those need different words:
       * one sends you hunting for a typo, the others tell you to ring the
       * business. A page that guessed would eventually guess wrong.
       */
      const message =
        error instanceof Error && "data" in error
          ? (error.data as { message?: string })?.message
          : undefined;
      return { error: message ?? "that link is not valid" } as const;
    },
  );

  if ("error" in quote) return <QuoteRefusal reason={quote.error} />;

  return <QuoteDocument quote={quote} token={token} />;
}
