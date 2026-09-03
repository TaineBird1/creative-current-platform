// @vitest-environment node
import { describe, expect, test } from "vitest";
// @ts-expect-error -- plain .mjs, no types, deliberately kept dependency-free
import { redact, fingerprint, relay } from "./lib/secret-redaction.mjs";

/**
 * NOTHING SECRET REACHES A LOG.
 *
 * These exist because the leak already happened. While `set-auth-keys.mjs` was
 * being written the Convex CLI refused a private key passed as an argument and
 * printed it back in its own error message. That text was relayed straight to
 * stderr and was in a terminal scrollback — and a chat transcript — before
 * anybody noticed.
 *
 * The key was TRUNCATED in that message, which is the whole reason an
 * exact-match redactor is not enough and why these tests are worth having.
 */

const PEM =
  "-----BEGIN PRIVATE KEY----- " +
  "MIIEvgIBADANBgkqhkiG9w0BAQEFAASCBKgwggSkAgEAAoIBAQCtvquXub6CL+QA " +
  "ONarm1kUyWVLh1gU1iWP3z8ocPrPDXnHgnvGDZLMHhqno/x7vwEBNeCqjHnRNY7E " +
  "-----END PRIVATE KEY-----";

const JWKS = '{"keys":[{"use":"sig","kty":"RSA","n":"tvquXub6CL-QAONarm1kUyWVLh1gU1iWP3z8"}]}';

const SECRETS = [
  { name: "JWT_PRIVATE_KEY", value: PEM },
  { name: "JWKS", value: JWKS },
];

/** Any run of the secret this long or longer must not survive. */
const RUNS = [24, 40, 80];

describe("the leak that actually happened", () => {
  test("THE CLI'S OWN TRUNCATED ERROR IS REDACTED", () => {
    /*
     * Reconstructed from the real failure. `commander` treats a value starting
     * with `-` as an option and echoes what it could not parse — a prefix of
     * the key, not the whole of it.
     */
    const real = `error: unknown option '${PEM.slice(0, 96)}...'`;

    const safe = redact(real, SECRETS);

    expect(safe).not.toContain("MIIEvgIBADANBgkq");
    expect(safe).not.toContain(PEM.slice(0, 40));
    expect(safe).toContain("JWT_PRIVATE_KEY redacted");
    // The error is still legible — that is the point of redacting rather than
    // dropping the message.
    expect(safe).toContain("unknown option");
  });

  test.each(RUNS)("a %i-character run of the key does not survive", (n) => {
    const leak = `something went wrong near ${PEM.slice(10, 10 + n)} and then stopped`;
    const safe = redact(leak, SECRETS);
    expect(safe).not.toContain(PEM.slice(10, 10 + n));
    expect(safe).toContain("redacted");
  });

  test("the whole value is redacted when echoed intact", () => {
    const safe = redact(`set FAILED with value ${PEM}`, SECRETS);
    expect(safe).not.toContain("MIIEvgIBADANBgkq");
  });

  test("JWKS is redacted too — it is registered, so it is protected", () => {
    const safe = redact(`could not parse ${JWKS}`, SECRETS);
    expect(safe).not.toContain("tvquXub6CL-QAONarm1kUyWVLh1gU1iWP3z8");
  });
});

describe("secrets we were not about to send", () => {
  test("A PEM BLOCK IS REDACTED STRUCTURALLY, even when unregistered", () => {
    /*
     * A tool can mention a key that is not the one we are setting. Matching
     * only on registered values would let that through on a technicality.
     */
    const other =
      "-----BEGIN RSA PRIVATE KEY-----\nAAAAB3NzaC1yc2EAAAADAQAB\n-----END RSA PRIVATE KEY-----";
    const safe = redact(`unrelated: ${other}`, []);
    expect(safe).not.toContain("AAAAB3NzaC1yc2EAAAADAQAB");
    expect(safe).toContain("[private key redacted]");
  });
});

describe("it stays usable", () => {
  test("ordinary output is untouched", () => {
    const ordinary = "Error: connection refused (ECONNREFUSED) contacting wary-pika-965";
    expect(redact(ordinary, SECRETS)).toBe(ordinary);
  });

  test("a run of tags collapses so the message is still readable", () => {
    const safe = redact(PEM, SECRETS);
    expect((safe.match(/redacted/g) ?? []).length).toBeLessThanOrEqual(2);
  });

  test("empty and nullish input do not throw", () => {
    expect(redact("", SECRETS)).toBe("");
    expect(redact(undefined, SECRETS)).toBe("");
    expect(redact(null, SECRETS)).toBe("");
  });

  test("a secret with no value is skipped rather than redacting everything", () => {
    // An empty string is a substring of every string. Splitting on it would
    // shred all output into tags.
    const safe = redact("perfectly normal line", [{ name: "EMPTY", value: "" }]);
    expect(safe).toBe("perfectly normal line");
  });
});

describe("the fingerprint is what may be printed instead", () => {
  test("it carries length and a sha256 prefix, and not the value", () => {
    const fp = fingerprint(PEM);
    expect(fp).toContain(`${PEM.length} chars`);
    expect(fp).toMatch(/sha256 [0-9a-f]{16}/);
    expect(fp).not.toContain("MIIEvg");
  });

  test("it distinguishes two values", () => {
    expect(fingerprint(PEM)).not.toBe(fingerprint(PEM + " "));
  });

  test("it is stable for the same value, so two logs can be compared", () => {
    expect(fingerprint(JWKS)).toBe(fingerprint(JWKS));
  });
});

describe("relay", () => {
  test("indents and redacts in one step", () => {
    const out = relay(`line one ${PEM.slice(0, 40)}\nline two`, SECRETS);
    expect(out).not.toContain(PEM.slice(0, 40));
    for (const line of out.split("\n")) expect(line.startsWith("      ")).toBe(true);
  });
});
