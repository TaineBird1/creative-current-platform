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
- Every screen goes through the `impeccable` skill. Tokens only.
- Never mark anything done without a deployed preview URL and a human tapping
  it on a real phone.

## Invariants held by tests, not by convention

`pnpm test` — 125 tests. The structural ones live in `convex/guards.test.ts`
and fail CI rather than relying on anyone remembering:

- no bare `query`/`mutation` outside a 5-file public allowlist
- no TENANT-scoped function accepts a `clientId` argument (platform functions
  may: operating across every tenant is the owner console's job)
- `ledgerEntries`, `auditLog` and `consents` are append-only
- `siteConfigs.ts` is the ONLY writer of the `sites` table — `config` is
  `v.any()`, so its Zod parse is the only thing holding the shape
- `lib/reseller.ts` is the ONLY writer of `clients.resellerId` and enforces
  reseller depth exactly 1, which is what makes the one-hop membership walk in
  `requireTenant` correct
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

Five must be set on every deployment. `npx convex env list` to check.

| Variable | Source |
|---|---|
| `JWT_PRIVATE_KEY`, `JWKS` | Generated as a matching PAIR with `jose`. Rotating one without the other invalidates every session. |
| `SITE_URL` | The OFFICE origin (`http://localhost:3200` in dev). Unused by the OTP flow; it is the redirect target for any OAuth or magic-link provider added later. |
| `AUTH_RESEND_KEY` | Resend, Sending access only. Not the outreach key — a separate one means "last used" tells you whether sign-in works. |
| `AUTH_EMAIL_FROM` | Must be on a Resend-verified domain. |

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
requires the nameserver method for wildcards, meaning the whole zone moves off
10Web with every existing record recreated by hand. A subdomain does not make
a demo more convincing (it still is not the lead's own domain), so it buys
nothing for that cost.

Real client domains are added to `cc-sites` individually through the domain
wizard. Apex needs an A record, a subdomain needs a CNAME — both work from
10Web's DNS panel with no nameserver change. So **nothing here forces a
nameserver move.** Moving to Vercel DNS may still be worth it later for
convenience; it is not a prerequisite for anything.

## Region — EU West (Ireland), deliberately

Convex offers US East (N. Virginia) and EU West (Ireland). No African region;
Canada and Australia are next. Ireland is therefore the closest available to
Durban and is the team default.

Two reasons, in order of how much they bite:

- **Latency.** Durban to eu-west-1 is roughly 150ms round trip, to us-east-1
  roughly 230ms. The public sites are server-rendered, so every page load pays
  it, against an LCP budget of under 2.0s on a mid-range Android.
- **POPIA.** Section 72 permits cross-border transfer with adequate protection,
  so US hosting is workable — but the data is our clients' CUSTOMERS' names and
  phone numbers, and choosing the nearer, EU-adequate region is the cheaper
  posture to defend.

**An existing deployment's region cannot be changed.** Moving one means
creating a new deployment in the target region and export/importing. The first
production deployment landed in US East because `convex deploy` inherited the
team default before it was set, and the CLI cannot yet select a region — so
check the region on any new deployment before putting data in it.

## Bootstrapping the first platform owner

`invites.inviteToPlatform` needs an existing owner, so the first one comes
from `bootstrap:claimPlatformOwner`, which refuses once an ACTIVE owner
exists. Sign in once first — it grants to an existing account, and will not
create one.

```bash
npx convex run bootstrap:claimPlatformOwner '{"email":"you@example.com"}'
```

## Commands

```bash
pnpm test                        # 125 tests
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
