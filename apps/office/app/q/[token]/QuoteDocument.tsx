import type { FunctionReturnType } from "convex/server";
import type { api } from "@cc/convex/api";
import { Accept } from "./Accept";
import s from "./quote.module.css";

export type QuoteView = FunctionReturnType<typeof api.public.quote.view>;

/**
 * THE DOCUMENT ITSELF, with no idea where its data came from.
 *
 * Split out of `page.tsx` so the preview harness can render THIS FILE against
 * fixtures. A harness that renders a COPY of the markup stops telling the
 * truth the first time somebody edits one of the two, silently — which is
 * worse than having no harness. Same split, same argument, as the invoice.
 */

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

function day(at: number): string {
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(at));
}


export function QuoteRefusal({ reason }: { reason: string }) {
  return (
    <main className={`world-client ${s.page}`}>
            <div className={s.refusal}>
              <h1 className={s.refusalTitle}>This link did not open a quote</h1>
              <p className={s.refusalReason}>{reason}.</p>
              <p className={s.refusalHelp}>
                Reply to the message this link came from and ask for another.
              </p>
            </div>
          </main>
  );
}

export function QuoteDocument({ quote, token }: { quote: QuoteView; token: string }) {
  return (
    <main className={`world-client ${s.page}`}>
          <article className={s.doc}>
            <header className={s.masthead}>
              <p className={s.from}>{quote.businessName ?? "Your quote"}</p>
              <h1 className={s.number}>{quote.number}</h1>
            </header>

            {/*
              THE TOTAL FIRST. On a phone, in a thread, the number is what the
              reader came for — burying it under a line table means scrolling to
              find out whether the rest is worth reading.
            */}
            <section className={s.headline}>
              <p className={s.headlineLabel}>Total</p>
              <p className={s.headlineFigure}>{money(quote.totalCents, quote.currency)}</p>
              {quote.accepted ? (
                <p className={s.headlineNote}>
                  Accepted{quote.acceptedAt ? ` on ${day(quote.acceptedAt)}` : ""}.
                </p>
              ) : quote.expired ? (
                <p className={s.headlineNote} data-tone="lapsed">
                  This quote lapsed on {day(quote.expiresAt)}. Ask{" "}
                  {quote.businessName ?? "the business"} for an updated one — prices
                  move.
                </p>
              ) : (
                <p className={s.headlineNote}>Valid until {day(quote.expiresAt)}.</p>
              )}
            </section>

            <div className={s.linesWrap}>
              <table className={s.lines}>
                <thead>
                  <tr>
                    <th scope="col">What is included</th>
                    <th scope="col" className={`${s.num} ${s.rateCol}`}>
                      Qty
                    </th>
                    <th scope="col" className={`${s.num} ${s.rateCol}`}>
                      Each
                    </th>
                    <th scope="col" className={s.num}>
                      Amount
                    </th>
                  </tr>
                </thead>
                <tbody>
                  {quote.lineItems.map((line, i) => (
                    <tr key={i}>
                      <td>
                        {line.description}
                        {/*
                          Qty and each, folded under the description for a phone —
                          the same trade the invoice makes, and for the same
                          reason: four mono columns push Amount off a 375px screen,
                          and Amount is the number they opened this for.
                        */}
                        <span className={s.rateInline}>
                          {line.quantity} × {money(line.unitPriceCents, quote.currency)}
                        </span>
                      </td>
                      <td className={`${s.num} ${s.rateCol}`}>{line.quantity}</td>
                      <td className={`${s.num} ${s.rateCol}`}>
                        {money(line.unitPriceCents, quote.currency)}
                      </td>
                      <td className={s.num}>{money(line.lineTotalCents, quote.currency)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className={s.totalRow}>
                    <th scope="row" colSpan={3}>
                      Total
                    </th>
                    <td className={s.num}>{money(quote.totalCents, quote.currency)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>

            {/*
              No VAT line, and that is correct rather than missing: nothing in this
              system stores a tax posture, the business is not registered, and
              total === subtotal. A blank VAT row invites somebody to fill it in.
            */}

            <Accept quote={quote} token={token} />

            <footer className={s.footer}>
              <p>
                Keep this link — it stays live, and shows the quote as it stands.
                Print it or save it as a PDF from your browser.
              </p>
            </footer>
          </article>
        </main>
  );
}
