import type { FunctionReturnType } from "convex/server";
import type { api } from "@cc/convex/api";
import s from "./outbox.module.css";

type Row = FunctionReturnType<typeof api.messages.outbox>[number];

/**
 * DID MY CUSTOMER HEAR FROM US?
 *
 * The only screen that answers that, and until now the answer was a Convex
 * command run by somebody else — which meant the question arrived as a phone
 * call to the agency, about a customer the agency has never met.
 *
 * Operate mode. The reader is a business owner who has just been asked "I
 * never got a confirmation" and needs to know, in about four seconds, whether
 * that is true and what to do about it.
 *
 * WHAT WENT WRONG COMES FIRST, and that is the whole information design. A
 * reverse-chronological list buries the four rows that need a person under
 * ninety that do not. The failures are the reason anybody opens this.
 *
 * THE RAW `error` IS NEVER SHOWN, and this is a rule rather than a
 * simplification. Those sentences are written for whoever runs the PLATFORM —
 * several of them name environment variables, one names a Resend key — and a
 * client reading "MESSAGING_ALLOWLIST is unset" learns nothing they can act on
 * and quite a lot they should not have to think about. Every state is
 * translated into what it means for THEM and what they can do next.
 *
 * The same rule the client calendar follows: show the STATE, never the
 * underlying error.
 */
export function Outbox({ rows, timezone }: { rows: Row[]; timezone: string }) {
  const attention = rows.filter((row) => NEEDS_ATTENTION.has(row.status));
  const rest = rows.filter((row) => !NEEDS_ATTENTION.has(row.status));

  if (rows.length === 0) {
    return (
      <p className={s.quiet}>
        Nothing has been sent yet. Confirmations, reminders and quotes appear
        here the moment they go out — and so does anything that did not.
      </p>
    );
  }

  return (
    <div className={s.stack}>
      {attention.length > 0 ? (
        <section aria-labelledby="attention">
          <div className={s.sectionHead}>
            <h2 className={s.sectionTitle} id="attention">
              Did not reach anybody
            </h2>
            <p className={s.count}>{attention.length}</p>
          </div>
          <ul className={s.list}>
            {attention.map((row) => (
              <MessageRow key={row._id} row={row} timezone={timezone} />
            ))}
          </ul>
        </section>
      ) : null}

      <section aria-labelledby="everything">
        <div className={s.sectionHead}>
          <h2 className={s.sectionTitle} id="everything">
            {attention.length > 0 ? "Everything else" : "Sent"}
          </h2>
          <p className={s.count}>{rest.length}</p>
        </div>

        {rest.length === 0 ? (
          <p className={s.quiet}>Nothing else has gone out.</p>
        ) : (
          <ul className={s.list}>
            {rest.map((row) => (
              <MessageRow key={row._id} row={row} timezone={timezone} />
            ))}
          </ul>
        )}
      </section>
    </div>
  );
}

/**
 * The states where nobody received anything and somebody should know.
 *
 * `sending` is deliberately NOT here: it is in flight, and a row that has been
 * in flight for ten minutes is requeued by the drain rather than being a
 * problem a client can do anything about.
 */
const NEEDS_ATTENTION = new Set([
  "failed",
  "suppressed_consent",
  "suppressed_demo",
  "suppressed_lead",
]);

function MessageRow({ row, timezone }: { row: Row; timezone: string }) {
  const state = STATES[row.status] ?? {
    label: row.status,
    tone: "neutral" as Tone,
    detail: null,
  };

  return (
    <li className={s.row}>
      <div>
        <p className={s.name}>{row.customerName ?? "You"}</p>
        <p className={s.what}>{TEMPLATE_NAMES[row.templateKey] ?? row.templateKey}</p>
      </div>

      <div className={s.middle}>
        {/*
          The address, because "did they get it" is often really "did it go to
          the right place" — a typo in an email is the commonest cause and the
          client is the only person who can spot it.
        */}
        <p className={s.to}>{row.to || "no address on file"}</p>
        <p className={s.when}>{when(row, timezone, state.tone)}</p>
      </div>

      <div className={s.right}>
        <p className={s.state} data-tone={state.tone}>
          {state.label}
        </p>
        {state.detail ? <p className={s.detail}>{state.detail}</p> : null}
      </div>
    </li>
  );
}

/**
 * Every state, in words a business owner can act on.
 *
 * Written from the reader's side: what happened to their customer, and what
 * they can do. Not what the pipeline did, and never the platform's own
 * diagnostics.
 */
type Tone = "good" | "waiting" | "bad" | "neutral";

const STATES: Record<string, { label: string; tone: Tone; detail: string | null }> = {
  sent: { label: "Sent", tone: "good", detail: null },
  delivered: { label: "Delivered", tone: "good", detail: null },

  scheduled: {
    label: "Queued",
    tone: "waiting",
    detail: "Going out in the next few minutes.",
  },
  holding_quiet_hours: {
    label: "Holding until morning",
    tone: "waiting",
    detail: "It is quiet hours, so this waits rather than waking somebody up.",
  },
  sending: { label: "Going out now", tone: "waiting", detail: null },

  failed: {
    label: "Not sent",
    tone: "bad",
    /*
     * The honest general case. `error` holds the specific reason and is
     * deliberately not shown — it is written for the platform, and several of
     * those sentences name environment variables.
     */
    detail: "We could not deliver this. Check the address, and tell us if it looks right.",
  },
  suppressed_consent: {
    label: "Not sent",
    tone: "bad",
    detail: "This customer has not agreed to be contacted, or has asked us to stop.",
  },
  suppressed_demo: {
    label: "Not sent",
    tone: "neutral",
    detail: "This is demonstration data, so nothing was really sent.",
  },
  suppressed_lead: {
    label: "Not sent",
    tone: "bad",
    /*
     * Deliberately says nothing about WHY beyond "we could not". The real
     * reason is that this contact is also on the platform's prospecting list,
     * which is the platform's business and not this client's — and an earlier
     * wording ("a business we are not allowed to message") hinted at the
     * existence of that list, which is the same disclosure in softer words.
     */
    detail: "We could not message this contact. Ring them instead.",
  },
};

const TEMPLATE_NAMES: Record<string, string> = {
  booking_confirmation: "Booking confirmation",
  reminder_24h: "Reminder — the day before",
  reminder_1h: "Reminder — an hour before",
  booking_cancelled: "Booking cancelled",
  quote_sent: "Quote",
  review_request: "Review request",
  invoice_issued: "Invoice",
  client_invite: "Back-office invitation",
};

/**
 * When it went, when it will, or when we gave up.
 *
 * Rendered in the CLIENT's timezone — handed over by the page rather than
 * guessed from the browser, for the same reason the calendar does it: a
 * business owner travelling must not see their own messages shifted.
 *
 * "DUE" IS ONLY SAID OF SOMETHING STILL COMING. The first version derived it
 * from `sentAt` being null, which is also true of everything that FAILED — so
 * a message nobody would ever receive was labelled "due 4 Sept", on exactly
 * the rows a worried client is reading. It said the opposite of what the
 * status beside it said, and the reassuring one was the lie.
 */
function when(row: Row, timezone: string, tone: Tone): string {
  const at = row.sentAt ?? row.scheduledFor;
  const label = new Intl.DateTimeFormat("en-ZA", {
    timeZone: timezone,
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(new Date(at));

  if (row.sentAt) return label;
  if (tone === "waiting") return `due ${label}`;
  // Failed or suppressed: this is when it was going to go, and did not.
  return `was due ${label}`;
}
