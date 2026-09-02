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
  message is held until the business's morning. **A transactional
  acknowledgement is EXEMPT** — see the next rule. Fixing it needs a real source
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
- **SHORT LINKS ARE NOT BEING BUILT, AND THE REASON IS NOT EFFORT.** A demo
  link goes out over WhatsApp, which fetches the URL to build the preview
  card - as does every forward, and every device it lands on. A redirect
  count cannot tell a scraper from a person, so it would register a hit on
  every demo the moment the link was PASTED, before anyone looked. That is
  not a weak signal, it is a false one on every row, and it is the kind you
  act on. If it is ever built it needs scraper user-agents excluded and only
  a second, later view counted - and it still guesses. `demoEngagements`
  (form submitted) is a real signal precisely because a scraper cannot
  produce it.
- **`tasks.status` IS STORED, AND THAT IS NOT THE INVOICE MISTAKE REPEATED.**
  An invoice is paid because money arrived and the ledger can be counted, so
  storing settlement was a bug - a truer source existed. A task is done
  because a PERSON judged it done, and there is nothing else to compute it
  from. `status` and `completedAt` are written together by `complete` and
  `reopen` only, because two fields that must agree are two fields that will
  disagree. Overdue is still derived: it is a fact about today.
  CANCELLED is distinct from DONE. "I did it" and "it stopped being worth
  doing" are different answers, and collapsing them makes a completed-work
  list that flatters whoever is reading it - who is the person who wrote the
  tasks.
- **A DEMO INVENTS NOTHING ABOUT THE BUSINESS.** `siteLocation.addressLine`
  is OPTIONAL for exactly this reason: a directory listing gives a suburb,
  not a street, and requiring one would force the demo builder to invent an
  address for a real business and print it under their name - the harm the
  whole demo regime exists to prevent, arriving through a schema default. The
  phone shown is theirs, off the listing they already publish. `leads.area`
  carries the suburb as its own field because a demo needs it; it used to
  live only inside `provenance.detail`, which is the one field that may never
  be edited.
  Building a demo is OUTREACH and goes through `contactDecision` - doing it
  for a business that asked not to be contacted is the same act as calling
  them. Revoking expires the demo rather than deleting it, so the slug stays
  claimed and a link already sent cannot later resolve to a different
  business's demo.
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
- **AN EMPTY FIELD REFUSES; A PLAUSIBLE ONE PRINTS.** The issuer's legal
  name goes at the top of a document a client keeps, so a value invented by a
  seed script, a test fixture or an assistant filling in a form it could not
  leave blank is worse than a blank one - blank fails safely, plausible does
  not. Two defences, because one is not enough:
  `PLACEHOLDER` in issuer.ts refuses obvious fakes (test, ACME, John Doe) on
  WHOLE WORDS, so "Testa Holdings" and "Barlow Trading" still pass - a rule
  people work around protects nothing.
  `issuers.confirmedAt` covers the rest, which the word list cannot: a name
  that is plausible, passes every pattern, and is still not the person's
  actual legal name. `invoices.issue` refuses an unconfirmed issuer, and
  EVERY edit clears the confirmation - otherwise it is approved once and
  changed freely afterwards. Confirming means typing the legal name back, not
  ticking a box: a box can be ticked without reading, and the thing being
  guarded against is precisely a value nobody read.
- **WHEN THE INVOICE UI COMES, BUILD THE CLIENT-FACING HALF FIRST.** The PDF,
  email delivery, and the payment reference on the document. The owner's own
  admin table is the easy half and the one he can live without - he will
  issue from the CLI until the client half exists. Building the admin table
  first is the tempting order because it is easier and more visible to the
  person building it, which is exactly why it is the wrong one.
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
- **WON MEANS THEY SAID YES. CONVERTED MEANS THEY EXIST.**
  `deals.advance` records the win and returns `conversionOwed: true`; it
  refuses to mark the lead converted, because a lead in the funnel's last
  column with no client behind it makes every count downstream wrong in the
  direction that flatters us. `onboarding.convertWonDeal` is the one thing
  that pays that debt, and it does the whole of it in ONE serializable
  mutation: client, site, owner invite, checklist, build invoice, lead
  converted. **The value is entirely in the atomicity** — every partial state
  is its own quiet disaster (a back office pointing at nothing; access granted
  to somebody never told; a client live and paying nothing, which is the one
  nobody notices for a month; a converted-but-not-really lead that reappears
  in the pipeline so somebody phones a customer to sell them a website).
  Guard tests hold it: only `onboarding.ts` may mark a lead converted or write
  the checklist.
  **THE DEMO IS PROMOTED, NOT REPLACED.** The prospect has had that URL in a
  WhatsApp thread for a fortnight, and the slug is made from their own
  business name. A fresh site would take a second slug because the first is
  held by the demo, so the address they were sold on would quietly become
  somebody else's, and the demo client would linger as a duplicate of a
  business that is now a customer. `promoteSiteToLive` in `siteConfigs.ts`
  (the sites-table owner) flips `isDemo` and **clears `demoExpiresAt`** — that
  clearing is load-bearing and has its own guard, because `public/site`
  refuses to serve a site past its expiry, so a promoted site that kept one
  goes dark thirty days after the client starts paying.
  `isDemo` comes off the client HERE and only here. Anywhere else that would
  be turning off a guard; here it is the event the flag was waiting for.
  **The issuer is checked BEFORE anything is written**, with its own guard on
  the ordering: `issueInvoiceFor` refuses an unconfirmed issuer and runs last,
  so without the early check the whole transaction rolls back at the final
  step and reports an invoicing problem for what looked like an onboarding
  one. Refusing to onboard over an admin detail is the right way round — it
  forces the issuer to exist before the first client does, which is the order
  those two things have to happen in anyway.
  **NOT DONE: the invite is not emailed.** The plaintext token is returned
  once and stored nowhere, so it has to be carried out of the response and
  given to the client by hand. Wiring it to the outbox is the obvious next
  step and is deliberately not in this change.
- **A TRANSACTIONAL ACKNOWLEDGEMENT MAY INTERRUPT QUIET HOURS, FOR AN HOUR.**
  Quiet hours exist to stop a business intruding on somebody's evening. It is
  not intruding when the person booked ninety seconds ago and is waiting to
  hear that it worked — they started the conversation, and silence after an
  action reads to them as failure: they phone the business, or book somewhere
  else. Two halves, and both are load-bearing.
  **BY TYPE, from one list, default quiet.** `INTERRUPTS_QUIET_HOURS` in
  `lib/messaging.ts` holds `booking.confirmation` and `quote.sent`. A type
  added to `MessageKind` is subject to quiet hours unless somebody
  deliberately writes it there, which is the right way round: "did the
  recipient just do something" has to be asked out loud about each type, and a
  type nobody thought about should be the polite one. NOT on it, and none are
  close calls: reminders, review requests, quote follow-ups, win-backs — every
  one is US choosing the moment.
  **AND IT EXPIRES, one hour after the triggering event.** Without that the
  exemption is a loaded gun: a drain that was down comes back at 03:00, finds
  a hundred queued confirmations still exempt by type, and sends the lot —
  a hundred phones lighting up about yesterday, exactly the intrusion the
  window exists to prevent, arriving through the door built to allow one
  exception. So the exemption is anchored to WHEN THE THING HAPPENED.
  `triggeredAt` is passed only by a caller that WITNESSED the event —
  `bookings.createBooking` and nothing else — and its absence means no
  exemption. That default is what makes a bulk import of yesterday's bookings
  at 22:00 safe: it witnessed nobody doing anything, so it wakes nobody.
  `_creationTime` was the tempting anchor and is exactly wrong; for an import
  it is the order of a loop, and this is a decision about what a person did.
  Stored as `messages.quietHoursExemptUntil`, a DEADLINE not a flag, so the
  drain re-evaluates it hours later and reaches the same answer the write did.
  Checked at dispatch AND at claim, from one helper. Guard tests fail if a
  second module sets the deadline, and if the window stops expiring.
- **A PROSPECT IS NOT A CUSTOMER, AND `isDemo`/`isSeed` DO NOT COVER IT.**
  Those two are DESIGNATIONS applied to data we invented. A lead carries
  neither, and a lead is REAL — dev holds 39 actual KZN solar installers with
  actual numbers off trade directories — which is exactly what makes messaging
  one the expensive version of the mistake rather than the harmless one.
  So `dispatch` checks every recipient against the lead list before queueing,
  through `recipientIsLead` in `lib/leadAccess.ts` (still the only module that
  may read `leads`). Both of the recipient's identifiers are checked whichever
  channel is in play: the phone against lead phones on the `by_phone` index, and
  the email's domain against lead websites — a customer record carrying a
  lead's number IS that lead, and emailing them instead does not make them
  somebody else. A match writes a `suppressed_lead` row NAMING the business,
  because whoever reads the outbox is the only person who can tell a mistake
  from a coincidence of numbers. **The booking is still taken** — refusing it
  would turn a messaging limitation into lost work, same call as an
  unreachable phone on a quote.
  Checked at QUEUE time, not at the driver: a queued row is already a decision.
  It fails closed, with one stated exception — a phone that will not normalise
  is SKIPPED rather than blocked, because lead phones are stored as E.164 so an
  unreadable number cannot match one, and `contactDecision` refuses it a few
  lines later in better words (a foreign customer is a messaging limitation,
  not an accusation). That makes the two checks lean on each other, so
  `guards.test.ts` asserts BOTH are called.
- **THE SEND ALLOWLIST DEFAULTS TO NOBODY, AND THAT IS NOT AN INVERSION OF THE
  RULE ABOVE.** `MESSAGING_ALLOWLIST` is a comma- or space-separated list of
  addresses, `@domains`, or the single token `*`. Unset means nothing sends.
  It looks like it contradicts "prefer sending twice over suppressing" and it
  does not, which is written here because that apparent inconsistency is
  exactly the kind somebody eventually tidies away. **That rule is about which
  message a RUNNING system sends** — given a pipeline that is switched on and a
  judgement call about one message, send it. An unconfigured deployment is not
  making that judgement. It is not suppressing a message; it has not been
  switched on. Different question, and answering the second with the first is
  how a live provider ends up pointed at a database of real people because
  nobody had got round to saying who it may reach.
  That leaves only the ordinary question of which error is recoverable. A
  deployment that sends nothing is a config change away from correct, with
  every held message still in the outbox waiting. One that sends everything
  has already sent it.
  The cost is real — a production nobody configured sends nothing — and three
  things pay for it: every held row is in the outbox with the reason, the
  refusal names the variable AND the value that opens it, and
  `npx convex run health:messagingConfig` answers it in one command.
  Gating happens at `driverFor`, which wraps every driver that can actually
  send, so a WhatsApp driver added later is gated the day it is written rather
  than the day somebody remembers. A guard test fails if the wrapper is
  dropped. It gates at the DRIVER, not at dispatch, so a held message is still
  queued, claimed, counted and visible — refusing at queue time would hide the
  very rows you turned it on to look at.
- **THE FROM LINE IS "CLIENT via THE CREATIVE CURRENT", ALWAYS.** Not a
  deliverability workaround, though it helps with one: every client's mail
  goes out from OUR domain on their behalf, and a From reading "Renu Solar
  <hello@thecreativecurrent.co.za>" states something untrue of both parties.
  A display name that does not match its domain is also the shape of a
  phishing attempt, which is why receivers weigh it — so saying the
  relationship out loud settles the ambiguity for a person and a filter at
  once. It is the pattern mailing lists use, for the same reason.
  **The display name is always QUOTED.** Real client names carry commas, full
  stops and parentheses — "Renu Solar (Pty) Ltd" — and every one is a special
  character in an address header. Unquoted, that is a 422 from the provider or
  a header that parses into something other than what was meant.
- **CLIENT #1 IS MADE BY `onboarding.createFirstClient`, WHICH DISARMS
  ITSELF.** The messaging pipeline cannot be verified against seeded data —
  `dispatch` refuses it, deliberately — so testing it needs one real client.
  The tempting shortcut is flipping `isSeed` on the seeded client, which is
  turning off a guard to pass a test, and a guard turned off for a test stays
  off because nothing ever reminds anyone. So there is a real-client path
  instead, and it **refuses once a real client exists**, the same shape as
  `bootstrap:claimPlatformOwner`: a convenient back door is how the onboarding
  transaction stays unbuilt. It writes no site, sends no invite and touches no
  deal — onboarding is still owed.
  `onboarding.takeFirstBooking` exists because there is no booking screen yet,
  so without it the pipeline has no reachable entry point outside the test
  suite — and a pipeline verified only by its own tests is one nobody has
  watched work. It goes through `createBooking`, not around it.
- **ONE FUNCTION CREATES A BOOKING: `createBooking` in `bookings.ts`.** `book`
  is the tenant wrapper over it — it re-derives the tenant and applies
  `assertLocationAllowed`, which are the parts that are about who is asking.
  Everything else (overlap, the 24-hour cap, buffers, the confirmation queued
  in the same transaction) is in the one function, so a second caller gets the
  identical rules rather than a second implementation that drifts. The insert
  stays in `bookings.ts`, which is what keeps the `startsAt` guard meaningful.
  A guard test fails on a caller outside the named allowlist, and on a second
  `db.insert("bookings")` appearing in the file.
- **A REPLY HAS SOMEWHERE TO LAND, OR THE COPY DOES NOT ASK FOR ONE.** The
  From address is on a SENDING domain, which may have no MX record — and a
  domain with no MX swallows every reply in silence. A booking confirmation is
  the most replied-to message this system will ever send: somebody wanting to
  move an appointment hits reply, because that is what people do. A
  confirmation whose reply goes nowhere is a customer who believes they have
  rescheduled and has not.
  So `resolveReplyTo` answers it ONCE and the answer goes to the renderer AND
  the driver, which is what makes it impossible for the copy to invite a reply
  the envelope will not carry. The client's own `primaryContactEmail` wins —
  the customer is replying to the BUSINESS, not to the platform, and that
  address is one they demonstrably read. `MESSAGING_REPLY_TO` is the
  deployment fallback. **Null is a real answer**: no `reply_to` header at all,
  and the copy drops the invitation rather than defaulting to the From address,
  which would look like it worked.
  The "phone us" half comes from the BOOKING'S OWN BRANCH (`locations.phone`,
  falling back to the client contact), put in the payload by the producer
  because the drain no longer knows which branch it was. A two-branch business
  has two numbers and the wrong one is worse than none — they phone Hillcrest
  about a Ballito job and are told nothing is booked. No number, no promise.
  Nothing here can check MX from the Convex runtime, so nothing guesses:
  `dig MX thecreativecurrent.co.za +short` is the check, and
  `health:messagingConfig` reports the fallback.
- **MEASURED, 2 Sep 2026: the pipeline sent a real email to a real inbox.** A
  real client (`renu-solar-live`, neither demo nor seed), a booking through
  `createBooking`, one `outbox:drain`, and the row reached `sent` with Resend
  id `8891e0a2-89b5-4585-aa35-84fc208f9573`. It arrived in the Gmail INBOX,
  not spam. The `via` From line, the `reply_to`, the branch phone in the body
  and the quiet-hours exemption stamp were all correct on the row.
  **WHAT THAT DOES NOT PROVE, and the distinction matters more than the
  result.** It was one send to an address that had already received sign-in
  codes from the same domain — a warm recipient at a provider that has seen us
  before, which is the most favourable case there is. It says nothing about a
  COLD recipient at a provider with no history of us, which is what every one
  of a client's customers will be. Re-measure against a cold address before
  claiming deliverability; treat this as "the pipeline works", not "the mail
  arrives".
  At the time of measuring, the sending domain had DKIM (`resend._domainkey`)
  and SPF (on `send.`) but **no MX and no DMARC record at all** — both
  outstanding. That it landed in the inbox anyway is a fact about Gmail's
  tolerance for a warm sender, not evidence the records are unnecessary.
- **EMAIL SENDS. WHATSAPP DOES NOT, AND SAYS SO.** `lib/providers.ts` is the
  provider seam: one interface, one driver per channel, chosen by `driverFor`.
  Email is live over Resend. WhatsApp and SMS get a **logging no-op that
  refuses** — it prints the message in full and returns a non-retryable
  failure with a readable reason, so the row lands in the outbox saying "no
  WhatsApp provider is configured". A no-op that returned SUCCESS is the
  tempting shape and the forbidden one: it would stamp `sent` on rows nobody
  received, and the outbox — the only screen that answers "did they hear from
  us" — would agree. A guard test fails on `delivered: true` inside it.
  Whoever wires WhatsApp deletes the no-op rather than making it agreeable.
- **THE DRAIN IS THREE MUTATIONS, AND THE MIDDLE ONE IS THE RISK.** A provider
  call is network I/O, so it runs in an action, and an action has no
  transaction. So: CLAIM (serializable — exactly one drain gets a row), SEND,
  RECORD. A row stranded in `sending` because the action died is REQUEUED
  after ten minutes, not abandoned: that risks a duplicate and rules out
  silence, which is the standing preference. `scheduledFor` on a claimed row
  is its reclaim deadline, which is what lets the stall sweep reuse
  `by_status_scheduledFor` instead of needing a `claimedAt` column.
  Quiet hours are re-checked at CLAIM time as well as at dispatch: a row
  written at 19:58 and reached at 20:01 must not go, and the customer whose
  phone lights up does not care which side of the boundary the write was on.
- **REMINDERS ARE SWEPT FROM CURRENT STATE, NEVER SCHEDULED AT BOOKING TIME.**
  `scheduler.runAt(startsAt - 24h, …)` is the tempting version and it is wrong
  in two ways that both reach a customer: a booking moved from Friday to
  Monday still fires on Thursday, and a cancelled booking still fires at all.
  A sweep reads what is true when it runs. Overlapping windows are deliberate
  and free — the idempotency key refuses the second — which is what makes a
  missed cron run recoverable rather than a reminder nobody ever gets.
  `bookings.by_start` exists for this and spans every client; a guard test
  keeps tenant-scoped code off it.
- **THE DRAIN POLLS, AND POLLING IS THE WRONG SHAPE. NOT A CADENCE KNOB.**
  *Decided 2 Sep 2026. Deliberately NOT built yet — trigger below.*
  Every rule in this file says Convex spend must scale with **bookings and
  admin usage, not with time**. The drain cron is the first thing that does
  not: at two minutes it runs 720 times a day whether or not a single message
  exists. With its two internal reads that is ~65k function calls a month per
  deployment, ~142k across dev and production once the reminder sweeps are
  counted — a FIXED FLOOR, paid on an empty table. (Arithmetic from the
  cadence, not an observed bill.)
  **The fix is architectural: `ctx.scheduler.runAt(scheduledFor, …)` when a
  message is queued, plus an HOURLY safety sweep.** Then calls scale with
  MESSAGES, which is the shape everything else here has — and latency
  *improves*, because a confirmation goes out when it is queued instead of up
  to two minutes later.
  **Slowing the poll to five minutes is the tempting fix and it is wrong.** It
  trades latency for cost, buys a 60% cut in the one direction that does not
  matter, and leaves calls still scaling with time. Cheaper-but-still-wrong is
  worse than wrong, because it removes the pressure to fix the shape.
  The hourly sweep is not belt-and-braces, it is the recoverable half: a
  scheduled job lost to a deploy, a retry that needs re-scheduling, a message
  held for quiet hours whose window opens later. Without it a lost schedule is
  a message nobody ever sends and nobody ever hears about — the exact silent
  failure this pipeline exists to prevent. Hourly is enough precisely because
  it is a backstop and not the mechanism.
  **The REMINDER sweeps stay crons and are not part of this.** They scan
  BOOKINGS, not messages, and the rule above is why: a scheduled reminder
  fires for a booking that has since moved or been cancelled. Their cost is
  ~6k calls a month, which is not the problem.
  **Trigger: the month we move off the free plan.** Free-plan usage covers
  this at no cost, and EU deployments bill on demand from the first call with
  no included usage — so the day the plan changes is the day this stops being
  free, and it is worth exactly one afternoon then. Two minutes stands until
  then.
- **A BOOKING ESTABLISHES A CONTRACT BASIS, NOT A CONSENT ONE.** Before this,
  every confirmation was suppressed for want of consent — a pipeline that ran
  end to end and reached nobody, because the only consent writer was a staff
  member recording one by hand. `book` now writes a consent row for the one
  channel its confirmation uses, `lawfulBasis: "contract"`, source "made a
  booking". POPIA s69 governs direct MARKETING; telling somebody the
  appointment they just asked for is confirmed is not that, and the basis
  recorded says so rather than borrowing the word "consent" for something the
  customer never gave. **It never overrides an existing row** — a withdrawal
  always stands — and that is the only thing that makes writing one on
  somebody's behalf defensible. Two writers only: `customers.ts` and
  `messages.ts`, held by a guard.
- **`book` QUEUES THE CONFIRMATION IN ITS OWN TRANSACTION**, and returns the
  outcome. A booking that committed while its confirmation did not is the
  exact failure: the calendar says the customer was told and the customer was
  not. And the person who just took the booking is told NOW if nothing will
  reach this customer — while they can still ask for an email address — the
  same reasoning as `reachable` on `customers.upsertByPhone`.
- **"TODAY" MEANS TODAY WHERE THE CLIENT IS.** The server runs in UTC and the
  Vercel functions in Dublin, so a day boundary computed on the running clock
  shows a Durban client yesterday at 01:00 and tomorrow at 23:00 — on the
  screen they use to decide where to drive. `lib/localDay.ts` does the
  arithmetic once, against the client own `timezone` column, and the calendar
  query hands the grouping to the browser already done rather than letting the
  phone regroup it in its own zone. DST needed TWO passes: sampling the offset
  at midday and applying it to midnight is an hour out in a zone that shifted
  overnight, which a New York fall-back test caught.
- **THE CLIENT CALENDAR ANSWERS BOTH HALVES: what is on, and whether the
  customer was told.** They are one question to the person asking — a booking
  whose confirmation quietly failed looks exactly like one that went out, and
  the customer is who finds the difference. The join is EXACT rather than a
  guess: `idempotencyKeyFor` wrote the key, so asking it for the key again and
  reading the index is the same join dispatch would make.
  The screen shows the STATE and never the underlying error — those sentences
  are written for whoever runs the platform and some of them name environment
  variables. Today shows cancellations, the rest of the week does not: a job
  somebody saw an hour ago that is now off has to be visibly off or they drive
  to it, while a cancelled booking next Thursday is noise.
- **`/preview/bookings` RENDERS FIXTURES, AND CANNOT EXIST IN PRODUCTION.**
  The back office is behind an emailed code, so without a harness the only way
  to look at the calendar is to be a signed-in client who already has
  bookings — nobody, until the day it matters most. It renders the REAL
  component, not a mock, so what is reviewed is what ships.
  **It is NOT the `apps/sites` preview case, and treating it as one was the
  mistake.** That harness renders invented marketing copy on a public
  template. This one renders the shape of a TENANT'S BOOKINGS — customer names
  and phone numbers — so a runtime `VERCEL_ENV` comparison, which is what it
  had first, is one bad environment variable away from publishing a client's
  customer list, silently and publicly.
  Three independent barriers, every default off:
  1. **It is not a page.** The file is `page.preview.tsx`, which Next does not
     route unless `preview.tsx` is in `pageExtensions`. Verified: a normal
     production build lists ten routes and none of them is `/preview`.
  2. **The build cannot see the flag.** `ALLOW_PREVIEW_ROUTES` is deliberately
     absent from `turbo.json`, and Turborepo filters the environment to what a
     task declares — so setting it in the Vercel dashboard does nothing. This
     is the load-bearing one: it removes the mistake rather than guarding it.
  3. **And it still refuses**, before rendering, unless the flag is exactly
     `"1"`.
  **Fixtures only, forever**: a guard bans any Convex read under `app/preview`,
  because a harness that can be pointed at a real tenant is the thing all of
  the above exists to prevent. Run it with
  `ALLOW_PREVIEW_ROUTES=1 pnpm --filter @cc/office dev`.
- Every screen goes through the `impeccable` skill. Tokens only.
- Never mark anything done without a deployed preview URL and a human tapping
  it on a real phone.

## How the guards are built, and three ways they have been fooled

- **PREFER A BARRIER THAT REMOVES THE CAPABILITY OVER ONE THAT REFUSES TO USE
  IT.** Nothing has to run correctly for the first kind. `ALLOW_PREVIEW_ROUTES`
  is the worked example: the runtime check (`if flag !== "1" notFound()`) has
  to execute, on the right build, with the right value, every time — and one
  wrong environment variable defeats it. Leaving the variable out of
  `turbo.json` means a Vercel build **cannot see it at all**, because Turborepo
  filters the environment to what a task declares. That is not a stronger
  check; it is the absence of the thing a check would have to get right.
  Same shape elsewhere: `page.preview.tsx` is not a route because Next never
  looks at it, not because something decided to hide it. Reach for capability
  removal first, and keep the refusal as the second layer rather than the only
  one.
- **COMMENT-STRIPPING IS THE DEFAULT IN THE GUARD HELPERS, AND THE NAMES
  ENFORCE IT.** `sourceFiles` exposes `code` (stripped) and `raw` (not), and
  deliberately no `text` — so scanning prose is something somebody has to type
  the word `raw` to do. It has caught us three times, and it is structural
  rather than unlucky: the prose most likely to sit next to a rule is the
  paragraph explaining that rule, so **the most carefully documented code is
  the easiest to fool with a text scan.**
  1. the webhook rule that fired on its own comment saying `request.json()`
     never appears in that file
  2. the one that fired on the comment showing the banned
     `if (!secret) return true` shape
  3. the next-config gate that **passed against a deleted check**, because the
     paragraph explaining the flag still contained the flag's name
  `raw` is right only where over-eagerness is wanted — the `startsAt` guards,
  where a false positive costs one comment and a false negative costs a
  customer standing outside a locked door.
- **EVERY WALKER ASSERTS IT FOUND SOMETHING, AND NAMES WHAT.** A guard that
  scanned nothing reports safety it never checked, and it does it in green.
  The shared `walk` in `convex/guards.test.ts` collects only `.ts`, which is
  correct for `convex/` and silently wrong anywhere else: reused over a tree of
  `.tsx` it returned an empty list, every rule built on it passed, and **three
  of four negative controls came back green against deliberately broken code.**
  So `convex/guards.test.ts`, `apps/sites/demo-guard.test.ts` and
  `scripts/lint-tokens.mjs` each assert a floor AND name files they must have
  found — a count alone survives a walker pointed at the wrong tree. The token
  linter exits 1 rather than printing "0 files clean", which reads as a pass.
  Audited 2 Sep 2026: no existing guard was blind. `demo-guard` matches
  `/\.tsx?$/` and the token linter covers `.css/.ts/.tsx/.jsx/.js`, both
  correct. The trap was latent, not live.
- **NEGATIVE CONTROLS, ALWAYS.** Break the thing on purpose, watch the guard
  fail, restore it, watch it pass. Every one of the failures above was found
  that way and none of them by reading. A guard that has never been seen to
  fail is a guard nobody has tested.

## Invariants held by tests, not by convention

`pnpm test` — 678 tests. The structural ones live in `convex/guards.test.ts`
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

Seven on production, six on dev, plus four for messaging.
`npx convex env list` to check.

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
| `MESSAGING_RESEND_KEY` | Resend, Sending access. **Optional but wanted.** Customer-facing mail — confirmations and reminders. Separate from the auth key for the same reason the auth key is separate: "last used" then answers a question. Unset, the outbox falls back to `AUTH_RESEND_KEY`; unset with no fallback either, every email retries five times and lands in the outbox saying so, which is deliberate — an unconfigured deployment must fail visibly rather than decide the message was handled. |
| `MESSAGING_EMAIL_FROM` | Same shape as `AUTH_EMAIL_FROM`, on a verified domain. A bare address gets the CLIENT's name as its display name; the client's own domain is never the envelope sender, because it is not verified with Resend and would be rejected or filed as spam. |
| `MESSAGING_REPLY_TO` | A mailbox that actually RECEIVES. Fallback for clients with no `primaryContactEmail`; the client's own address wins where it exists. Unset is survivable and honest — those messages carry no `reply_to` and drop the "reply to this message" line rather than pointing a customer at a domain with no MX. Not the same as `MESSAGING_EMAIL_FROM`, which is a sending address and need not receive anything. |
| `MESSAGING_ALLOWLIST` | **Required for anything to send at all.** Comma- or space-separated: full addresses, `@domain` entries, or the single token `*` for everybody. **Unset means NOBODY** — see the rule above for why that inversion is deliberate. Check it with `npx convex run health:messagingConfig`, which answers "who does this deployment actually send to" in one line. |
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
pnpm test                        # 678 tests
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
