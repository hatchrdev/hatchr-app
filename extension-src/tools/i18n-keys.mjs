// Collects every English UI string that the side panel shows, so tests can check
// that each language has a translation. Run directly to print the missing ones:
//   node tools/i18n-keys.mjs nl
import { readFileSync } from "node:fs";
import { GUIDES } from "../src/lib/guides.js";
import { AI_PROVIDERS } from "../src/lib/settings.js";

const src = readFileSync(new URL("../src/sidepanel.js", import.meta.url), "utf8");
const html = readFileSync(new URL("../src/sidepanel.html", import.meta.url), "utf8");
const unq = (s) => JSON.parse(`"${s}"`);
const STR = String.raw`"((?:[^"\\]|\\.)*)"`;
const set = new Set();
const add = (s) => { if (s && /[A-Za-z]/.test(s)) set.add(s); };

for (const m of src.matchAll(new RegExp(String.raw`\bt\(\s*${STR}`, "g"))) add(unq(m[1]));
for (const m of src.matchAll(new RegExp(String.raw`\b(?:label|help|title|note|resetLabel):\s*${STR}`, "g"))) add(unq(m[1]));
// select options: ["value", "Label"]
for (const m of src.matchAll(new RegExp(String.raw`\[\s*"[\w-]+"\s*,\s*${STR}\s*\]`, "g"))) add(unq(m[1]));
// sub-tabs: ["id", "icon", "Label"]
for (const m of src.matchAll(new RegExp(String.raw`\[\s*"\w+"\s*,\s*"[^"]+"\s*,\s*${STR}\s*\]`, "g"))) add(unq(m[1]));
for (const m of html.matchAll(/data-i18n(?:-ph|-title)?="([^"]+)"/g)) add(m[1].replace(/&quot;/g, '"').replace(/&amp;/g, "&"));
for (const g of Object.values(GUIDES)) {
  add(g.title); add(g.intro);
  (g.steps || []).forEach(add); (g.tips || []).forEach(add);
}
add("Open {site}");
for (const p of Object.values(AI_PROVIDERS)) add(p.label);
add("Automatic (browser language)");
// labels of the "Test setup" rows
["Wallet", "RPC", "Balance", "Pinata", "AI", "Create tx (test)"].forEach(add);
// option values that are also labels
for (const x of ["low (cheapest)", "medium", "high", "Off"]) add(x);
// things that are not UI text
for (const x of ["TICKER", "https://… image URL", "AI test image", "Hatchr", "Solscan ↗", "pump.fun", "Axiom", "tx", "LIVE", "TEST", "AUTO", "SOL", "eur", "usd", "sol", "gbp"]) set.delete(x);

export const keys = [...set].sort();

if (process.argv[1] && process.argv[1].endsWith("i18n-keys.mjs")) {
  const lang = process.argv[2];
  if (!lang) { console.log(JSON.stringify(keys, null, 1)); }
  else {
    const dict = (await import(`../src/i18n/${lang}.js`)).default;
    const missing = keys.filter((k) => !dict[k]);
    console.log(JSON.stringify(missing, null, 1));
    console.error(`${missing.length} of ${keys.length} missing`);
  }
}
