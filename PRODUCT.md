# PRODUCT.md — The Creative Current

> Derived from the platform spec and the build answer sheet (28 Aug 2026), plus
> the owner's decisions in session. Nothing here is inferred taste; where a fact
> was not stated it is marked OPEN.

## What this is

A web agency platform. Three surfaces, one Convex backend:

- **`apps/sites`** — the public websites of the agency's clients. Multi-tenant,
  rendered from data. THIS document's current surface.
- **`apps/office`** — one app serving both the owner's admin console (`/admin`)
  and every client's white-label back office (`/c/<slug>`). M3.
- **`convex/`** — database, functions, auth, crons, webhooks.

The golden rule: **a client website is a row, not a repo.** One renderer, one
section registry, skinned by template variants. A fix ships to every client at
once. Code is never forked per client.

## Who it is for

Three audiences, and the public site serves only the third:

1. **Taine** (owner, Durban KZN) — runs the console, sells the platform.
2. **The client** (a small business owner: solar installer, guest house,
   trades) — runs their back office, edits content, never sees code.
3. **The client's customer** — lands on the public site from Google or a
   WhatsApp link, on a mid-range Android phone, on mobile data, probably
   standing up. They want a price or a call-back. They will not create an
   account, and the platform never asks them to.

## The surface in scope: public client websites

**Mode: Persuade.** The visitor decides and acts. Success is one thing: a
qualified quote request or a phone call. Everything else on the page exists to
earn that.

**What must be believed before they act:** that this business is competent,
local, and still answers the phone. For trades and solar specifically, the
buyer has been burned or knows someone who was — the enemy is not a competitor,
it is doubt.

**The proof available** is unusually strong and unusually plain: real tariff
numbers with their sources, contractual SLA promises, named accreditations,
honest cost bands. Template #1 leans on it.

## Constraints that are already settled

| | |
|---|---|
| Home currency | ZAR, integer cents, never summed across currencies |
| Timezone | Africa/Johannesburg default, per-site tz stored regardless |
| Compliance | POPIA primary, GDPR shape. Review-gating banned outright |
| Accounts | No end-customer accounts. Ever. Name + phone is the whole form |
| Imagery | Stock/AI/scraped may never appear as the client's real work |
| Performance | LCP < 2.0s mid-Android, CLS < 0.05, Lighthouse 95/100/100 |
| Numbers | Tabular figures on every number, price, time and phone |

## Template #1 — solar / trades

Seeded from a real shipped solar site in KZN. Real copy, real numbers, real
sources. Uses the **quote** flow, not booking: a solar job is quoted, not
slotted. Ships without a gallery or reviews section, because at seed time
there are no consented client assets and the registry refuses stock imagery
presented as work.

Template #2 is guest houses, and arrives when a direct-booking client lands.

## What would make a polished result feel wrong

- Anything that reads as a template. These sites compete with a local rival's
  site, not with each other, but a lead who sees two identical ones stops
  believing either.
- Stock photography of smiling people near solar panels. The content is the
  proof; decorative imagery actively weakens it.
- A number without its source.
- Any friction between "I want a price" and the form.

## OPEN

- The first real client's identity (the answer sheet's own flagged blocker).
- WhatsApp provider.
