import { convexTest } from "convex-test";
import { afterEach, describe, expect, test, vi } from "vitest";
import { generateKeyPair, exportPKCS8, exportJWK } from "jose";
import schema from "./schema";
import { internal } from "./_generated/api";

/**
 * THE PAIR CHECK, WHICH IS THE ONLY LINE THAT ANSWERS THE QUESTION.
 *
 * `health:authConfig` used to validate each half in isolation: JWKS parses,
 * JWT_PRIVATE_KEY is a well-formed PKCS8 PEM. Two individually perfect halves
 * that do not match each other is a different failure, invisible from either
 * value alone, and it is the expensive one — sign-in breaks for the owner,
 * every client and every client's back office simultaneously, while the check
 * reports `ok` three times.
 *
 * A half-rotation produces exactly that. These tests exist so the detection is
 * not something somebody has to remember to do by hand, because the hand check
 * happened once and the next rotation is production.
 */

const modules = import.meta.glob("./**/*.ts");

/** A whole keypair in the shapes the deployment actually stores. */
async function pair() {
  const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
  return {
    // Convex holds the PEM on one line, newlines replaced by spaces — the
    // exact shape gen-auth-keys.mjs writes, so the PEM rebuild is exercised
    // rather than side-stepped.
    JWT_PRIVATE_KEY: (await exportPKCS8(privateKey)).trimEnd().replace(/\n/g, " "),
    JWKS: JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(publicKey)) }] }),
  };
}

const authConfig = async () => {
  const t = convexTest(schema, modules);
  return t.query(internal.health.authConfig, {});
};

afterEach(() => {
  vi.unstubAllEnvs();
});

describe("a matching pair", () => {
  test("verifies, and says so", async () => {
    const keys = await pair();
    vi.stubEnv("JWT_PRIVATE_KEY", keys.JWT_PRIVATE_KEY);
    vi.stubEnv("JWKS", keys.JWKS);

    const result = await authConfig();
    expect(result.PAIR).toMatch(/^ok/);
  });

  test("works with a REAL PEM too, not only the space-joined form", async () => {
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });
    vi.stubEnv("JWT_PRIVATE_KEY", await exportPKCS8(privateKey));
    vi.stubEnv("JWKS", JSON.stringify({ keys: [{ use: "sig", ...(await exportJWK(publicKey)) }] }));

    expect((await authConfig()).PAIR).toMatch(/^ok/);
  });

  test("finds the key even when the JWKS carries more than one", async () => {
    /*
     * A set may legitimately hold several during a rotation. Checking only
     * keys[0] would report a mismatch for a deployment that works perfectly.
     */
    const stranger = await generateKeyPair("RS256", { extractable: true });
    const { privateKey, publicKey } = await generateKeyPair("RS256", { extractable: true });

    vi.stubEnv("JWT_PRIVATE_KEY", await exportPKCS8(privateKey));
    vi.stubEnv(
      "JWKS",
      JSON.stringify({
        keys: [
          { use: "sig", ...(await exportJWK(stranger.publicKey)) },
          { use: "sig", ...(await exportJWK(publicKey)) },
        ],
      }),
    );

    const result = await authConfig();
    expect(result.PAIR).toMatch(/^ok/);
    expect(result.PAIR).toContain("key 2 of 2");
  });
});

describe("A HALF-ROTATION IS CAUGHT", () => {
  test("mismatched halves report MISMATCH", async () => {
    const a = await pair();
    const b = await pair();
    vi.stubEnv("JWT_PRIVATE_KEY", a.JWT_PRIVATE_KEY);
    vi.stubEnv("JWKS", b.JWKS); // the other keypair's public half

    expect((await authConfig()).PAIR).toMatch(/^MISMATCH/);
  });

  test("AND THE OTHER LINES STILL SAY ok — which is the whole point", async () => {
    /*
     * This is the assertion that justifies the feature. Both values are
     * individually valid, so every check that looks at one value passes, and
     * a deployment in this state signs tokens nothing can verify.
     */
    const a = await pair();
    const b = await pair();
    vi.stubEnv("JWT_PRIVATE_KEY", a.JWT_PRIVATE_KEY);
    vi.stubEnv("JWKS", b.JWKS);

    const result = await authConfig();
    expect(result.JWKS).toBe("ok — 1 key(s)");
    expect(result.JWT_PRIVATE_KEY).toBe("ok");
    expect(result.PAIR).toMatch(/^MISMATCH/);
  });

  test("the message names the fix", async () => {
    const a = await pair();
    const b = await pair();
    vi.stubEnv("JWT_PRIVATE_KEY", a.JWT_PRIVATE_KEY);
    vi.stubEnv("JWKS", b.JWKS);

    expect((await authConfig()).PAIR).toContain("set-auth-keys.mjs");
  });
});

describe("it says UNCHECKABLE rather than guessing", () => {
  test("when JWKS is missing", async () => {
    const keys = await pair();
    vi.stubEnv("JWT_PRIVATE_KEY", keys.JWT_PRIVATE_KEY);
    vi.stubEnv("JWKS", "");
    expect((await authConfig()).PAIR).toMatch(/^UNCHECKABLE/);
  });

  test("when the private key is missing", async () => {
    const keys = await pair();
    vi.stubEnv("JWT_PRIVATE_KEY", "");
    vi.stubEnv("JWKS", keys.JWKS);
    expect((await authConfig()).PAIR).toMatch(/^UNCHECKABLE/);
  });

  test("when JWKS had its quotes eaten by a shell", async () => {
    // The original hazard. Unparseable is not the same as mismatched, and
    // saying MISMATCH would send somebody to rotate keys that are fine.
    const keys = await pair();
    vi.stubEnv("JWT_PRIVATE_KEY", keys.JWT_PRIVATE_KEY);
    vi.stubEnv("JWKS", "{keys:[{use:sig}]}");

    const result = await authConfig();
    expect(result.PAIR).toMatch(/^UNCHECKABLE/);
    expect(result.JWKS).toMatch(/INVALID JSON/);
  });

  test("when the private key is not a PEM at all", async () => {
    const keys = await pair();
    vi.stubEnv("JWT_PRIVATE_KEY", "not a key");
    vi.stubEnv("JWKS", keys.JWKS);
    expect((await authConfig()).PAIR).toMatch(/^UNCHECKABLE/);
  });
});

describe("nothing secret is reported", () => {
  test("no part of either value appears in the output", async () => {
    const keys = await pair();
    vi.stubEnv("JWT_PRIVATE_KEY", keys.JWT_PRIVATE_KEY);
    vi.stubEnv("JWKS", keys.JWKS);

    const printed = JSON.stringify(await authConfig());

    // The PEM body, in 32-character runs. None of it may surface.
    const body = keys.JWT_PRIVATE_KEY.replace(/-----[A-Z ]+-----/g, "").replace(/\s/g, "");
    for (let i = 0; i + 32 <= body.length; i += 32) {
      expect(printed).not.toContain(body.slice(i, i + 32));
    }
    // And the modulus from the public half, which is the identifying part.
    const n = JSON.parse(keys.JWKS).keys[0].n as string;
    expect(printed).not.toContain(n.slice(0, 32));
  });
});
