import { requiredRecords, type DnsRecord } from "./dns";

/**
 * The domain provider, behind an interface — the same pattern the WhatsApp
 * driver uses, and for the same reason: the platform has to be buildable and
 * demonstrable before every external account exists.
 *
 * With no VERCEL_TOKEN configured this returns a `simulated` result rather
 * than throwing. The wizard then still generates real DNS instructions a
 * client can act on, and the operator sees plainly that nothing was attached
 * upstream. A wizard that cannot run without a token would block onboarding
 * on an account setup that has nothing to do with the client.
 */

export type DomainAttachment = {
  hostname: string;
  /** false when no token is configured: instructions are real, attachment is not. */
  attached: boolean;
  verified: boolean;
  /** Vercel's own records when it answered; the documented defaults otherwise. */
  records: DnsRecord[];
  /** Present when Vercel wants a TXT challenge (domain already in use elsewhere). */
  verificationChallenge: DnsRecord | null;
  note: string;
};

const API = "https://api.vercel.com";

function config() {
  const token = process.env.VERCEL_TOKEN;
  const projectId = process.env.VERCEL_PROJECT_ID;
  const teamId = process.env.VERCEL_TEAM_ID;
  return { token, projectId, teamId, configured: Boolean(token && projectId) };
}

const teamQuery = (teamId?: string) => (teamId ? `?teamId=${teamId}` : "");

/** Vercel's verification challenges, mapped into our own record shape. */
function toChallenge(verification: unknown): DnsRecord | null {
  if (!Array.isArray(verification) || verification.length === 0) return null;
  const first = verification[0] as { type?: string; domain?: string; value?: string };
  if (!first?.type || !first.domain || !first.value) return null;
  return {
    type: "TXT",
    name: first.domain,
    value: first.value,
    purpose:
      "Proves you control this domain. Required because it is already in use " +
      "on another account.",
  };
}

export async function attachDomain(hostname: string): Promise<DomainAttachment> {
  const { token, projectId, teamId, configured } = config();
  const fallback = requiredRecords(hostname);

  if (!configured) {
    return {
      hostname,
      attached: false,
      verified: false,
      records: fallback,
      verificationChallenge: null,
      note:
        "VERCEL_TOKEN or VERCEL_PROJECT_ID is not set, so the domain was not " +
        "attached upstream. The DNS records below are still correct — send " +
        "them to the client, then attach once the token is configured.",
    };
  }

  const response = await fetch(
    `${API}/v10/projects/${projectId}/domains${teamQuery(teamId)}`,
    {
      method: "POST",
      headers: { Authorization: `Bearer ${token}`, "Content-Type": "application/json" },
      body: JSON.stringify({ name: hostname }),
    },
  );

  const body = (await response.json()) as {
    verified?: boolean;
    verification?: unknown;
    error?: { code?: string; message?: string };
  };

  // Already attached to THIS project is success, not failure — the wizard has
  // to be safe to re-run, because operators re-run it.
  const alreadyOurs = body.error?.code === "domain_already_in_use_by_this_project";

  if (!response.ok && !alreadyOurs) {
    throw new Error(
      `Vercel refused ${hostname}: ${body.error?.code ?? response.status} ` +
        `${body.error?.message ?? ""}`.trim(),
    );
  }

  return {
    hostname,
    attached: true,
    verified: Boolean(body.verified),
    records: fallback,
    verificationChallenge: toChallenge(body.verification),
    note: alreadyOurs
      ? "Already attached to this project. Nothing changed."
      : "Attached. It goes live once the DNS records below are in place.",
  };
}

export type DomainStatus = {
  attached: boolean;
  verified: boolean;
  misconfigured: boolean | null;
  note: string;
};

export async function domainStatus(hostname: string): Promise<DomainStatus> {
  const { token, projectId, teamId, configured } = config();

  if (!configured) {
    return {
      attached: false,
      verified: false,
      misconfigured: null,
      note: "No Vercel token configured, so upstream status is unknown.",
    };
  }

  const [domain, verify] = await Promise.all([
    fetch(`${API}/v9/projects/${projectId}/domains/${hostname}${teamQuery(teamId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
    fetch(`${API}/v6/domains/${hostname}/config${teamQuery(teamId)}`, {
      headers: { Authorization: `Bearer ${token}` },
    }),
  ]);

  if (domain.status === 404) {
    return {
      attached: false,
      verified: false,
      misconfigured: null,
      note: "Not attached to the project.",
    };
  }

  const domainBody = (await domain.json()) as { verified?: boolean };
  const verifyBody = (await verify.json()) as { misconfigured?: boolean };

  return {
    attached: true,
    verified: Boolean(domainBody.verified),
    misconfigured: verifyBody.misconfigured ?? null,
    note: verifyBody.misconfigured
      ? "Attached, but the DNS records are not right yet."
      : domainBody.verified
        ? "Live."
        : "Attached. Waiting on DNS.",
  };
}

export const isVercelConfigured = () => config().configured;
