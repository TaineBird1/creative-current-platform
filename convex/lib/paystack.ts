/**
 * THE PAYSTACK SEAM.
 *
 * Same shape as lib/providers.ts, and for the same reason: one interface, a
 * live driver, and a default that refuses rather than pretends. Everything
 * that decides WHETHER money may be asked for happens before a driver is
 * reached; this only knows how to ask.
 *
 * WHAT IS BLOCKED AND WHAT IS NOT. Going live needs a bank account, which does
 * not exist yet, so nothing here has been run against a real Paystack account.
 * Test mode needs only a test secret key and works end to end, which is what
 * the tests below the interface exercise. The distinction matters because an
 * untested integration that LOOKS finished is worse than an obviously unbuilt
 * one — so a missing key is a loud refusal, never a silent skip.
 *
 * ONLY `initialize` IS HERE. Paystack creates the subscription itself once the
 * customer pays a transaction that carries a plan code — we do not create one
 * through the API, so there is no second way to do it and no second state
 * machine. Everything after the redirect arrives as a webhook.
 */

export type PaystackInit = {
  /** The customer's email. Paystack keys its own customer records on it. */
  email: string;
  /** The plan code from Paystack's dashboard. It overrides any amount. */
  planCode: string;
  /**
   * OUR reference, generated before the customer sees anything, echoed back
   * on every transaction event. It is what makes the first `charge.success`
   * attributable — the provider's own subscription code does not exist yet.
   */
  reference: string;
  /** Carried through so a webhook can say whose this is without a lookup. */
  metadata: Record<string, string>;
  /** Where Paystack returns the customer afterwards. */
  callbackUrl?: string;
};

export type PaystackResult =
  | { ok: true; authorizationUrl: string; reference: string }
  | { ok: false; retryable: boolean; error: string };

export type PaystackDriver = {
  name: string;
  initialize(init: PaystackInit): Promise<PaystackResult>;
};

const API = "https://api.paystack.co/transaction/initialize";

/**
 * A MISSING KEY IS A REFUSAL, NOT A SKIP.
 *
 * The same rule as the webhook secret and the messaging provider. An
 * unconfigured deployment that returned a plausible-looking success here would
 * hand somebody a checkout link that goes nowhere, and the failure would land
 * on the client rather than on us.
 */
const live: PaystackDriver = {
  name: "paystack",
  async initialize(init) {
    const key = process.env.PAYSTACK_SECRET_KEY;
    if (!key) {
      return {
        ok: false,
        retryable: true,
        error:
          "No Paystack secret key on this deployment. Set PAYSTACK_SECRET_KEY. " +
          "Nothing was charged and no subscription was started.",
      };
    }

    /*
     * TEST KEYS ARE SAFE AND LIVE KEYS ARE NOT, so the two are worth telling
     * apart out loud rather than discovering from a bank statement. Paystack
     * prefixes them `sk_test_` and `sk_live_`.
     */
    if (!/^sk_(test|live)_/.test(key)) {
      return {
        ok: false,
        retryable: false,
        error: "PAYSTACK_SECRET_KEY does not look like a Paystack secret key.",
      };
    }

    let response: Response;
    try {
      response = await fetch(API, {
        method: "POST",
        headers: { Authorization: `Bearer ${key}`, "Content-Type": "application/json" },
        body: JSON.stringify({
          email: init.email,
          /*
           * NO `amount`. Paystack overrides it with the plan's own price, so
           * sending one would put a number in the request that is not the
           * number charged — and the next person to read it would believe it.
           */
          plan: init.planCode,
          reference: init.reference,
          metadata: init.metadata,
          ...(init.callbackUrl ? { callback_url: init.callbackUrl } : {}),
        }),
      });
    } catch (error) {
      return { ok: false, retryable: true, error: `Could not reach Paystack: ${String(error)}` };
    }

    const body = (await response.json().catch(() => null)) as
      | { status?: boolean; message?: string; data?: { authorization_url?: string; reference?: string } }
      | null;

    if (!response.ok || !body?.status || !body.data?.authorization_url) {
      /*
       * 4xx is our request — a plan code that does not exist, a duplicate
       * reference — and retrying reproduces it. 429 and 5xx are theirs.
       */
      const retryable = response.status === 429 || response.status >= 500;
      return {
        ok: false,
        retryable,
        error: `Paystack refused: ${response.status} ${body?.message ?? ""}`.trim(),
      };
    }

    return {
      ok: true,
      authorizationUrl: body.data.authorization_url,
      reference: body.data.reference ?? init.reference,
    };
  },
};

/**
 * The default when nothing is configured. It REFUSES, and says why, in the
 * same shape as the WhatsApp no-op: a driver that returned a fake checkout
 * URL would be a link somebody sends to a paying client.
 */
const unconfigured: PaystackDriver = {
  name: "paystack-unconfigured",
  async initialize() {
    return {
      ok: false,
      retryable: false,
      error:
        "Paystack is not configured on this deployment. Set PAYSTACK_SECRET_KEY " +
        "(a test key is enough to exercise the whole flow).",
    };
  },
};

export function paystack(): PaystackDriver {
  return process.env.PAYSTACK_SECRET_KEY ? live : unconfigured;
}

/** Whether this deployment could charge anybody, and on which key. */
export function paystackMode(): "live" | "test" | "unconfigured" {
  const key = process.env.PAYSTACK_SECRET_KEY;
  if (!key) return "unconfigured";
  return key.startsWith("sk_live_") ? "live" : "test";
}

/**
 * OUR reference for a checkout. Prefixed so it is recognisable in Paystack's
 * dashboard next to references from anything else, and random enough that two
 * attempts for the same client never collide — Paystack rejects a duplicate,
 * which would turn a second attempt into a refusal rather than a new checkout.
 */
export function newStartReference(): string {
  const bytes = new Uint8Array(12);
  crypto.getRandomValues(bytes);
  const suffix = [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `cc_sub_${suffix}`;
}
