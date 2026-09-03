import type { Metadata } from "next";
import { fetchQuery } from "convex/nextjs";
import { api } from "@cc/convex/api";
import s from "./invoice.module.css";

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

/** Rands from integer cents. Never float arithmetic on money. */
function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function day(at: number | null): string | null {
  if (at === null) return null;
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(at));
}

/**
 * What the reader is told about payment, in one place.
 *
 * A void invoice must not read as payable and an overpaid one must not read
 * as owing — both of those are a customer paying the wrong amount because a
 * page was written for the ordinary case only.
 */
function statement(doc: {
  settlement: string;
  owedCents: number;
  creditCents: number;
  overdue: boolean;
  currency: string;
}): { label: string; detail: string; tone: "owing" | "settled" | "void" | "overdue" } {
  switch (doc.settlement) {
    case "void":
      return {
        label: "Cancelled",
        detail: "This invoice was cancelled. Nothing is owed on it.",
        tone: "void",
      };
    case "settled":
      return { label: "Paid in full", detail: "Thank you — nothing further is due.", tone: "settled" };
    case "overpaid":
      return {
        label: "Overpaid",
        detail: `We are holding ${money(doc.creditCents, doc.currency)} of yours. It comes off your next invoice unless you would rather have it back.`,
        tone: "settled",
      };
    case "part_paid":
      return {
        label: "Part paid",
        detail: `${money(doc.owedCents, doc.currency)} still to pay.`,
        tone: doc.overdue ? "overdue" : "owing",
      };
    default:
      return {
        label: doc.overdue ? "Overdue" : "Due",
        detail: `${money(doc.owedCents, doc.currency)} to pay.`,
        tone: doc.overdue ? "overdue" : "owing",
      };
  }
}

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

  if ("error" in doc) {
    return (
      <main className={`world-client ${s.page}`}>
        <div className={s.refusal}>
          <h1 className={s.refusalTitle}>This link did not open an invoice</h1>
          <p className={s.refusalReason}>{doc.error}.</p>
          <p className={s.refusalHelp}>
            Reply to the email this link came from and we will send another.
          </p>
        </div>
      </main>
    );
  }

  const state = statement(doc);
  const issued = day(doc.issuedAt);
  const due = day(doc.dueAt);

  return (
    /*
     * WORLD-CLIENT WITH NO ACCENT INJECTED, which is a decision rather than an
     * omission.
     *
     * It is not the admin world: that ground is dark ink, and a dark document
     * prints as a black rectangle or as nothing, depending on the browser.
     * It is not the client world proper either — this document is OURS, and
     * wearing the client's brand colour on an invoice we are sending THEM
     * states the wrong relationship on the one page where who-owes-whom has
     * to be unambiguous.
     *
     * So: the warm light ground, and the accent tokens left at their ink
     * fallbacks. No colour on the page except the signal tones, which are
     * about money rather than about brand.
     */
    <main className={`world-client ${s.page}`}>
      <article className={s.doc}>
        <header className={s.masthead}>
          <div className={s.issuer}>
            <h1 className={s.issuerName}>{doc.issuerLegalName}</h1>
            {doc.issuer?.tradingName && (
              <p className={s.tradingName}>t/a {doc.issuer.tradingName}</p>
            )}
            <address className={s.address}>
              {doc.issuer?.addressLine}
              {doc.issuer?.suburb ? <>, {doc.issuer.suburb}</> : null}
              <br />
              {doc.issuer?.city}
              {doc.issuer?.postalCode ? <> {doc.issuer.postalCode}</> : null}
              <br />
              {doc.issuer?.email}
              {doc.issuer?.phone ? (
                <>
                  <br />
                  {doc.issuer.phone}
                </>
              ) : null}
            </address>
            {doc.issuerRegistrationNumber && (
              <p className={s.reg}>Reg. {doc.issuerRegistrationNumber}</p>
            )}
            {/*
              No VAT line and no VAT number while unregistered. Charging VAT
              you are not registered for is a much worse problem than not
              charging it, and a document that shows a blank VAT field invites
              somebody to fill it in.
            */}
            {doc.issuerVatNumber && <p className={s.reg}>VAT {doc.issuerVatNumber}</p>}
          </div>

          <div className={s.identity}>
            <p className={s.kicker}>Invoice</p>
            <p className={s.number}>{doc.number}</p>
            {doc.billToName && (
              <>
                <p className={s.kicker}>Billed to</p>
                <p className={s.billTo}>{doc.billToName}</p>
              </>
            )}
            {issued && (
              <>
                <p className={s.kicker}>Issued</p>
                <p className={s.date}>{issued}</p>
              </>
            )}
          </div>
        </header>

        <section className={s.status} data-tone={state.tone}>
          <p className={s.statusLabel}>{state.label}</p>
          <p className={s.statusDetail}>{state.detail}</p>
        </section>

        <table className={s.lines}>
          <thead>
            <tr>
              <th scope="col">Description</th>
              <th scope="col" className={s.num}>
                Qty
              </th>
              <th scope="col" className={s.num}>
                Unit
              </th>
              <th scope="col" className={s.num}>
                Amount
              </th>
            </tr>
          </thead>
          <tbody>
            {doc.lineItems.map((line, i) => (
              <tr key={i}>
                <td>{line.description}</td>
                <td className={s.num}>{line.quantity}</td>
                <td className={s.num}>{money(line.unitPriceCents, doc.currency)}</td>
                <td className={s.num}>{money(line.lineTotalCents, doc.currency)}</td>
              </tr>
            ))}
          </tbody>
          <tfoot>
            {/* The subtotal is only worth a row when something sits beside it. */}
            {doc.taxFlag && (
              <>
                <tr>
                  <th scope="row" colSpan={3}>
                    Subtotal
                  </th>
                  <td className={s.num}>{money(doc.subtotalCents, doc.currency)}</td>
                </tr>
                <tr>
                  <th scope="row" colSpan={3}>
                    VAT
                  </th>
                  <td className={s.num}>{money(doc.taxCents, doc.currency)}</td>
                </tr>
              </>
            )}
            <tr className={s.totalRow}>
              <th scope="row" colSpan={3}>
                Total
              </th>
              <td className={s.num}>{money(doc.totalCents, doc.currency)}</td>
            </tr>
            {doc.paidCents !== 0 && (
              <tr>
                <th scope="row" colSpan={3}>
                  Paid
                </th>
                <td className={s.num}>{money(doc.paidCents, doc.currency)}</td>
              </tr>
            )}
          </tfoot>
        </table>

        {doc.settlement !== "settled" && doc.settlement !== "void" && (
          <section className={s.pay}>
            <h2 className={s.payTitle}>How to pay</h2>

            {/*
              THE REFERENCE FIRST, and given its own block. It is the one thing
              on this page a person has to retype into a banking app, and a
              payment that arrives without it is money nobody can place against
              an invoice. Everything else here can be looked up again; this
              cannot be recovered after the fact.
            */}
            <div className={s.reference}>
              <p className={s.kicker}>Use this reference</p>
              <p className={s.referenceValue}>{doc.paymentReference}</p>
            </div>

            {doc.issuer?.bank ? (
              <dl className={s.bank}>
                <dt>Bank</dt>
                <dd>{doc.issuer.bank.name}</dd>
                <dt>Account name</dt>
                <dd>{doc.issuer.bank.accountName}</dd>
                <dt>Account number</dt>
                <dd className={s.mono}>{doc.issuer.bank.accountNumber}</dd>
                <dt>Branch code</dt>
                <dd className={s.mono}>{doc.issuer.bank.branchCode}</dd>
              </dl>
            ) : (
              /*
               * All four bank fields or none — a half-printed block is worse
               * than an absent one, because somebody transcribes an account
               * number that has no branch code beside it and the payment
               * bounces a week later.
               */
              <p className={s.noBank}>
                Reply to the email this came from for payment details.
              </p>
            )}

            {due && (
              <p className={s.terms}>
                Due {due} — {doc.paymentTermsDays} day
                {doc.paymentTermsDays === 1 ? "" : "s"} from issue.
              </p>
            )}
          </section>
        )}

        <footer className={s.footer}>
          <p>
            {/*
              Said out loud because the reader is about to close the tab and
              will want it back. The link is theirs, it keeps working, and
              knowing that is what stops the "can you resend it" email.
            */}
            Keep this link — it stays live and always shows the current balance.
            Print it or save it as a PDF from your browser.
          </p>
        </footer>
      </article>
    </main>
  );
}
