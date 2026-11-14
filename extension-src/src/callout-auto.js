/* Callout automode. Two independent parts, each with its own switch:
   1. Auto buy: watches new pump.fun coins, buys the smallest position pump.fun accepts for a callout when a coin
      passes Hatchr's own filters, checks the wallet really holds it, then posts the callout.
   2. Own buys: posts a callout right after you buy a coin yourself (on pump.fun, Axiom, anywhere) with a wallet Hatchr knows.
   It never sells.
   Runs in the background worker next to background.js, which hands over what it needs as globalThis.HatchrCore. */
(() => {
  "use strict";
  const F = globalThis.HatchrCalloutFilters;
  if (!F || globalThis.HatchrCalloutAuto) return;

  const CONFIG_KEY = "coAuto", STATE_KEY = "coAutoState", INDEX_KEY = "coAutoIndex", ALARM = "coAutoTick";
  const PUMP_ORIGINS = ["https://pump.fun/*", "https://frontend-api-v3.pump.fun/*"];
  const MAX_WATCHED = 150;         // coins followed at the same time; when full, the oldest makes room
  const MAX_WATCH_SEC = 1800;      // without an age limit of your own, a coin is followed this long
  const LOG_SIZE = 60;
  const core = () => globalThis.HatchrCore;
  const now = () => Date.now();
  const today = () => new Date().toISOString().slice(0, 10);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const short = (e, n = 200) => String(e && e.message || e || "").slice(0, n);

  let cfg = F.cleanConfig(null);
  let ready = false;
  let st = freshState();
  let busy = false;
  let solUsd = 0, solUsdAt = 0;
  let mainOn = true, mainAt = 0, walletsAt = 0, busyBuying = "";
  const watched = new Map();       // mint -> coin being measured
  const subscribed = new Set();
  const index = F.createIndex();
  let indexDirty = false, stateDirty = false, lastSave = 0, lastIndexSave = 0, ticker = null, slow = null;

  function freshState() {
    return { day: today(), seen: 0, watchedToday: 0, buysToday: 0, callsToday: 0, lastCallAt: 0, nextSlotAt: 0, paused: "", pending: [], log: [], skips: {},
      autoMints: [],     // coins the automode bought itself (never treated as "your own buy")
      called: [],        // coins Hatchr has called out (or found already called): never called twice
      ownSigs: [],       // transactions of yours already looked at
      ownLast: {},       // per wallet: the newest transaction seen by the wallet check
      ownTried: {},      // coin -> when its callout was last refused
      ownSince: 0, ownAt: 0 };
  }
  function rollDay() {
    if (st.day === today()) return;
    st = { ...st, day: today(), seen: 0, watchedToday: 0, buysToday: 0, callsToday: 0, failsToday: 0, skips: {} };
    stateDirty = true;
  }
  function log(kind, text, extra = {}) {
    st.log.unshift({ at: now(), kind, text: String(text).slice(0, 300), ...extra });
    if (st.log.length > LOG_SIZE) st.log.length = LOG_SIZE;
    stateDirty = true;
    save(true);
  }
  const publicState = () => ({ ...st, watching: watched.size, at: now() });
  function tally(tags) {
    for (const tag of tags && tags.length ? tags.slice(0, 2) : ["other"]) st.skips[tag] = (st.skips[tag] || 0) + 1;
    stateDirty = true;
  }
  async function save(force = false) {
    if (!ready) return;
    if (!force && now() - lastSave < 5000) return;
    lastSave = now();
    try {
      if (stateDirty) { stateDirty = false; await chrome.storage.local.set({ [STATE_KEY]: publicState() }); }
      if (indexDirty && chrome.storage.session && now() - lastIndexSave > 60000) { indexDirty = false; lastIndexSave = now(); await chrome.storage.session.set({ [INDEX_KEY]: index.dump(2500) }); }
    } catch { /* storage is best effort; the next save tries again */ }
  }

  // ---------- when may the next coin be bought? ----------
  // A buy is only worth making when a callout can follow it, so both share one slot.
  function slotOpen() {
    rollDay();
    return cfg.enabled && mainOn && !st.paused && !busy && !st.pending.some(p => !p.own && !waiting(p)) && now() >= st.nextSlotAt &&
      (cfg.maxPerDay === 0 || (st.callsToday < cfg.maxPerDay && st.buysToday < cfg.maxPerDay)); // 0 = no daily limit
  }
  // ---------- when a bought coin is called out ----------
  // Straight away by default. Optionally only after some seconds, and/or only once its market cap has reached a number.
  const rule = item => item.own ? { delay: cfg.ownDelaySec, minMc: cfg.ownMinMcUsd } : { delay: cfg.autoDelaySec, minMc: cfg.autoMinMcUsd };
  const waiting = item => {
    const r = rule(item);
    return now() < item.boughtAt + r.delay * 1000 || (r.minMc !== null && !(item.mcUsd >= r.minMc));
  };
  const money = v => `$${Math.round(v).toLocaleString("en-US")}`;

  function pause(reason, text) {
    st.paused = reason;
    log("error", text);
    stopWatching();
  }

  // ---------- pump.fun's live stream (shared with background.js: one connection for everything) ----------
  function socket() {
    const ws = core() && core().socket();
    return ws && ws.readyState === 1 ? ws : null;
  }
  function subscribe(mint) {
    const ws = socket();
    if (!ws || subscribed.has(mint)) return;
    try { ws.send(JSON.stringify({ method: "subscribeTokenTrade", keys: [mint] })); subscribed.add(mint); } catch { /* reconnect resubscribes */ }
  }
  function unsubscribe(mint) {
    if (!subscribed.delete(mint)) return;
    const ws = socket();
    if (ws) try { ws.send(JSON.stringify({ method: "unsubscribeTokenTrade", keys: [mint] })); } catch { /* socket is going away anyway */ }
  }
  function drop(coin, tags) {
    if (!watched.delete(coin.mint)) return;
    unsubscribe(coin.mint);
    if (tags) tally(tags);
    stateDirty = true;
  }
  function stopWatching() {
    for (const coin of [...watched.values()]) drop(coin);
  }
  function onOpen() {
    subscribed.clear();
    followed = [];
    for (const mint of watched.keys()) subscribe(mint);
    followWallets();
  }

  // ---------- your own buys ----------
  // Three ways a buy of yours is noticed, fastest first. Each one ends in ownBuy(), which sorts out doubles:
  //   1. pump.fun's stream (PumpPortal) names your wallet as the buyer.
  //   2. Your RPC tells Hatchr the moment any transaction touches your wallet (a second connection, to your own RPC).
  //   3. Every few seconds Hatchr asks the RPC for the wallet's latest transactions (works when 1 and 2 are down).
  // 2 and 3 read the transaction itself: it only counts when YOUR wallet signed it and ended up with more of a
  // pump.fun coin. Coins that somebody sends to the wallet (airdrops, spam) are never called.
  let myWallets = [], followed = [];
  async function loadWallets() {
    const list = [];
    try {
      const secret = await core().secret();
      if (secret) list.push(core().keypair(secret).publicKey.toBase58());
    } catch { /* no usable Hatchr wallet */ }
    try {
      const { settings } = await chrome.storage.local.get("settings");
      const extra = String(settings && settings.calloutWallet || "").trim(); // "Wallet you use on pump.fun" on the Callouts tab
      if (/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(extra) && !list.includes(extra)) list.push(extra);
      rpcUrl = String(settings && settings.rpcUrl || rpcUrl || "");
    } catch { /* keep the Hatchr wallet only */ }
    const changed = list.join(",") !== myWallets.join(",");
    myWallets = list;
    if (changed) st.pending = st.pending.filter(p => !p.own || list.includes(p.wallet));
    followWallets();
    feed(changed);
  }
  function followWallets() {
    const ws = socket();
    if (!ws) return;
    const want = cfg.ownBuys && mainOn ? myWallets : [];
    const add = want.filter(w => !followed.includes(w)), remove = followed.filter(w => !want.includes(w));
    try {
      if (add.length) ws.send(JSON.stringify({ method: "subscribeAccountTrade", keys: add }));
      if (remove.length) ws.send(JSON.stringify({ method: "unsubscribeAccountTrade", keys: remove }));
      followed = [...want];
    } catch { /* reconnect follows them again */ }
  }

  const keep = (list, item, max) => [...list.filter(x => x !== item), item].slice(-max);
  // A buy made by you, not by the automode: queue its callout and send it at once.
  function ownBuy(mint, wallet, via, signature, amount = 0) {
    if (!cfg.ownBuys || !mainOn || !/pump$/.test(mint) || !myWallets.includes(wallet)) return;
    if (signature) { if (st.ownSigs.includes(signature)) return; st.ownSigs = keep(st.ownSigs, signature, 400); stateDirty = true; }
    if (st.autoMints.includes(mint) || busyBuying === mint) return;          // the automode's own purchase
    if (st.pending.some(p => p.mint === mint) || st.called.includes(mint)) return; // on its way, or called before
    if (now() - (st.ownTried[mint] || 0) < 300000) return;                    // just tried and refused: no hammering
    const known = index.find(mint) || {};
    st.pending.push({ mint, name: known.name || "", ticker: known.ticker || "", description: "", image: "", amount: 0, seen: amount > 0 ? amount : 0, wallet,
      boughtAt: now(), own: true, via, tries: 0, retryAt: 0 });
    stateDirty = true;
    startTicker();
    kick(0);
    if (cfg.ownDelaySec > 0) kick(cfg.ownDelaySec * 1000 + 30); // on the dot when a delay is set
    refreshSoon();
    save(true);
  }

  // ---------- the "Coins you hold" list ----------
  // The RPC's list of what a wallet holds can trail a fresh buy by many seconds, which made Refresh look dead:
  // you bought, pressed Refresh, and the coin was not there. Three things fix that:
  //   - a coin Hatchr saw you (or itself) buy in the last few minutes is put in the list even if that RPC list lacks it;
  //   - Refresh also reads the wallet's last few transactions, so it finds a buy made seconds ago;
  //   - after a buy the list refreshes by itself, and a Refresh that gets no answer gives up after 25 s instead of spinning forever.
  let recent = []; // { mint, wallet, amount, at }
  function noteRecent(mint, wallet, amount) {
    if (!/pump$/.test(mint) || !(amount > 0)) return;
    recent = [...recent.filter(r => r.mint !== mint && now() - r.at < 300000), { mint, wallet, amount, at: now() }].slice(-40);
  }
  async function recentFromChain() {
    if (!rpcUrl) return;
    for (const wallet of myWallets) {
      let list;
      try { list = await core().rpc(rpcUrl, "getSignaturesForAddress", [wallet, { limit: 6, commitment: "confirmed" }]); } catch { continue; }
      for (const x of Array.isArray(list) ? list : []) {
        if (x.err || !x.blockTime || now() - x.blockTime * 1000 > 240000) continue;
        for (const got of await readTx(x.signature, wallet).catch(() => null) || []) noteRecent(got.mint, wallet, got.amount);
      }
    }
  }
  let scanning = null;
  // `original` is background.js's own wallet reader.
  function scanHeld(original) {
    if (scanning) return scanning;
    scanning = (async () => {
      const [list] = await Promise.all([original(), recentFromChain().catch(() => {})]);
      const have = Array.isArray(list) ? list : [];
      const { deploys = [] } = await chrome.storage.local.get("deploys");
      const missing = recent.filter(r => now() - r.at < 300000 && !have.some(c => c.mint === r.mint) && !deploys.some(d => d.mint === r.mint && d.ok && !d.dryRun && !d.sold));
      if (!missing.length) return have;
      let out = have;
      await core().lock(async () => {
        const { heldCoins = [] } = await chrome.storage.local.get("heldCoins");
        for (const r of missing) {
          if (heldCoins.some(c => c.mint === r.mint)) continue;
          const known = index.find(r.mint) || {};
          heldCoins.unshift({ mint: r.mint, amount: r.amount, wallet: r.wallet, name: known.name || "", ticker: known.ticker || "", description: "", image: "", id: `held:${r.mint}`, ok: true, dryRun: false });
        }
        await chrome.storage.local.set({ heldCoins });
        out = heldCoins;
      });
      return out;
    })().finally(() => { scanning = null; });
    return scanning;
  }
  // After a buy: bring the list up to date without anyone pressing Refresh (now, and again once the RPC has caught up).
  let refreshTimers = [];
  function refreshSoon() {
    refreshTimers.forEach(clearTimeout);
    refreshTimers = [4000, 12000, 30000].map(ms => setTimeout(() => { if (core()) scanHeld(core().scanHeld).catch(() => {}); }, ms));
  }
  // Runs the queue right away instead of waiting for the next 2-second beat.
  function kick(ms) { setTimeout(() => callPending().catch(() => {}), ms); }

  // Reads one transaction: did this wallet sign it, and which pump.fun coins did it gain?
  const txCache = new Map(); // signature -> what the wallet gained in it
  async function readTx(signature, wallet) {
    if (txCache.has(signature)) return txCache.get(signature);
    let tx = null;
    for (let i = 0; i < 8 && !tx; i++) { // a transaction seen a moment ago may take a beat to be readable
      if (i) await wait(350);
      tx = await core().rpc(rpcUrl, "getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]).catch(() => null);
    }
    if (!tx || !tx.meta) return null; // could not be read (RPC busy): NOT the same as "no buy in it"
    if (tx.meta.err) { txCache.set(signature, []); return []; }
    const message = tx.transaction && tx.transaction.message;
    const signers = (message && message.accountKeys || []).slice(0, message && message.header && message.header.numRequiredSignatures || 1).map(k => typeof k === "string" ? k : k && k.pubkey);
    if (!signers.includes(wallet)) return []; // sent TO the wallet by someone else: not a buy
    const total = list => { const m = new Map(); for (const b of list || []) if (b && b.owner === wallet && b.mint) m.set(b.mint, (m.get(b.mint) || 0) + Number(b.uiTokenAmount && b.uiTokenAmount.uiAmount || 0)); return m; };
    const before = total(tx.meta.preTokenBalances), after = total(tx.meta.postTokenBalances);
    const gained = [...after.entries()].filter(([mint, amount]) => /pump$/.test(mint) && amount > (before.get(mint) || 0)).map(([mint, amount]) => ({ mint, amount }));
    txCache.set(signature, gained);
    if (txCache.size > 300) txCache.delete(txCache.keys().next().value);
    return gained;
  }
  const reading = new Set(), unread = new Map();
  const recheck = (signature, wallet, via) => handleTx(signature, wallet, via).catch(() => {});
  async function handleTx(signature, wallet, via) {
    if (!signature || reading.has(signature) || st.ownSigs.includes(signature)) return;
    reading.add(signature);
    let read = false;
    try {
      const gained = await readTx(signature, wallet);
      read = gained !== null;
      for (const got of gained || []) { noteRecent(got.mint, wallet, got.amount); ownBuy(got.mint, wallet, via, "", got.amount); }
    } finally {
      reading.delete(signature);
      // Only a transaction that was really read is ticked off. One the RPC could not show yet is looked at again by
      // the wallet check a few seconds later (up to 5 times), instead of the buy being missed for good.
      const misses = read ? 0 : (unread.get(signature) || 0) + 1;
      if (read || misses >= 5) { unread.delete(signature); st.ownSigs = keep(st.ownSigs, signature, 400); stateDirty = true; }
      else { unread.set(signature, misses); if (unread.size > 200) unread.delete(unread.keys().next().value); st.ownAt = 0; setTimeout(() => recheck(signature, wallet, via), 1500); }
    }
  }

  // Way 2: a live line to your own RPC.
  let rpcUrl = "", feedSocket = null, feedUrl = "", feedLive = false, feedRetry = 0, feedTimer = null, feedPing = null;
  function feed(restart) {
    const want = cfg.ownBuys && mainOn && myWallets.length && /^https?:\/\//i.test(rpcUrl) && typeof WebSocket !== "undefined";
    const url = want ? rpcUrl.replace(/^http/i, "ws") : "";
    if (feedSocket && (restart || url !== feedUrl)) { const old = feedSocket; feedSocket = null; feedLive = false; try { old.close(); } catch { /* already gone */ } }
    if (!want || feedSocket || feedTimer) return;
    let ws;
    try { ws = new WebSocket(url); } catch { return; }
    feedSocket = ws; feedUrl = url;
    const ids = new Map(); // subscription id -> wallet
    ws.onopen = () => {
      if (feedSocket !== ws) return;
      feedRetry = 0;
      myWallets.forEach((wallet, i) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "logsSubscribe", params: [{ mentions: [wallet] }, { commitment: "confirmed" }] })));
      clearInterval(feedPing);
      feedPing = setInterval(() => { try { ws.send(JSON.stringify({ jsonrpc: "2.0", id: 999, method: "ping" })); } catch { /* closing */ } }, 45000);
    };
    ws.onmessage = event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (typeof msg.id === "number" && msg.id >= 1 && msg.id <= myWallets.length && typeof msg.result === "number") { ids.set(msg.result, myWallets[msg.id - 1]); feedLive = true; return; }
      if (msg.method !== "logsNotification") return;
      const value = msg.params && msg.params.result && msg.params.result.value, wallet = ids.get(msg.params && msg.params.subscription);
      if (value && !value.err && value.signature && wallet) handleTx(value.signature, wallet, "wallet feed").catch(() => {});
    };
    const lost = () => {
      if (feedSocket !== ws) return;
      feedSocket = null; feedLive = false; clearInterval(feedPing);
      const delay = Math.min(60000, 2000 * 2 ** Math.min(feedRetry++, 5));
      feedTimer = setTimeout(() => { feedTimer = null; feed(false); }, delay);
    };
    ws.onclose = lost; ws.onerror = lost;
  }

  // Way 3: ask for the wallet's latest transactions. Often while the live line is down, seldom while it is up.
  async function checkWallets() {
    if (!cfg.ownBuys || !mainOn || !myWallets.length || !rpcUrl || now() - st.ownAt < (feedLive ? 55000 : 9000)) return;
    st.ownAt = now();
    for (const wallet of myWallets) {
      let list;
      try { list = await core().rpc(rpcUrl, "getSignaturesForAddress", [wallet, { limit: 15, commitment: "confirmed" }]); } catch { continue; }
      if (!Array.isArray(list) || !list.length) { if (Array.isArray(list) && !st.ownLast[wallet]) { st.ownLast[wallet] = "-"; stateDirty = true; } continue; }
      const last = st.ownLast[wallet];
      st.ownLast[wallet] = list[0].signature; stateDirty = true;
      if (!last) continue; // first look at this wallet: only what happens from now on counts
      const at = list.findIndex(x => x.signature === last);
      const fresh = (at < 0 ? list : list.slice(0, at)).filter(x => !x.err && (!x.blockTime || x.blockTime * 1000 > st.ownSince - 5000)).reverse();
      for (const x of fresh) await handleTx(x.signature, wallet, "wallet check").catch(() => {});
    }
  }

  // PumpPortal sends SOL and coin amounts as plain numbers; older messages used the raw on-chain units.
  const sol = v => { const n = Number(v); return Number.isFinite(n) ? (n > 1e6 ? n / 1e9 : n) : null; };
  const tokens = v => { const n = Number(v); return Number.isFinite(n) ? (n > 2e9 ? n / 1e6 : n) : null; };

  function applyCurve(coin, msg) {
    const vSol = sol(msg.vSolInBondingCurve), vTokens = tokens(msg.vTokensInBondingCurve), mc = sol(msg.marketCapSol);
    if (vSol !== null) coin.vSol = vSol;
    if (vTokens !== null) coin.vTokens = vTokens;
    if (mc !== null) coin.mcSol = mc;
    else if (vSol !== null && vTokens) coin.mcSol = vSol / vTokens * 1e9;
  }

  function onStream(msg) {
    if (!ready || !(cfg.enabled || cfg.ownBuys) || !mainOn || !msg || typeof msg !== "object" || typeof msg.mint !== "string") return;
    const type = String(msg.txType || "").toLowerCase();
    if (type === "create" || (!type && msg.name)) onCreate(msg);
    else if (type === "buy" || type === "sell") {
      if (type === "buy" && myWallets.includes(String(msg.traderPublicKey || ""))) {
        const got = tokens(msg.newTokenBalance) || tokens(msg.tokenAmount) || 0;
        noteRecent(msg.mint, String(msg.traderPublicKey), got);
        if (cfg.ownBuys) ownBuy(msg.mint, String(msg.traderPublicKey), "stream", typeof msg.signature === "string" ? msg.signature : "", got);
      }
      onTrade(msg, type);
    }
    else if (/migrat/.test(type) || msg.pool === "pump-amm") { const coin = watched.get(msg.mint); if (coin) drop(coin, ["left the bonding curve"]); }
  }

  function onCreate(msg) {
    const at = now();
    const coin = {
      mint: msg.mint, name: String(msg.name || "").slice(0, 60), ticker: String(msg.symbol || "").slice(0, 16),
      uri: typeof msg.uri === "string" ? msg.uri.slice(0, 400) : "", creator: String(msg.traderPublicKey || ""),
      curve: String(msg.bondingCurveKey || ""), createdAt: at,
      devBuySol: sol(msg.solAmount) || 0, txns: 0, buys: 0, sells: 0, volSol: 0, balances: new Map(), meta: null, metaFailed: false
    };
    // Every coin goes into the memory of recent names, also while nothing is being bought: that memory is what spots copies.
    coin.clones = index.check(coin, at, cfg.filters.cloneWindowMin);
    index.add(coin, at);
    indexDirty = true;
    rollDay();
    st.seen++;
    stateDirty = true;

    if (!cfg.enabled || !mainOn || !slotOpen()) return;
    if ((msg.pool && msg.pool !== "pump") || !/pump$/.test(coin.mint) || !coin.creator || !coin.curve) return tally(["not a pump.fun coin"]);
    const quote = msg.quoteMint || msg.quote_mint; // when the stream says what the coin is priced in, non-SOL coins are not even watched
    if (typeof quote === "string" && quote && quote !== WSOL && !/^1+$/.test(quote)) return tally(["not priced in SOL"]);
    if (watched.size >= MAX_WATCHED) drop(watched.values().next().value, ["watch list full"]);

    const first = tokens(msg.initialBuy) || 0;
    if (first > 0) { coin.balances.set(coin.creator, first); coin.txns = 1; coin.buys = 1; coin.volSol = coin.devBuySol; }
    applyCurve(coin, msg);

    const quick = F.worthWatching(coin, cfg.filters, { now: at, solUsd, clones: coin.clones });
    if (!quick.ok) return tally(quick.tags);
    watched.set(coin.mint, coin);
    st.watchedToday++;
    subscribe(coin.mint);
    const f = cfg.filters;
    if (f.twitter || f.website || f.telegram || f.anySocial || f.includeKeywords.length || f.excludeKeywords.length) loadMeta(coin);
    startTicker();
  }

  function onTrade(msg, type) {
    const held = st.pending.length ? st.pending.find(p => p.mint === msg.mint) : null;
    if (held) {
      const mc = sol(msg.marketCapSol);
      if (mc !== null) { held.mcSol = mc; if (solUsd > 0) { held.mcUsd = mc * solUsd; held.mcAt = now(); if (!waiting(held)) kick(0); } }
      if (!held.curve && typeof msg.bondingCurveKey === "string") held.curve = msg.bondingCurveKey;
    }
    const coin = watched.get(msg.mint);
    if (!coin) return;
    const who = String(msg.traderPublicKey || ""), amount = tokens(msg.tokenAmount) || 0, paid = sol(msg.solAmount) || 0;
    coin.txns++;
    if (type === "buy") coin.buys++; else coin.sells++;
    coin.volSol += paid;
    if (who) {
      const after = tokens(msg.newTokenBalance);
      const next = after !== null && msg.newTokenBalance !== undefined ? after : Math.max(0, (coin.balances.get(who) || 0) + (type === "buy" ? amount : -amount));
      if (next > 0) coin.balances.set(who, next); else coin.balances.delete(who);
    }
    applyCurve(coin, msg);
    if (now() - (coin.judgedAt || 0) > 700) judge(coin);
  }

  // ---------- the coin's links and description (from its metadata file) ----------
  let metaRunning = 0;
  const link = v => (typeof v === "string" && /^https?:\/\/\S+\.\S+/i.test(v.trim()) ? v.trim().slice(0, 300) : "");
  async function fetchJson(url) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 5000);
    try {
      const response = await fetch(url, { signal: controller.signal, credentials: "omit", redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      const text = await response.text();
      if (text.length > 20000) throw new Error("too large");
      return JSON.parse(text);
    } finally { clearTimeout(timer); }
  }
  async function loadMeta(coin) {
    if (!/^https:\/\//i.test(coin.uri)) { coin.metaFailed = true; return; }
    if (metaRunning >= 6) { // busy: come back in a moment rather than give the coin up
      coin.metaTries = (coin.metaTries || 0) + 1;
      if (coin.metaTries > 4) { coin.metaFailed = true; return; }
      setTimeout(() => { if (watched.has(coin.mint)) loadMeta(coin); }, 1500);
      return;
    }
    metaRunning++;
    try {
      const cid = F.uriKey(coin.uri);
      const urls = [coin.uri];
      if (/^[A-Za-z0-9]{32,}$/.test(cid) && !/^https:\/\/ipfs\.io\//i.test(coin.uri)) urls.push(`https://ipfs.io/ipfs/${cid}`);
      let data = null;
      for (const url of urls) { try { data = await fetchJson(url); break; } catch { /* next gateway */ } }
      if (!data || typeof data !== "object") { coin.metaFailed = true; return; }
      coin.meta = {
        twitter: link(data.twitter), telegram: link(data.telegram), website: link(data.website),
        description: typeof data.description === "string" ? data.description.slice(0, 300) : "",
        image: link(data.image)
      };
    } catch { coin.metaFailed = true; }
    finally { metaRunning--; if (watched.has(coin.mint)) judge(coin); }
  }

  // ---------- judging ----------
  function judge(coin) {
    coin.judgedAt = now();
    const result = F.evaluate(coin, cfg.filters, { now: coin.judgedAt, solUsd, clones: coin.clones });
    if (result.dead) return drop(coin, result.tags);
    const limit = cfg.filters.ageSec.max !== null ? cfg.filters.ageSec.max : MAX_WATCH_SEC;
    if ((coin.judgedAt - coin.createdAt) / 1000 > limit) return drop(coin, result.tags);
    coin.why = result.why;
    if (result.pass && slotOpen()) buyAndCall(coin).catch(e => log("error", `Auto callout stopped on an error: ${short(e)}`));
  }

  function startTicker() {
    if (ticker) return;
    ticker = setInterval(() => tick().catch(() => {}), 2000);
  }
  async function tick() {
    if (!ready) return;
    rollDay();
    await refreshMain();
    if (!cfg.enabled || !mainOn) stopWatching();
    else {
      if (watched.size && !busy && !slotOpen()) stopWatching();
      for (const coin of [...watched.values()]) judge(coin);
    }
    if (mainOn) {
      await trackWaiting();
      reviewWaiting();
      await callPending();
      await checkWallets();
    }
    if (!watched.size && !st.pending.length && ticker) { clearInterval(ticker); ticker = null; }
    index.prune(now(), cfg.filters.cloneWindowMin * 60000);
    save();
  }
  async function refreshMain() {
    if (now() - mainAt < 15000) return;
    mainAt = now();
    try {
      const { settings } = await chrome.storage.local.get("settings");
      mainOn = !settings || settings.watching !== false;
      testMode = !settings || settings.dryRun !== false;
    } catch { /* keep the last answer */ }
    warmTab();
    if (now() - walletsAt > 60000) { walletsAt = now(); await loadWallets(); }
    if ((cfg.enabled || st.pending.length || cfg.ownMinMcUsd !== null || cfg.autoMinMcUsd !== null) && now() - solUsdAt > 120000) {
      try { const price = await core().solPrice(); if (price && price.usd > 0) { solUsd = price.usd; solUsdAt = now(); } } catch { /* keep the last price */ }
    }
  }

  // ---------- the on-chain double check before any money moves ----------
  const WSOL = "So11111111111111111111111111111111111111112";
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function base58(bytes) {
    let n = 0n, out = "";
    for (const b of bytes) n = (n << 8n) | BigInt(b);
    while (n > 0n) { out = B58[Number(n % 58n)] + out; n /= 58n; }
    for (const b of bytes) { if (b !== 0) break; out = "1" + out; }
    return out;
  }
  // A reason to leave a coin alone that is nobody's fault: no retry pause, no red line in the activity list.
  const benign = (text, tag) => Object.assign(new Error(text), { benign: tag });
  function readU64(bytes, offset) {
    let v = 0n;
    for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[offset + i]);
    return v;
  }
  async function verifyOnChain(coin, rpcUrl) {
    const info = await core().rpc(rpcUrl, "getAccountInfo", [coin.curve, { encoding: "base64", commitment: "confirmed" }]);
    const b64 = info && info.value && info.value.data && info.value.data[0];
    if (!b64) throw new Error("the coin's bonding curve was not found on-chain");
    const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0));
    if (bytes.length < 49) throw new Error("the coin's bonding curve could not be read");
    if (bytes[48] === 1) throw benign("it already left the bonding curve", "left the bonding curve");
    // Since pump.fun's "create v2", a coin can be priced in another token than SOL (bonding curve: quote_mint at byte 83).
    // A SOL buy of such a coin is rejected on-chain (error 6063, UnsupportedQuoteMint) and still costs the fees, so it is never sent.
    if (bytes.length >= 115) {
      const quote = bytes.subarray(83, 115);
      if (quote.some(b => b !== 0) && base58(quote) !== WSOL) throw benign("it is priced in another token than SOL, which Hatchr cannot buy", "not priced in SOL");
    }
    const vTokens = Number(readU64(bytes, 8)) / 1e6, vSol = Number(readU64(bytes, 16)) / 1e9;
    if (!(vTokens > 0) || !(vSol > 0)) throw new Error("the coin's bonding curve is empty");
    coin.vTokens = vTokens; coin.vSol = vSol; coin.mcSol = vSol / vTokens * 1e9;
    const dev = await core().tokenBalance(rpcUrl, coin.creator, coin.mint);
    if (dev.ui > 0) coin.balances.set(coin.creator, dev.ui); else coin.balances.delete(coin.creator);
  }

  // pump.fun's error numbers, in words, for the ones a buy can run into.
  const PUMP_ERRORS = { 6002: "the price moved more than your slippage allows", 6005: "the coin already left the bonding curve", 6021: "not enough coins left on the bonding curve",
    6042: "the price moved more than your slippage allows", 6063: "the coin is priced in another token than SOL" };
  function explain(err) {
    const text = typeof err === "string" ? err : JSON.stringify(err);
    const code = (text.match(/"Custom":\s*(\d+)/) || [])[1];
    if (code && PUMP_ERRORS[code]) return `${PUMP_ERRORS[code]}, pump.fun error ${code}`;
    if (/InsufficientFunds|insufficient lamports|"Custom":\s*1\b/.test(text)) return "not enough SOL in the wallet";
    return text.slice(0, 160);
  }

  // ---------- buy ----------
  async function buildBuy(pub, mint, amountSol) {
    const response = await fetch("https://pumpportal.fun/api/trade-local", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ publicKey: pub, action: "buy", mint, denominatedInSol: "true", amount: amountSol, slippage: Number(cfg.slippage), priorityFee: Number(cfg.priorityFee), pool: "pump" })
    });
    if (response.status !== 200) throw new Error(`PumpPortal ${response.status}: ${(await response.text()).slice(0, 200) || response.statusText}`);
    return core().Tx.deserialize(new Uint8Array(await response.arrayBuffer()));
  }

  async function buyAndCall(coin) {
    if (busy) return;
    busy = true;
    const C = core(), label = `$${coin.ticker || "?"}`;
    let sent = false;
    try {
      const settings = await C.settings();
      if (!C.watching(settings)) return;
      const secret = await C.secret();
      if (!secret) return pause("no-wallet", "Auto callouts paused: there is no Hatchr wallet. Create or import one in Settings → Account.");
      const keypair = C.keypair(secret), pub = keypair.publicKey.toBase58();
      if (!settings.dryRun && !C.isDesktop && chrome.permissions && !await chrome.permissions.contains({ origins: PUMP_ORIGINS })) {
        return pause("no-permission", "Auto callouts paused: Hatchr is not allowed to reach pump.fun yet. Open Settings → Callouts and switch the automode on again to allow it.");
      }
      const price = await C.solPrice();
      if (!price || !(price.usd > 0)) throw new Error("no SOL price right now");
      solUsd = price.usd; solUsdAt = now();
      const amount = Math.ceil(cfg.buyUsd / solUsd * 1e6) / 1e6;
      const balance = await C.balance(settings.rpcUrl, pub);
      const needed = amount + Number(cfg.priorityFee) + Number(cfg.reserveSol) + 0.003; // 0.003: the new token account's rent and network fee
      if (balance < needed && !settings.dryRun) {
        return pause("low-balance", `Auto callouts paused: the wallet has ${balance.toFixed(4)} SOL, a buy needs ${needed.toFixed(4)} SOL including your reserve.`);
      }

      // The stream is fast but can miss things; what is on-chain right now has the last word.
      try { await verifyOnChain(coin, settings.rpcUrl); }
      catch (e) {
        if (!e.benign) throw e;
        drop(coin, [e.benign]);
        return log("info", `${label} passed your filters, but ${short(e)}. Nothing was bought.`, { mint: coin.mint, ticker: coin.ticker });
      }
      const again = F.evaluate(coin, cfg.filters, { now: now(), solUsd, clones: coin.clones });
      if (!again.pass) { drop(coin, again.tags); return; }

      const tx = await buildBuy(pub, coin.mint, amount);
      tx.sign([keypair]);
      drop(coin);
      if (settings.dryRun) {
        const sim = await C.simulate(settings.rpcUrl, tx).catch(e => ({ err: short(e) }));
        st.nextSlotAt = now() + cfg.minIntervalMin * 60000;
        log("test", `TEST: ${label} passed your filters. Would buy $${cfg.buyUsd} (${amount} SOL) and call it out.${sim.err ? ` The buy simulation failed: ${typeof sim.err === "string" ? sim.err : JSON.stringify(sim.err)}` : ""}`, { mint: coin.mint, ticker: coin.ticker });
        stopWatching();
        return;
      }

      // Dry run on the RPC first: a buy that would fail on-chain still costs its fees, so it is not sent at all.
      const trial = await C.simulate(settings.rpcUrl, tx);
      if (trial && trial.err) {
        st.nextSlotAt = Math.max(st.nextSlotAt, now() + 30000);
        return log("info", `${label} passed your filters, but the buy would have failed (${explain(trial.err)}). It was not sent, so it cost nothing.`, { mint: coin.mint, ticker: coin.ticker });
      }
      busyBuying = coin.mint;
      st.autoMints = [...st.autoMints, coin.mint].slice(-200);
      const signature = await C.send(settings.rpcUrl, tx, settings.skipPreflight);
      sent = true;
      st.buysToday++;
      st.lastBuyAt = now();
      stateDirty = true;
      stopWatching();
      let confirmError = null;
      try { await C.confirm(settings.rpcUrl, signature, 45000); } catch (e) { confirmError = e; }
      let held = await C.tokenBalance(settings.rpcUrl, pub, coin.mint).catch(() => ({ ui: 0 }));
      if (!(held.ui > 0) && !confirmError) { await wait(2500); held = await C.tokenBalance(settings.rpcUrl, pub, coin.mint).catch(() => ({ ui: 0 })); }
      if (!(held.ui > 0)) {
        // Nothing was bought, so it does not use up one of today's buys. Several in a row mean something is wrong: stop and say so.
        st.buysToday = Math.max(0, st.buysToday - 1);
        st.autoMints = st.autoMints.filter(m => m !== coin.mint);
        st.failsToday = (st.failsToday || 0) + 1;
        st.nextSlotAt = now() + 120000;
        const reason = confirmError ? explain(short(confirmError, 400)) : "";
        if (st.failsToday >= 4) return pause("buy-fails", `Auto callouts paused: ${st.failsToday} buys failed today, the last one (${label})${reason ? `: ${reason}` : ""}. Each failed buy still costs its network fee. Press Resume to carry on.`);
        log("error", `Buy of ${label} did not go through${reason ? `: ${reason}` : "."} Only the network fee was spent.`, { mint: coin.mint, ticker: coin.ticker, signature });
        return;
      }
      const item = {
        mint: coin.mint, name: coin.name, ticker: coin.ticker, description: coin.meta && coin.meta.description || "",
        image: coin.meta && coin.meta.image || "", amount: held.ui, wallet: pub, boughtAt: now(), buySol: amount, signature, tries: 0, retryAt: 0,
        curve: coin.curve, mcUsd: coin.mcSol > 0 && solUsd > 0 ? coin.mcSol * solUsd : 0
      };
      st.nextSlotAt = Math.max(st.nextSlotAt, now() + cfg.minIntervalMin * 60000); // the wait between automatic buys counts from the buy
      if (cfg.autoDelaySec > 0) kick(cfg.autoDelaySec * 1000 + 30);
      st.pending.push(item);
      log("buy", `Bought ${label} for ${amount} SOL (about $${cfg.buyUsd}). Holding ${Math.round(held.ui).toLocaleString("en-US")}.`, { mint: coin.mint, ticker: coin.ticker, signature });
      noteRecent(coin.mint, pub, held.ui);
      refreshSoon();
      await save(true);
      busy = false;
      await callOut(item);
      if (st.pending.includes(item)) kick(300); // another callout was in flight: this one follows straight after
    } catch (e) {
      drop(coin);
      st.nextSlotAt = Math.max(st.nextSlotAt, now() + 60000); // an error must not turn into a rapid loop
      log(sent ? "error" : "skip", sent ? `After buying ${label}: ${short(e)}` : `${label} passed your filters but was not bought: ${short(e)}`, { mint: coin.mint, ticker: coin.ticker });
    } finally { busy = false; busyBuying = ""; }
  }

  // ---------- callout ----------
  async function ensureHeld(item) {
    // The coin has to be in Hatchr's "coins you hold" list: that list is what the callout sender accepts.
    await core().lock(async () => {
      const { heldCoins = [] } = await chrome.storage.local.get("heldCoins");
      const id = `held:${item.mint}`;
      const at = heldCoins.findIndex(c => c.id === id);
      const entry = { mint: item.mint, amount: item.amount, wallet: item.wallet, name: item.name, ticker: item.ticker, description: item.description, image: item.image, id, ok: true, dryRun: false, auto: true };
      if (at >= 0) heldCoins[at] = { ...entry, ...heldCoins[at], amount: item.amount };
      else heldCoins.unshift(entry);
      await chrome.storage.local.set({ heldCoins });
    });
  }

  const pick = list => list[Math.floor(Math.random() * list.length)];
  async function makeText(item, settings) {
    const fill = t => F.fillText(t, item);
    if (cfg.textMode === "list" && cfg.texts.length) return fill(pick(cfg.texts));
    if (cfg.textMode === "auto" && (item.ticker || !item.own)) {
      try {
        const made = await within(core().texts(settings, { name: item.name, ticker: item.ticker, description: item.description, handle: "", postText: "", ageMin: (now() - item.boughtAt) / 60000 }, { useAi: core().useAi(settings) }), 4000); // an AI that takes over 4 s is not waited for
        const list = (made && made.texts || []).filter(t => typeof t === "string" && t.trim());
        if (list.length) return list[Math.floor(Math.random() * list.length)].trim().slice(0, 2000);
      } catch { /* fall back to your own text */ }
    }
    return fill(item.own ? cfg.ownTemplate : cfg.template);
  }

  // The texts offered in the callout window (Callouts tab). `original` is Hatchr's own generator: AI, else built-in.
  // Your saved texts replace the built-in ones; they also replace the AI's when you chose that or when the AI gives nothing.
  async function windowTexts(id, original) {
    if (!ready || !cfg.texts.length) return original(id);
    const { deploys = [], heldCoins = [] } = await chrome.storage.local.get(["deploys", "heldCoins"]);
    const coin = deploys.find(c => c.id === id) || heldCoins.find(c => c.id === id);
    if (!coin) return original(id);
    const mine = () => {
      const pool = [...cfg.texts], out = [];
      while (pool.length && out.length < 3) out.push(F.fillText(pool.splice(Math.floor(Math.random() * pool.length), 1)[0], coin));
      return { texts: out.filter(Boolean), by: "custom" };
    };
    if (cfg.textsOnly) return mine();
    let made = null;
    try { made = await original(id); } catch (e) { made = { texts: [], by: "built-in", error: short(e) }; }
    if (made && made.by === "ai" && made.texts && made.texts.length) return made;
    return { ...mine(), error: made && made.error || undefined };
  }

  const done = item => {
    st.pending = st.pending.filter(p => p !== item && p.mint !== item.mint);
    if (!watched.has(item.mint)) unsubscribe(item.mint);
    stateDirty = true;
  };

  // ---------- market cap of coins waiting for their callout ----------
  const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", USDC = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  function curveOf(mint) {
    try {
      const PK = core().PublicKey;
      return PK.findProgramAddressSync([new TextEncoder().encode("bonding-curve"), new PK(mint).toBytes()], new PK(PUMP_PROGRAM))[0].toBase58();
    } catch { return ""; }
  }
  // Market cap in $ from a bonding curve account; null when it cannot be told (unknown pricing token).
  function curveMcUsd(bytes) {
    if (!bytes || bytes.length < 49) return null;
    const vTokens = Number(readU64(bytes, 8)) / 1e6, vQuote = Number(readU64(bytes, 16));
    if (!(vTokens > 0) || !(vQuote > 0)) return null;
    const quote = bytes.length >= 115 ? bytes.subarray(83, 115) : null;
    const name = quote && quote.some(b => b !== 0) ? base58(quote) : WSOL;
    if (name === WSOL) return solUsd > 0 ? vQuote / 1e9 / vTokens * 1e9 * solUsd : null;
    if (name === USDC) return vQuote / 1e6 / vTokens * 1e9;
    return null;
  }
  let mcAt = 0;
  // Keeps the market cap of every coin that waits for one up to date: live from pump.fun's stream, and read from the
  // chain every few seconds (one request for all of them) in case the stream is quiet.
  async function trackWaiting() {
    const need = st.pending.filter(p => rule(p).minMc !== null);
    if (!need.length) return;
    if (!(solUsd > 0)) { try { const price = await core().solPrice(); if (price && price.usd > 0) { solUsd = price.usd; solUsdAt = now(); } } catch { /* next round */ } }
    for (const p of need) if (!(p.mcUsd > 0) && p.mcSol > 0 && solUsd > 0) { p.mcUsd = p.mcSol * solUsd; p.mcAt = now(); } // seen before the SOL price was known
    for (const p of need) { if (!p.curve) p.curve = curveOf(p.mint); subscribe(p.mint); }
    if (now() - mcAt < 4000 || !rpcUrl) return;
    mcAt = now();
    const withCurve = need.filter(p => p.curve).slice(0, 100);
    if (!withCurve.length) return;
    try {
      const got = await core().rpc(rpcUrl, "getMultipleAccounts", [withCurve.map(p => p.curve), { encoding: "base64", commitment: "confirmed" }]);
      (got && got.value || []).forEach((account, i) => {
        const b64 = account && account.data && account.data[0];
        if (!b64) return;
        const bytes = Uint8Array.from(atob(b64), c => c.charCodeAt(0)), item = withCurve[i];
        item.offCurve = bytes[48] === 1; // left the bonding curve: this number is where it stood when it left, a floor
        const mc = curveMcUsd(bytes);
        if (mc !== null && (!item.offCurve || !(item.mcUsd > mc))) { item.mcUsd = mc; item.mcAt = now(); }
      });
      stateDirty = true;
    } catch { /* next round */ }
  }
  // Announces a wait once, and drops coins whose wait has run out.
  function reviewWaiting() {
    while (st.pending.length > 300) done(st.pending[0]); // a queue this long means the oldest will never be reached
    for (const item of [...st.pending]) {
      const r = rule(item), label = item.ticker ? `$${item.ticker}` : "the coin you bought", tag = { mint: item.mint, ticker: item.ticker };
      if (!waiting(item)) continue;
      if (item.own && !item.ticker && !item.nameTried) { item.nameTried = true; nameOf(item).then(() => { stateDirty = true; }, () => {}); continue; } // its name first, then say what it waits for
      if (!item.waitSaid) {
        item.waitSaid = true;
        const parts = [];
        if (now() < item.boughtAt + r.delay * 1000) parts.push(`in ${r.delay} s`);
        if (r.minMc !== null) parts.push(`once its market cap reaches ${money(r.minMc)}${item.mcUsd > 0 ? ` (now ${money(item.mcUsd)})` : ""}`);
        log("info", `${item.own ? "You bought" : "Holding"} ${label}. Its callout goes out ${parts.join(" and ")}.`, tag);
      }
      if (r.minMc !== null && cfg.waitMaxMin !== null && now() - item.boughtAt > cfg.waitMaxMin * 60000 && now() >= item.boughtAt + r.delay * 1000) {
        done(item);
        log("skip", `${label} did not reach ${money(r.minMc)} within ${cfg.waitMaxMin} min${item.mcUsd > 0 ? ` (it stands at ${money(item.mcUsd)})` : ""}, so it was not called out.`, tag);
      }
    }
  }

  // Name and ticker of a coin you bought yourself, when the stream did not carry them.
  const within = (promise, ms) => Promise.race([promise, new Promise(resolve => setTimeout(() => resolve(null), ms))]);
  // Name and ticker of a coin you bought yourself. Quick sources only, and never more than 1.2 s: a callout that is
  // a second late is worse than one that says "this one" instead of the ticker.
  async function nameOf(item) {
    const seen = index.find(item.mint);
    if (seen && seen.ticker) { item.name = seen.name; item.ticker = seen.ticker; return; }
    try {
      const { heldCoins = [], metaTokens = {} } = await chrome.storage.local.get(["heldCoins", "metaTokens"]);
      const known = heldCoins.find(c => c.mint === item.mint && c.ticker) || (metaTokens[item.mint] && metaTokens[item.mint].ticker ? metaTokens[item.mint] : null);
      if (known) { item.name = known.name || ""; item.ticker = known.ticker || ""; return; }
      const asset = await within(core().rpc(rpcUrl, "getAsset", { id: item.mint }).catch(() => null), 1200); // Helius and other DAS RPCs
      const meta = asset && asset.content && asset.content.metadata;
      if (meta && meta.symbol) { item.name = String(meta.name || "").slice(0, 60); item.ticker = String(meta.symbol).slice(0, 16); }
    } catch { /* the callout goes out without the ticker in its text */ }
  }

  let calling = false; // one callout at a time; separate from `busy`, so a buy in progress never holds a callout back
  async function callOut(item) {
    if (calling) return;
    calling = true;
    const C = core(), tag = { mint: item.mint, ticker: item.ticker };
    let label = `$${item.ticker || "?"}`;
    try {
      const settings = await C.settings();
      // Only a coin the wallet holds right now is called.
      let held;
      if (waiting(item)) return; // its moment has not come (settings changed meanwhile)
      if (item.own && item.seen > 0 && now() - item.boughtAt < 15000) held = { ui: item.seen }; // the buy itself was just seen with the coins arriving: no waiting for the RPC's slower wallet list
      else {
        held = await C.tokenBalance(settings.rpcUrl, item.wallet, item.mint).catch(() => ({ ui: 0 }));
        if (!(held.ui > 0)) {
          const lag = item.lag || 0;
          if (item.own && lag < 8 && now() - item.boughtAt < 20000) { item.lag = lag + 1; item.retryAt = now() + 1200; kick(1250); return; } // a fresh buy the RPC does not list yet
          if (now() - item.boughtAt > 15000 && lag < 2) { item.lag = lag + 1; item.retryAt = now() + 2000; kick(2050); return; } // one more look before deciding it was sold
          done(item);
          return log("skip", `${label} is no longer in the wallet${now() - item.boughtAt > 15000 ? " (sold before its callout was due)" : ""}, so it was not called.`, tag);
        }
      }
      item.amount = held.ui;
      if (item.own && !item.ticker) { await nameOf(item); tag.ticker = item.ticker; label = item.ticker ? `$${item.ticker}` : "the coin you bought"; }
      if (item.own && !item.announced) { item.announced = true; log("info", `You bought ${label} (seen by the ${item.via || "wallet check"}, ${Math.max(0, Math.round((now() - item.boughtAt) / 100) / 10)}s ago). Sending its callout.`, tag); }
      if (settings.dryRun) {
        done(item);
        return log("test", `TEST: ${item.own ? "you bought" : "holding"} ${label}. Would call it out: "${(await makeText(item, settings)).slice(0, 120)}"`, tag);
      }
      await ensureHeld(item);
      const text = await makeText(item, settings);
      const postAt = Date.now();
      const result = await globalThis.HatchrCallouts.create({ id: `held:${item.mint}`, mint: item.mint, text }, (id, patch) => C.saveHeld(id, patch));
      const postMs = Date.now() - postAt, secs = ms => `${Math.max(0, Math.round(ms / 100) / 10)} s`;
      const gap = cfg.minIntervalMin * 60000;
      if (result.sent) {
        done(item);
        st.called = keep(st.called, item.mint, 600);
        st.callsToday++; st.lastCallAt = now();
        if (!item.own) st.nextSlotAt = now() + gap; // your own buys do not push the automatic buys back
        // Where the time went, so a slow callout can be traced: Hatchr's part, pump.fun's answer, and any refusals before it.
        const timing = item.own ? ` — ${secs(now() - item.boughtAt)} after Hatchr saw the buy (pump.fun took ${secs(postMs)} to answer${item.tries ? `, after refusing ${item.tries} time${item.tries === 1 ? "" : "s"} because it did not see your coins yet` : ""})` : "";
        log("call", `Called out ${label}: "${text.slice(0, 120)}"${timing}`, { ...tag, url: result.url });
        if (settings.notifyDeploys) C.notify(`Callout sent for ${label}`, text, `coauto-${item.mint}`);
        return;
      }
      switch (result.reason) {
        case "unknown":
          done(item);
          st.called = keep(st.called, item.mint, 600);
          st.callsToday++; st.lastCallAt = now(); st.nextSlotAt = now() + gap;
          return log("error", `The callout for ${label} may or may not have been posted. Check pump.fun; Hatchr does not send it twice.`, tag);
        case "has-live-callout":
          done(item);
          st.called = keep(st.called, item.mint, 600);
          return log("skip", `${label} already has a live callout from you.`, tag);
        case "in-progress":
          item.retryAt = now() + 15000;
          return;
        case "cannot-call":
          item.tries++;
          if (item.own) {
            // pump.fun's own records lag behind the chain by a few seconds after a buy: keep trying for about two minutes.
            const waits = [1500, 2500, 4000, 8000, 15000, 30000, 60000];
            if (item.tries <= waits.length) {
              if (item.tries === 1) log("info", `pump.fun does not show your ${label} yet. Trying again every few seconds.`, tag);
              item.retryAt = now() + waits[item.tries - 1]; kick(waits[item.tries - 1] + 50);
              return;
            }
            done(item);
            st.ownTried[item.mint] = now();
            return log("error", `pump.fun would not take the callout for ${label}: the account signed in on pump.fun does not hold $1 of it. Check that the wallet that bought it is linked to that pump.fun account.`, tag);
          }
          if (item.tries >= 4) {
            done(item);
            st.nextSlotAt = now() + 600000;
            return log("error", `pump.fun would not take the callout for ${label}: the signed-in account does not hold $1 of it. Check that the wallet that bought it is linked to that pump.fun account${item.own ? "" : ", or raise the buy size"}.`, tag);
          }
          item.retryAt = now() + 20000; // pump.fun needs a moment to see a fresh buy
          return;
        case "rate-limited":
          item.retryAt = now() + 30 * 60000;
          st.nextSlotAt = Math.max(st.nextSlotAt, item.retryAt);
          return log("info", `pump.fun is limiting callouts. ${label} stays queued and is tried again in 30 minutes.`, tag);
        case "not-signed-in":
          return pause("not-signed-in", `Auto callouts paused: sign in on pump.fun${C.isDesktop ? " in Hatchr's Pump.fun window" : " in this Chrome profile"}, then press Resume. ${label} stays queued.`);
        case "no-permission":
          return pause("no-permission", `Auto callouts paused: Hatchr is not allowed to reach pump.fun. Switch the automode on again in Settings → Callouts to allow it. ${label} stays queued.`);
        case "no-pump-page":
          item.tries++;
          if (item.tries >= 3) return pause("no-pump-page", `Auto callouts paused: pump.fun could not be opened to send the callout. ${label} stays queued; press Resume to try again.`);
          item.retryAt = now() + 30000;
          return;
        case "forbidden":
          return pause("forbidden", `Auto callouts paused: pump.fun refused access. Check your login or any verification on pump.fun, then press Resume. ${label} stays queued.`);
        default:
          done(item);
          if (item.own) st.ownTried[item.mint] = now();
          else st.nextSlotAt = Math.max(st.nextSlotAt, now() + 300000);
          return log("error", `pump.fun refused the callout for ${label}${result.detail ? `: ${String(result.detail).slice(0, 160)}` : "."}`, tag);
      }
    } catch (e) {
      item.tries++;
      const again = item.tries <= 2 ? 3000 : 60000; // a passing hiccup is retried at once, a lasting one slowly
      item.retryAt = now() + again; kick(again + 50);
      if (item.tries >= 5) { done(item); log("error", `Gave up calling out ${label}: ${short(e)}`, tag); }
    } finally { calling = false; stateDirty = true; save(true); }
  }

  // ---------- a pump.fun tab kept ready ----------
  // A callout leaves from a pump.fun tab (pump.fun only answers its own pages). Without one open, Chrome first has to
  // open and load a tab for every single callout, which costs seconds. So one small pinned tab is kept in the background.
  let tabAt = 0, testMode = true;
  async function warmTab() {
    if (!cfg.keepTab || !(cfg.enabled || cfg.ownBuys) || !mainOn || testMode || !core() || core().isDesktop || !chrome.tabs || now() - tabAt < 30000) return;
    tabAt = now();
    try {
      if (chrome.permissions && !await chrome.permissions.contains({ origins: PUMP_ORIGINS })) return;
      const open = (await chrome.tabs.query({ url: "https://pump.fun/*" })).filter(t => !t.discarded);
      const tab = open[0] || await chrome.tabs.create({ url: "https://pump.fun/robots.txt", active: false, pinned: true });
      if (tab && tab.autoDiscardable !== false) await chrome.tabs.update(tab.id, { autoDiscardable: false }); // Chrome's memory saver would put it to sleep
    } catch { /* without the tab a callout still works, only slower */ }
  }

  // Pauses that are about buying say nothing about whether a callout can be sent: your own buys still go out.
  const BUY_PAUSES = ["low-balance", "no-wallet", "buy-fails"];
  async function callPending() {
    if (calling || !st.pending.length) return;
    const blocked = p => st.paused && !(p.own && BUY_PAUSES.includes(st.paused));
    const item = st.pending.find(p => now() >= (p.retryAt || 0) && !blocked(p) && !waiting(p)); // your own buys do not wait behind a coin that is backing off or waiting
    if (!item) return;
    if (!item.own && cfg.maxPerDay !== 0 && st.callsToday >= cfg.maxPerDay) return; // the daily number limits the automatic buys, not your own
    await callOut(item);
  }

  // ---------- start-up, settings, messages ----------
  function wantsStream() { return ready && (cfg.enabled || cfg.ownBuys) && mainOn; }

  async function applyConfig(next, { fromUser = false } = {}) {
    const wasOwn = cfg.ownBuys;
    cfg = F.cleanConfig(next);
    const on = cfg.enabled || cfg.ownBuys;
    if (fromUser && st.paused) { st.paused = ""; stateDirty = true; }
    if (!cfg.enabled) stopWatching();
    if (!cfg.ownBuys && wasOwn) { st.pending = st.pending.filter(p => !p.own); stateDirty = true; }
    try {
      if (chrome.alarms) {
        if (on) chrome.alarms.create(ALARM, { periodInMinutes: 1 });
        else chrome.alarms.clear(ALARM);
      }
    } catch { /* no alarms here (desktop app): the timers below cover it */ }
    if (on && st.pending.length) startTicker();
    if (cfg.ownBuys && !slow) slow = setInterval(() => tick().catch(() => {}), 10000); // the wallet check: Chrome's alarms only come once a minute
    if (!cfg.ownBuys && slow) { clearInterval(slow); slow = null; }
    mainAt = 0; walletsAt = 0;
    await refreshMain();
    try { await core().reconnect(); } catch { /* the watchdog reconnects */ }
    followWallets();
    feed(false);
    save(true);
  }

  async function init() {
    for (let i = 0; i < 100 && !core(); i++) await wait(50); // background.js sets HatchrCore at the end of its own start-up
    if (!core()) return;
    try {
      const got = await chrome.storage.local.get([CONFIG_KEY, STATE_KEY]);
      const saved = got[STATE_KEY];
      if (saved && typeof saved === "object") {
        st = { ...freshState(), ...saved, pending: Array.isArray(saved.pending) ? saved.pending : [], log: Array.isArray(saved.log) ? saved.log : [], skips: saved.skips && typeof saved.skips === "object" ? saved.skips : {},
          autoMints: Array.isArray(saved.autoMints) ? saved.autoMints : [], called: Array.isArray(saved.called) ? saved.called : [],
          ownSigs: Array.isArray(saved.ownSigs) ? saved.ownSigs : [], ownLast: saved.ownLast && typeof saved.ownLast === "object" ? saved.ownLast : {},
          ownTried: saved.ownTried && typeof saved.ownTried === "object" ? saved.ownTried : {} };
        delete st.ownKnown; delete st.ownBaseline; delete st.ownWallets; // from 3.6.0 / 3.6.1
        delete st.watching; delete st.at;
        const cut = now() - 3600000; // forget refusals older than an hour
        for (const k of Object.keys(st.ownTried || {})) if (!(st.ownTried[k] > cut)) delete st.ownTried[k];
      }
      if (chrome.storage.session) index.load((await chrome.storage.session.get(INDEX_KEY))[INDEX_KEY]);
      ready = true;
      rollDay();
      // Up to 3.6.6 a fresh setup waited 180 minutes between automatic buys, which read like a time-out by the app.
      // That default is 0 now. A setup still on the old 180 is moved over once; a wait you set yourself later is kept.
      let config = got[CONFIG_KEY];
      if (!st.noWaitMoved) {
        st.noWaitMoved = true; stateDirty = true;
        if (config && Number(config.minIntervalMin) === 180) {
          config = { ...config, minIntervalMin: 0 };
          st.nextSlotAt = 0;
          await chrome.storage.local.set({ [CONFIG_KEY]: F.cleanConfig(config), coAutoWhy: { why: "no-wait", at: now() } });
          log("info", "The 180-minute wait between automatic buys is switched off (it was the old default, not something you set). Minutes between callouts is 0 now; change it under Settings → Callouts if you want a wait.");
        }
      }
      await applyConfig(config);
    } catch (e) { console.warn("callout automode failed to start", e); ready = true; }
  }

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area === "local" && changes[CONFIG_KEY] && ready) applyConfig(changes[CONFIG_KEY].newValue).catch(() => {});
      if (area === "local" && changes.settings) {
        // Hatchr's main switch: off means this automode is off too, stream included.
        const next = changes.settings.newValue, on = !next || next.watching !== false;
        mainAt = 0;
        if (on !== mainOn) { mainOn = on; if (!on) stopWatching(); if (ready && (cfg.enabled || cfg.ownBuys)) core()?.reconnect().catch(() => {}); }
        if (ready) loadWallets().catch(() => {}); // "Wallet you use on pump.fun" may have changed
      }
      if (area === "local" && changes.walletSecret && ready) loadWallets().catch(() => {});
    });
    if (chrome.alarms) chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM) tick().catch(() => {}); });
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      const type = message && message.type;
      if (type !== "coAutoGet" && type !== "coAutoSave" && type !== "coAutoResume" && type !== "coAutoClearLog" && type !== "coAutoSkipWait") return false;
      if (sender?.id !== chrome.runtime.id || sender?.url !== chrome.runtime.getURL("sidepanel.html")) { respond({ ok: false, error: "Not allowed from here" }); return false; }
      (async () => {
        for (let i = 0; i < 60 && !ready; i++) await wait(50);
        if (type === "coAutoSave") {
          const next = F.cleanConfig(message.config), ownWasOn = cfg.ownBuys;
          await chrome.storage.local.set({ [CONFIG_KEY]: next });
          await applyConfig(next, { fromUser: true });
          // A new waiting time counts at once, also for a wait that is already running.
          st.nextSlotAt = Math.max(st.lastBuyAt || 0, st.lastCallAt || 0) + next.minIntervalMin * 60000;
          stateDirty = true; await save(true);
          // Switching "own buys" on starts from this moment: buys made before it are not called.
          if (next.ownBuys && !ownWasOn) { st.ownSince = now(); st.ownLast = {}; st.ownAt = 0; stateDirty = true; await checkWallets().catch(() => {}); await save(true); }
        } else if (type === "coAutoResume") {
          st.paused = ""; stateDirty = true;
          if (st.pending.length) { st.pending.forEach(p => { p.tries = 0; p.retryAt = 0; }); startTicker(); }
          await save(true);
        } else if (type === "coAutoSkipWait") {
          st.nextSlotAt = 0; stateDirty = true; await save(true);
        } else if (type === "coAutoClearLog") {
          st.log = []; stateDirty = true; await save(true);
        }
        return { config: cfg, state: publicState(), live: !!socket(), wallets: myWallets, walletFeed: feedLive };
      })().then(data => respond({ ok: true, data }), e => respond({ ok: false, error: short(e) }));
      return true;
    });
  } catch (e) { console.warn("callout automode listeners", e); }

  globalThis.HatchrCalloutAuto = Object.freeze({ wantsStream, onStream, onOpen, windowTexts, scanHeld });
  init();
})();
