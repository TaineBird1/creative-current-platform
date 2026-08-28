# DESIGN.md — The Creative Current

Durable visual decisions. Tokens live in `packages/tokens/src/tokens.css` and are
enforced by `pnpm lint:tokens`, which fails the build on raw hex, literal colour
functions, inline fonts and magic radii. This document explains the decisions;
the lint rule is what actually holds them.

## Two worlds, never blended

| | `.world-admin` | `.world-client` |
|---|---|---|
| Where | `apps/office/admin` | `apps/sites`, `apps/office/c/<slug>` |
| Ground | Monochrome ink, dark | Warm near-white |
| Accent | **None.** Deliberately absent | The client's own, via the AA ramp |
| Why | A tinted console is how you misread whose data you are looking at | The site belongs to the client, not to us |

Never restyle one while changing the other. There is no shared component that
renders differently per world by prop; they share tokens and nothing else.

## Type — decided 2026-08-28

**Zilla Slab** (display) · **Hanken Grotesk** (body) · **Martian Mono** (data).

Rejected: Inter + Instrument Serif. Same legibility, no character, and it is
the house style of AI-generated design — which is a problem for a template
whose entire job is to not look like the other quotes in the client's inbox.

- **Zilla Slab** carries authority without formality. A slab display reads as
  technical-editorial, which is what the content already is: tariff numbers,
  SLA terms, honest cost bands. It also holds a long headline in three lines
  at 360px, where a tighter grotesque starts to cramp.
- **Hanken Grotesk** stays warm at 15px on a mid-range Android. Humanist, not
  neutral; the prose is an argument and should not read like a form.
- **Martian Mono** for every number, price, time and phone. Mono here is
  measurement, not costume — tabular figures so a column of rand amounts
  aligns, which is the whole point of showing them.

All three are variable, on Google Fonts, self-hosted at build via `next/font`.
No external font request ships.

## Colour

Neutrals are a fixed warm ink ramp. Accent is **per client**, derived from
their brand colour by `packages/site-config/src/accent.ts` and injected as
`--accent-*` custom properties on the page root.

Three properties the ramp holds, each with a test:

1. **The client's colour appears in it.** Anchored to whichever step its own
   lightness is nearest. A navy client whose accent came out a generic mid-blue
   has been given somebody else's brand.
2. **AA or it does not ship.** Step 700 (body/links on white) and step 500
   (button fill under its foreground) both clear 4.5:1, corrected if needed.
3. **Strictly monotonic.** A correction that pushed 700 past 800 produced a
   ramp that looked broken in a way no contrast check catches. It happened.

A consequence worth knowing: a very dark brand anchors near 900, so its button
fill is a lighter step and the brand colour itself shows up in dark bands and
headings. That is correct, and clients notice, so say it out loud at onboarding.

## Template #1 — `solar-trades`, variant `ink`

**One live variant for M1.** "Field manual" (mono-forward, blueprint restraint)
becomes variant #2 later, not now.

Structure and tone inherited from a real shipped solar site; palette is not —
that comes from each client's ramp.

**Section bands alternate** paper → dark → paper → accent-tinted, so the page
has rhythm without needing imagery. Every section is designed to be complete
with **zero photographs**: a client goes live the day they sign, and supplied
photography is an upgrade, never a launch dependency.

Three things this variant refuses:

- **No eyebrows above headings.** The source site stacks a kicker over every
  heading; the headings are strong enough alone. `eyebrow` stays in the schema
  because clients may want it, and this variant does not render it stacked —
  it becomes the section's accessible label and its entry in the section nav.
- **No card grids as page structure.** The sectors and SLA sections are
  bordered editorial columns, not boxes. Nested cards are never correct.
- **No big-number stat cards.** The tariff figures render as a ruled data line
  with their sources attached, which is what a tariff notice actually looks
  like and is more persuasive than a metric tile.

**Numbered steps are earned** in the process section only, where the sequence
carries information the reader needs. Nowhere else.

## Motion

One authored moment per page: section bands settle in on first paint with an
exponential ease-out from an already-visible default, so nothing is invisible
if JS fails or motion is reduced. `prefers-reduced-motion` collapses every
duration token to 1ms — the animation still runs, it just arrives instantly.

## Browser surfaces

The parts we did not draw still carry the design: selection colour, caret,
focus ring, scrollbar, underline offset, and tabular numerals are all themed
from the palette. Defaults here are the cheapest tell that a page was
assembled rather than built.

## Non-negotiables

- Tabular figures on every number, price, time and phone.
- Body measure 65–75ch.
- LCP < 2.0s on mid Android, CLS < 0.05.
- Stock, AI or scraped imagery may never appear as the client's real work.
- Every number on a client site carries its source.
