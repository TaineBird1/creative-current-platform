import type { InvoiceView } from "@cc/convex-src/public/invoice";
import s from "./invoice.module.css";

/**
 * THE DOCUMENT ITSELF, WITH NO IDEA WHERE ITS DATA CAME FROM.
 *
 * Split out of `page.tsx` so the preview harness can render THIS FILE against
 * fixtures. That is the same rule the bookings harness follows and it is the
 * only thing that makes either of them worth having: a harness that renders a
 * COPY of the markup stops telling the truth the first time somebody edits one
 * of the two, and does it silently, which is worse than having no harness at
 * all.
 *
 * It takes a plain object and returns markup. No fetching, no Convex import
 * beyond the type, nothing that could reach a real client's invoice — which is
 * what lets `app/preview` import it without breaking the FIXTURES-ONLY guard.
 */

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


export function InvoiceRefusal({ reason }: { reason: string }) {
  return (
    <main className={`world-client ${s.page}`}>
            <div className={s.refusal}>
              <h1 className={s.refusalTitle}>This link did not open an invoice</h1>
              <p className={s.refusalReason}>{reason}.</p>
              <p className={s.refusalHelp}>
                Reply to the email this link came from and we will send another.
              </p>
            </div>
          </main>
  );
}

export function InvoiceDocument({ doc }: { doc: InvoiceView }) {
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

            <div className={s.linesWrap}>
        <table className={s.lines}>
              <thead>
                <tr>
                  <th scope="col">Description</th>
                  <th scope="col" className={`${s.num} ${s.rateCol}`}>
                    Qty
                  </th>
                  <th scope="col" className={`${s.num} ${s.rateCol}`}>
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
                    <td>
                      {line.description}
                      {/*
                        THE SAME TWO FIGURES, folded under the description for
                        a phone. Qty and Unit are two wide mono columns, and
                        dropping them on a narrow screen is what makes AMOUNT
                        fit — AMOUNT being the number the reader opened the
                        document for. Restated rather than removed: an invoice
                        that hides how a line was arrived at is one somebody
                        has to ring up about.
                      */}
                      <span className={s.rateInline}>
                        {line.quantity} × {money(line.unitPriceCents, doc.currency)}
                      </span>
                    </td>
                    <td className={`${s.num} ${s.rateCol}`}>{line.quantity}</td>
                    <td className={`${s.num} ${s.rateCol}`}>
                      {money(line.unitPriceCents, doc.currency)}
                    </td>
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
        </div>

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
