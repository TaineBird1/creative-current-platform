import { buildAccentRamp } from "../packages/site-config/src/accent";
import { contrastRatio } from "../packages/site-config/src/primitives";

const brands: Record<string, string> = {
  "solar orange": "#f26a1b",
  "deep navy":    "#12305e",
  "forest":       "#1f6f43",
};

for (const [name, hex] of Object.entries(brands)) {
  const r = buildAccentRamp(hex);
  const body = contrastRatio(r[700], "#ffffff");
  const btn = contrastRatio(r[500], r.onAccent);
  console.log(`\n${name}  (brand ${hex})`);
  console.log(`  500 ${r[500]}  onAccent ${r.onAccent}   button contrast ${btn.toFixed(2)}:1 ${btn >= 4.5 ? "PASS" : "FAIL"}`);
  console.log(`  700 ${r[700]}                       body-on-white  ${body.toFixed(2)}:1 ${body >= 4.5 ? "PASS" : "FAIL"}`);
  console.log(`  ramp ${[50,100,200,300,400,500,600,700,800,900].map(k => (r as any)[k]).join(" ")}`);
}
