/**
 * Deployment environment the tests can assume.
 *
 * `SITE_URL` is one of the variables every real deployment has — it is in the
 * table in CLAUDE.md and set on both dev and production — so a test suite
 * running without it is modelling a deployment that does not exist, and 57
 * tests failing on a missing link origin says nothing about the code.
 *
 * Set HERE rather than per-test on purpose: a value each test stubs for
 * itself is one the next test forgets, and the failure then looks like the
 * feature is broken rather than the fixture.
 *
 * The REFUSAL when it is absent is still tested, in invoices.test.ts, by
 * stubbing it empty for exactly that case. An ambient default that could not
 * be turned off would be an ambient default that hides its own rule.
 */
process.env.SITE_URL ??= "http://localhost:3200";
