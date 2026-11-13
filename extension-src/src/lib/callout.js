// Callouts: a short text a holder posts on pump.fun to tell their followers why they hold a coin.
// This file writes the texts. Sending is done by callout-client.js, the composer is callout-dialog.js.
import { chat } from "./aiclient.js";

export const CALLOUT_MAX = 2000; // pump.fun's own limit for a callout text
const EACH_MAX = 220;

// A callout may be excited, but it must not promise or predict money. pump.fun now pays callers by whether their
// followers profit, so a promise that doesn't come true costs the caller too.
const PROMISE = /\b(?:guarantee[ds]?|risk[- ]?free|can(?:'|’)?t lose|cannot lose|sure thing|easy money|free money|financial advice|price target|will (?:moon|pump|explode|fly|rip|print|run|send)|going to (?:moon|pump|explode|fly|rip|print|run)|get rich|millionaire|not (?:a )?rug|can(?:'|’)?t rug|safe (?:bet|play|buy))\b|\b\d+\s?x\b|\d+\s?%/i;

export const validMint = (m) => typeof m === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(m);

/** One callout text, tidied: one paragraph, no wrapping quotes, no hashtags, within the length limit. */
export function cleanCallout(text, max = EACH_MAX) {
  let s = String(text || "").replace(/\s+/g, " ").trim();
  s = s.replace(/^["'“”‘’`]+|["'“”‘’`]+$/g, "").trim();
  s = s.replace(/(^|\s)#\w+/g, "$1").replace(/\s+/g, " ").trim();
  if (s.length > max) {
    const cut = s.slice(0, max);
    const stop = Math.max(cut.lastIndexOf(". "), cut.lastIndexOf("! "), cut.lastIndexOf("? "));
    s = stop > max * 0.5 ? cut.slice(0, stop + 1) : cut.slice(0, cut.lastIndexOf(" ") > 0 ? cut.lastIndexOf(" ") : max).replace(/[,;:\s]+$/, "") + "…";
  }
  return s;
}

export const makesPromise = (text) => PROMISE.test(String(text || ""));

const snippet = (text, n = 90) => {
  const s = String(text || "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim();
  return s.length > n ? s.slice(0, s.lastIndexOf(" ", n) > 20 ? s.lastIndexOf(" ", n) : n).replace(/[,;:\s]+$/, "") + "…" : s;
};

/** Texts built from the coin's own facts, used when no AI is set up or the AI gave nothing usable. */
export function builtInCallouts(coin) {
  const tk = `$${coin.ticker || "?"}`, name = coin.name || coin.ticker || "this coin";
  const from = coin.handle && coin.handle !== "manual" ? `@${coin.handle}` : "";
  const quote = snippet(coin.postText);
  const out = [];
  if (from && quote) out.push(`Holding ${tk}. It's the ${name} coin from ${from}'s post: "${quote}"`);
  if (from) out.push(`${name} (${tk}) went live right after ${from} posted. I'm in and holding.`);
  if (coin.description && coin.description !== coin.postText) out.push(`${tk}: ${snippet(coin.description, 120)} I'm holding.`);
  out.push(`${tk} is my pick from today's timeline: ${name}. Early and small, and I'm holding. Do your own research.`);
  out.push(`Calling ${tk} (${name}). I hold it because the story behind it is easy to get and fun to share.`);
  return [...new Set(out.map((x) => cleanCallout(x)))].filter((x) => x && !makesPromise(x)).slice(0, 3);
}

const SYSTEM = `You write callouts for pump.fun. A callout is a short note a holder sends to their followers saying why they hold a memecoin.
Write 3 different callouts for the coin described by the user.
Rules:
- 1 or 2 sentences each, under 200 characters.
- Sound like a real trader talking to friends: energetic, confident, fun. Hype is fine.
- Say what the coin is about and why it is timely, using ONLY the facts given. Do not invent facts, news, partnerships or endorsements.
- Never promise or predict price, profit, multiples or percentages. No "100x", "guaranteed", "can't lose", "easy money", "will moon".
- No hashtags, no links, at most one emoji, no quotation marks around the whole text.
- Each of the 3 takes a different angle (the story, the timing, the meme).
Reply ONLY with JSON: {"callouts":["","",""]}`;

function describe(coin) {
  const lines = [`Coin: ${coin.name || "?"} ($${coin.ticker || "?"})`];
  if (coin.description) lines.push(`Description on the coin: ${snippet(coin.description, 200)}`);
  if (coin.postText) lines.push(`The post it was made from${coin.handle && coin.handle !== "manual" ? ` (by @${coin.handle})` : ""}: "${snippet(coin.postText, 400)}"`);
  if (coin.ageMin != null) lines.push(`Launched ${coin.ageMin < 60 ? `${Math.max(1, Math.round(coin.ageMin))} minutes` : `${Math.round(coin.ageMin / 60)} hours`} ago on pump.fun`);
  return lines.join("\n");
}

function parseCallouts(content) {
  const m = String(content || "").match(/\{[\s\S]*\}/);
  if (!m) return [];
  try {
    const j = JSON.parse(m[0]);
    return Array.isArray(j.callouts) ? j.callouts.filter((x) => typeof x === "string") : [];
  } catch { return []; }
}

/**
 * Three callout texts for a coin. Uses the AI the user set up; texts that promise money are thrown away and
 * replaced by built-in ones. Never throws. Returns { texts, by: "ai" | "built-in", error? }.
 */
export async function calloutTexts(settings, coin, { useAi = true } = {}) {
  const builtIn = builtInCallouts(coin);
  if (!useAi) return { texts: builtIn, by: "built-in" };
  let error = null;
  try {
    const r = await chat(settings, { model: settings.aiModel, system: SYSTEM, user: describe(coin), maxTokens: 400, temperature: 0.9, json: true });
    if (r.usage && settings.onAiUsage) settings.onAiUsage(settings.aiModel, r.usage);
    if (r.ok) {
      const texts = [...new Set(parseCallouts(r.content).map((x) => cleanCallout(x)))].filter((x) => x.length >= 12 && !makesPromise(x)).slice(0, 3);
      if (texts.length) return { texts: [...texts, ...builtIn].slice(0, 3), by: "ai" };
      error = "The AI gave no usable text";
    } else error = `AI error ${r.status}`;
  } catch (e) { error = String((e && e.message) || e); }
  return { texts: builtIn, by: "built-in", error };
}
