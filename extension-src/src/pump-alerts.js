/* Pump alerts: tells you when a coin you hold jumps, so a pump is not missed while you are not looking.
   Every 20 seconds the prices of the coins in your wallet are read (one request to DexScreener for up to 30 coins;
   coins too new for DexScreener are read from their bonding curve on-chain). Two rules, each optional:
     - "up X% since Hatchr started watching it" (after an alert the mark moves up, so the next X% alerts again), and
     - "up Y% within Z minutes" (the sudden kind).
   An alert is a desktop notification, a sound, a line in the list, and, when set up, a message to your phone
   through your own Telegram bot (works on iPhone and Android; nothing passes through any Hatchr server).
   Runs in the background next to background.js, which hands over what it needs as globalThis.HatchrCore. */
(() => {
  "use strict";
  if (globalThis.HatchrPumpAlerts) return;
  const CONFIG_KEY = "pumpAlerts", STATE_KEY = "pumpAlertsState", ALARM = "pumpAlertsTick";
  const core = () => globalThis.HatchrCore;
  const now = () => Date.now();
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const short = (e, n = 200) => String(e && e.message || e || "").slice(0, n);

  // ---------- settings ----------
  const DEFAULTS = Object.freeze({
    enabled: false,
    risePct: 50,        // alert when a coin is up this much since the mark (empty = rule off)
    fastPct: 30,        // alert when a coin is up this much…
    fastMin: 5,         // …within this many minutes (either empty = rule off)
    minValueUsd: 0,     // ignore coins whose holding is worth less than this
    skipHidden: true,   // coins hidden on the Callouts tab are not watched
    desktop: true,      // desktop notification
    sound: true,
    tgOn: false,        // send to the phone through Telegram
    tgToken: "",        // your bot's token from @BotFather
    tgChat: "",         // the chat the bot writes to (found by "Connect")
    tgEvents: true      // also send CA buys and automatic callouts to the phone
  });
  const opt = v => { if (v === null || v === undefined || v === "" || typeof v === "boolean") return null; const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) && n > 0 ? n : null; };
  function clean(input) {
    const c = input && typeof input === "object" ? input : {};
    return {
      enabled: c.enabled === true,
      risePct: "risePct" in c ? opt(c.risePct) : DEFAULTS.risePct,
      fastPct: "fastPct" in c ? opt(c.fastPct) : DEFAULTS.fastPct,
      fastMin: "fastMin" in c ? opt(c.fastMin) : DEFAULTS.fastMin,
      minValueUsd: opt(c.minValueUsd) || 0,
      skipHidden: c.skipHidden !== false,
      desktop: c.desktop !== false,
      sound: c.sound !== false,
      tgOn: c.tgOn === true,
      tgToken: typeof c.tgToken === "string" && /^\d{5,}:[\w-]{20,}$/.test(c.tgToken.trim()) ? c.tgToken.trim() : "",
      tgChat: /^-?\d{3,}$/.test(String(c.tgChat ?? "").trim()) ? String(c.tgChat).trim() : "",
      tgEvents: c.tgEvents !== false
    };
  }

  // ---------- phone (Telegram) ----------
  async function telegram(method, body, token = cfg.tgToken) {
    if (!token) throw new Error("No Telegram bot token yet.");
    const response = await fetch(`https://api.telegram.org/bot${token}/${method}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body || {}) });
    const data = await response.json().catch(() => null);
    if (!data || !data.ok) throw new Error(data && data.description ? `Telegram: ${data.description}` : `Telegram answered ${response.status}`);
    return data.result;
  }
  async function push(text) {
    if (!cfg.tgOn || !cfg.tgToken || !cfg.tgChat) return false;
    try { await telegram("sendMessage", { chat_id: cfg.tgChat, text: String(text).slice(0, 3500), disable_web_page_preview: true }); st.pushError = ""; return true; }
    catch (e) { st.pushError = short(e); save(); return false; }
  }
  // The chat to write to: whoever last wrote to the bot (you, after pressing Start in Telegram).
  async function findChat(token) {
    const me = await telegram("getMe", {}, token);
    const updates = await telegram("getUpdates", { limit: 20, allowed_updates: ["message"] }, token);
    const last = [...(updates || [])].reverse().find(u => u.message && u.message.chat && u.message.chat.id);
    if (!last) throw new Error(`Open Telegram, find @${me.username}, press Start (or send it any message), then press Connect again.`);
    return { chat: String(last.message.chat.id), bot: me.username, who: last.message.chat.username || last.message.chat.first_name || "" };
  }

  // ---------- state ----------
  let cfg = clean(null), ready = false, timer = null, polling = false;
  let st = { coins: {}, log: [], at: 0, error: "", pushError: "", watched: 0 };
  let saveTimer = null;
  function save() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; chrome.storage.local.set({ [STATE_KEY]: st }).catch(() => {}); }, 400); }

  // ---------- prices ----------
  const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", WSOL = "So11111111111111111111111111111111111111112", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  async function dexPairs(mints) {
    const all = [];
    for (let i = 0; i < mints.length; i += 30) {
      const response = await fetch(`https://api.dexscreener.com/tokens/v1/solana/${mints.slice(i, i + 30).join(",")}`, { headers: { accept: "application/json" } });
      if (!response.ok) throw new Error(`DexScreener answered ${response.status}`);
      const pairs = await response.json();
      if (Array.isArray(pairs)) all.push(...pairs);
    }
    return all;
  }
  // One price per coin, always from the same place. Before 3.7.4 a coin's price could come from one pool in one reading
  // and from another pool (or from the bonding curve) in the next; a coin that did not move at all then looked like it
  // jumped 50–90%. Now the pool a coin was first priced from is kept (src), and a different source starts a new mark
  // instead of being compared with the old one.
  // pinned: mint -> the source used last time ("dex:<pair>", "via:<pair>" or "curve")
  async function fromDexScreener(mints, pinned = new Map()) {
    const out = new Map(), byMint = new Map();
    for (const pair of await dexPairs(mints)) {
      const mint = pair && pair.baseToken && pair.baseToken.address;
      if (mint && mints.includes(mint)) (byMint.get(mint) || byMint.set(mint, []).get(mint)).push(pair);
    }
    const txns = (pair, k) => { const t = pair.txns && pair.txns[k]; return t && typeof t === "object" ? (Number(t.buys) || 0) + (Number(t.sells) || 0) : null; };
    const depth = pair => [Number(pair.liquidity && pair.liquidity.usd) || 0, Number(pair.volume && pair.volume.h24) || 0];
    const pick = (pairs, want) => pairs.find(p => want && p.pairAddress === want) || [...pairs].sort((x, y) => { const [a1, a2] = depth(x), [b1, b2] = depth(y); return b1 - a1 || b2 - a2; })[0];
    const info = (pair, price, src) => ({ price, src, liq: depth(pair)[0], mc: Number(pair.marketCap || pair.fdv) || price * 1e9, name: pair.baseToken.name || "", ticker: pair.baseToken.symbol || "",
      trades5: txns(pair, "m5"), trades60: txns(pair, "h1") });
    const indirect = new Map();
    for (const [mint, pairs] of byMint) {
      const was = String(pinned.get(mint) || ""), wantPair = was.replace(/^(dex|via):/, "");
      const direct = pairs.filter(p => Number(p.priceUsd) > 0), viaOther = pairs.filter(p => !(Number(p.priceUsd) > 0) && Number(p.priceNative) > 0 && p.quoteToken && p.quoteToken.address);
      // stay with the kind of price this coin had (a direct dollar price, or one through the coin it is paired with)
      if (direct.length && !(was.startsWith("via:") && viaOther.some(p => p.pairAddress === wantPair))) {
        const pair = pick(direct, wantPair);
        out.set(mint, info(pair, Number(pair.priceUsd), `dex:${pair.pairAddress || ""}`));
      } else if (viaOther.length) indirect.set(mint, pick(viaOther, wantPair));
      // its own pool is missing from this answer: this reading is skipped (poll moves to another pool only if it stays away)
      if (wantPair && !pairs.some(p => p.pairAddress === wantPair) && out.has(mint)) out.get(mint).away = true;
    }
    if (indirect.size) { // a coin paired with another coin: its price in that coin × that coin's dollar price
      const quotes = new Map();
      try {
        const qMints = [...new Set([...indirect.values()].map(p => p.quoteToken.address))];
        const qPairs = new Map();
        for (const pair of await dexPairs(qMints)) { const m = pair && pair.baseToken && pair.baseToken.address; if (m && Number(pair.priceUsd) > 0) (qPairs.get(m) || qPairs.set(m, []).get(m)).push(pair); }
        for (const [m, list] of qPairs) quotes.set(m, Number(pick(list, "").priceUsd));
      } catch { /* those coins get a price next round */ }
      for (const [mint, pair] of indirect) {
        const q = quotes.get(pair.quoteToken.address);
        if (q > 0) out.set(mint, { ...info(pair, Number(pair.priceNative) * q, `via:${pair.pairAddress || ""}`), away: !!pinned.get(mint) && pinned.get(mint) !== `via:${pair.pairAddress || ""}` && pinned.get(mint) !== `dex:${pair.pairAddress || ""}` });
      }
    }
    return out;
  }
  function u64(bytes, o) { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[o + i]); return Number(v); }
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function b58(bytes) { let n = 0n, out = ""; for (const b of bytes) n = (n << 8n) | BigInt(b); while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; } for (const b of bytes) { if (b !== 0) break; out = "1" + out; } return out; }
  // Coins DexScreener does not list yet: straight from the pump.fun bonding curve.
  async function fromCurves(mints, rpcUrl) {
    const out = new Map(), C = core();
    if (!mints.length || !rpcUrl) return out;
    const PK = C.PublicKey, curves = [];
    for (const mint of mints) { try { curves.push([mint, PK.findProgramAddressSync([new TextEncoder().encode("bonding-curve"), new PK(mint).toBytes()], new PK(PUMP_PROGRAM))[0].toBase58()]); } catch { /* not a pump.fun coin */ } }
    if (!curves.length) return out;
    const sol = (await C.solPrice().catch(() => null) || {}).usd || 0;
    const got = await C.rpc(rpcUrl, "getMultipleAccounts", [curves.slice(0, 100).map(c => c[1]), { encoding: "base64", commitment: "confirmed" }]);
    (got && got.value || []).forEach((account, i) => {
      const b64 = account && account.data && account.data[0];
      if (!b64) return;
      const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
      if (bytes.length < 49 || bytes[48] === 1) return; // left the curve: this number would be stale
      const vTokens = u64(bytes, 8) / 1e6, vQuote = u64(bytes, 16);
      if (!(vTokens > 0) || !(vQuote > 0)) return;
      const quote = bytes.length >= 115 && bytes.subarray(83, 115).some(b => b !== 0) ? b58(bytes.subarray(83, 115)) : WSOL;
      const price = quote === WSOL ? (sol > 0 ? vQuote / 1e9 / vTokens * sol : 0) : quote === USDC ? vQuote / 1e6 / vTokens : 0;
      if (price > 0) out.set(curves[i][0], { price, liq: 0, mc: price * 1e9, name: "", ticker: "", src: "curve", trades5: null, trades60: null });
    });
    return out;
  }

  // ---------- what you hold ----------
  let scanAt = 0;
  async function holdings() {
    // The wallet list is refreshed every 2 minutes, so coins bought while the panel is closed are watched too.
    if (now() - scanAt > 120000) {
      scanAt = now();
      try { const A = globalThis.HatchrCalloutAuto; await (A && A.scanHeld ? A.scanHeld(core().scanHeld) : core().scanHeld()); } catch { /* the stored list is used */ }
    }
    const { heldCoins = [], deploys = [], coHidden = [] } = await chrome.storage.local.get(["heldCoins", "deploys", "coHidden"]);
    const hidden = cfg.skipHidden ? new Set(coHidden) : new Set(), out = new Map();
    for (const c of heldCoins) if (c && c.mint && !hidden.has(c.mint)) out.set(c.mint, { mint: c.mint, amount: Number(c.amount) || 0, name: c.name || "", ticker: c.ticker || "" });
    for (const d of deploys) if (d && d.mint && d.ok && !d.dryRun && !d.sold && !hidden.has(d.mint) && !out.has(d.mint)) out.set(d.mint, { mint: d.mint, amount: 0, name: d.name || "", ticker: d.ticker || "" });
    return [...out.values()].slice(0, 120);
  }

  // ---------- the rules ----------
  const pct = (a, b) => (a / b - 1) * 100;
  const money = v => v >= 1 ? `$${v.toLocaleString("en-US", { maximumFractionDigits: 2 })}` : `$${Number(v.toPrecision(3))}`;
  const big = v => v >= 1e6 ? `$${(v / 1e6).toFixed(2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(1)}K` : `$${Math.round(v)}`;
  const clock = t => new Date(t).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  // One coin, one fresh price. Returns the alert to send, or null. Pure: easy to test.
  // info: { src, trades5, trades60 } from the price reading (trades: DexScreener's count of trades, null = unknown)
  function judge(rec, price, at, rules, info = {}) {
    const src = info.src || "";
    if (!rec.ref || (rec.src || "") !== src) { // first reading, or a price from somewhere else: a new mark, nothing to compare
      rec.ref = price; rec.refAt = at; rec.samples = [[at, price]]; rec.src = src; rec.fastAt = 0; rec.pending = null; rec.last = price; rec.lastAt = at;
      return null;
    }
    rec.samples.push([at, price]);
    const keep = Math.max(60, (rules.fastMin || 0) * 60 + 60) * 1000;
    while (rec.samples.length > 2 && at - rec.samples[0][0] > keep) rec.samples.shift();
    rec.last = price; rec.lastAt = at;
    let fast = null, rise = null;
    if (rules.fastPct && rules.fastMin) {
      const since = at - rules.fastMin * 60000;
      const base = rec.samples.filter(s => s[0] >= since && (!rec.fastAt || s[0] > rec.fastAt)).reduce((min, s) => Math.min(min, s[1]), Infinity); // the low of the window, since the last sudden-move alert
      if (base < Infinity && pct(price, base) >= rules.fastPct) fast = { kind: "fast", up: pct(price, base), minutes: rules.fastMin };
    }
    if (rules.risePct && pct(price, rec.ref) >= rules.risePct) rise = { kind: "rise", up: pct(price, rec.ref), since: rec.refAt };
    // a price can only really move when the coin is traded: no trades in the window = no alert
    const traded = rules.fastMin && rules.fastMin <= 5 ? info.trades5 : info.trades60;
    if (fast && traded === 0) fast = null;
    if (rise && info.trades60 === 0) rise = null;
    if (!fast && !rise) { rec.pending = null; return null; }
    // and it has to show on two readings in a row, so one odd price never alerts
    if (!rec.pending || at - rec.pending > 90000) { rec.pending = at; return null; }
    rec.pending = null;
    if (fast) rec.fastAt = at;
    if (rise) { rec.ref = price; rec.refAt = at; } // the mark moves up: the next X% from here alerts again
    return rise ? { ...rise, also: fast } : fast; // the bigger story wins; a sudden move in the same reading is mentioned with it
  }
  async function poll() {
    if (polling || !ready || !cfg.enabled) return;
    polling = true;
    try {
      const settings = await core().settings(); // pump alerts have their own switch; the Feed's switch does not stop them
      const held = await holdings();
      st.watched = held.length;
      if (!held.length) { st.coins = {}; st.at = now(); st.error = ""; return save(); } // nothing held: nothing remembered
      const mints = held.map(h => h.mint);
      let prices = new Map(), problem = "";
      const pinned = new Map(mints.map(m => [m, st.coins[m] && st.coins[m].src]));
      try { prices = await fromDexScreener(mints, pinned); } catch (e) { problem = short(e); }
      // the bonding curve only for coins DexScreener has never priced: one that is just missing from this answer waits
      const missing = mints.filter(m => !prices.has(m) && /pump$/.test(m) && !/^(dex|via):/.test(String(pinned.get(m) || "")));
      if (missing.length) { try { for (const [m, p] of await fromCurves(missing, settings.rpcUrl)) prices.set(m, p); } catch (e) { problem = problem || short(e); } }
      st.error = prices.size ? "" : problem || "No prices could be read.";
      const at = now();
      for (const coin of held) {
        const p = prices.get(coin.mint);
        if (!p) continue;
        const rec = st.coins[coin.mint] = st.coins[coin.mint] || {};
        // the pool this coin is priced from was not in DexScreener's answer: skip the reading; after 2 minutes, move on
        if (p.away && rec.src) { rec.away = (rec.away || 0) + 1; if (rec.away < 6) continue; }
        rec.away = 0;
        rec.name = coin.name || p.name || rec.name || ""; rec.ticker = coin.ticker || p.ticker || rec.ticker || "";
        rec.value = coin.amount > 0 ? coin.amount * p.price : null; rec.mc = p.mc;
        const alert = judge(rec, p.price, at, cfg, p);
        if (alert && !(cfg.minValueUsd > 0 && rec.value !== null && rec.value < cfg.minValueUsd)) fire(coin.mint, rec, alert, settings);
      }
      for (const mint of Object.keys(st.coins)) if (!mints.includes(mint)) delete st.coins[mint]; // sold: forgotten, so buying it again starts a fresh mark
      st.at = at;
      save();
    } catch (e) { st.error = short(e); save(); }
    finally { polling = false; }
  }

  function fire(mint, rec, alert, settings) {
    const name = rec.ticker ? `$${rec.ticker}` : rec.name || `${mint.slice(0, 6)}…`;
    const how = a => a.kind === "fast" ? `up ${Math.round(a.up)}% in the last ${a.minutes} min` : `up ${Math.round(a.up)}% since ${clock(a.since)}`;
    const headline = `${name} is ${how(alert)}${alert.also ? ` (${how(alert.also)})` : ""}`;
    const detail = `Now ${money(rec.last)}, market cap ${big(rec.mc)}.${rec.value !== null ? ` Your holding is worth about ${money(rec.value)}.` : ""}`;
    st.log.unshift({ at: now(), mint, ticker: rec.ticker || "", text: `${headline}. ${detail}`, up: Math.round(alert.up) });
    if (st.log.length > 50) st.log.length = 50;
    try { if (cfg.desktop) core().notify(`📈 ${headline}`, detail, `pump-${mint}-${now()}`); } catch { /* notifications are best effort */ }
    try { if (cfg.sound && core().sound) core().sound("deploy", true); } catch { /* so is the sound */ }
    push(`📈 ${headline}\n${detail}\nhttps://pump.fun/coin/${mint}\nhttps://axiom.trade/t/${mint}`);
  }

  // ---------- start-up, settings, messages ----------
  function schedule() {
    if (timer) { clearInterval(timer); timer = null; }
    try { if (chrome.alarms) { if (cfg.enabled) chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); else chrome.alarms.clear(ALARM); } } catch { /* the timer below covers it */ }
    if (!cfg.enabled) return;
    timer = setInterval(() => poll().catch(() => {}), 20000);
    poll().catch(() => {});
  }
  async function applyConfig(next, { reset = false } = {}) {
    const was = cfg.enabled;
    cfg = clean(next);
    if (reset || (cfg.enabled && !was)) { for (const rec of Object.values(st.coins)) { rec.ref = 0; rec.fastAt = 0; rec.samples = []; } } // switched on (again): today's prices are the marks
    schedule();
  }
  async function init() {
    for (let i = 0; i < 100 && !core(); i++) await wait(50);
    if (!core()) return;
    try {
      const got = await chrome.storage.local.get([CONFIG_KEY, STATE_KEY]);
      const s = got[STATE_KEY];
      if (s && typeof s === "object") st = { ...st, ...s, coins: s.coins && typeof s.coins === "object" ? s.coins : {}, log: Array.isArray(s.log) ? s.log : [] };
      if (st.v !== 2) { st.coins = {}; st.v = 2; save(); } // marks from before 3.7.4 could come from mixed price sources
      cfg = clean(got[CONFIG_KEY]);
      ready = true;
      schedule();
    } catch (e) { console.warn("pump alerts failed to start", e); ready = true; }
  }
  try {
    chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && ready && changes[CONFIG_KEY]) applyConfig(changes[CONFIG_KEY].newValue).catch(() => {}); });
    if (chrome.alarms) chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) poll().catch(() => {}); });
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      const type = message && message.type;
      if (!["pumpGet", "pumpSave", "pumpClearLog", "pumpTest", "pumpConnect", "pumpReset"].includes(type)) return false;
      if (sender?.id !== chrome.runtime.id || sender?.url !== chrome.runtime.getURL("sidepanel.html")) { respond({ ok: false, error: "Not allowed from here" }); return false; }
      (async () => {
        for (let i = 0; i < 60 && !ready; i++) await wait(50);
        let extra = {};
        if (type === "pumpSave") { const next = clean(message.config); await chrome.storage.local.set({ [CONFIG_KEY]: next }); await applyConfig(next); }
        else if (type === "pumpClearLog") { st.log = []; save(); }
        else if (type === "pumpReset") { await applyConfig(cfg, { reset: true }); }
        else if (type === "pumpConnect") { extra = await findChat(clean({ tgToken: message.token }).tgToken || ""); }
        else if (type === "pumpTest") {
          const c = clean(message.config || cfg);
          await telegram("sendMessage", { chat_id: c.tgChat, text: "✅ Hatchr can reach your phone. Pump alerts and buys will arrive here." }, c.tgToken);
          extra = { sent: true };
        }
        const coins = Object.entries(st.coins).map(([mint, r]) => ({ mint, ticker: r.ticker, name: r.name, last: r.last, ref: r.ref, refAt: r.refAt, value: r.value, up: r.ref > 0 && r.last > 0 ? pct(r.last, r.ref) : 0 }));
        return { config: cfg, state: { log: st.log, at: st.at, error: st.error, pushError: st.pushError, watched: st.watched, coins }, ...extra };
      })().then(data => respond({ ok: true, data }), e => respond({ ok: false, error: short(e) }));
      return true;
    });
  } catch (e) { console.warn("pump alerts listeners", e); }

  // Other parts of Hatchr (CA buys, automatic callouts) send their news to the phone through here.
  globalThis.HatchrPush = Object.freeze({ event: text => { if (cfg.tgEvents) push(text); }, send: push, ready: () => !!(cfg.tgOn && cfg.tgToken && cfg.tgChat), error: () => st.pushError });
  // the watchlist (coin-watch.js) reads prices the same way
  globalThis.HatchrPumpAlerts = Object.freeze({ clean, judge, poll, DEFAULTS, dexPairs, fromDexScreener, fromCurves });
  init();
})();
