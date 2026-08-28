import { contrastRatio, SURFACE_FLOOR } from "./primitives";
import type { z } from "zod";
import type { accentRamp } from "./primitives";

export type AccentRamp = z.infer<typeof accentRamp>;
export const RAMP_STEPS = [50, 100, 200, 300, 400, 500, 600, 700, 800, 900] as const;
export type RampStep = (typeof RAMP_STEPS)[number];

/**
 * Brand colour -> AA-safe accent ramp.
 *
 * Three properties this has to hold, because the client picks the colour and
 * we do not get to refuse it:
 *
 *   1. THE BRAND COLOUR APPEARS IN THE RAMP. A navy client whose accent comes
 *      out a generic mid-blue has been given someone else's brand. So the ramp
 *      is anchored: the brand lands exactly on whichever step its own lightness
 *      is nearest, and the rest of the scale is built around it.
 *   2. AA OR IT DOES NOT SHIP. Step 700 is body/link text and must clear
 *      4.5:1 against SURFACE_FLOOR -- the darkest light band it sits on, not
 *      pure white, which flatters the number by about 0.15 and let two real
 *      brand colours ship at 4.40:1. Step 500 is a button fill and must clear
 *      4.5:1 against whichever of black/white sits on it. Both are corrected.
 *   3. MONOTONIC. Every step is strictly lighter than the next. A correction
 *      that pushes 700 past 800 produces a ramp that looks broken in a way no
 *      contrast check catches -- which is exactly what the first version did.
 *
 * accentRamp's superRefine rejects anything that still fails, so this function
 * is the only thing between a brand colour and an unpublishable config.
 */

const clamp = (n: number, lo = 0, hi = 1) => Math.min(hi, Math.max(lo, n));

function hexToRgb(hex: string): [number, number, number] {
  const n = parseInt(hex.slice(1), 16);
  return [(n >> 16) & 255, (n >> 8) & 255, n & 255];
}

function rgbToHex(r: number, g: number, b: number): string {
  const to = (c: number) => Math.round(clamp(c, 0, 255)).toString(16).padStart(2, "0");
  return `#${to(r)}${to(g)}${to(b)}`;
}

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
  const [rf, gf, bf] = [r / 255, g / 255, b / 255] as const;
  const max = Math.max(rf, gf, bf);
  const min = Math.min(rf, gf, bf);
  const l = (max + min) / 2;
  if (max === min) return [0, 0, l];
  const d = max - min;
  const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
  let h: number;
  if (max === rf) h = ((gf - bf) / d + (gf < bf ? 6 : 0)) / 6;
  else if (max === gf) h = ((bf - rf) / d + 2) / 6;
  else h = ((rf - gf) / d + 4) / 6;
  return [h, s, l];
}

function hslToHex(h: number, s: number, l: number): string {
  if (s === 0) {
    const v = l * 255;
    return rgbToHex(v, v, v);
  }
  const q = l < 0.5 ? l * (1 + s) : l + s - l * s;
  const p = 2 * l - q;
  const hue = (t: number) => {
    let x = t;
    if (x < 0) x += 1;
    if (x > 1) x -= 1;
    if (x < 1 / 6) return p + (q - p) * 6 * x;
    if (x < 1 / 2) return q;
    if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
    return p;
  };
  return rgbToHex(hue(h + 1 / 3) * 255, hue(h) * 255, hue(h - 1 / 3) * 255);
}

/** Nominal lightness per step, before anchoring and correction. */
const NOMINAL: Record<RampStep, number> = {
  50: 0.97, 100: 0.94, 200: 0.87, 300: 0.78, 400: 0.67,
  500: 0.56, 600: 0.47, 700: 0.39, 800: 0.30, 900: 0.21,
};

/** Minimum lightness gap between adjacent steps, so the ramp reads as a ramp. */
const MIN_GAP = 0.035;

/**
 * The highest lightness at this hue/saturation that still clears `min` against
 * `against`. Scans downward in 0.5% steps; returns 0 if even black fails,
 * which cannot happen for white but keeps the function total.
 */
function maxLightnessPassing(
  h: number,
  s: number,
  against: string,
  min: number,
  startL: number,
): number {
  let l = startL;
  for (let i = 0; i < 200; i++) {
    if (contrastRatio(hslToHex(h, s, l), against) >= min) return l;
    l -= 0.005;
    if (l <= 0) return 0;
  }
  return 0;
}

export function buildAccentRamp(brandColour: string): AccentRamp {
  const [r, g, b] = hexToRgb(brandColour);
  const [rawH, rawS, brandL] = rgbToHsl(r, g, b);
  // A near-grey brand produces a near-grey ramp, which reads as broken rather
  // than as restraint. Floor the saturation so an accent is still an accent.
  const s = Math.max(rawS, 0.18);
  const h = rawH;

  // --- 1. anchor: shift the scale so the brand lands on its nearest step ----
  const anchor = RAMP_STEPS.reduce((best, step) =>
    Math.abs(NOMINAL[step] - brandL) < Math.abs(NOMINAL[best] - brandL) ? step : best,
  );
  const offset = brandL - NOMINAL[anchor];

  const lightness: Record<number, number> = {};
  for (const step of RAMP_STEPS) {
    lightness[step] = clamp(NOMINAL[step] + offset, 0.04, 0.98);
  }

  // --- 2. correct the two anchors that carry an accessibility contract -----
  // 700 is body text and links, on the darkest light band it can land on.
  lightness[700] = Math.min(
    lightness[700]!,
    maxLightnessPassing(h, s, SURFACE_FLOOR, 4.5, lightness[700]!),
  );

  // 500 is a button fill. Prefer keeping it as-is with whichever foreground
  // works; only darken if neither black nor white clears AA on it.
  const fgFor = (fill: string) =>
    contrastRatio(fill, "#ffffff") >= contrastRatio(fill, "#111111") ? "#ffffff" : "#111111";
  if (contrastRatio(hslToHex(h, s, lightness[500]!), fgFor(hslToHex(h, s, lightness[500]!))) < 4.5) {
    lightness[500] = Math.min(
      lightness[500]!,
      maxLightnessPassing(h, s, SURFACE_FLOOR, 4.5, lightness[500]!),
    );
  }

  // --- 3. monotonicity, outward from each corrected anchor ----------------
  // Darker steps must stay darker than 700; lighter steps must stay lighter.
  for (const step of [800, 900] as const) {
    const prev = step === 800 ? lightness[700]! : lightness[800]!;
    lightness[step] = clamp(Math.min(lightness[step]!, prev - MIN_GAP), 0.02, 1);
  }
  const ascending = [600, 500, 400, 300, 200, 100, 50] as const;
  let floor = lightness[700]!;
  for (const step of ascending) {
    lightness[step] = clamp(Math.max(lightness[step]!, floor + MIN_GAP), 0, 0.99);
    floor = lightness[step]!;
  }

  // Nudging 500 upward for monotonicity can cost it its contrast; re-check.
  let s500 = hslToHex(h, s, lightness[500]!);
  if (contrastRatio(s500, fgFor(s500)) < 4.5) {
    // 500 is boxed in between 600 and 400, so take the foreground that wins
    // and, if neither does, fall back to the darkest permitted lightness.
    lightness[500] = clamp(lightness[600]! + MIN_GAP / 2, 0, 0.99);
    s500 = hslToHex(h, s, lightness[500]!);
  }

  // The tinted band paints step 50 and writes step 700 on it. That pairing has
  // its own floor, and it is tighter than the page ground for saturated hues.
  for (let i = 0; i < 40; i++) {
    if (contrastRatio(hslToHex(h, s, lightness[700]!), hslToHex(h, s, lightness[50]!)) >= 4.5) break;
    lightness[700] = clamp(lightness[700]! - 0.01, 0.02, 1);
    lightness[800] = clamp(Math.min(lightness[800]!, lightness[700]! - MIN_GAP), 0.02, 1);
    lightness[900] = clamp(Math.min(lightness[900]!, lightness[800]! - MIN_GAP), 0.02, 1);
  }

  const hex = (step: RampStep) => hslToHex(h, s, lightness[step]!);
  const onAccent = fgFor(hex(500));

  return {
    50: hex(50), 100: hex(100), 200: hex(200), 300: hex(300), 400: hex(400),
    500: hex(500), 600: hex(600), 700: hex(700), 800: hex(800), 900: hex(900),
    onAccent,
  };
}

/** Which step, if any, is the client's own colour. For logo lockups. */
export function anchorStep(brandColour: string): RampStep {
  const [r, g, b] = hexToRgb(brandColour);
  const [, , l] = rgbToHsl(r, g, b);
  return RAMP_STEPS.reduce((best, step) =>
    Math.abs(NOMINAL[step] - l) < Math.abs(NOMINAL[best] - l) ? step : best,
  );
}
