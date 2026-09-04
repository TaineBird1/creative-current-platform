"use client";

import { useMemo, useState } from "react";
import { useMutation } from "convex/react";
import type { FunctionReturnType } from "convex/server";
import { api } from "@cc/convex/api";
import s from "./quotes.module.css";

/*
 * DERIVED from the queries. A hand-written copy of a row shape is a copy that
 * drifts on the first field added to convex/quotes.ts.
 */
type Quote = FunctionReturnType<typeof api.quotes.list>[number];
type Request = FunctionReturnType<typeof api.quoteRequests.list>[number];

/**
 * PRICING A JOB, AND GETTING THE NUMBER TO THE CUSTOMER.
 *
 * Operate mode. The usage scene is an installer with a request in front of
 * them — a name, a number, and a paragraph about a roof — deciding what to
 * charge and then getting that figure into the customer's hands before the
 * customer phones somebody else. Two of those steps are this screen's job.
 *
 * THE ACCEPT LINK IS SHOWN EXACTLY ONCE, AND THAT SHAPES THE WHOLE FLOW.
 *
 * `quotes.create` mints a bearer token, stores only its hash, and returns the
 * plaintext once — the same reasoning as a password reset link. Nothing can
 * ever show it again. So the moment after creating a quote is not a toast and
 * not a row that appears in a list: it is a HARD STOP that replaces the form
 * and does not let you carry on until you have done something with the link.
 * Navigating away from it means that quote can never be accepted and has to be
 * built again from nothing.
 *
 * The primary action there opens WhatsApp with the message drafted, because
 * that is where this actually gets sent. It DRAFTS — the client presses send
 * themselves, in their own thread, from their own number. Nothing here sends
 * on anybody's behalf.
 *
 * WHAT "MARK AS SENT" DOES AND DOES NOT DO, said plainly on the screen: it
 * records that the client handed the quote over. `quotes.send` sets a status
 * and writes an audit row; it does not dispatch a message. A button labelled
 * "Send" would be claiming something the backend does not do, which is the one
 * thing this codebase refuses everywhere else.
 */
export function QuoteBuilder({
  quotes,
  requests,
  currency,
}: {
  quotes: Quote[];
  requests: Request[];
  currency: string;
}) {
  const [drafting, setDrafting] = useState<Draft | null>(null);
  const [handover, setHandover] = useState<Handover | null>(null);

  if (handover) {
    return (
      <HandoverPanel
        {...handover}
        currency={currency}
        onDone={() => {
          setHandover(null);
          setDrafting(null);
        }}
      />
    );
  }

  if (drafting) {
    return (
      <Builder
        draft={drafting}
        currency={currency}
        onCancel={() => setDrafting(null)}
        onCreated={setHandover}
      />
    );
  }

  const unpriced = requests.filter((r) => r.status === "new" || r.status === "contacted");

  return (
    <div className={s.stack}>
      <section aria-labelledby="waiting">
        <div className={s.sectionHead}>
          <h2 className={s.sectionTitle} id="waiting">
            Waiting for a price
          </h2>
          {unpriced.length > 0 ? <p className={s.count}>{unpriced.length}</p> : null}
        </div>

        {unpriced.length === 0 ? (
          <p className={s.quiet}>
            Nothing waiting. Requests from your website appear here the moment
            somebody asks for a price.
          </p>
        ) : (
          <ul className={s.list}>
            {unpriced.map((request) => (
              <li className={s.row} key={request._id}>
                <div>
                  <p className={s.name}>{request.name}</p>
                  {request.phone ? (
                    <a className={s.phone} href={`tel:${request.phone}`}>
                      {request.phone}
                    </a>
                  ) : (
                    <p className={s.withheld}>No number on this request</p>
                  )}
                </div>

                <dl className={s.answers}>
                  {request.answers.slice(0, 4).map((answer) => (
                    <div key={answer.key}>
                      <dt className={s.answerKey}>{answer.key}</dt>
                      <dd className={s.answerValue}>{answer.value}</dd>
                    </div>
                  ))}
                </dl>

                <button
                  className={s.primary}
                  type="button"
                  onClick={() =>
                    setDrafting({
                      name: request.name,
                      phone: request.phone ?? "",
                      email: request.email ?? undefined,
                      requestId: request._id,
                    })
                  }
                >
                  Price this
                </button>
              </li>
            ))}
          </ul>
        )}
      </section>

      <section aria-labelledby="quotes">
        <div className={s.sectionHead}>
          <h2 className={s.sectionTitle} id="quotes">
            Quotes
          </h2>
          <button
            className={s.secondary}
            type="button"
            onClick={() => setDrafting({ name: "", phone: "", requestId: null })}
          >
            New quote
          </button>
        </div>

        {quotes.length === 0 ? (
          <p className={s.quiet}>
            No quotes yet. Price a request above, or start one from scratch.
          </p>
        ) : (
          <ul className={s.list}>
            {quotes.map((quote) => (
              <QuoteRow key={quote._id} quote={quote} currency={currency} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/* ------------------------------------------------------------------ rows */

function QuoteRow({ quote, currency }: { quote: Quote; currency: string }) {
  const markSent = useMutation(api.quotes.markSent);
  const sendToCustomer = useMutation(api.quotes.sendToCustomer);
  const decline = useMutation(api.quotes.decline);
  const resend = useMutation(api.quotes.resendToCustomer);
  const reissue = useMutation(api.quotes.reissueAcceptLink);
  const [freshLink, setFreshLink] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [notice, setNotice] = useState<string | null>(null);

  /*
   * `isExpired` is derived by the query rather than stored, so it is true
   * whenever anybody looks. It outranks the stored status in the label: a
   * quote that says "sent" and expired yesterday is not waiting on anybody.
   */
  const state = quote.isExpired && quote.status !== "accepted" ? "expired" : quote.status;

  async function run(action: () => Promise<unknown>) {
    setBusy(true);
    setError(null);
    try {
      await action();
    } catch (caught) {
      const message =
        caught && typeof caught === "object" && "data" in caught
          ? (caught.data as { message?: string })?.message
          : undefined;
      setError(message ?? "That did not go through. Try again.");
    } finally {
      setBusy(false);
    }
  }

  return (
    <li className={s.row}>
      <div>
        <p className={s.name}>{quote.customerName}</p>
        <p className={s.number}>{quote.number}</p>
      </div>

      <div className={s.lines}>
        <p className={s.total}>{money(quote.totalCents, currency)}</p>
        <p className={s.meta}>
          {workLabel(quote.lineItems)}
          {/*
            NO EXPIRY BESIDE THE CHIP THAT ALREADY SAYS IT. An expired quote
            read `1 line · expired` directly above a state chip reading
            `EXPIRED`, which is the same word twice in adjacent lines. Accepted
            has never shown one, for the same reason it does not apply.
          */}
          {state === "accepted" || state === "expired"
            ? null
            : ` · ${expiryLabel(quote.expiresAt)}`}
        </p>
        {error ? <p className={s.error}>{error}</p> : null}
        {notice ? <p className={s.notice}>{notice}</p> : null}
        {freshLink ? (
          <>
            <p className={s.notice}>
              A fresh link. The previous one has stopped working, and this is
              the only time it is shown.
            </p>
            <output className={s.linkBox}>{freshLink}</output>
          </>
        ) : null}
      </div>

      <div className={s.rowActions}>
        <p className={s.state} data-state={state}>
          {STATE_LABEL[state]}
        </p>

{/*
          TWO WAYS OUT OF A DRAFT, named for what each one does.

          "Email it" dispatches through the outbox and is the only one that
          sends anything. "Mark as sent" records that the client handed the
          link over themselves, which is how this business actually works —
          the accept link goes into their own WhatsApp thread.

          Both act only on a draft, so taking one closes the other. That is
          what stops the email path re-minting a token and killing a link the
          customer already has.
        */}
        {quote.status === "draft" && !quote.isExpired ? (
          <>
            <button
              className={s.secondary}
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const result = await sendToCustomer({
                    clientSlug: slugFromPath(),
                    quoteId: quote._id,
                  });
                  /*
                   * The BACKEND'S sentence, shown as-is. It is the only thing
                   * that knows whether the message was queued, held for quiet
                   * hours, or refused — and a screen that guessed would tell
                   * somebody it had gone when it had not.
                   */
                  if (result.notice) setNotice(result.notice);
                })
              }
            >
              {busy ? "Sending…" : "Email it"}
            </button>

            <button
              className={s.quietAction}
              type="button"
              disabled={busy}
              onClick={() => run(() => markSent({ clientSlug: slugFromPath(), quoteId: quote._id }))}
            >
              I sent it myself
            </button>
          </>
        ) : null}

{/*
          "SENT" IS NOT A ONE-WAY DOOR. A customer who deletes the email, or
          never got it, is week one for any installer — and before these the
          only way back was building the whole quote again under a new number,
          putting two documents for one job in front of them.

          Both mint a fresh link and kill the old one, because there is one
          token hash: two live links to one document is two things to remember
          to revoke, and the second is the one nobody remembers.
        */}
        {state === "sent" ? (
          <>
            <button
              className={s.secondary}
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await resend({ clientSlug: slugFromPath(), quoteId: quote._id });
                  setNotice(r.notice ?? `Sent again. ${r.number} is on a fresh link.`);
                })
              }
            >
              {busy ? "Sending…" : "Send again"}
            </button>

            <button
              className={s.quietAction}
              type="button"
              disabled={busy}
              onClick={() =>
                run(async () => {
                  const r = await reissue({ clientSlug: slugFromPath(), quoteId: quote._id });
                  setFreshLink(r.acceptUrl);
                })
              }
            >
              Get the link
            </button>
          </>
        ) : null}

        {quote.status !== "accepted" && quote.status !== "declined" ? (
          <button
            className={s.quietAction}
            type="button"
            disabled={busy}
            onClick={() => run(() => decline({ clientSlug: slugFromPath(), quoteId: quote._id }))}
          >
            Withdraw
          </button>
        ) : null}
      </div>
    </li>
  );
}

const STATE_LABEL: Record<string, string> = {
  draft: "Not sent",
  sent: "With the customer",
  accepted: "Accepted",
  declined: "Withdrawn",
  expired: "Expired",
};

/* --------------------------------------------------------------- builder */

type Draft = {
  name: string;
  phone: string;
  email?: string;
  requestId: string | null;
};

type Handover = {
  quoteId: Quote["_id"];
  number: string;
  totalCents: number;
  acceptToken: string;
  customerName: string;
  customerPhone: string;
};

type Line = { description: string; quantity: string; unitPrice: string };

const EMPTY_LINE: Line = { description: "", quantity: "1", unitPrice: "" };

function Builder({
  draft,
  currency,
  onCancel,
  onCreated,
}: {
  draft: Draft;
  currency: string;
  onCancel: () => void;
  onCreated: (handover: Handover) => void;
}) {
  const upsert = useMutation(api.customers.upsertByPhone);
  const create = useMutation(api.quotes.create);

  const [name, setName] = useState(draft.name);
  const [phone, setPhone] = useState(draft.phone);
  const [lines, setLines] = useState<Line[]>([{ ...EMPTY_LINE }]);
  const [validDays, setValidDays] = useState("14");
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);

  /*
   * Totalled the SAME WAY the server totals: each line rounded to whole cents
   * before summing, never the sum of unrounded products. If this disagreed
   * with `lineTotals` in convex/quotes.ts by a cent, the figure the client
   * approved would not be the figure the customer is asked to accept.
   *
   * The server's number is still the authority — this one is here so the
   * client sees the total move as they type, which is the whole reason to
   * build a quote on a screen rather than on paper.
   */
  const subtotal = useMemo(
    () =>
      lines.reduce((sum, line) => {
        const cents = toCents(line.unitPrice);
        const qty = Number(line.quantity);
        if (cents === null || !Number.isFinite(qty) || qty <= 0) return sum;
        return sum + Math.round(cents * qty);
      }, 0),
    [lines],
  );

  const usable = lines.filter(
    (line) => line.description.trim() !== "" && toCents(line.unitPrice) !== null,
  );
  const ready = name.trim() !== "" && phone.trim() !== "" && usable.length > 0;

  async function submit() {
    setBusy(true);
    setError(null);
    try {
      const slug = slugFromPath();
      const { customerId } = await upsert({
        clientSlug: slug,
        name: name.trim(),
        phone: phone.trim(),
        ...(draft.email ? { email: draft.email } : {}),
      });

      const created = await create({
        clientSlug: slug,
        customerId,
        validDays: Number(validDays) || 14,
        lineItems: usable.map((line) => ({
          description: line.description.trim(),
          quantity: Number(line.quantity) || 1,
          unitPriceCents: toCents(line.unitPrice)!,
        })),
      });

      onCreated({
        quoteId: created.quoteId,
        number: created.number,
        totalCents: created.totalCents,
        acceptToken: created.acceptToken,
        customerName: name.trim(),
        customerPhone: phone.trim(),
      });
    } catch (caught) {
      const message =
        caught && typeof caught === "object" && "data" in caught
          ? (caught.data as { message?: string })?.message
          : undefined;
      setError(message ?? "The quote was not created. Nothing has been sent.");
      setBusy(false);
    }
  }

  return (
    <section className={s.builder} aria-labelledby="building">
      <div className={s.sectionHead}>
        <h2 className={s.sectionTitle} id="building">
          New quote
        </h2>
        <button className={s.quietAction} type="button" onClick={onCancel}>
          Cancel
        </button>
      </div>

      <div className={s.fields}>
        <label className={s.field}>
          <span className={s.label}>Customer</span>
          <input
            className={s.input}
            value={name}
            onChange={(e) => setName(e.target.value)}
            placeholder="Their name"
            autoComplete="off"
          />
        </label>

        <label className={s.field}>
          <span className={s.label}>Phone</span>
          <input
            className={s.input}
            value={phone}
            onChange={(e) => setPhone(e.target.value)}
            placeholder="082 555 1234"
            inputMode="tel"
            autoComplete="off"
          />
        </label>
      </div>

      <div className={s.lineHead}>
        <span className={s.label}>What they are paying for</span>
      </div>

      <ul className={s.lineList}>
        {lines.map((line, i) => (
          <li className={s.lineRow} key={i}>
            <label className={s.lineField}>
              <span className={s.srOnly}>Description of line {i + 1}</span>
              <input
                className={s.input}
                value={line.description}
                onChange={(e) => setLines(edit(lines, i, { description: e.target.value }))}
                placeholder="8kW inverter, supplied and fitted"
                autoComplete="off"
              />
            </label>

            <label className={s.lineQty}>
              <span className={s.srOnly}>Quantity of line {i + 1}</span>
              <input
                className={`${s.input} ${s.figure}`}
                value={line.quantity}
                onChange={(e) => setLines(edit(lines, i, { quantity: e.target.value }))}
                inputMode="decimal"
                aria-label={`Quantity for line ${i + 1}`}
              />
            </label>

            <label className={s.linePrice}>
              <span className={s.srOnly}>Unit price of line {i + 1}</span>
              <input
                className={`${s.input} ${s.figure}`}
                value={line.unitPrice}
                onChange={(e) => setLines(edit(lines, i, { unitPrice: e.target.value }))}
                inputMode="decimal"
                placeholder="0.00"
                aria-label={`Unit price for line ${i + 1}`}
                aria-invalid={line.unitPrice !== "" && toCents(line.unitPrice) === null}
              />
            </label>

            {lines.length > 1 ? (
              <button
                className={s.removeLine}
                type="button"
                onClick={() => setLines(lines.filter((_, at) => at !== i))}
                aria-label={`Remove line ${i + 1}`}
              >
                Remove
              </button>
            ) : (
              <span aria-hidden="true" />
            )}
          </li>
        ))}
      </ul>

      <button
        className={s.secondary}
        type="button"
        onClick={() => setLines([...lines, { ...EMPTY_LINE }])}
      >
        Add a line
      </button>

      <div className={s.totalBar}>
        <span className={s.label}>Total</span>
        <span className={s.totalFigure}>{money(subtotal, currency)}</span>
      </div>

      <label className={s.field}>
        <span className={s.label}>Valid for</span>
        <span className={s.validRow}>
          <input
            className={`${s.input} ${s.figure} ${s.days}`}
            value={validDays}
            onChange={(e) => setValidDays(e.target.value)}
            inputMode="numeric"
          />
          <span className={s.meta}>days</span>
        </span>
      </label>

      {error ? <p className={s.error}>{error}</p> : null}

      <button className={s.primary} type="button" disabled={!ready || busy} onClick={submit}>
        {busy ? "Creating…" : "Create the quote"}
      </button>

      <p className={s.footnote}>
        Nothing is sent yet. The next screen gives you a link to hand over, and
        it is the only time that link can be shown.
      </p>
    </section>
  );
}

/* -------------------------------------------------------------- handover */

function HandoverPanel({
  quoteId,
  number,
  totalCents,
  acceptToken,
  customerName,
  customerPhone,
  currency,
  onDone,
}: Handover & { currency: string; onDone: () => void }) {
  const markSent = useMutation(api.quotes.markSent);
  const [copied, setCopied] = useState(false);
  const [busy, setBusy] = useState(false);

  const link =
    typeof window === "undefined" ? "" : `${window.location.origin}/q/${acceptToken}`;

  const message = `Hi ${customerName}, here is your quote ${number} for ${money(
    totalCents,
    currency,
  )}. You can read it and accept it here: ${link}`;

  const whatsapp = `https://wa.me/${customerPhone.replace(/[^\d]/g, "")}?text=${encodeURIComponent(
    message,
  )}`;

  return (
    <section className={s.handover} aria-labelledby="handover">
      <h2 className={s.sectionTitle} id="handover">
        {number} is ready to hand over
      </h2>

      <p className={s.handoverLead}>
        <strong className={s.totalFigure}>{money(totalCents, currency)}</strong> for{" "}
        {customerName}.
      </p>

      {/*
        THE WARNING COMES BEFORE THE LINK, not after it. Read in order, this
        has to say "you only get this once" while there is still time to act on
        it — underneath the link it would be read by somebody who has already
        navigated away.
      */}
      <p className={s.warning}>
        This link is shown once and cannot be shown again. If you leave without
        sending it, this quote can never be accepted and you will have to build
        it a second time.
      </p>

      <output className={s.linkBox}>{link}</output>

      <div className={s.handoverActions}>
        <a className={s.primary} href={whatsapp} target="_blank" rel="noreferrer">
          Open WhatsApp with this drafted
        </a>

        <button
          className={s.secondary}
          type="button"
          onClick={async () => {
            try {
              await navigator.clipboard.writeText(link);
              setCopied(true);
            } catch {
              // Clipboard access can be refused; the link is on screen and
              // selectable, so this is a convenience rather than the only way.
              setCopied(false);
            }
          }}
        >
          {copied ? "Copied" : "Copy the link"}
        </button>
      </div>

      <p className={s.footnote}>
        WhatsApp opens with the message written; you still press send. Nothing
        goes out from here.
      </p>

      {/*
        THIS RECORDS THE SEND, it does not just close the panel. Left as a
        plain dismiss, the quote would sit at `draft` after the client had
        already handed the link over — and "Email it" would then still be
        offered on it, re-minting a token and killing the link the customer
        already has.
      */}
      <button
        className={s.quietAction}
        type="button"
        disabled={busy}
        onClick={async () => {
          setBusy(true);
          try {
            await markSent({ clientSlug: slugFromPath(), quoteId });
          } catch {
            /*
             * Deliberately swallowed. The link is already in the customer's
             * hands — that happened outside this system — so refusing to
             * close the panel would strand the client on a screen whose work
             * is done. The quote stays a draft and the list still shows it.
             */
          } finally {
            setBusy(false);
            onDone();
          }
        }}
      >
        {busy ? "Saving…" : "I have sent it"}
      </button>
    </section>
  );
}

/* ---------------------------------------------------------------- helpers */

function edit(lines: Line[], index: number, patch: Partial<Line>): Line[] {
  return lines.map((line, i) => (i === index ? { ...line, ...patch } : line));
}

/**
 * Rands as typed, to integer cents. Null when it is not a number yet — an
 * empty field and a half-typed one are the same thing to the total, and
 * neither is an error worth shouting about while somebody is still typing.
 */
export function toCents(input: string): number | null {
  const cleaned = input.replace(/[\s,R]/g, "");
  if (cleaned === "" || !/^\d+(\.\d{0,2})?$/.test(cleaned)) return null;
  const [whole, fraction = ""] = cleaned.split(".");
  return Number(whole) * 100 + Number((fraction + "00").slice(0, 2));
}

function money(cents: number, currency: string): string {
  return new Intl.NumberFormat("en-ZA", {
    style: "currency",
    currency,
    minimumFractionDigits: 2,
  }).format(cents / 100);
}

/**
 * WHAT THE QUOTE IS FOR, not how it is stored.
 *
 * This line used to read `2 lines`, which names the shape of the record and
 * tells the reader nothing — and on an accepted quote, where no expiry is
 * shown, `1 line` was the entire line of text. The person scanning this list
 * is deciding which quote to open, and the thing that identifies one is the
 * work: "8kW hybrid inverter, fitted".
 *
 * The count survives where it carries something the description does not —
 * that there is more below the first line — as `+2 more` rather than a total,
 * because the first item is already named.
 *
 * A quote with no lines cannot be sent, but it can exist as a draft, so the
 * empty case says so rather than rendering a stray bullet.
 */
function workLabel(lineItems: readonly { description: string }[]): string {
  const first = lineItems[0]?.description?.trim();
  if (!first) return "nothing priced yet";
  const rest = lineItems.length - 1;
  return rest > 0 ? `${first} · +${rest} more` : first;
}

function expiryLabel(expiresAt: number): string {
  const days = Math.ceil((expiresAt - Date.now()) / (24 * 60 * 60 * 1000));
  if (days < 0) return "expired";
  if (days === 0) return "expires today";
  if (days === 1) return "expires tomorrow";
  return `${days} days left`;
}

/**
 * The tenant slug, from the address bar.
 *
 * Every mutation here is tenant-scoped and takes a SLUG, never a client id —
 * the server re-derives the tenant from the caller's own membership rows, so
 * a forged slug reaches nothing. Reading it from the path rather than
 * threading it through props keeps that true in one place.
 */
function slugFromPath(): string {
  if (typeof window === "undefined") return "";
  return window.location.pathname.split("/")[2] ?? "";
}
