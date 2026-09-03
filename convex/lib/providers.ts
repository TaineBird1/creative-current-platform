/**
 * THE PROVIDER SEAM.
 *
 * `dispatch` decides WHETHER a message may be sent. This file is the other
 * half: how a queued row becomes something a person actually receives, and
 * what it means when it does not.
 *
 * One interface, one driver per channel, chosen by `driverFor`. Email is real
 * — Resend, the same account that already sends sign-in codes. WhatsApp and
 * SMS have no account yet, so they get the no-op driver below.
 *
 * WHAT THE NO-OP DRIVER DOES NOT DO IS RETURN SUCCESS.
 *
 * That is the whole design decision in this file. A no-op that reported
 * `delivered` would stamp `sent` on a row nobody received, and the outbox —
 * the one screen that answers "did they hear from us" — would answer yes.
 * This codebase treats the invisible failure as the expensive one everywhere
 * else; it would be strange to build one here on purpose. So the no-op driver
 * LOGS the message in full, which is what makes it useful while developing,
 * and reports a refusal with a readable reason. Non-retryable, so the row
 * lands in the outbox saying "no WhatsApp provider is configured" on the first
 * attempt rather than spending a retry budget to arrive at the same sentence
 * several hours later.
 *
 * Adding WhatsApp later is one function in this file and one line in
 * `driverFor`. Nothing above this seam changes, and nothing below it decides
 * whether a message is ALLOWED — that is settled before a driver is reached.
 */

import { formatCents, type Currency } from "./money";

export type MessageChannel = "whatsapp" | "email" | "sms";

/** Everything a driver needs, already rendered. Drivers do not read the db. */
export type OutboundMessage = {
  channel: MessageChannel;
  /** An email address or an E.164 phone number, depending on the channel. */
  to: string;
  templateKey: string;
  subject: string;
  body: string;
  /** The business the message comes from, not the platform. */
  clientName: string;
  /**
   * WHERE A REPLY ACTUALLY GOES, or null if nowhere.
   *
   * The From address is on OUR domain, which is a sending domain: it may have
   * no MX record at all, and a domain with no MX swallows every reply in
   * silence. A booking confirmation is the most replied-to message this system
   * will ever send — somebody wanting to move an appointment hits reply,
   * because that is what people do — so a confirmation whose reply goes
   * nowhere is a customer who believes they have rescheduled and has not.
   *
   * Resolved by `resolveReplyTo` and passed to the RENDERER as well as the
   * driver, so the copy cannot invite a reply the envelope will not deliver.
   */
  replyTo: string | null;
  /**
   * True when the recipient IS the client — our invoice, our invite — rather
   * than one of their customers. It flips the From line from "<Client> via
   * The Creative Current" to plain The Creative Current, which is the only
   * accurate reading of a message we are sending them.
   */
  toClient: boolean;
};

/**
 * Deliberately a return value and not an exception.
 *
 * A driver that throws makes every caller decide what a thrown error means,
 * and the tempting answer is to catch and move on — which loses the message
 * silently. A verdict has to be recorded, so a verdict is what a driver
 * returns.
 *
 * `retryable` is the driver's claim about ITS OWN failure, and it is the only
 * thing separating "the network blinked" from "that address does not exist".
 * Wrong in the retryable direction costs a few cron cycles. Wrong the other
 * way drops a message that would have gone on the second attempt. A driver
 * that cannot tell says retryable.
 */
export type SendResult =
  | { delivered: true; providerName: string; providerMessageId?: string }
  | { delivered: false; providerName: string; retryable: boolean; error: string };

export type MessageDriver = {
  name: string;
  send(message: OutboundMessage): Promise<SendResult>;
};

/* ----------------------------------------------------------------- sender */

/** Used only when `MESSAGING_EMAIL_FROM` carries a bare address and no name. */
const PLATFORM_SENDER_NAME = "The Creative Current";

/**
 * "Renu Solar via The Creative Current <hello@thecreativecurrent.co.za>".
 *
 * NOT A DELIVERABILITY WORKAROUND, though it helps with one. It is the
 * accurate description of what is happening: every client's mail goes out from
 * our domain, on their behalf, and a From line reading "Renu Solar
 * <hello@thecreativecurrent.co.za>" says something that is not true of either
 * party. A display name that does not match its domain is also the shape of a
 * phishing attempt, which is why receivers weigh it — so stating the
 * relationship costs nothing and removes the ambiguity for a person and a
 * filter at the same time. It is the pattern mailing lists use, for exactly
 * this reason.
 *
 * The display name is ALWAYS quoted. Real client names carry commas, full
 * stops and parentheses — "Renu Solar (Pty) Ltd" — and every one of those is
 * a special character in an address header. An unquoted name containing one is
 * not a formatting nitpick; it is a 422 from the provider, or worse, a header
 * that parses into something other than what was meant.
 */
export function viaSender(clientName: string, from: string): string {
  const match = from.match(/^(.*)<([^>]+)>\s*$/);
  const address = (match ? match[2]! : from).trim();

  const configuredName = match?.[1]?.trim().replace(/^"(.*)"$/, "$1").trim();
  const platform = configuredName || PLATFORM_SENDER_NAME;

  const client = clientName.trim();
  // Our own mail, or a client that shares our name: "X via X" is silly, and
  // the relationship it would be stating is not one.
  const display = !client || client === platform ? platform : `${client} via ${platform}`;

  return `${quoted(display)} <${address}>`;
}

/** RFC 5322 quoted-string. Always quoting is valid and sidesteps atom rules. */
const quoted = (name: string) => `"${name.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;

/* ------------------------------------------------------------------ email */

/**
 * Resend. The same provider that sends sign-in codes, on a SEPARATE key.
 *
 * `AUTH_RESEND_KEY` is the sign-in key and stays that: a shared key makes
 * "when did this last send anything" unanswerable for either purpose, and that
 * is the one diagnostic that tells you whether sign-in itself is broken. The
 * `MESSAGING_*` pair falls back to the auth pair only so a deployment nobody
 * has given its own key yet still sends rather than silently queueing. The
 * fallback is not free — it is the case this comment exists to make visible.
 */
const resendEmail: MessageDriver = {
  name: "resend",
  async send(message) {
    const key = process.env.MESSAGING_RESEND_KEY ?? process.env.AUTH_RESEND_KEY;
    const from = process.env.MESSAGING_EMAIL_FROM ?? process.env.AUTH_EMAIL_FROM;

    /*
     * A missing key is RETRYABLE, and it is never a skip. Same reasoning as
     * the missing webhook secret: an unconfigured deployment must fail visibly
     * and keep asking, not decide the message was handled. It exhausts its
     * attempts and lands in the outbox with this sentence attached.
     */
    if (!key || !from) {
      return {
        delivered: false,
        providerName: "resend",
        retryable: true,
        error:
          "No email provider configured on this deployment. Set MESSAGING_RESEND_KEY " +
          "and MESSAGING_EMAIL_FROM (or the AUTH_ equivalents).",
      };
    }

    /*
     * OUR OWN NAME ON OUR OWN MAIL. `viaSender` collapses to the platform
     * name alone when there is no client to speak on behalf of, which is
     * exactly the case here — we are not writing on the client's behalf, we
     * are writing to them.
     */
    const sender = viaSender(message.toClient ? "" : message.clientName, from);

    let response: Response;
    try {
      response = await fetch("https://api.resend.com/emails", {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          from: sender,
          to: [message.to],
          subject: message.subject,
          text: message.body,
          // Omitted entirely when there is nowhere to send a reply, rather
          // than defaulted to the From address — which is on a sending domain
          // and may have no MX at all. The copy has already been rendered to
          // match: see resolveReplyTo.
          ...(message.replyTo ? { reply_to: message.replyTo } : {}),
        }),
      });
    } catch (error) {
      // Could not reach Resend at all. Always worth another go.
      return {
        delivered: false,
        providerName: "resend",
        retryable: true,
        error: `Could not reach Resend: ${String(error)}`,
      };
    }

    if (!response.ok) {
      const detail = await response.text().catch(() => "");
      /*
       * 4xx is us — a malformed address, an unverified sender, a rejected
       * domain — and retrying reproduces it exactly. 429 is the exception: a
       * 4xx that means "later", which is what a retry is for.
       */
      const retryable = response.status === 429 || response.status >= 500;
      return {
        delivered: false,
        providerName: "resend",
        retryable,
        error: `Resend refused the send: ${response.status} ${detail}`.trim(),
      };
    }

    const body = (await response.json().catch(() => null)) as { id?: string } | null;
    return { delivered: true, providerName: "resend", providerMessageId: body?.id };
  },
};

/* ------------------------------------------------- whatsapp and sms (none) */

/**
 * The logging no-op. It prints what WOULD have gone out, and refuses.
 *
 * Non-retryable on purpose: nothing about waiting five minutes makes a
 * provider account exist.
 */
function loggingNoop(channel: MessageChannel, why: string): MessageDriver {
  return {
    name: `${channel}-noop`,
    async send(message) {
      console.log(
        `[outbox:${channel}] NOT SENT to ${message.to} — ${message.templateKey}\n` +
          `  from: ${message.clientName}\n` +
          message.body
            .split("\n")
            .map((line) => `  | ${line}`)
            .join("\n"),
      );
      return { delivered: false, providerName: `${channel}-noop`, retryable: false, error: why };
    },
  };
}

/* -------------------------------------------------------- the send allowlist */

/**
 * WHO MAY ACTUALLY BE SENT TO, on this deployment, right now.
 *
 * A live driver plus a database of real people is a thing that can reach them
 * before anybody has read a single message it produced. The allowlist is the
 * dial between "wired up" and "loose", and it is the driver's business rather
 * than dispatch's: a blocked address should still be QUEUED, still claimed,
 * still counted, and still visible in the outbox with the reason. Refusing at
 * queue time would hide the very rows you turned it on to look at.
 *
 * `MESSAGING_ALLOWLIST` is a comma- or space-separated list. Entries are
 * matched case-insensitively and may be:
 *   - a full address or E.164 number  — taine@example.com, +27825551234
 *   - a domain, written with a leading @   — @thecreativecurrent.co.za
 *   - the single token `*`            — everybody, the steady state
 *
 * UNSET MEANS NOBODY, and that is the deliberate half.
 *
 * THIS IS NOT AN INVERSION OF "PREFER SENDING TWICE OVER SUPPRESSING", and
 * the distinction is written down here because it is the kind of apparent
 * inconsistency somebody eventually tidies away.
 *
 * That rule is about which message a RUNNING system sends: given a pipeline
 * that is switched on and a judgement call about one message, send it, because
 * a duplicate is visible and a suppression is not. An unconfigured deployment
 * is not making that judgement. It is not suppressing a message — it has not
 * been switched on. Those are different questions, and answering the second
 * one with the first is how a live provider ends up pointed at a database of
 * real people because nobody had got round to saying who it may reach.
 *
 * Which leaves only the ordinary question of which error is recoverable. An
 * unconfigured deployment that sends nothing is a config change away from
 * correct, and every held message is still sitting in the outbox waiting.
 * An unconfigured deployment that sends everything has already sent it.
 *
 * The cost is real: a production nobody configured sends nothing. Three
 * things pay for it — every held row is in the outbox with this sentence
 * attached, the refusal names the variable AND the value that opens it, and
 * `health:messagingConfig` answers it in one command. It is a loud silence.
 */
const ALLOWLIST_VAR = "MESSAGING_ALLOWLIST";

export type AllowlistState =
  | { mode: "unset" }
  | { mode: "open" }
  | { mode: "restricted"; entries: string[] };

export function sendAllowlist(): AllowlistState {
  const raw = process.env[ALLOWLIST_VAR]?.trim();
  if (!raw) return { mode: "unset" };

  const entries = raw
    .split(/[,\s]+/)
    .map((entry) => entry.trim().toLowerCase())
    .filter(Boolean);

  if (entries.includes("*")) return { mode: "open" };
  if (entries.length === 0) return { mode: "unset" };
  return { mode: "restricted", entries };
}

/** Whether one destination clears the allowlist, and the sentence if it does not. */
export function allowedToSend(to: string): { allowed: boolean; reason: string } {
  const state = sendAllowlist();
  if (state.mode === "open") return { allowed: true, reason: "" };

  if (state.mode === "unset") {
    return {
      allowed: false,
      reason:
        `Nothing sends: ${ALLOWLIST_VAR} is not set on this deployment. Set it to the ` +
        `addresses that may receive mail, or to "*" for everybody. The message is ` +
        "queued and recorded, not lost.",
    };
  }

  const target = to.trim().toLowerCase();
  const at = target.lastIndexOf("@");
  const domain = at > 0 ? target.slice(at + 1) : null;

  const allowed = state.entries.some((entry) => {
    // A leading @ means "anybody at this domain".
    if (entry.startsWith("@")) return domain !== null && domain === entry.slice(1);
    return entry === target;
  });

  return {
    allowed,
    reason: allowed
      ? ""
      : `${to} is not on this deployment's ${ALLOWLIST_VAR}. The message is queued and ` +
        "recorded, not sent — add the address to widen it.",
  };
}

/**
 * Wrap a driver so it cannot reach anybody the allowlist has not named.
 *
 * The wrapper keeps the driver's own NAME, so the outbox still says which
 * provider would have handled it and `LIVE_CHANNELS` below still recognises a
 * real driver from a no-op.
 */
function gated(driver: MessageDriver): MessageDriver {
  return {
    name: driver.name,
    async send(message) {
      const verdict = allowedToSend(message.to);
      if (!verdict.allowed) {
        console.log(
          `[outbox:${message.channel}] HELD BY ALLOWLIST — ${message.to} — ` +
            `${message.templateKey}\n` +
            message.body
              .split("\n")
              .map((line) => `  | ${line}`)
              .join("\n"),
        );
        // Non-retryable: waiting does not put an address on a list.
        return {
          delivered: false,
          providerName: driver.name,
          retryable: false,
          error: verdict.reason,
        };
      }
      return driver.send(message);
    },
  };
}

const isNoop = (driver: MessageDriver) => driver.name.endsWith("-noop");

/**
 * The one place that says which channels can actually reach a person.
 *
 * Callers choose a channel from what the CUSTOMER has — an email address, a
 * phone — and what they have consented to. This says what the PLATFORM has. A
 * channel with no driver still queues a row and still records a refusal, so
 * the gap reads as a stated reason in the outbox rather than as silence.
 *
 * Every driver that can actually send is wrapped in the allowlist, HERE rather
 * than inside each driver, so a WhatsApp driver added later is gated the day
 * it is written and not the day somebody remembers. The no-ops are left
 * unwrapped: "no WhatsApp provider is configured" is the truer sentence, and
 * putting an address on a list would not change it.
 */
export function driverFor(channel: MessageChannel): MessageDriver {
  const driver = pickDriver(channel);
  return isNoop(driver) ? driver : gated(driver);
}

function pickDriver(channel: MessageChannel): MessageDriver {
  switch (channel) {
    case "email":
      return resendEmail;
    case "whatsapp":
      return loggingNoop(
        "whatsapp",
        "No WhatsApp provider is configured yet. The message was queued and logged, " +
          "not sent — phone the customer, or take an email address for them.",
      );
    case "sms":
      return loggingNoop(
        "sms",
        "No SMS provider is configured. The message was queued and logged, not sent.",
      );
  }
}

/**
 * The channels that can actually deliver today.
 *
 * Derived from `driverFor` being real rather than declared beside it, so the
 * two cannot drift: a channel is live exactly when its driver is not the
 * no-op. Adding WhatsApp therefore makes it selectable automatically.
 */
export const LIVE_CHANNELS: readonly MessageChannel[] = (
  ["email", "whatsapp", "sms"] as MessageChannel[]
).filter((channel) => !driverFor(channel).name.endsWith("-noop"));

/* --------------------------------------------------------------- reply-to */

/**
 * WHERE A REPLY GOES. Resolved ONCE, for the renderer and the driver together.
 *
 * The customer is replying to the BUSINESS, not to the platform, so the
 * client's own `primaryContactEmail` is the right answer and almost always a
 * mailbox that demonstrably works — it is the address they gave us. The env
 * fallback is for a deployment that wants every reply in one place, and for
 * the case where a client record has no contact address yet.
 *
 * NULL IS A REAL ANSWER and the copy respects it. Defaulting to the From
 * address would look like it worked: replies would leave the customer's outbox
 * cheerfully and land nowhere, because the sending domain has no MX. There is
 * no way for this code to check MX from the Convex runtime, so it does not
 * guess — it only ever names an address somebody actually chose.
 */
export function resolveReplyTo(clientContactEmail: string | null | undefined): string | null {
  const client = clientContactEmail?.trim();
  if (client) return client;
  return process.env.MESSAGING_REPLY_TO?.trim() || null;
}

/* ----------------------------------------------------------------- content */

/**
 * Rendering, in code rather than out of `messageTemplates`.
 *
 * That table is for provider-APPROVED templates — WhatsApp requires a
 * business-initiated message to use one, and the approval status is a fact
 * about Meta review, not about us. Nothing writes it because nothing has been
 * submitted to anybody. Email carries no such requirement, so email copy lives
 * here in the repo where it is reviewed like the rest of the code. When
 * WhatsApp arrives its driver reads an approved name from that table, and this
 * stays the email path.
 */
export type RenderInput = {
  templateKey: string;
  channel: MessageChannel;
  payload: Record<string, string>;
  clientName: string;
  /** The SITE timezone — the same one quiet hours use, for the same reason. */
  timezone: string;
  /** See OutboundMessage. The copy addresses the client, not their customer. */
  toClient: boolean;
  /**
   * The resolved reply-to, or null. The COPY changes on this: a message only
   * invites a reply when a reply has somewhere to land.
   */
  replyTo: string | null;
};

/**
 * "How to reach us", written from what is actually true.
 *
 * The first version of this copy said "reply to this message or phone us" on
 * every message, unconditionally. Both halves could be false at once: the
 * From address is on a sending domain that may have no MX, and "phone us" with
 * no number is not an instruction. A confirmation is the most replied-to
 * message this system sends, so the sentence that tells somebody how to change
 * their appointment is the one that can least afford to be decorative.
 *
 * `contactPhone` comes from the booking's own branch, put in the payload by
 * the producer — which is the only place that knows which branch it was.
 */
function howToReach(input: RenderInput, prefix: string): string {
  const phone = input.payload.contactPhone?.trim();
  const canReply = Boolean(input.replyTo);

  if (canReply && phone) return `${prefix}, reply to this message or phone us on ${phone}.`;
  if (canReply) return `${prefix}, just reply to this message.`;
  if (phone) return `${prefix}, phone us on ${phone}.`;
  /*
   * Neither. Deliberately vague rather than inviting a reply into a black
   * hole — and deliberately still present, because a customer has to know the
   * appointment can be changed at all. It reads as thin, which is the point:
   * it is the visible symptom of a client record with no contact details.
   */
  return `${prefix}, please get in touch with ${input.clientName}.`;
}

/**
 * Null for an unknown key, rather than a guess or a throw. An unknown template
 * is a bug in whatever queued the message, and the row should say so in the
 * outbox instead of sending a half-rendered sentence to a customer.
 */
export function renderMessage(input: RenderInput): { subject: string; body: string } | null {
  const when = input.payload.startsAt
    ? formatWhen(Number(input.payload.startsAt), input.timezone)
    : null;
  const client = input.clientName;

  switch (input.templateKey) {
    case "booking_confirmation":
      if (!when) return null;
      return {
        subject: `Booking confirmed — ${when.short}`,
        body: [
          `Your booking with ${client} is confirmed.`,
          "",
          `  ${when.long}`,
          "",
          howToReach(input, "If you need to change or cancel it"),
          "",
          client,
        ].join("\n"),
      };

    case "quote_sent": {
      const link = input.payload.link;
      const number = input.payload.number ?? "your quote";
      if (!link) return null;

      const total = input.payload.totalCents
        ? formatMoney(Number(input.payload.totalCents), input.payload.currency ?? "ZAR")
        : null;
      const until = input.payload.expiresAt
        ? (formatWhen(Number(input.payload.expiresAt), input.timezone)?.short ?? null)
        : null;

      return {
        subject: total ? `Your quote from ${client} — ${total}` : `Your quote from ${client}`,
        body: [
          `${client} has sent you a quote.`,
          "",
          total ? `  ${number} — ${total}` : `  ${number}`,
          "",
          /*
           * The link, alone on its line. Mail clients and WhatsApp both
           * linkify a bare URL reliably; a URL wrapped in a sentence is the
           * one that gets truncated or half-selected.
           */
          "Read it and accept it here:",
          `  ${link}`,
          "",
          until ? `It stands until ${until}.` : null,
          until ? "" : null,
          howToReach(input, "If anything on it looks wrong"),
          "",
          client,
        ]
          .filter((line) => line !== null)
          .join("\n"),
      };
    }

    case "reminder_24h":
      if (!when) return null;
      return {
        subject: `Reminder: ${client} tomorrow, ${when.short}`,
        body: [
          `A reminder that your booking with ${client} is tomorrow.`,
          "",
          `  ${when.long}`,
          "",
          howToReach(input, "If tomorrow no longer suits, tell us as early as you can"),
          "",
          client,
        ].join("\n"),
      };

    case "reminder_1h":
      if (!when) return null;
      return {
        subject: `${client} — in about an hour`,
        body: [
          `Your booking with ${client} is in about an hour.`,
          "",
          `  ${when.long}`,
          "",
          client,
        ].join("\n"),
      };


    /* ------------------------------------------------- to the CLIENT, from us */

    case "invoice_issued": {
      /*
       * THE LINK IS THE DOCUMENT. No attachment, and no PDF rendered
       * anywhere: the page prints, so "save as PDF" in a browser covers the
       * bookkeeping case without this codebase ever owning a PDF pipeline.
       * If a real client asks for an attachment, that is the moment to build
       * one — and they may never ask.
       */
      const amount = money(input.payload.totalCents, input.payload.currency);
      const due = day(input.payload.dueAt);
      const reference = input.payload.paymentReference;
      if (!amount || !reference) return null;

      return {
        subject: `Invoice ${input.payload.number} from ${input.payload.issuerLegalName}`,
        body: [
          `Hi ${input.payload.billToName ?? "there"},`,
          "",
          `Invoice ${input.payload.number} for ${amount}.`,
          "",
          `  ${input.payload.viewUrl}`,
          "",
          "That opens in a browser and prints straight to PDF if you need one",
          "for your records.",
          "",
          due ? `  Due          ${due}` : `  Terms        ${input.payload.termsDays} days`,
          `  Reference    ${reference}`,
          "",
          /*
           * Said plainly and given its own line, because it is the one thing
           * on here that a person has to TYPE, into a banking app, from
           * memory of a page they closed. A payment that arrives without it
           * is money that reconciles to nothing.
           */
          `Please use ${reference} as the payment reference — it is how the payment`,
          "gets matched to this invoice.",
          "",
          input.payload.issuerLegalName ?? PLATFORM_SENDER_NAME,
        ].join("\n"),
      };
    }

    case "client_invite": {
      const business = input.payload.businessName ?? input.clientName;
      const url = input.payload.signInUrl;
      const email = input.payload.email;
      if (!url || !email) return null;

      return {
        subject: `Your ${business} back office is ready`,
        body: [
          "Hi,",
          "",
          `The back office for ${business} is set up. It is where your bookings and`,
          "your customers live, and it works on a phone — open it once and you can",
          "add it to your home screen like an app.",
          "",
          `  ${url}`,
          "",
          /*
           * THE ADDRESS, NOT A TOKEN, and the copy has to say so.
           *
           * Sign-in reconciles invites by email address (see resolveSignIn),
           * so the ONE thing that can go wrong is signing in with a different
           * address — a personal Gmail instead of the work one — which fails
           * with "this platform is invite-only" and reads as a broken invite.
           * Naming the address is what prevents the support call.
           */
          `Sign in with ${email}. That is the address we have given access to, and`,
          "another one will not be recognised. You will get a code by email — there",
          "is no password to remember.",
          "",
          PLATFORM_SENDER_NAME,
        ].join("\n"),
      };
    }

    default:
      return null;
  }
}

/**
 * Money for a person, from the strings a payload carries.
 *
 * Null rather than a guess: a total that will not parse is a bug in whatever
 * queued the message, and `renderMessage` returning null puts that in the
 * outbox instead of emailing somebody an invoice for "NaN".
 */
function money(cents: string | undefined, currency: string | undefined): string | null {
  const value = Number(cents);
  if (!cents || !Number.isFinite(value) || !currency) return null;
  return formatCents(value, currency as Currency);
}

/** A date a person reads, in the platform timezone. Null if absent or unparseable. */
function day(at: string | undefined): string | null {
  const value = Number(at);
  if (!at || !Number.isFinite(value)) return null;
  return new Intl.DateTimeFormat("en-ZA", {
    timeZone: "Africa/Johannesburg",
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
  }).format(new Date(value));
}

/**
 * A time a person recognises, in the BUSINESS timezone.
 *
 * The same approximation as quiet hours, for the same reason: a booking takes
 * a name and a phone number, so no recipient timezone exists anywhere to use.
 * Naming the timezone out loud in the long form is what makes that survivable
 * for the customer who is not in it.
 */
/**
 * Rands from integer cents, for a message body.
 *
 * The same shape the invoice and quote documents render, so a customer who
 * sees a figure in an email and then opens the link is not comparing two
 * differently-formatted numbers and wondering which is right.
 */
function formatMoney(cents: number, currency: string): string | null {
  if (!Number.isFinite(cents)) return null;
  try {
    return new Intl.NumberFormat("en-ZA", {
      style: "currency",
      currency,
      minimumFractionDigits: 2,
    }).format(cents / 100);
  } catch {
    // An unknown currency code must not take the whole message down; the
    // renderer returning null would drop a quote nobody could then accept.
    return null;
  }
}

function formatWhen(at: number, timeZone: string): { short: string; long: string } | null {
  if (!Number.isFinite(at)) return null;
  const date = new Date(at);
  const short = new Intl.DateTimeFormat("en-ZA", {
    timeZone,
    weekday: "short",
    day: "numeric",
    month: "short",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
  }).format(date);
  const long = new Intl.DateTimeFormat("en-ZA", {
    timeZone,
    weekday: "long",
    day: "numeric",
    month: "long",
    year: "numeric",
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZoneName: "short",
  }).format(date);
  return { short, long };
}
