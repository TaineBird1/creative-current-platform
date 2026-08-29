/**
 * DNS instructions for pointing a client's domain at their site.
 *
 * Pure functions, no network. This is the part a client's IT person, or their
 * cousin who "does websites", actually has to act on — so it is generated
 * rather than written by hand per client, and it is tested.
 *
 * The AUTHORITATIVE records come from Vercel's API when a token is
 * configured. These are the documented defaults, used for the preview a
 * client sees before we attach anything, and as a fallback. When the API
 * disagrees, the API wins.
 */

/** Vercel's documented anycast address for apex domains. */
export const VERCEL_APEX_A = "76.76.21.21";

/** Vercel's documented CNAME target for subdomains. */
export const VERCEL_CNAME = "cname.vercel-dns.com";

export type DnsRecord = {
  type: "A" | "CNAME" | "TXT";
  /** What goes in the registrar's "name"/"host" field. */
  name: string;
  value: string;
  /** Why this record exists, in words a non-technical person can act on. */
  purpose: string;
};

export type HostnameShape =
  | { kind: "apex"; domain: string }
  | { kind: "subdomain"; domain: string; label: string };

const HOSTNAME_RE = /^(?=.{1,253}$)([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z]{2,}$/;

/**
 * Deliberately naive about multi-part public suffixes: `co.za` means
 * `renusolar.co.za` is an apex with three labels. Treating label-count as the
 * test would call it a subdomain and hand the client a CNAME their registrar
 * refuses at the zone root. South African clients are the default case here,
 * so this list is not optional.
 */
const MULTI_PART_SUFFIXES = [
  "co.za", "org.za", "net.za", "web.za", "gov.za", "ac.za",
  "co.uk", "org.uk", "me.uk", "com.au", "co.nz", "com.br",
];

/**
 * Reject anything that is not a plain hostname BEFORE it reaches the database
 * or Vercel. A hostname is a routing key here: `domains.by_hostname` decides
 * whose site a request serves, so a malformed or duplicated one is a tenancy
 * problem, not a validation nicety.
 */
export function normaliseHostname(input: string): string {
  const trimmed = input
    .trim()
    .toLowerCase()
    .replace(/^https?:\/\//, "")
    .replace(/\/.*$/, "")
    .replace(/\.$/, "");

  if (!HOSTNAME_RE.test(trimmed)) {
    throw new Error(`"${input}" is not a valid hostname`);
  }

  // A bare public suffix is syntactically a hostname and semantically nobody's:
  // no one can own `co.za`. Vercel would refuse it eventually; refusing here
  // gives the operator a sentence they can act on instead of an API code.
  if (MULTI_PART_SUFFIXES.includes(trimmed) || !trimmed.includes(".")) {
    throw new Error(`"${trimmed}" is a public suffix, not a domain anyone can own`);
  }

  return trimmed;
}

/**
 * Apex or subdomain? They need completely different records, and getting it
 * wrong is the single most common reason a domain never goes live.
 */
export function hostnameShape(hostname: string): HostnameShape {
  const suffix = MULTI_PART_SUFFIXES.find((s) => hostname.endsWith(`.${s}`));
  const labelsInSuffix = suffix ? suffix.split(".").length : 1;
  const labels = hostname.split(".");

  if (labels.length === labelsInSuffix + 1) {
    return { kind: "apex", domain: hostname };
  }
  return {
    kind: "subdomain",
    domain: labels.slice(labels.length - labelsInSuffix - 1).join("."),
    label: labels.slice(0, labels.length - labelsInSuffix - 1).join("."),
  };
}

export function requiredRecords(hostname: string): DnsRecord[] {
  const shape = hostnameShape(hostname);

  if (shape.kind === "apex") {
    return [
      {
        type: "A",
        name: "@",
        value: VERCEL_APEX_A,
        purpose: `Points ${hostname} at the website.`,
      },
      {
        type: "CNAME",
        name: "www",
        value: VERCEL_CNAME,
        purpose: `Sends www.${hostname} to the same place, so both work.`,
      },
    ];
  }

  return [
    {
      type: "CNAME",
      name: shape.label,
      value: VERCEL_CNAME,
      purpose: `Points ${hostname} at the website.`,
    },
  ];
}

/**
 * The shareable one-pager.
 *
 * Plain text on purpose: it gets pasted into WhatsApp, an email, or a support
 * ticket at a registrar. Anything richer arrives broken. It names the
 * registrar's own vocabulary ("Host", "Points to") rather than ours, because
 * the person reading it is looking at their registrar's form, not at us.
 */
export function dnsOnePager(args: {
  hostname: string;
  businessName: string;
  records: DnsRecord[];
}): string {
  const { hostname, businessName, records } = args;
  const shape = hostnameShape(hostname);

  const lines: string[] = [
    `DNS changes for ${hostname}`,
    `Website for ${businessName}`,
    "",
    "Sign in wherever the domain was bought (the registrar), find the DNS or",
    "Name Server settings, and add these records.",
    "",
  ];

  for (const [i, record] of records.entries()) {
    lines.push(
      `${i + 1}. ${record.type} record`,
      `   Host / Name:  ${record.name}`,
      `   Points to:    ${record.value}`,
      `   TTL:          leave as the default (or 3600)`,
      `   Why:          ${record.purpose}`,
      "",
    );
  }

  lines.push(
    "Notes",
    "",
    "- If a record with the same Host already exists, REPLACE it rather than",
    "  adding a second one. Two records for the same host will conflict.",
  );

  if (shape.kind === "apex") {
    lines.push(
      "- Some registrars write the apex Host as blank, or as the domain itself,",
      `  instead of @. All three mean the same thing.`,
    );
  }

  lines.push(
    "- Changes usually take effect within an hour, occasionally up to 24.",
    "- Nothing here touches email. Existing MX records are unaffected.",
    "",
    "The certificate is issued automatically once the records are live.",
    "There is nothing to buy and nothing to install.",
  );

  return lines.join("\n");
}
