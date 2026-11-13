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
  if (from && quote) out.push(`${from}: "${quote}" and ${tk} was LIVE seconds later. yeah I aped 🔥`);
  if (from) out.push(`${from} posted, ${tk} dropped, I'M IN. ${name} is cooking rn LFG`);
  if (coin.description && coin.description !== coin.postText) out.push(`${tk} 👀 ${snippet(coin.description, 110)} aped a bag, no notes`);
  out.push(`${tk} JUST HIT MY RADAR AND I'M ALREADY IN. ${name} is too funny to fade 🔥`);
  out.push(`aped ${tk}. ${name}. that's it, that's the callout`);
  out.push(`${name} (${tk}) is cooking in the trenches rn and I got my bag. LFG`);
  return [...new Set(out.map((x) => cleanCallout(x)))].filter((x) => x && !makesPromise(x)).slice(0, 3);
}

const SYSTEM = `You write pump.fun callouts in the voice of a real trenches degen. A callout is a short note a holder blasts to their followers about a memecoin they hold.
Write 3 different callouts for the coin described by the user.
Voice:
- A real person typing fast on a phone. Not a brand, not an assistant, not a press release. Raw, loud, funny.
- Crypto-Twitter slang is welcome: aped, bags, cooking, LFG, send it, the trenches, CT, no way, bro, ngl, rn.
- Mix the energy: one mostly in CAPS, one lowercase and lazy, one in between. Short punches. Fragments are fine. 0 to 2 emojis each.
- Never formal. Do not use: "pick", "timeline", "do your own research", "the story behind it", "early and small", "exciting", "community", "utility", "potential", "project".
Rules:
- 1 or 2 short sentences each, under 160 characters.
- Use the coin's $TICKER once. Riff on what the coin is actually about, using ONLY the facts given. Do not invent facts, news, partnerships or endorsements.
- Never promise or predict price, profit, multiples or percentages. No "100x", "guaranteed", "can't lose", "easy money", "will moon", "not a rug".
- No hashtags, no links, no quotation marks around the whole text.
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
    // models that think first need room for the thinking, or the answer comes back empty
    const reasoning = /gpt-oss|qwen3|deepseek-r1|o\d|reason/i.test(settings.aiModel || "");
    const r = await chat(settings, { model: settings.aiModel, system: SYSTEM, user: describe(coin), maxTokens: reasoning ? 1200 : 500, temperature: 1, json: true, reasoning });
    if (r.usage && settings.onAiUsage) settings.onAiUsage(settings.aiModel, r.usage);
    if (r.ok) {
      const texts = [...new Set(parseCallouts(r.content).map((x) => cleanCallout(x)))].filter((x) => x.length >= 12 && !makesPromise(x)).slice(0, 3);
      if (texts.length) return { texts: [...texts, ...builtIn].slice(0, 3), by: "ai" };
      error = "The AI gave no usable text";
    } else error = `AI error ${r.status}`;
  } catch (e) { error = String((e && e.message) || e); }
  return { texts: builtIn, by: "built-in", error };
}
