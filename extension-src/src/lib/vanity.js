// Vanity wallet addresses: odds and input checks (no crypto here, the search runs in a worker).
export const BASE58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";

/** Characters that can never appear in a Solana address (0, O, I, l, symbols…). */
export function badChars(text) {
  return [...new Set([...String(text || "")].filter((c) => !BASE58.includes(c)))];
}

/** Roughly how many random addresses it takes to find one that matches. */
export function vanityTries(prefix = "", suffix = "", caseSensitive = false) {
  let tries = 1;
  for (const c of String(prefix) + String(suffix)) {
    const matches = caseSensitive ? 1 : [...BASE58].filter((x) => x.toLowerCase() === c.toLowerCase()).length || 1;
    tries *= 58 / matches;
  }
  return tries;
}

/** Does this address match? */
export function vanityMatch(addr, prefix = "", suffix = "", caseSensitive = false) {
  const a = caseSensitive ? addr : addr.toLowerCase();
  const p = caseSensitive ? prefix : prefix.toLowerCase();
  const s = caseSensitive ? suffix : suffix.toLowerCase();
  return (!p || a.startsWith(p)) && (!s || a.endsWith(s));
}
