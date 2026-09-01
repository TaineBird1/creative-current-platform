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
     * The business name in the display name, on OUR verified domain. A client
     * own domain is not verified with Resend and would be rejected or filed as
     * spam, so their address belongs in a reply-to once there is one to put
     * there — not in the envelope sender.
     */
    const sender = from.includes("<") ? from : `${message.clientName} <${from}>`;

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
 * The rule elsewhere in this codebase is prefer sending twice over
 * suppressing, and this inverts it — so it needs its reason stated rather than
 * assumed. The deployment this protects is the one nobody configures. Dev
 * holds real leads and real numbers and will never have a go-live checklist
 * run against it; production gets one, deliberately, on the day it goes live.
 * Defaulting open protects the deployment that is already being watched and
 * leaves the dangerous one open.
 *
 * The cost is real and it is the one this codebase normally refuses: an
 * unconfigured production sends nothing. Three things pay for it — every
 * blocked row is in the outbox with this sentence attached, the refusal names
 * the variable and the value that opens it, and `health:messagingConfig`
 * answers it in one command. It is a loud silence, not a quiet one.
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
};

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
          "If you need to change or cancel it, reply to this message or phone us.",
          "",
          client,
        ].join("\n"),
      };

    case "reminder_24h":
      if (!when) return null;
      return {
        subject: `Reminder: ${client} tomorrow, ${when.short}`,
        body: [
          `A reminder that your booking with ${client} is tomorrow.`,
          "",
          `  ${when.long}`,
          "",
          "If tomorrow no longer suits, tell us as early as you can and we will",
          "move it.",
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

    default:
      return null;
  }
}

/**
 * A time a person recognises, in the BUSINESS timezone.
 *
 * The same approximation as quiet hours, for the same reason: a booking takes
 * a name and a phone number, so no recipient timezone exists anywhere to use.
 * Naming the timezone out loud in the long form is what makes that survivable
 * for the customer who is not in it.
 */
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
