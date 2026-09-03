import type { Metadata } from "next";
import { fetchQuery } from "convex/nextjs";
import { api } from "@cc/convex/api";
import { InvoiceDocument, InvoiceRefusal } from "./InvoiceDocument";

/**
 * ONE INVOICE, TO WHOEVER HOLDS THE LINK.
 *
 * This is the client-facing half of invoicing, and it is deliberately the
 * half that was built first. The owner can issue from the CLI; the client
 * cannot receive a document that has nowhere to be read.
 *
 * NO AUTHENTICATION, AND THAT IS THE DESIGN. The person who most needs to
 * open this is the client's bookkeeper — somebody with no account here, who
 * will never have one. A login in front of an invoice is an invoice that does
 * not get opened, which is an invoice that does not get paid. The token in
 * the URL is the credential, it is 256 random bits, it is revocable, and
 * `public/invoice.view` is written so it can reach exactly this document and
 * nothing else.
 *
 * The middleware DOES see this path and lets it through DELIBERATELY. It used
 * to fall through by omission — the middleware listed what was protected, so
 * anything unlisted was public — and an exception that exists as an absence
 * is one that a later catch-all removes without anybody noticing, killing
 * every invoice link already sitting in a client's inbox. `/i/:token` is now
 * a named entry in `lib/public-routes.ts`, which is the only list of paths
 * that may be reached without a session, and `office-routes.test.ts` asserts
 * that list EQUALS its intended set in both directions.
 *
 * IT PRINTS. That is the entire PDF strategy — a print stylesheet below, and
 * "save as PDF" in any browser covers the bookkeeping case. No PDF is ever
 * rendered in a Convex action, no storage is consumed, and nothing has to be
 * regenerated when a payment lands. If a real client asks for an attachment,
 * that is the moment to build one; they may not ask.
 */

export const metadata: Metadata = {
  title: "Invoice",
  /*
   * A tokenised document is not a web page anybody should find. `noindex`
   * only binds crawlers that honour it, which is why the token is doing the
   * actual work — but a link pasted into a chat whose preview scraper follows
   * it should not also end up in an index.
   */
  robots: { index: false, follow: false },
};

export default async function InvoicePage({
  params,
}: {
  params: Promise<{ token: string }>;
}) {
  const { token } = await params;

  const doc = await fetchQuery(api.public.invoice.view, { token }).catch(
    (error: unknown) => {
      /*
       * The REFUSAL SENTENCE is the backend's, not this page's — same rule as
       * the demo quote form. `public/invoice.view` is the only thing that
       * knows whether a link is unknown or withdrawn, and those need different
       * sentences: one sends you looking for a typo, the other tells you to
       * ask for a fresh link. A page that guessed would eventually guess wrong.
       */
      const message =
        error instanceof Error && "data" in error
          ? (error.data as { message?: string })?.message
          : undefined;
      return { error: message ?? "that link is not valid" } as const;
    },
  );

  if ("error" in doc) return <InvoiceRefusal reason={doc.error} />;

  return <InvoiceDocument doc={doc} />;
}
