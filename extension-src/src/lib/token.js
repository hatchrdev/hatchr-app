// $HATCHR: the coin that unlocks holder perks in Hatchr.
//
// The official address and the tier amounts come from a small file on hatchr.pro, so they can be set
// on launch day (and adjusted later) without a new store review. Until that file carries an address,
// the coin counts as "not launched" and nothing is unlocked.
//
// Holding is read from the Hatchr wallet with one balance lookup. Nothing is signed, sent or connected.

export const TOKEN_CONFIG_URL = "https://hatchr.pro/token.json";
// true only in the local preview build: adds a switch that shows the panel as a Holder or Gold holder,
// and lets a vote be saved on this computer. Store builds keep this false.
export const PREVIEW_BUILD = false;
const CONFIG_TTL_MS = 6 * 3_600_000;
// Until the file carries an address the coin isn't launched, and the file is re-read every few minutes, so the
// perks switch on by themselves shortly after the address is published. Once it's there, a few hours is plenty.
const PRELAUNCH_TTL_MS = 4 * 60_000;

export const TOKEN_DEFAULT = {
  name: "Hatchr",
  ticker: "HATCHR",
  mint: "", // set in token.json on launch day
  supply: 1_000_000_000,
  tiers: [
    { id: "holder", label: "Holder", min: 100_000 },
    { id: "gold", label: "Gold", min: 1_000_000 },
  ],
  votes: [
    { id: "autosell", title: "Auto-sell rules", text: "Take profit and stop loss on coins you launched." },
    { id: "push", title: "Phone alerts", text: "A push message when a coin launches or sells." },
    { id: "launchpads", title: "More launchpads", text: "Launch on other Solana launchpads besides pump.fun." },
    { id: "firefox", title: "Firefox version", text: "Hatchr as a Firefox add-on." },
  ],
};

// What each tier unlocks. Everything here is extra: nothing that is free today is locked.
export const PERKS = [
  { id: "badge", tier: "holder", title: "Holder badge on PnL cards", text: "Every PnL card you share shows you hold $HATCHR." },
  { id: "theme", tier: "holder", title: "Gold theme", text: "A gold look for the whole panel.", setting: "goldTheme" },
  { id: "votes", tier: "holder", title: "Feature votes", text: "Vote on what gets built next." },
  { id: "beta", tier: "holder", title: "Early access", text: "New features reach holders first." },
  { id: "card", tier: "gold", title: "Gold PnL card", text: "A gold share card that stands out on X.", setting: "goldCard" },
  { id: "weight", tier: "gold", title: "Double vote", text: "Your feature vote counts twice." },
];

const BASE58 = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;

/** Only well-formed values from the remote file are used; anything else falls back to the built-in default. */
export function normalizeConfig(raw) {
  const out = { ...TOKEN_DEFAULT };
  if (!raw || typeof raw !== "object") return out;
  if (typeof raw.mint === "string" && BASE58.test(raw.mint.trim())) out.mint = raw.mint.trim();
  if (Array.isArray(raw.tiers)) {
    const tiers = TOKEN_DEFAULT.tiers
      .map((d) => {
        const r = raw.tiers.find((x) => x && x.id === d.id);
        const min = Number(r?.min);
        return { ...d, min: Number.isFinite(min) && min > 0 ? min : d.min };
      })
      .sort((a, b) => a.min - b.min);
    if (tiers[0].id === "holder") out.tiers = tiers; // Gold must stay above Holder
  }
  if (Array.isArray(raw.votes)) {
    const votes = raw.votes
      .filter((v) => v && typeof v.id === "string" && typeof v.title === "string")
      .slice(0, 6)
      .map((v) => ({ id: v.id.slice(0, 24), title: v.title.slice(0, 60), text: String(v.text || "").slice(0, 140) }));
    if (votes.length) out.votes = votes;
  }
  return out;
}

/** The token file from hatchr.pro, cached for a few hours. Never throws: offline or missing means the default. */
export async function loadTokenConfig({ force = false, storage = chrome.storage.local, fetchImpl = fetch, now = Date.now() } = {}) {
  const { tokenConfig } = await storage.get("tokenConfig");
  const cached = tokenConfig ? normalizeConfig(tokenConfig.data) : null;
  if (!force && cached && now - tokenConfig.at < (cached.mint ? CONFIG_TTL_MS : PRELAUNCH_TTL_MS)) return cached;
  try {
    const res = await fetchImpl(TOKEN_CONFIG_URL, { cache: "no-store", signal: AbortSignal.timeout(6000) });
    if (!res.ok) throw new Error(`HTTP ${res.status}`);
    const data = await res.json();
    await storage.set({ tokenConfig: { at: now, data } });
    return normalizeConfig(data);
  } catch {
    return normalizeConfig(tokenConfig?.data);
  }
}

/** Highest tier reached with `amount`, or null. */
export function tierFor(amount, tiers = TOKEN_DEFAULT.tiers) {
  let hit = null;
  for (const tier of tiers) if (Number(amount) >= tier.min) hit = tier;
  return hit;
}

/** The next tier up and how far along the holder is: { tier, missing, progress 0..1 }, or null at the top. */
export function nextTier(amount, tiers = TOKEN_DEFAULT.tiers) {
  const a = Math.max(0, Number(amount) || 0);
  const next = tiers.find((tier) => a < tier.min);
  if (!next) return null;
  const prev = tierFor(a, tiers);
  const from = prev ? prev.min : 0;
  return { tier: next, missing: next.min - a, progress: Math.min(1, Math.max(0, (a - from) / (next.min - from))) };
}

/** True when `tier` (a tier object or null) covers the perk's tier. */
export function hasPerk(perk, tier, tiers = TOKEN_DEFAULT.tiers) {
  if (!tier) return false;
  const need = tiers.findIndex((x) => x.id === perk.tier);
  const have = tiers.findIndex((x) => x.id === tier.id);
  return need >= 0 && have >= need;
}

export function fmtAmount(n) {
  return Math.floor(Number(n) || 0).toLocaleString("en-US");
}
