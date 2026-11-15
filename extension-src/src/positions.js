/* Positions and automatic exits for the coins Hatchr buys by itself (CA buy, launch watch, copy trade).
   Each buy opens a position with the exit rules of the feature that bought it:
     take profit in up to three steps ("+100%: sell 50% of what is left"), stop loss, trailing stop (from the
     highest price since the buy), a market cap target, and a time limit.
   Prices: coins on the pump.fun bonding curve are read straight from the curve on your RPC every 2 seconds (one call
   for all of them, exact, no third party); coins that left the curve from DexScreener every 6 seconds, always from
   the same pool. A rule on a DexScreener price has to hold on two readings in a row; a curve price is on-chain
   truth and acts at once.
   In TEST mode the buyers send nothing, but a paper position is opened at the price of that moment, so you can see
   what your rules would have done.
   Not for coins Hatchr called out on pump.fun: automatic selling after a callout is the call-and-dump this app
   does not do. Those positions are shown, and you can still sell them by hand.
   Runs in the background next to background.js (globalThis.HatchrCore) and trade-routes.js (globalThis.HatchrRoutes). */
(() => {
  "use strict";
  if (globalThis.HatchrPositions) return;
  const STATE_KEY = "positions", ALARM = "positionsTick";
  const core = () => globalThis.HatchrCore;
  const R = () => globalThis.HatchrRoutes;
  const now = () => Date.now();
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const short = (e, n = 200) => String(e && e.message || e || "").slice(0, n);
  const USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

  // ---------- exit rules (each buyer keeps its own copy in its settings) ----------
  const num = (v, fallback = null) => { if (v === null || v === undefined || v === "" || typeof v === "boolean") return fallback; const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) && n > 0 ? n : fallback; };
  const EXITS = Object.freeze({ on: false, tp: Object.freeze([]), sl: null, trail: null, mcUsd: null, mcSell: 100, afterMin: null, slippage: 25, priorityFee: 0.0005, boost: false });
  function cleanExits(input) {
    const x = input && typeof input === "object" ? input : {};
    const tp = (Array.isArray(x.tp) ? x.tp : []).map(s => ({ up: num(s && s.up), sell: Math.min(100, num(s && s.sell, 100)) })).filter(s => s.up).slice(0, 3).sort((a, b) => a.up - b.up);
    return {
      on: x.on === true,
      tp,
      sl: num(x.sl) !== null ? Math.min(99, num(x.sl)) : null,
      trail: num(x.trail) !== null ? Math.min(99, num(x.trail)) : null,
      mcUsd: num(x.mcUsd),
      mcSell: Math.min(100, num(x.mcSell, 100)),
      afterMin: num(x.afterMin),
      slippage: num(x.slippage, EXITS.slippage),
      priorityFee: num(x.priorityFee, EXITS.priorityFee),
      boost: x.boost === true
    };
  }
  const hasRules = x => !!(x && x.on && (x.tp.length || x.sl || x.trail || x.mcUsd || x.afterMin));
  function describe(x) {
    if (!hasRules(x)) return "no automatic exits";
    const parts = [...x.tp.map(s => `+${s.up}%: sell ${s.sell}%`)];
    if (x.sl) parts.push(`stop loss -${x.sl}%`);
    if (x.trail) parts.push(`trailing ${x.trail}% from the top`);
    if (x.mcUsd) parts.push(`market cap $${Math.round(x.mcUsd).toLocaleString("en-US")}: sell ${x.mcSell}%`);
    if (x.afterMin) parts.push(`after ${x.afterMin} min: sell all`);
    return parts.join(", ");
  }

  // ---------- state ----------
  let st = { list: [], log: [] }, ready = false;
  let saveTimer = null;
  let savedAt = 0;
  function save() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; savedAt = now(); chrome.storage.local.set({ [STATE_KEY]: { list: st.list, log: st.log, at: now() } }).catch(() => {}); }, 400); }
  function log(kind, text, extra = {}) {
    st.log.unshift({ at: now(), kind, text: String(text).slice(0, 400), ...extra });
    if (st.log.length > 80) st.log.length = 80;
    save();
  }
  const label = p => p.ticker ? "$" + p.ticker : `${p.mint.slice(0, 6)}…`;
  const openOnes = () => st.list.filter(p => p.status === "open");

  // A buyer reports a buy. tokens: what arrived in the wallet (null for a TEST buy: the price of the moment decides).
  function open(o) {
    if (!o || typeof o.mint !== "string") return;
    const exits = cleanExits(o.exits);
    let p = st.list.find(x => x.mint === o.mint && x.status === "open" && !!x.paper === !!o.paper);
    if (p) { // bought more of the same coin: one position, the cost adds up and the entry price is the average
      p.costSol += Number(o.costSol) || 0;
      p.tokens = p.tokens !== null && o.tokens !== null ? p.tokens + (Number(o.tokens) || 0) : null;
      if (p.tokens > 0) p.entry = p.costSol / p.tokens;
      p.calledOut = p.calledOut || !!o.calledOut;
    } else {
      p = { id: `${now()}-${o.mint.slice(0, 6)}`, mint: o.mint, ticker: String(o.ticker || "").slice(0, 20), source: String(o.source || "Hatchr").slice(0, 30), by: String(o.by || "").slice(0, 40),
        costSol: Number(o.costSol) || 0, tokens: o.tokens === null || o.tokens === undefined ? null : Number(o.tokens), paper: !!o.paper, calledOut: !!o.calledOut,
        exits, openedAt: now(), status: "open", price: null, high: null, mcUsd: null, priceAt: 0, done: [], pending: null, fails: 0, nextTry: 0, selling: false, src: "" };
      // the price paid per coin: every rule measures from it (selling part of the position does not move it)
      p.entry = p.tokens > 0 && p.costSol > 0 ? p.costSol / p.tokens : null;
      st.list.unshift(p);
      if (st.list.length > 200) st.list = st.list.filter((x, i) => x.status === "open" || i < 150);
    }
    const why = p.calledOut ? " Called out on pump.fun: no automatic exits (you can still sell it here by hand)." : "";
    log(p.paper ? "test" : "open", `${p.paper ? "TEST position" : "Position"}: ${label(p)} from ${p.source}${p.by ? ` (${p.by})` : ""}, ${p.costSol} SOL. ${p.calledOut ? "" : describe(p.exits) + "."}${why}`, { mint: p.mint });
    start();
    save();
  }

  // ---------- prices ----------
  // curve: [vTokens @8, vQuote @16, complete @48, quote mint @83]
  const u64 = (b, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(b[o + i]); return v; };
  let solUsd = 0, solAt = 0;
  async function sol() {
    if (now() - solAt > 60000) { try { const r = await core().solPrice(); if (r && r.usd > 0) { solUsd = r.usd; solAt = now(); } } catch { /* keeps the last */ } }
    return solUsd;
  }
  async function fromCurves(list, rpcUrl) {
    const out = new Map();
    const PK = core().PublicKey, program = new PK(R().PUMP_PROGRAM);
    const keys = list.map(p => PK.findProgramAddressSync([new TextEncoder().encode("bonding-curve"), new PK(p.mint).toBytes()], program)[0].toBase58());
    for (let i = 0; i < keys.length; i += 100) {
      const got = await core().rpc(rpcUrl, "getMultipleAccounts", [keys.slice(i, i + 100), { encoding: "base64", commitment: "processed", dataSlice: { offset: 0, length: 115 } }]);
      (got && got.value || []).forEach((acc, j) => {
        const p = list[i + j];
        if (!acc || !acc.data) return out.set(p.mint, { gone: true });
        const b = Uint8Array.from(atob(acc.data[0]), c => c.charCodeAt(0));
        if (b.length < 49) return;
        if (b[48]) return out.set(p.mint, { gone: true }); // complete: it left the curve
        const vTok = Number(u64(b, 8)) / 1e6, vQuote = Number(u64(b, 16));
        const quote = b.length >= 115 && b.subarray(83, 115).some(x => x) ? R().base58(b.subarray(83, 115)) : "";
        if (!(vTok > 0) || !(vQuote > 0)) return;
        if (!quote || quote === R().SOL) out.set(p.mint, { sol: vQuote / 1e9 / vTok, src: "curve" });
        else if (quote === USDC && solUsd > 0) out.set(p.mint, { sol: vQuote / 1e6 / vTok / solUsd, src: "curve" });
        else out.set(p.mint, { gone: true }); // priced in another coin: DexScreener does the sum
      });
    }
    return out;
  }
  let dexAt = 0;
  async function fromDex(list) {
    const out = new Map();
    if (!list.length || now() - dexAt < 6000 || !(solUsd > 0)) return out;
    dexAt = now();
    for (let i = 0; i < list.length; i += 30) {
      const part = list.slice(i, i + 30);
      const response = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${part.map(p => p.mint).join(",")}`, { headers: { accept: "application/json" } });
      if (!response.ok) continue;
      const pairs = await response.json().catch(() => []);
      for (const p of part) {
        const mine = (Array.isArray(pairs) ? pairs : []).filter(x => x && x.baseToken && x.baseToken.address === p.mint && Number(x.priceUsd) > 0);
        if (!mine.length) continue;
        const want = p.src.startsWith("dex:") ? p.src.slice(4) : "";
        const pair = mine.find(x => x.pairAddress === want) || mine.sort((a, b) => (Number(b.liquidity && b.liquidity.usd) || 0) - (Number(a.liquidity && a.liquidity.usd) || 0))[0];
        if (want && pair.pairAddress !== want && (p.away = (p.away || 0) + 1) < 4) continue; // its own pool is missing from this answer: wait
        p.away = 0;
        out.set(p.mint, { sol: Number(pair.priceUsd) / solUsd, mcUsd: Number(pair.marketCap || pair.fdv) || 0, src: `dex:${pair.pairAddress || ""}`, ticker: pair.baseToken.symbol || "" });
      }
    }
    return out;
  }

  // ---------- the rules ----------
  // Returns the sell to make now, or null. Pure apart from the marks it keeps on the position (pending, high).
  function judge(p, reading, at) {
    const price = reading.sol;
    if (p.src !== reading.src) { p.pending = null; if (p.src && !p.src.startsWith("curve")) p.high = price; } // a new source: no comparing across sources
    p.src = reading.src;
    p.price = price; p.priceAt = at;
    if (reading.mcUsd) p.mcUsd = reading.mcUsd; else if (solUsd > 0) p.mcUsd = price * solUsd * 1e9;
    if (p.tokens === null && p.paper) { p.tokens = p.costSol / price; p.entry = price; } // a TEST position starts at the price of this moment
    if (!(p.tokens > 0) || !(p.entry > 0)) return null;
    p.high = Math.max(p.high || 0, price);
    if (p.calledOut || !hasRules(p.exits)) return null;
    const x = p.exits, gain = (price / p.entry - 1) * 100;
    let rule = null;
    if (x.sl && gain <= -x.sl) rule = { why: `stop loss (${Math.round(gain)}%)`, pct: 100, key: "sl" };
    else if (x.trail && p.high > p.entry && price <= p.high * (1 - x.trail / 100)) rule = { why: `trailing stop (${Math.round((1 - price / p.high) * 100)}% under the top)`, pct: 100, key: "trail" };
    else if (x.afterMin && at - p.openedAt >= x.afterMin * 60000) rule = { why: `${x.afterMin} minutes are up`, pct: 100, key: "time" };
    else {
      const step = x.tp.findIndex((s, i) => !p.done.includes(`tp${i}`) && gain >= s.up);
      if (step >= 0) rule = { why: `take profit +${x.tp[step].up}% (now ${gain >= 0 ? "+" : ""}${Math.round(gain)}%)`, pct: x.tp[step].sell, key: `tp${step}` };
      else if (x.mcUsd && !p.done.includes("mc") && p.mcUsd >= x.mcUsd) rule = { why: `market cap $${Math.round(p.mcUsd).toLocaleString("en-US")}`, pct: x.mcSell, key: "mc" };
    }
    if (!rule) { p.pending = null; return null; }
    // a DexScreener price has to say it twice; the curve is exact
    if (!reading.src.startsWith("curve") && (!p.pending || p.pending.key !== rule.key || at - p.pending.at > 60000)) { p.pending = { key: rule.key, at }; return null; }
    p.pending = null;
    return rule;
  }

  // ---------- selling ----------
  const hot = { keypair: null, pub: "", rpcUrl: "", dryRun: true, at: 0 };
  async function reload() {
    try {
      const C = core(), { settings } = await chrome.storage.local.get("settings");
      hot.rpcUrl = String(settings && settings.rpcUrl || (await C.settings()).rpcUrl || "");
      hot.dryRun = !settings || settings.dryRun !== false;
      const secret = await C.secret();
      hot.keypair = secret ? C.keypair(secret) : null;
      hot.pub = hot.keypair ? hot.keypair.publicKey.toBase58() : "";
      hot.at = now();
    } catch { /* keeps what it had */ }
  }
  async function sell(p, pct, why, manual) {
    if (p.selling) return;
    p.selling = true;
    const share = Math.max(1, Math.min(100, Math.round(pct)));
    try {
      if (p.paper) {
        const value = p.price ? p.price * p.tokens * share / 100 : 0;
        p.tokens = share >= 100 ? 0 : p.tokens * (1 - share / 100);
        p.soldSol = (p.soldSol || 0) + value;
        log("test", `TEST: would sell ${share}% of ${label(p)} (${why}), worth about ${value.toFixed(4)} SOL.`, { mint: p.mint });
      } else {
        if (now() - hot.at > 60000) await reload();
        if (!hot.keypair) throw new Error("no Hatchr wallet");
        const fee = p.exits.boost ? (await R().feeEstimate(hot.rpcUrl)).fee : p.exits.priorityFee;
        const before = await core().tokenBalance(hot.rpcUrl, hot.pub, p.mint).catch(() => null);
        if (before && !(before.ui > 0)) { p.tokens = 0; p.status = "closed"; p.closedAt = now(); log("close", `${label(p)}: none left in the wallet; position closed.`, { mint: p.mint }); return; }
        const made = await R().sell(p.mint, hot.keypair, hot.rpcUrl, { pub: hot.pub, pct: share, raw: before && before.raw, slippage: p.exits.boost ? R().BOOST_SLIPPAGE.sell : p.exits.slippage, priorityFee: fee });
        const signature = await core().send(hot.rpcUrl, made.tx, true);
        log("sell", `Sold ${share}% of ${label(p)} (${why}) through ${made.route}.`, { mint: p.mint, signature });
        try { globalThis.HatchrPush && globalThis.HatchrPush.event(`💰 ${manual ? "Sold" : "Exit"}: ${share}% of ${label(p)}, ${why}.\nhttps://pump.fun/coin/${p.mint}`); } catch { /* bonus */ }
        const failed = await core().confirm(hot.rpcUrl, signature, 45000).then(() => "", e => R().explain(short(e, 300)));
        const after = await core().tokenBalance(hot.rpcUrl, hot.pub, p.mint).catch(() => null);
        // a confirmation that timed out can still have landed: the wallet decides (so a step is never sold twice)
        if (failed && !(after && before && after.ui < before.ui * 0.99)) throw new Error(`the sell did not go through: ${failed}`);
        if (after) p.tokens = after.ui;
      }
      p.fails = 0;
      if (!(p.tokens > 0) || share >= 100) { p.tokens = 0; p.status = "closed"; p.closedAt = now(); }
      return true;
    } catch (e) {
      p.fails++; p.nextTry = now() + Math.min(60000, 5000 * p.fails);
      log("error", `Selling ${share}% of ${label(p)} (${why}) failed: ${short(e, 260)}${p.fails >= 5 ? " Automatic exits for this coin are paused; sell it by hand." : ""}`, { mint: p.mint });
      if (p.fails >= 5) p.paused = true;
      return false;
    } finally { p.selling = false; save(); }
  }

  // ---------- the loop: only while there are open positions ----------
  let timer = null, ticking = false;
  function start() {
    if (!ready || timer || !openOnes().length) return;
    timer = setInterval(() => tick().catch(() => {}), 2000);
    try { chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); } catch { /* the interval still runs */ }
    tick().catch(() => {});
  }
  function stop() { clearInterval(timer); timer = null; try { chrome.alarms.clear(ALARM); } catch { /* none */ } }
  async function tick() {
    if (ticking) return;
    const list = openOnes();
    if (!list.length) return stop();
    ticking = true;
    try {
      if (!hot.rpcUrl || now() - hot.at > 120000) await reload();
      await sol();
      const curve = list.filter(p => /pump$/.test(p.mint) && !p.offCurve), at = now();
      let prices = new Map();
      if (curve.length && hot.rpcUrl) { try { prices = await fromCurves(curve, hot.rpcUrl); } catch { /* next round */ } }
      for (const [mint, r] of prices) if (r.gone) { const p = list.find(x => x.mint === mint); if (p) p.offCurve = true; prices.delete(mint); }
      const rest = list.filter(p => !prices.has(p.mint));
      if (rest.length) { try { for (const [m, r] of await fromDex(rest)) prices.set(m, r); } catch { /* next round */ } }
      for (const p of list) {
        const r = prices.get(p.mint);
        if (!r) continue;
        if (r.ticker && !p.ticker) p.ticker = r.ticker;
        const rule = judge(p, r, at);
        if (rule && !p.paused && !p.selling && now() >= p.nextTry) {
          p.done.push(rule.key);
          sell(p, rule.pct, rule.why, false).then(ok => { if (!ok) p.done = p.done.filter(k => k !== rule.key); });
        }
      }
      // prices alone are written every 10 s (the panel asks for live ones while the Positions page is open)
      if (now() - savedAt > 10000) save();
    } finally { ticking = false; }
  }

  // ---------- start-up and messages ----------
  async function init() {
    for (let i = 0; i < 100 && !(core() && R()); i++) await wait(50);
    if (!core() || !R()) return;
    try {
      const got = (await chrome.storage.local.get(STATE_KEY))[STATE_KEY];
      if (got && typeof got === "object") st = { list: Array.isArray(got.list) ? got.list.map(p => ({ ...p, selling: false, exits: cleanExits(p.exits), entry: p.entry || (p.tokens > 0 ? p.costSol / p.tokens : null) })) : [], log: Array.isArray(got.log) ? got.log : [] };
    } catch { /* fresh */ }
    ready = true;
    await reload();
    start();
  }
  try {
    chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM && ready) { start(); tick().catch(() => {}); } });
    chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && ready && (changes.settings || changes.walletSecret)) reload().catch(() => {}); });
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      const type = message && message.type;
      if (!["posGet", "posSell", "posForget", "posClearLog", "posExits"].includes(type)) return false;
      if (sender?.id !== chrome.runtime.id || sender?.url !== chrome.runtime.getURL("sidepanel.html")) { respond({ ok: false, error: "Not allowed from here" }); return false; }
      (async () => {
        for (let i = 0; i < 60 && !ready; i++) await wait(50);
        const p = message.mint ? st.list.find(x => x.mint === message.mint && x.status === "open" && (message.paper === undefined || !!x.paper === !!message.paper)) : null;
        if (type === "posSell") { if (!p) throw new Error("No open position for that coin"); await sell(p, Number(message.pct) || 100, "sold by hand", true); }
        else if (type === "posForget") { if (p) { p.status = "closed"; p.closedAt = now(); p.forgotten = true; } else st.list = st.list.filter(x => x.mint !== message.mint || x.status === "open"); save(); }
        else if (type === "posExits") { if (!p) throw new Error("No open position for that coin"); p.exits = cleanExits(message.exits); p.paused = false; p.fails = 0; p.done = []; save(); }
        else if (type === "posClearLog") { st.log = []; st.list = st.list.filter(x => x.status === "open"); save(); }
        return { list: st.list.slice(0, 60), log: st.log, test: hot.dryRun, solUsd, at: now() };
      })().then(data => respond({ ok: true, data }), e => respond({ ok: false, error: short(e) }));
      return true;
    });
  } catch (e) { console.warn("positions listeners", e); }

  // Something else sold part of a position (copy trade following a sell): keep the amount right.
  function sold(mint, pct, paper) {
    const p = st.list.find(x => x.mint === mint && x.status === "open" && !!x.paper === !!paper);
    if (!p) return;
    if (paper) { p.tokens = pct >= 100 ? 0 : (p.tokens || 0) * (1 - pct / 100); if (!(p.tokens > 0)) { p.status = "closed"; p.closedAt = now(); } save(); return; }
    setTimeout(async () => {
      const after = await core().tokenBalance(hot.rpcUrl, hot.pub, mint).catch(() => null);
      if (after) { p.tokens = after.ui; if (!(after.ui > 0)) { p.status = "closed"; p.closedAt = now(); } save(); }
    }, 4000);
  }

  globalThis.HatchrPositions = Object.freeze({ open, sold, cleanExits, describe, judge, hasRules, EXITS });
  init();
})();
