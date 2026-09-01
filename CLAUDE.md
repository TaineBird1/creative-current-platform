# The Creative Current — platform

## Context — do not ask, these are settled

```
Owner:      Taine, The Creative Current, Durban KZN, South Africa
Machine:    Windows, repo at C:\Users\taine\projects\creative-current-platform
Stack:      pnpm + Turborepo, TypeScript strict, Convex backend, Vercel
Apps:       apps/sites, apps/office (/admin + /c/<slug>), convex/
Domains:    thecreativecurrent.co.za · office at app.thecreativecurrent.co.za
Auth:       Convex Auth, invite-only, no public signup, no end-customer accounts
Email:      Resend        WhatsApp: provider undecided — code to an interface,
                                    ship a logging no-op driver
Currency:   ZAR, integer cents as v.number(), never sum currencies, no auto-FX
Timezone:   Africa/Johannesburg default, per-site tz stored regardless
Entity:     not yet registered — sole prop for now, reg-number field nullable
VAT:        not registered — tax flag off, no VAT line
Rails:      Paystack (ZAR) · Paddle (international) · Stripe/GoCardless stubs
Compliance: POPIA primary, GDPR shape, review-gating banned
Ventures:   1 Sites (platform) · 2 Systems (consulting). Property venture later.
```

## Rules that override anything else

- First niche template is **solar/trades** (`solar-trades`, variant `ink`),
  seeded from a real shipped site. Guest houses become template #2 when a
  direct-booking client lands. The section registry stays generic.
- Outreach is drafted, never bulk-sent. No email sender for outreach in this
  codebase. Transactional client messages DO auto-send — separate pipeline.
- Do not start M2 until one real client is live and paying on M1.
- **Tenancy is re-derived from the authenticated user on every scoped
  function.** Scoped functions take a SLUG, never an `Id<"clients">`, and
  resolve it by walking the caller's own membership rows — so no code path
  selects a document before authorising, and an unauthorised slug is
  indistinguishable from a nonexistent one. Cross-tenant access has failing
  tests in `convex/tenancy.test.ts`. Never soften one to make a feature pass.
- Client sites are data. One renderer. Never fork code per client.
- **A BOOKING is an appointment; a JOB is multi-day work. They are different
  tables with different rules, and the boundary is here so it is obvious
  rather than discovered.**

  A **booking** reserves calendar time. It is overlap-checked against other
  bookings and block-outs at its location, on windows expanded by the
  service's buffers, and it **may not exceed 24 hours**. That cap is a product
  rule first: an appointment longer than a day is not an appointment. It is
  also load-bearing for correctness — the overlap query looks back exactly 24
  hours, so the cap is what makes that range provably contain everything that
  could overlap. Raise one and you must raise the other.

  A **job** is quoted → accepted → scheduled → in progress → complete, carries
  a crew, materials and photos, and spans days. Multi-day work is a job, never
  a long booking.

  **A job does NOT reserve calendar time.** It has `scheduledFor` and no end,
  no duration and no location-time index, so nothing overlap-checks it. That
  is the current schema, not an oversight to code around: crew time that must
  be reserved is booked as bookings against the job. If a job ever needs to
  hold the calendar itself, it needs an end time and an index first — decide
  that in the schema, not in a handler.
- **`apps/sites` does not query Convex per pageview.** `SiteConfig` is served
  from ISR, with tag-based revalidation when a config is written — never a live
  query on the request path. Measured against a production build on 31 Aug 2026:
  5 pageviews with no invalidation cost **0** Convex calls; 5 after a tag
  invalidation cost exactly **1**. Re-measure rather than assume if this path
  changes — an earlier version deduped on an options object and silently never
  hit, which looks identical from the outside. This was always required by the LCP budget; it is
  now also the cost control, because EU deployments bill on demand with no
  included usage, so a per-request query would make Convex spend scale with
  traffic. Convex calls must scale with **bookings and admin usage, not
  pageviews**. Live queries belong to the interactive paths — availability,
  booking, quote submit, the office app — which are also the only places the
  region's latency is felt.
- **WHERE THE TWO ERRORS COST DIFFERENTLY, DEFAULT TO THE RECOVERABLE ONE.**
  The rule the next two are instances of, stated once so it does not have to
  be re-derived per domain. Sending twice is recoverable and suppressing is
  not, so messaging sends. Suppressing on ambiguous consent is recoverable and
  messaging someone who opted out is not, so consent suppresses. The two look
  contradictory and are the same rule applied to different costs. Settle
  arguments in money and impersonation the same way: an over-collected payment
  is refundable, an under-collected one is a conversation with a customer; an
  action wrongly attributed to staff is correctable, one wrongly attributed to
  an owner is not. Work out which error you can undo BEFORE picking a default.
- **`_creationTime` IS WRITE ORDER. IT IS NEVER EVIDENCE OF WHAT A PERSON
  DID.** It records when a row reached the database and nothing else. For a
  CSV import it is the order of lines in a file; for a backfill it is the
  order of a loop; for a retried mutation it is the second attempt. It may
  therefore NEVER break a tie about a real-world event — which consent it was
  that the customer meant, which branch a crew was dispatched from. When two
  rows tie on a real timestamp, resolve on MEANING (`lib/consent.ts` picks
  withdrawn) or REFUSE to answer (`public/quote.ts` creates no job when the
  branch is ambiguous). Inventing an answer is worse than having none.
  The one legitimate use is PRESENTATION: `lib/ordering.ts` appends `_id` to
  every list sort so a tied list cannot reshuffle between two reads, which is
  safe precisely because `_id` means nothing and claims nothing. Quote lists
  sort by `_creationTime` for the same reason — a quote comes into existence
  when it is written, so there the write IS the event.
- **PREFER SENDING TWICE OVER SUPPRESSING.** A duplicate message is visible
  and mildly annoying. A suppression is invisible: nobody is told, and the
  customer arrives at the old time. Every judgement call in the messaging
  pipeline resolves that way — which is why a booking's idempotency key
  carries BOTH `startsAt` and `messageRevision`, two chances to differ rather
  than one. `guards.test.ts` fails if anything but `book` writes `startsAt`,
  because a second writer that forgets to bump the revision produces exactly
  the silent failure this rule exists to prevent.
- **AMBIGUOUS CONSENT IS NOT CONSENT**, and this is the one place the rule
  above is inverted. Two consent rows sharing a timestamp are resolved by
  `lib/consent.ts`, and a tie resolves to **withdrawn**. There is deliberately
  no `_creationTime` tie-break: it would resolve by write order, which for a
  CSV import is the order of lines in a file, not evidence of what the
  customer did. The conservative error is recoverable — record a grant with a
  later timestamp. Messaging someone who asked you to stop is not.
- **Quiet hours use the SITE's timezone, not the recipient's.** Bookings
  collect a name and a phone number and nothing else, deliberately, so no
  recipient timezone exists anywhere to populate. The field is named
  `quietHoursTimezone` for what it actually holds. This is an approximation:
  it is right for a customer in the same city and WRONG for one abroad, whose
  message is held until the business's morning. Fixing it needs a real source
  for a recipient's timezone — not a field nothing can fill.
- **INVOICE NUMBERING PREFERS A GAP.** A gap is recoverable: you explain it
  to an accountant once and the explanation is boring. A DUPLICATE is not —
  two documents bearing INV-0042, sent to two customers, and no way to say
  afterwards which one a payment settled. The meta-rule settles it without
  further argument. Preferring a gap FORCES the implementation: allocate the
  number and insert the invoice in ONE mutation. Convex mutations are
  serializable, so a counter read-and-patch in the same transaction as the
  insert cannot hand the same number to two concurrent issuers — one retries
  and takes the next. Split across two mutations, a failure between them
  burns a number with no invoice behind it, and then someone "tidies up" by
  reusing it. `guards.test.ts` fails in BOTH directions: allocating without
  inserting, and inserting without allocating. Nothing writes either table
  today; the guard is aimed at whoever builds invoicing.
- **WEBHOOKS: VERIFY BEFORE PARSING, KEY ON THE PROVIDER'S EVENT ID, NEVER
  ASSUME ORDER.** All three are enforced, not just documented.
  *Verify first.* `http.ts` reads `request.text()`, verifies the HMAC over
  those exact bytes, and only then parses. `request.json()` is banned there
  by a guard test: it runs a parser over bytes a stranger sent to a
  discoverable URL, and it re-serialises, so the signature would be checked
  against different bytes and fail in a way that looks like a wrong secret.
  *A missing secret is a REFUSAL (500), never a skip.* `if (!secret) return
  true` would turn an unconfigured deployment into one accepting forged
  payments silently, with a 200. A guard test bans that shape. 500 not 401 so
  the provider keeps retrying until the config is fixed.
  *Idempotency is the provider's event id* — a key derived from the payload
  cannot tell a retry from a genuine second charge of the same amount.
  *Order is never assumed.* FACTS are appended (a payment is true whenever we
  hear about it; a sum has no order). STATE is advanced only by an event
  NEWER than the one that last set it, compared on the PROVIDER's timestamp,
  which is why `subscriptions.lastEventAt` exists. `charge.success` arriving
  after `subscription.disable` records the money AND leaves the cancellation
  standing — treating them as one ordered stream either loses the payment or
  resurrects the subscription.
  *What cannot be attributed is parked, not guessed* (`unattributed`), and a
  ledger refusal is parked too (`refused`) rather than thrown — a throw
  aborts the mutation that records the event, so the anomaly would exist only
  in the provider's failed-delivery dashboard. The ledger post happens BEFORE
  the `payments` row, so a refusal cannot leave an orphan payment.
- **THE PLACES SPEND CAP IS A LEDGER, NOT A CONSTANT.** A sourcing run is a
  loop over a paid API, so a bug in the loop is an invoice rather than a
  crash - and it is spent before anyone notices. `lib/placesBudget.ts` is the
  only writer of `apiSpend`: the run records what it is about to spend, reads
  the period's total, and is refused above the cap. The cap lives in the
  `spendCaps` table because a constant is invisible to whoever pays the bill.
  A guard test bans `MAX_CALLS`-shaped constants elsewhere.
  **Charged BEFORE the call and never refunded.** Over-counting refuses a
  call we could have afforded (recoverable - raise the cap). Under-counting
  spends past it (not recoverable). A refund path is how a retry loop turns a
  cap into a suggestion. **No cap configured refuses everything** - there is
  no unlimited mode, same reasoning as a missing webhook secret.
- **WHAT GOOGLE LETS US KEEP, CHECKED NOT REMEMBERED.** Per the Places
  policies and Maps Platform Service Specific Terms: `place_id` is EXEMPT and
  may be stored indefinitely; everything else the API returns is Google Maps
  Content under a temporary caching allowance of **30 consecutive calendar
  days**; anything displayed carries attribution (the "Google Maps" name, not
  a bare "Powered by Google", plus the third-party attributions returned and
  a link to the source). So `placesCache.expiresAt` is a column and
  `readPlace` returns **null** past it - not stale data with a warning,
  because a caller holding the data will use it. Enforcement is on READ, not
  a cleanup job: a job-based expiry lapses the night the job fails.
  `leads.rating` and `leads.reviewCount` were removed - they were a permanent
  copy of 30-day content - and a guard test keeps them out of every table but
  `placesCache`. A name/phone/website is a fact about a business that exists
  without Google; a rating exists only because Google computed it. That line
  is why `leads.provenance` exists.
- **SUPPRESSION FILTERS THE QUEUE, NOT THE DIAL.** Blocking at the moment of
  dialling is one step too late: the name and number are already on a screen,
  and a person who can see a number will phone it from their own handset,
  where nothing records it and nothing stops it. `lib/leadAccess.ts` is the
  ONLY module that may read the `leads` table, and `listContactable` always
  filters. A guard test fails on `query("leads")` anywhere else; the
  candidate-assembler allowlist has a second guard asserting those files do
  call the filter.
  **A failed suppression read empties the queue rather than unfiltering it.**
  An empty queue is visibly wrong and someone investigates; a full queue that
  skipped the check looks exactly like a normal working day. `listUnavailable`
  is returned so the UI can tell those apart. Every catch in
  `lib/suppression.ts` is guarded, not just the last one - that test used to
  read only the final block and went green while a batch filter above it was
  the one that mattered.
  The DETAIL view deliberately still shows a suppressed lead, with its reason:
  somebody chasing "why has nobody contacted them" needs to find the answer,
  and a vanished row sends them to re-source the same business and start over.
  `queue.disposition` writes the suppression on `not_interested` /
  `wrong_number` immediately - on placeId AND phone, closing both routes back -
  because the gap between "they said no" and "they stop appearing" is the
  window in which somebody phones them again.
- **`leads.placeId` IS OPTIONAL.** It was required, which quietly assumed
  Google Places was the only source. The first real import - 59 KZN solar
  installers off trade directories - has none, and the tempting fix was to
  mint synthetic IDs. That would put a fabricated key in the column
  suppression matches on, where it could later collide with a real Place ID
  and silently suppress the wrong business. `provenance` is the field that
  always answers where a row came from; `placeId` only says whether Google
  was involved. `queue.disposition` therefore suppresses on whatever
  identifiers exist, and falls back to a name fragment when there are none -
  a refusal recorded against nothing is not a refusal.
- **ONE PHONE NORMALISER: `toE164` IN `lib/phone.ts`.** The phone is the
  suppression key, so two opinions about its canonical form are two opinions
  about who may be called. There were THREE - the importer produced
  `+27833176385`, the suppression matcher `833176385`, and `customers.ts`
  `0833176385`. They agreed only because every comparison re-normalised both
  sides, so the divergence was latent rather than harmless: one import path
  storing a raw string and a suppressed number is back on the queue with
  every test green. A guard test now fails on any other module that strips
  digits out of a phone.
  **E.164 is the stored KEY; `leads.phoneDisplay` keeps the original string**
  - it is what a person recognises and it holds the second number that
  normalising to one key necessarily discards ("0833176385 / 0622155142").
  `toE164` REFUSES rather than guessing: a normaliser that always returns
  something turns a typo into a key matching nothing, and matching nothing
  reads as permission. `toStorageKey` falls back to digits for a non-SA
  number so a booking is not refused - with the stated cost that such a
  customer cannot be checked against the DNC list and will therefore be
  suppressed. **The CUSTOMER is told at the moment they give the number** -
  `public/quote.submit` returns `reachable` and a notice saying "we will
  phone you rather than message you, or give us an SA number", and
  `customers.upsertByPhone` returns `reachable` so staff hear it while they
  can still ask. The outbox row explaining a suppression is visible to the
  BUSINESS; the customer sees nothing unless we say it. Same shape as the
  demo form, same answer: the backend knows, so the backend says so. The
  enquiry is still RECORDED - refusing the number would turn a messaging
  limitation into a lost booking.
- **THE CALL QUEUE CONTAINS ONLY CALLABLE ROWS.** A lead with no dialable
  number is excluded, not greyed out: a dial button that does nothing teaches
  you it is sometimes a lie, and three of those in a morning is enough to
  stop trusting the screen. They are counted (`needsNumberCount`) and listed
  by `queue.needsNumber`, which is research and does not belong between two
  calls - and that list is suppression-filtered too, because someone who
  asked not to be contacted should not appear on a list of numbers to go and
  find.
- **PROVENANCE AT CAPTURE, NEVER BACKFILLED.** Every lead row carries
  `provenance: { source, capturedAt, lawfulBasis, detail? }`, REQUIRED in the
  schema. "Where did you get my number" has to be answerable from the row, not
  from somebody's memory of which spreadsheet a batch came from. Required
  rather than optional because optional means the rows that most need it - a
  hurried import, a pasted list - are the ones that will not have it. A guard
  test fails on any `db.patch`/`replace` touching provenance: a provenance
  written later is a guess about the past dressed as a record of it, and the
  only reason to write one is that the true answer was not kept. `lawfulBasis`
  is the operator's claim, stored and auditable; the code does not and cannot
  validate it, and recording one is not a finding that any given channel is
  permitted (POPIA s69 treats electronic direct marketing more strictly than a
  call to a listed business number).
- **SUPPRESSION FAILS CLOSED.** The consent problem again, resolved the same
  way: a missed check means phoning someone who asked us not to, which is not
  recoverable; being wrongly suppressed is. `lib/suppression.ts`'s
  `contactDecision` is the one choke point for every call and message path,
  and **every uncertain answer is blocked** - a lookup error, an unparseable
  phone, no identifier at all, or a partial name-fragment match. It returns a
  verdict and never throws, because a thrown error is a decision some caller
  will eventually catch and proceed past. A guard test bans reading
  `suppressions` directly and asserts the catch resolves to blocked.
  It is wired into `dispatch` too: a business that refused us during
  prospecting has not changed their mind because someone later typed their
  number into a booking.
- **A DEMO CARRIES A REAL BUSINESS'S NAME. ENFORCE AT THE RENDERER.** Not per
  template - one template missing a meta tag is a live, indexable
  impersonation of a business trading in its own name, which is a legal
  problem rather than a bug. `SiteRenderer` is the single point: it renders
  `DemoDisclosure` for every demo and **throws** rather than drawing a demo
  without its context or past its expiry. A guard test fails if any section
  or template component so much as reads `isDemo`.
  The gate is also in the BACKEND (`public/site.ts`), so no renderer can
  bypass it - an expired demo never gets its config. Two fail-OPEN holes were
  closed there: the check keyed on `status === "demo"` (so a demo moved to
  "live" escaped the expiry entirely) and read `&& site.demoExpiresAt` (so a
  demo created without one served forever). It now keys on `isDemo`, and **a
  missing expiry is a refusal**. Expired serves a notice, never the site.
  Stock and AI imagery is already refused as work by `workImage` in the
  config schema; the disclosure says so in words as well.
  **`noindex` covers search engines and NOTHING ELSE.** Three things sit
  outside it, all handled in `apps/sites/lib/demo-safety.ts`:
  *The link preview.* Sending the demo over WhatsApp is the intended flow, so
  the scraped card is the FIRST thing a prospect sees - before the page and
  before the disclosure bar. Scrapers do not honour noindex. Title AND
  description carry the proposal framing (correcting only the title leaves
  the business's own marketing copy underneath and the card still reads as
  theirs), `og:site_name` becomes the agency rather than their brand, and the
  Twitter card is set explicitly rather than left to fall back to OpenGraph.
  The framing leads with "Proposal" so it survives WhatsApp's ~60-character
  truncation.
  *Structured data.* `LocalBusiness` JSON-LD is a machine-readable assertion
  that a business of this name trades at this address. On a demo it is
  ABSENT, not softened - a correct-looking record with a caveat in a field
  nothing parses is still an assertion. `localBusinessJsonLd` returns null
  for a demo, and a guard bans a second emitter and bans `aggregateRating`
  anywhere (a rating is Google's 30-day licensed content; restating it as our
  own structured claim puts it on a page that outlives the licence).
  *The form response.* A demo submission is logged as engagement and reaches
  nobody, so silence reads as success and a real customer who found the demo
  waits in for a tradesman nobody sent. `public/quote.submit` returns
  `recorded` and a `notice`, and the form DISPLAYS the server's verdict
  rather than deciding - the backend is the only party that knows whether
  anything was dispatched, and a template working it out is a template that
  can be wrong. The notice OUTRANKS the configured success message. Sections
  receive a pre-decided message, never a flag: the guard banning `isDemo` in
  section components still holds.
- **THE LEDGER STOPS AT THE DOCUMENT.** The ledger records money that
  actually moved and needs no registered entity to be true — payments,
  refunds, adjustments, reversals, per-client and per-venture totals, all
  live. An INVOICE is the other thing: a legal name, a registration number, a
  sequential number, the document a customer receives and SARS reads. There
  is no registered entity behind this platform yet, so `invoices` has no
  writer and `guards.test.ts` holds it that way. Whoever registers the entity
  finds that test failing and has to name the issuer before the first invoice
  exists, which is the order those two things have to happen in anyway.
  Consequence: **there are no receivables.** No `outstanding`, no `aging`, no
  "what does this client owe me" — and their absence is deliberate. Nothing
  is owed until something has been issued, so a receivables screen showing R0
  would be a claim about the world rather than a gap in the data. Same
  judgement as the P&L's "not tracked". A guard test fails on
  `outstandingCents`, `receivableCents` and `agingBuckets`.
- **Every `ledgerEntries` write goes through `postEntry` in `lib/ledger.ts`.**
  Same shape as `dispatch` for messages, and for the same reason: whole
  cents, a sign that agrees with the type, a client that belongs to its
  venture, and demo/seed data that never accrues are only rules if there is
  one place to break them. Every one of those failures is SILENT — a
  wrong-signed refund does not error, it reports the refund as revenue, and
  the month reads better than one in which nothing happened. Revenue
  classification (`isRevenue`) lives in the same file: it was duplicated in
  income.ts and finance.ts, and a type recorded by one but missed by the
  other is money that exists in the ledger and never reaches a P&L.
  The P&L is CASH basis. `invoice_issued` is not revenue; counting it and the
  payment against it would report every job twice.
- **Messaging is NOT STOP-compliant, and must not be described as such.** The
  consent table is checked on every send and a withdrawal suppresses. But
  nothing can SET `withdrawn` from an inbound STOP: there is no provider
  webhook and no inbound pipeline at all, so the only withdrawal path today is
  a staff member recording one by hand. The outbound half is real; the half
  that makes STOP automatic does not exist.
- Every screen goes through the `impeccable` skill. Tokens only.
- Never mark anything done without a deployed preview URL and a human tapping
  it on a real phone.

## Invariants held by tests, not by convention

`pnpm test` — 434 tests. The structural ones live in `convex/guards.test.ts`
and fail CI rather than relying on anyone remembering:

- no bare `query`/`mutation` outside a 5-file public allowlist
- no TENANT-scoped function accepts a `clientId` argument (platform functions
  may: operating across every tenant is the owner console's job)
- `ledgerEntries`, `auditLog` and `consents` are append-only
- `siteConfigs.ts` is the ONLY writer of the `sites` table — `config` is
  `v.any()`, so its Zod parse is the only thing holding the shape
- an EXTERNAL client never has a slug. `app.<domain>/c/<slug>` resolves on
  slug alone and nothing downstream re-checks `kind`, so a slug on a
  consulting client would mint a back office nobody sold, for a client with
  nowhere to sign in, reachable by anyone who guessed the URL
- `lib/reseller.ts` is the ONLY writer of `clients.resellerId` and enforces
  reseller depth exactly 1, which is what makes the one-hop membership walk in
  `requireTenant` correct
- an unbuilt P&L line is rendered ABSENT, never as a zero. `finance.pnl`
  returns `notTracked` beside the totals so the screen cannot say "you earned
  nothing from subscriptions" when the truth is "nothing tracks subscriptions
  yet" — a business fact and a build state, which a zero cannot tell apart
- income and expenses both require that the client belong to the VENTURE. Otherwise a cost
  sits in one venture's P&L while pointing at another's client: the arithmetic
  still adds up, nothing errors, and every per-venture figure is quietly wrong
- a quote's total is COMPUTED, never accepted from the caller, and each line
  is rounded to whole cents before summing so the total equals the sum of the
  lines the customer actually sees
- **VAT is not implemented and `taxable` has no home.** Line items carry the
  flag and quotes carry `subtotalCents`/`totalCents`, but NOTHING stores a tax
  posture — no registration flag, no rate. Today `total === subtotal`, which is
  correct while unregistered. On registration the flag needs a schema field
  first; deriving a rate from a constant would put a tax figure on a customer
  document that no record justifies
- money is integer cents as `v.number()`, never bigint, always stored beside
  its currency; integer-ness comes from `assertCents()` in `convex/lib/money.ts`

`pnpm lint:tokens` fails on raw hex, literal colour functions, inline fonts and
magic radii outside `packages/tokens`. Brand colours entering as data are
allowlisted by path, with the reason stated in the script.

## Design

See `DESIGN.md`. Two visual worlds, never blended: admin is monochrome ink,
client is warm white-label tinted per client by an AA-safe accent ramp derived
from their brand colour. The ramp is corrected against the real page ground,
not pure white — that distinction was a live bug.

## Deployment environment variables

Seven on production, six on dev. `npx convex env list` to check.

**`SITES_REVALIDATE_URL` is production-only, and this is not an oversight.**
Convex actions run in Convex's cloud, so `localhost:3100` there resolves to
*their* machine, not yours — the runtime rejects it outright with
`Request to http://localhost:3100/... forbidden`, before any HTTP status
exists. Setting it in dev buys nothing and turns every publish into a red
ERROR line; unset, the action logs one WARN and returns. To exercise the push
path locally you need a public tunnel to :3100, not a localhost URL.

| Variable | Source |
|---|---|
| `JWT_PRIVATE_KEY`, `JWKS` | Generated as a matching PAIR with `jose`. Rotating one without the other invalidates every session. |
| `SITE_URL` | The OFFICE origin (`http://localhost:3200` in dev). Unused by the OTP flow; it is the redirect target for any OAuth or magic-link provider added later. |
| `AUTH_RESEND_KEY` | Resend, Sending access only. Not the outreach key — a separate one means "last used" tells you whether sign-in works. |
| `AUTH_EMAIL_FROM` | Must be on a Resend-verified domain. |
| `SITES_REVALIDATE_URL` | `https://<sites-origin>/api/revalidate`. Where a config write pushes cache invalidation. Unset is survivable — writes still succeed and sites self-heal within the hour — but every publish looks broken for that hour. |
| `REVALIDATE_SECRET` | A shared secret, set on BOTH the Convex deployment and the sites Vercel project. The route fails closed if it is unset there, so an unset secret means no revalidation at all rather than an open endpoint. |

**A Vercel env var is invisible to the build unless `turbo.json` names it.**
Vercel runs `turbo run build`, and Turborepo filters the environment to what
the task declares — so a variable set correctly in the Vercel dashboard simply
does not exist inside the build. `apps/office` fails loudly (its config throws
without `CONVEX_URL`), but **`apps/sites` builds green and serves the holding
page to every visitor**, which is the dangerous half: a successful deploy that
cannot reach a backend. Both were observed on the first deploy, 31 Aug 2026.
Turbo does warn — "set on your Vercel project, but missing from turbo.json" —
at the END of the build log, under a green checkmark. Any new build-time
variable goes in `tasks.build.env`.

Vercel needs only `CONVEX_URL` per project. `apps/office/next.config.mjs`
derives `NEXT_PUBLIC_CONVEX_URL` from it, so there is one value to keep right
— and that config THROWS on a production build if it is missing, because
Convex Auth would otherwise fail at runtime after a green deploy.

**Never set these from PowerShell.** It strips the double quotes out of JSON
before the CLI sees them, so `JWKS` lands as `{keys:[...]}` instead of
`{"keys":[...]}`. Convex then cannot build a key set and EVERY token
verification fails with `AuthProviderDiscoveryFailed` — which surfaces as
"middleware thinks nobody is signed in", "the back office says not found",
and a client retry storm in the logs. It cost an hour of misdiagnosis.

Use the Convex dashboard's env settings (masked field, no shell), or Git Bash:

```bash
npx convex env set "JWKS=$(cat jwks.json)"
```

Generate a fresh pair headlessly — never the interactive `npx @convex-dev/auth`
wizard, which hangs without a TTY:

```bash
node scripts/gen-auth-keys.mjs
```

Verify it took. Every line must read `ok`; `JWKS` reporting `INVALID JSON` is
the quote-stripping above, and is the single likeliest cause of a sign-in that
fails for no visible reason:

```bash
npx convex run health:authConfig
```

## Domains and origins — do not let this drift

| Host | Vercel project | Serves |
|---|---|---|
| `app.thecreativecurrent.co.za` | `cc-office` | `/admin` and every `/c/<slug>` back office |
| the client's own domain | `cc-sites` | that one client's public website |
| `sites.thecreativecurrent.co.za` | `cc-sites` | demos and previews, by path |

**`cc-office` gets ONE origin and no other domain. Ever.**

Not tidiness — the back office is an installable PWA with web push, and
service worker scope, push subscriptions, and cookies are all bound to an
origin. A second host means a second PWA install, a second push subscription,
and a session that appears to vanish when a client reaches the "wrong" one.
Adding a domain to `cc-office` is therefore a breaking change for every client
who has already installed it, and it cannot be undone by removing the domain
again.

**Demos are PATH-based, not subdomains.** `sites.thecreativecurrent.co.za/<slug>`,
which the existing `[[...slug]]` resolution already serves. The alternative,
`<slug>.demo.thecreativecurrent.co.za`, needs a WILDCARD domain — and Vercel
requires the nameserver method for wildcards, meaning the whole zone moves to
Vercel DNS with every existing record recreated by hand. A subdomain does not
make a demo more convincing (it still is not the lead's own domain), so it buys
nothing for that cost.

The cost is smaller than this once claimed — the zone is on Cloudflare, not
10Web, so a move would be from there — but the conclusion is unchanged, because
it was never the DNS work that made subdomain demos not worth it.

Both hosts went live 31 Aug 2026 and serve the right app.

**DNS for `thecreativecurrent.co.za` is on CLOUDFLARE**, not 10Web — earlier
notes here said 10Web and were wrong. Nameservers are `dave.ns.cloudflare.com`
and `piper.ns.cloudflare.com`. Records are `A <sub> 76.76.21.21`, and they must
be **"DNS only" (grey cloud)**. A proxied record stops Vercel completing its
ACME challenge, so no certificate is issued and you get a redirect loop or an
SSL error that looks like a Vercel fault and is not.

**Vercel did not auto-issue the certificates.** Both subdomains sat at
"configured OK" for six minutes serving fine over HTTP while HTTPS failed the
handshake outright — no cert existed. `vercel certs issue <domain>` fixed each
in 15 seconds. If a client domain ever serves on HTTP but not HTTPS, that is
the fix; it presents as a DNS problem and is not one.

Real client domains are added to `cc-sites` individually through the domain
wizard, the same way. No nameserver change is required for any of it.

## Region — EU West (Ireland), deliberately

Convex offers US East (N. Virginia) and EU West (Ireland). No African region;
Canada and Australia are next. Ireland is therefore the closest available to
Durban and is the team default.

**The reason is interactive round trips, not pageviews.** Durban to eu-west-1
is roughly 150ms, to us-east-1 roughly 230ms. That 80ms is paid on every
availability check, slot booking, quote submit and every action in the office
app — the things a person waits on while looking at a spinner. Public pageviews
do **not** pay it, because the site does not query Convex per request (see
"apps/sites does not query Convex per pageview" below).

POPIA is deliberately **not** a reason here, and earlier notes that said so were
wrong. Section 72 permits cross-border transfer under its conditions and has
never required EU or SA residency; US East would not have breached it. Do not
record a legal constraint that does not exist — it makes the real argument
harder to weigh and invites a decision nobody can defend.

**EU costs more, and the difference is not the headline number.** On paid plans
resource-based pricing is 30% higher. More importantly, the included usage on
Starter and Pro — the 25M function calls a month — **does not apply to EU
deployments at all**; EU is billed on demand from the first call. Free-plan
usage is unaffected, so this costs nothing today and starts biting the month we
go paid. It is affordable only because Convex calls scale with bookings and
admin usage rather than traffic. Source: Convex's EU launch post, "Just landed
in Europe".

Project `creative-current`, both deployments on `eu-west-1`:

| | Deployment | Verified |
|---|---|---|
| dev | `wary-pika-965` | `.eu-west-1.` in the Cloud URL |
| prod | `shocking-mosquito-587` | same |

**Verify the region from the URL, not from memory.** An EU deployment's URL
carries an `.eu-west-1.` segment; a US East one has no region segment at all
(`valiant-rooster-710.convex.cloud`). That single character difference is the
only cheap way to tell them apart, and it is how the mistake below was finally
caught.

**The VERCEL functions must sit beside Convex too, and did not.** Both projects
defaulted to `iad1` (Washington) while Convex is in Ireland — the same mistake
as the Convex one below, a layer up, and invisible unless you read
`x-vercel-id`. Every server-side call was crossing Washington to Dublin. Pinned
to `dub1` in `apps/*/vercel.json`; check `x-vercel-id` (format
`edge::function::id`) after any project or plan change, because the region
resets to the platform default rather than erroring.

`apps/sites` barely notices — it is ISR-cached and measured at 0 Convex calls
per pageview. `apps/office` is where it mattered: every availability check,
booking and admin action is a live round trip, which is the entire reason the
region was chosen.

**An existing deployment's region cannot be changed.** Moving one means
creating a new project or deployment in the target region and migrating by
export/import. **There is still no `--region` CLI flag**; the docs say "coming
soon", and a launch-post promise of one is not the same thing. Regions are
chosen in the dashboard at creation time, so check the region on any new
deployment before putting data in it, and keep the team default on EU West.

**This has already gone wrong once, and the failure was silent.** The first
project's production deployment (`valiant-rooster-710`) was created in US East
because `convex deploy` inherited the team default before that default was set.
It went unnoticed because dev was correctly in Ireland and nobody checks the
deployment they never look at — and it was recorded here as "confirmed EU West,
no migration outstanding" on an assumption rather than a reading of the
dashboard. It was caught on 31 Aug 2026 only because a deploy key was being
generated and the region field happened to be on screen.

The migration cost nothing because prod was still empty — zero documents, no
auth env vars, nobody had ever signed in. That is the only cheap moment, and it
ends the day a real installer signs. If a deployment's region is ever in doubt,
check it before writing to it, not after.

## Bootstrapping the first platform owner

`invites.inviteToPlatform` needs an existing owner, so the first one comes
from `bootstrap:claimPlatformOwner`, which refuses once an ACTIVE owner
exists. Sign in once first — it grants to an existing account, and will not
create one.

```bash
npx convex run bootstrap:claimPlatformOwner '{"email":"you@example.com"}'
```

## Branch protection — main takes no direct pushes

Ruleset "protect main" (`~DEFAULT_BRANCH`, active, **no bypass actors**) holds
four rules: `deletion`, `non_fast_forward`, `pull_request` (0 approvals) and
`required_status_checks` on **`Tests, lint, build`**. Every change reaches main
through a branch and a PR whose CI is green. The gate exists because CI sat red
for three commits and nothing stopped them — history was protected, contents
were not.

Three things about it that are not self-evident:

- **The required check name IS the job name** in `.github/workflows/ci.yml`.
  Rename the job and the required check stops reporting, so every PR blocks
  forever with nothing failing and nothing to click. Rename both or neither.
- **Never require `Deploy Convex`.** It is gated to pushes on main, so on a PR
  it reports as *skipped* — observed on PR #1 — and never as passed. Requiring
  it would stake every merge on how GitHub happens to treat a skipped required
  check, which is not a guarantee worth depending on.
- **Keep `user.email` on the address linked to the GitHub account.** The rule
  set carries `require_extra_approval_for_unattributed_changes`, so a commit
  whose author GitHub cannot resolve demands an approval that a solo owner
  cannot give — GitHub forbids approving your own PR. It is set repo-local;
  it was previously unset entirely.

No bypass actor is deliberate. One for the owner would recreate exactly the
hole this closes.

## Commands

```bash
pnpm test                        # 434 tests
pnpm lint:tokens                 # design system enforcement
pnpm --filter @cc/sites dev      # public sites on :3100
pnpm --filter @cc/office dev     # admin + back offices on :3200
npx convex dev                   # backend; leave running while developing
npx convex run seed:solarClient  # one live seed client, served at /renu-solar
```

Convex writes `.env.local` at the REPO ROOT, because `convex/` lives there.
Next only reads `.env.local` from the app directory, and passing the value
through `next.config`'s `env` does not reach the middleware runtime — so
`scripts/sync-env.mjs` copies it into each app, wired into `predev` and
`prebuild`. One source of truth, owned by the Convex CLI.

<!-- convex-ai-start -->

This project uses [Convex](https://convex.dev) as its backend.

When working on Convex code, **always read
`convex/_generated/ai/guidelines.md` first** for important guidelines on
how to correctly use Convex APIs and patterns. The file contains rules that
override what you may have learned about Convex from training data.

Convex agent skills for common tasks can be installed by running
`npx convex ai-files install`.

<!-- convex-ai-end -->
