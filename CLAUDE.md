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
- Every screen goes through the `impeccable` skill. Tokens only.
- Never mark anything done without a deployed preview URL and a human tapping
  it on a real phone.

## Invariants held by tests, not by convention

`pnpm test` — 223 tests. The structural ones live in `convex/guards.test.ts`
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
pnpm test                        # 223 tests
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
