// Tiny translation layer for the side panel. Keys are the English text; a missing
// translation falls back to English, so new strings never show up blank.
import NL from "../i18n/nl.js";
import DE from "../i18n/de.js";
import ES from "../i18n/es.js";

const DICTS = { nl: NL, de: DE, es: ES };
export const LANGUAGES = [
  ["auto", "Automatic (browser language)"],
  ["en", "English"],
  ["nl", "Nederlands"],
  ["de", "Deutsch"],
  ["es", "Español"],
];

let dict = null;
let current = "en";

export function resolveLang(code, browser = (globalThis.navigator && navigator.language) || "en") {
  const c = code && code !== "auto" ? code : String(browser).slice(0, 2).toLowerCase();
  return DICTS[c] ? c : "en";
}

export function setLang(code) {
  current = resolveLang(code);
  dict = DICTS[current] || null;
  if (globalThis.document) document.documentElement.lang = current;
  return current;
}

export const lang = () => current;

export function t(text, vars) {
  let out = (dict && dict[text]) || text;
  if (vars) out = out.replace(/\{(\w+)\}/g, (m, k) => (k in vars ? String(vars[k]) : m));
  return out;
}

export function hasTranslation(code, text) {
  return !!(DICTS[code] && DICTS[code][text]);
}
