/* Hatchr watchlist (3.9.4): coins you keep an eye on, with a market-cap alert. "Tell me when $X dumps to $4k" (or
   reaches $50k), so you can look at it and buy yourself. Nothing is bought or sold here.
   Prices: the pump.fun bonding curve for a coin still on it (exact, every read), DexScreener for the rest (always the
   same pool; a level has to show on two readings in a row there, so one odd print does not alert).
   An alert: notification, sound, a line in the list and the phone (Telegram, set up under Pump alerts). After it, the
   same level alerts again only once the market cap has moved 25% back the other way.
   Runs in the background (Chrome's service worker / the desktop app), like pump alerts. */
(() => {
  if (globalThis.HatchrWatch) return;
  const CONFIG_KEY = "coinWatch", STATE_KEY = "coinWatchState", ALARM = "coinWatchTick";
  const core = () => globalThis.HatchrCore;
  const A = () => globalThis.HatchrPumpAlerts;
  const now = () => Date.now(), wait = ms => new Promise(r => setTimeout(r, ms));
  const short = (e, n = 200) => String(e && e.message ? e.message : e).slice(0, n);
  const MINT = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const REARM = 1.25, MAX_ITEMS = 50;
  const DEFAULTS = Object.freeze({ enabled: false, everySec: 15, desktop: true, sound: true, phone: true, items: [] });

  // "4k", "4,000", "$1.2m" → 4000 / 1200000; empty or nonsense → null (no alert on that side)
  function num(v) {
    if (v === null || v === undefined || v === "") return null;
    if (typeof v === "number") return v > 0 && isFinite(v) ? v : null;
    const m = String(v).trim().toLowerCase().replace(/[$,\s]/g, "").match(/^(\d+(?:\.\d+)?)([kmb]?)$/);
    if (!m) return null;
    const n = Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[m[2]] || 1);
    return n > 0 && isFinite(n) ? n : null;
  }
  const big = v => !(v > 0) ? "?" : v >= 1e9 ? `$${(v / 1e9).toFixed(2)}B` : v >= 1e6 ? `$${(v / 1e6).toFixed(v >= 1e7 ? 1 : 2)}M` : v >= 1e3 ? `$${(v / 1e3).toFixed(v >= 1e4 ? 1 : 2)}k` : `$${Math.round(v)}`;

  function cleanItem(x) {
    const mint = String(x && x.mint || "").trim();
    if (!MINT.test(mint)) return null;
    return { mint, label: String(x.label || "").trim().slice(0, 30), below: num(x.below), above: num(x.above), addedAt: Number(x.addedAt) || now() };
  }
  function clean(input) {
    const c = input && typeof input === "object" ? input : {};
    const seen = new Set(), items = [];
    for (const x of Array.isArray(c.items) ? c.items : []) { const it = cleanItem(x); if (it && !seen.has(it.mint)) { seen.add(it.mint); items.push(it); } }
    return {
      enabled: c.enabled === true,
      everySec: Math.min(120, Math.max(10, Math.round(Number(c.everySec) || DEFAULTS.everySec))),
      desktop: c.desktop !== false, sound: c.sound !== false, phone: c.phone !== false,
      items: items.slice(0, MAX_ITEMS)
    };
  }

  // ---------- state ----------
  let cfg = clean(null), ready = false, timer = null, polling = false, saveTimer = null;
  let st = { coins: {}, log: [], at: 0, error: "" };
  function save() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; chrome.storage.local.set({ [STATE_KEY]: st }).catch(() => {}); }, 400); }
  async function store() { await chrome.storage.local.set({ [CONFIG_KEY]: cfg }); }
  function log(kind, text, mint) { st.log.unshift({ at: now(), kind, text, mint: mint || "" }); if (st.log.length > 60) st.log.length = 60; save(); }
  const nameOf = (item, rec) => item.label || (rec && rec.ticker ? `$${rec.ticker}` : (rec && rec.name) || `${item.mint.slice(0, 6)}…`);

  // ---------- prices ----------
  async function poll() {
    if (polling || !ready || !cfg.enabled || !cfg.items.length || !A()) return;
    polling = true;
    try {
      const mints = cfg.items.map(i => i.mint);
      const s = await core().settings().catch(() => ({}));
      // the bonding curve first (exact and instant while a coin is on it), DexScreener for everything else
      const curve = s.rpcUrl ? await A().fromCurves(mints, s.rpcUrl).catch(() => new Map()) : new Map();
      const rest = mints.filter(m => !curve.has(m));
      const pinned = new Map(rest.map(m => [m, st.coins[m] && st.coins[m].src]).filter(([, v]) => v && v !== "curve"));
      const dex = rest.length ? await A().fromDexScreener(rest, pinned) : new Map();
      // a name for coins only the curve knows yet (once)
      const nameless = [...curve.keys()].filter(m => !(st.coins[m] && st.coins[m].ticker));
      if (nameless.length) {
        try { for (const p of await A().dexPairs(nameless)) { const m = p && p.baseToken && p.baseToken.address, r = m && st.coins[m]; if (r && !r.ticker) { r.ticker = p.baseToken.symbol || ""; r.name = p.baseToken.name || ""; } } }
        catch { /* the address is shown meanwhile */ }
      }
      for (const item of cfg.items) {
        const rec = st.coins[item.mint] || (st.coins[item.mint] = { below: { armed: true }, above: { armed: true } });
        const r = curve.get(item.mint) || dex.get(item.mint);
        if (!r || r.away) { rec.missing = (rec.missing || 0) + (r ? 0 : 1); continue; }
        rec.missing = 0;
        if (r.ticker) rec.ticker = r.ticker;
        if (r.name) rec.name = r.name;
        if (rec.src && rec.src !== r.src) { rec.below.pending = 0; rec.above.pending = 0; } // another source: no half-confirmed level carries over
        rec.src = r.src; rec.mc = r.mc; rec.price = r.price; rec.at = now();
        if (!rec.startMc) rec.startMc = r.mc;
        rec.low = rec.low ? Math.min(rec.low, r.mc) : r.mc; rec.high = Math.max(rec.high || 0, r.mc);
        check(item, rec, "below", r.src === "curve");
        check(item, rec, "above", r.src === "curve");
      }
      for (const m of Object.keys(st.coins)) if (!mints.includes(m)) delete st.coins[m];
      st.at = now(); st.error = "";
      save();
    } catch (e) { st.error = short(e); save(); }
    finally { polling = false; }
  }
  function check(item, rec, side, exact) {
    const level = item[side], s = rec[side] || (rec[side] = { armed: true });
    if (s.level !== level) { s.level = level; s.armed = true; s.pending = 0; } // a new level starts fresh
    if (!level) return;
    const hit = side === "below" ? rec.mc <= level : rec.mc >= level;
    if (!s.armed) { // after an alert: ready again once the market cap moved 25% back
      if (side === "below" ? rec.mc >= level * REARM : rec.mc <= level / REARM) { s.armed = true; s.pending = 0; }
      return;
    }
    if (!hit) { s.pending = 0; return; }
    if (!exact && !s.pending) { s.pending = 1; return; } // DexScreener: the level has to show twice in a row
    s.armed = false; s.pending = 0; s.firedAt = now(); s.firedMc = rec.mc;
    fire(item, rec, side, level);
  }
  function fire(item, rec, side, level) {
    const name = nameOf(item, rec);
    const headline = side === "below" ? `${name} is down to ${big(rec.mc)} market cap` : `${name} is up to ${big(rec.mc)} market cap`;
    const detail = `Your alert: ${side === "below" ? "at or below" : "at or above"} ${big(level)}.${rec.startMc ? ` It was ${big(rec.startMc)} when you added it.` : ""}`;
    log(side === "below" ? "down" : "up", `${headline}. ${detail}`, item.mint);
    try { if (cfg.desktop) core().notify(`👀 ${headline}`, detail, `watch-${item.mint}-${now()}`); } catch { /* best effort */ }
    try { if (cfg.sound && core().sound) core().sound("deploy", true); } catch { /* best effort */ }
    try { if (cfg.phone && globalThis.HatchrPush) globalThis.HatchrPush.send(`👀 ${headline}\n${detail}\nhttps://pump.fun/coin/${item.mint}\nhttps://axiom.trade/t/${item.mint}`); } catch { /* best effort */ }
  }

  // An address, or a pump.fun / Axiom / DexScreener / Solscan link. DexScreener and Axiom links hold the pool's
  // address, not the coin's: that is looked up. A coin DexScreener does not list yet is kept as it is (the curve prices it).
  async function resolve(text) {
    const words = String(text || "").match(/[1-9A-HJ-NP-Za-km-z]{32,44}/g) || [];
    const address = words.find(w => MINT.test(w)) || "";
    if (!address) throw new Error("Paste a coin address, or a pump.fun, Axiom or DexScreener link.");
    try {
      const pairs = await A().dexPairs([address]);
      const own = pairs.find(p => p.baseToken && p.baseToken.address === address);
      if (own) return { mint: address, ticker: own.baseToken.symbol || "", name: own.baseToken.name || "" };
    } catch { /* below */ }
    try {
      const r = await fetch(`https://api.dexscreener.com/latest/dex/pairs/solana/${address}`, { headers: { accept: "application/json" } });
      const j = r.ok ? await r.json() : null, pair = j && (j.pair || (Array.isArray(j.pairs) && j.pairs[0]));
      if (pair && pair.baseToken && MINT.test(pair.baseToken.address || "")) return { mint: pair.baseToken.address, ticker: pair.baseToken.symbol || "", name: pair.baseToken.name || "", fromPool: true };
    } catch { /* not a pool either */ }
    return { mint: address, ticker: "", name: "" };
  }

  // ---------- running ----------
  function schedule(kick = true) {
    if (timer) { clearInterval(timer); timer = null; }
    const on = cfg.enabled && cfg.items.length > 0;
    try { if (chrome.alarms) { if (on) chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); else chrome.alarms.clear(ALARM); } } catch { /* the timer covers it */ }
    if (!on) return;
    timer = setInterval(() => poll().catch(() => {}), cfg.everySec * 1000);
    if (kick) poll().catch(() => {});
  }
  async function applyConfig(next) { cfg = clean(next); schedule(); }
  async function init() {
    for (let i = 0; i < 100 && !(core() && A()); i++) await wait(50);
    if (!core()) return;
    try {
      const got = await chrome.storage.local.get([CONFIG_KEY, STATE_KEY]);
      const s = got[STATE_KEY];
      if (s && typeof s === "object") st = { ...st, ...s, coins: s.coins && typeof s.coins === "object" ? s.coins : {}, log: Array.isArray(s.log) ? s.log : [] };
      cfg = clean(got[CONFIG_KEY]);
    } catch (e) { console.warn("watchlist failed to start", e); }
    ready = true;
    schedule();
  }
  function view() {
    const coins = cfg.items.map(item => {
      const r = st.coins[item.mint] || {};
      const side = k => ({ level: item[k], armed: !r[k] || r[k].armed !== false, firedAt: r[k] && r[k].firedAt || 0, firedMc: r[k] && r[k].firedMc || 0 });
      return { ...item, ticker: r.ticker || "", name: r.name || "", mc: r.mc || 0, startMc: r.startMc || 0, low: r.low || 0, high: r.high || 0, at: r.at || 0, src: r.src || "", missing: r.missing || 0, below: side("below"), above: side("above") };
    });
    const P = globalThis.HatchrPush;
    return { config: cfg, state: { at: st.at, error: st.error, log: st.log, coins }, phone: { ready: !!(P && P.ready && P.ready()), error: P && P.error ? P.error() : "" } };
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => { if (area === "local" && ready && changes[CONFIG_KEY]) applyConfig(changes[CONFIG_KEY].newValue).catch(() => {}); });
    if (chrome.alarms) chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) poll().catch(() => {}); });
    // a click on a watchlist notification opens the coin
    try {
      if (chrome.notifications && chrome.notifications.onClicked) chrome.notifications.onClicked.addListener(id => {
        const m = /^watch-([1-9A-HJ-NP-Za-km-z]{32,44})-/.exec(String(id));
        if (m && chrome.tabs) chrome.tabs.create({ url: `https://axiom.trade/t/${m[1]}` }).catch(() => {});
      });
    } catch { /* not offered here */ }
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      const type = message && message.type;
      if (!["watchGet", "watchSave", "watchAdd", "watchEdit", "watchRemove", "watchRearm", "watchClearLog"].includes(type)) return false;
      if (sender?.id !== chrome.runtime.id || sender?.url !== chrome.runtime.getURL("sidepanel.html")) { respond({ ok: false, error: "Not allowed from here" }); return false; }
      (async () => {
        for (let i = 0; i < 60 && !ready; i++) await wait(50);
        let note = "";
        if (type === "watchSave") { // the switch and the How settings; the list itself changes through the messages below
          cfg = clean({ ...cfg, ...(message.config || {}), items: cfg.items }); await store(); schedule();
        } else if (type === "watchAdd") {
          if (cfg.items.length >= MAX_ITEMS) throw new Error(`The watchlist holds ${MAX_ITEMS} coins; remove one first.`);
          const found = await resolve(message.address);
          if (cfg.items.some(i => i.mint === found.mint)) throw new Error("That coin is already on the watchlist.");
          const item = cleanItem({ mint: found.mint, label: message.label, below: message.below, above: message.above });
          cfg = clean({ ...cfg, enabled: true, items: [item, ...cfg.items] });
          if (found.ticker) st.coins[found.mint] = { ...(st.coins[found.mint] || { below: { armed: true }, above: { armed: true } }), ticker: found.ticker, name: found.name };
          await store(); schedule(false);
          note = `Watching ${item.label || (found.ticker ? "$" + found.ticker : found.mint.slice(0, 6) + "…")}${found.fromPool ? " (found from the pool's address)" : ""}.`;
        } else if (type === "watchEdit") {
          const i = cfg.items.findIndex(x => x.mint === message.mint);
          if (i < 0) throw new Error("That coin is not on the watchlist any more.");
          const items = [...cfg.items];
          items[i] = cleanItem({ ...items[i], label: message.label, below: message.below, above: message.above });
          cfg = clean({ ...cfg, items }); await store(); schedule(false);
        } else if (type === "watchRemove") {
          cfg = clean({ ...cfg, items: cfg.items.filter(x => x.mint !== message.mint) }); delete st.coins[message.mint]; save(); await store(); schedule();
        } else if (type === "watchRearm") {
          const r = st.coins[message.mint];
          if (r) { for (const k of ["below", "above"]) if (r[k]) { r[k].armed = true; r[k].pending = 0; } save(); }
          poll().catch(() => {});
        } else if (type === "watchClearLog") { st.log = []; save(); }
        if (type === "watchAdd" || type === "watchEdit") { // a price straight away, without making the page wait for it
          (async () => { for (let i = 0; i < 100 && polling; i++) await wait(50); await poll(); })().catch(() => {});
        }
        return { ...view(), note };
      })().then(data => respond({ ok: true, data }), e => respond({ ok: false, error: short(e) }));
      return true;
    });
  } catch (e) { console.warn("watchlist listeners", e); }

  globalThis.HatchrWatch = Object.freeze({ clean, num, big, check, poll, resolve, DEFAULTS });
  init();
})();
