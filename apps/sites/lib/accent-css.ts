import type { AccentRamp } from "@cc/site-config";

/**
 * Ramp -> CSS custom properties on the page root.
 *
 * This is the ONLY place a client's colour enters the stylesheet. Every
 * component reads var(--accent-N); none of them know which client they are
 * rendering, which is what lets one renderer serve every tenant.
 *
 * The ramp is already AA-validated by the time it reaches here -- an invalid
 * one cannot be persisted -- so there is no contrast decision left to make.
 */
export function accentStyle(ramp: AccentRamp): React.CSSProperties {
  return {
    "--accent-50": ramp[50],
    "--accent-100": ramp[100],
    "--accent-200": ramp[200],
    "--accent-300": ramp[300],
    "--accent-400": ramp[400],
    "--accent-500": ramp[500],
    "--accent-600": ramp[600],
    "--accent-700": ramp[700],
    "--accent-800": ramp[800],
    "--accent-900": ramp[900],
    "--on-accent": ramp.onAccent,
  } as React.CSSProperties;
}
