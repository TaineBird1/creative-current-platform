import { contrastRatio } from "./primitives";
import type { z } from "zod";
import type { accentRamp } from "./primitives";

export type AccentRamp = z.infer<typeof accentRamp>;

/**
 * Brand colour -> AA-safe accent ramp.
 *
 * The client picks a colour; we do not get to refuse it, and we do not get to
 * ship 3.9:1 body text because their brand happens to be a light teal. So the
 * ramp is DERIVED and then CORRECTED until it passes, rather than generated
 * and hoped over. accentRamp's superRefine rejects anything that still fails,
 * which makes this function the only thing standing between a brand colour and
 * an unpublishable config.
 *
 * Two anchors do the work:
 *   - step 700 is the body/link colour. Darkened until it clears 4.5:1 on white.
 *   - step 500 is the button fill. `onAccent` is whichever of black/white
 *     contrasts better against it; if neither clears 4.5:1, 500 is darkened
 *     until white does.
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

/** Lightness targets per step, before correction. */
const STEP_LIGHTNESS: Record<string, number> = {
  50: 0.97,
  100: 0.94,
  200: 0.87,
  300: 0.78,
  400: 0.67,
  500: 0.56,
  600: 0.47,
  700: 0.39,
  800: 0.30,
  900: 0.21,
};

/** Darken `hex` in 1% lightness steps until `test` passes, or we hit black. */
function darkenUntil(hex: string, test: (candidate: string) => boolean): string {
  const [r, g, b] = hexToRgb(hex);
  const [h, s, l] = rgbToHsl(r, g, b);
  let lightness = l;
  let candidate = hex;
  // 100 iterations is a hard bound; at 1% per step it reaches black.
  for (let i = 0; i < 100 && !test(candidate); i++) {
    lightness = clamp(lightness - 0.01);
    candidate = hslToHex(h, s, lightness);
    if (lightness <= 0) break;
  }
  return candidate;
}

export function buildAccentRamp(brandColour: string): AccentRamp {
  const [r, g, b] = hexToRgb(brandColour);
  const [h, rawS] = rgbToHsl(r, g, b);
  // A near-grey brand colour produces a near-grey ramp, which reads as broken.
  // Floor the saturation so the accent is still visibly an accent.
  const s = Math.max(rawS, 0.18);

  const step = (key: keyof typeof STEP_LIGHTNESS) => hslToHex(h, s, STEP_LIGHTNESS[key]!);

  // Body/link anchor: must clear AA on white.
  const s700 = darkenUntil(step("700"), (c) => contrastRatio(c, "#ffffff") >= 4.5);

  // Button anchor: pick the better foreground, darken the fill if neither works.
  let s500 = step("500");
  const best = (fill: string) =>
    contrastRatio(fill, "#ffffff") >= contrastRatio(fill, "#111111") ? "#ffffff" : "#111111";
  if (contrastRatio(s500, best(s500)) < 4.5) {
    s500 = darkenUntil(s500, (c) => contrastRatio(c, "#ffffff") >= 4.5);
  }
  const onAccent = best(s500);

  return {
    50: step("50"),
    100: step("100"),
    200: step("200"),
    300: step("300"),
    400: step("400"),
    500: s500,
    600: step("600"),
    700: s700,
    800: step("800"),
    900: step("900"),
    onAccent,
  };
}
