/* Copy trade: when a wallet you follow buys a coin, Hatchr buys it too, at once; when it sells, Hatchr sells the same
   share of its own position (optional). Each wallet can have its own size, its own sell rule and its own exits, and
   can be followed for everything it buys, or only for the coins it creates itself (its own launches).
   Fast path: a live line to your own RPC (logsSubscribe at "processed", one per wallet). pump.fun and PumpSwap write
   every trade into the transaction's log as an event (TradeEvent / BuyEvent / SellEvent); Hatchr reads coin, side and
   size straight from that log line, so nothing has to be looked up before the copy is built. Trades elsewhere
   (Raydium, Meteora, Jupiter…) are read from the transaction itself, which takes about a second longer.
   The copy is built by trade-routes.js (PumpPortal, or Jupiter) and sent without the RPC's own dry run.
   Runs in the background next to background.js, which hands over what it needs as globalThis.HatchrCore. */
(() => {
  "use strict";
  if (globalThis.HatchrCopy) return;
  const CONFIG_KEY = "copyTrade", STATE_KEY = "copyTradeState", ALARM = "copyTradeTick";
  const core = () => globalThis.HatchrCore;
  const R = () => globalThis.HatchrRoutes;
  const now = () => Date.now();
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const short = (e, n = 200) => String(e && e.message || e || "").slice(0, n);
  const today = () => new Date().toISOString().slice(0, 10);

  // ---------- settings ----------
  const DEFAULTS = Object.freeze({
    enabled: false,
    wallets: Object.freeze([]), // [{ address, label, on, what, size, sol, ratioPct, maxSol, sells, exits, ownExits }]
    sizeMode: "fixed",       // "fixed": always buySol; "ratio": ratioPct % of what they spent
    buySol: 0.1,
    ratioPct: 100,
    maxSol: 1,               // never more than this per copy (0 = no cap)
    minTheirSol: 0,          // ignore their buys smaller than this (dust, tests)
    copySells: true,         // when they sell, sell the same share
    onlyCopied: true,        // …but only coins Hatchr bought by copying
    oncePerCoin: true,       // copy their first buy of a coin only, not every top-up
    onlyPump: false,         // only pump.fun coins (address ends in "pump")
    maxAgeSec: 10,           // a trade seen later than this is not copied (the slow path only; 0 = any)
    slippage: 30,
    priorityFee: 0.001,
    reserveSol: 0.02,
    maxPerDay: 0,            // buys per day (0 = no limit)
    boost: false,            // ⚡ the network's fee of the moment (capped) and Boost slippage instead of the fields
    exits: null              // automatic exits for copied coins (positions.js), unless a wallet has its own
  });
  const WHAT = ["buys", "launches", "both"], SIZES = ["default", "fixed", "ratio"], SELLS = ["default", "copy", "no"], EXIT_MODES = ["default", "own", "none"];
  const cleanExits = x => (globalThis.HatchrPositions ? globalThis.HatchrPositions.cleanExits(x) : x && typeof x === "object" ? x : null);
  const num = (v, fallback) => { if (v === null || v === undefined || v === "" || typeof v === "boolean") return fallback; const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) && n >= 0 ? n : fallback; };
  const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  // "label: address", "address label", or just the address; one per line (or an array from a backup)
  function walletList(v) {
    const lines = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\n+/) : [];
    const out = [];
    for (const line of lines) {
      if (line && typeof line === "object") { if (ADDRESS.test(String(line.address || "").trim())) out.push(cleanWallet(line)); continue; }
      const words = String(line || "").replace(/[,;]/g, " ").split(/\s+|:\s*/).map(w => w.trim()).filter(Boolean);
      const address = words.find(w => ADDRESS.test(w));
      if (!address) continue;
      out.push(cleanWallet({ address, label: words.filter(w => w !== address).join(" ").replace(/:$/, "") }));
    }
    const seen = new Set();
    return out.filter(w => !seen.has(w.address) && seen.add(w.address)).slice(0, 50);
  }
  // one followed wallet: "default" means the page's general setting
  function cleanWallet(w) {
    const maybe = v => (v === null || v === undefined || v === "" ? null : num(v, null));
    return {
      address: String(w.address).trim(), label: String(w.label || "").trim().slice(0, 30), on: w.on !== false,
      what: WHAT.includes(w.what) ? w.what : "both", // a coin a followed wallet creates is copied unless you say otherwise
      size: SIZES.includes(w.size) ? w.size : "default", sol: maybe(w.sol), ratioPct: maybe(w.ratioPct), maxSol: maybe(w.maxSol),
      sells: SELLS.includes(w.sells) ? w.sells : "default",
      exits: EXIT_MODES.includes(w.exits) ? w.exits : "default", ownExits: w.exits === "own" || w.ownExits ? cleanExits(w.ownExits) : null
    };
  }
  function clean(input) {
    const c = input && typeof input === "object" ? input : {};
    // 3.9.0 saved "their buys" for every wallet by default, which skipped a coin they created without buying it
    // themselves; from 3.9.1 the default is buys + launches. A setting saved by 3.9.1 or later (v 2) stays as chosen.
    const wallets = walletList(c.wallets).map(w => (c.v === 2 || w.what !== "buys" ? w : { ...w, what: "both" }));
    return {
      v: 2,
      enabled: c.enabled === true,
      wallets,
      sizeMode: c.sizeMode === "ratio" ? "ratio" : "fixed",
      buySol: num(c.buySol, DEFAULTS.buySol) || DEFAULTS.buySol,
      ratioPct: num(c.ratioPct, DEFAULTS.ratioPct),
      maxSol: num(c.maxSol, DEFAULTS.maxSol),
      minTheirSol: num(c.minTheirSol, DEFAULTS.minTheirSol),
      copySells: c.copySells !== false,
      onlyCopied: c.onlyCopied !== false,
      oncePerCoin: c.oncePerCoin !== false,
      onlyPump: c.onlyPump === true,
      maxAgeSec: num(c.maxAgeSec, DEFAULTS.maxAgeSec),
      slippage: num(c.slippage, DEFAULTS.slippage),
      priorityFee: num(c.priorityFee, DEFAULTS.priorityFee),
      reserveSol: num(c.reserveSol, DEFAULTS.reserveSol),
      maxPerDay: Math.floor(num(c.maxPerDay, DEFAULTS.maxPerDay)),
      boost: c.boost === true,
      exits: cleanExits(c.exits)
    };
  }
  // what applies to one wallet
  const walletOf = address => cfg.wallets.find(w => w.address === address) || cleanWallet({ address });
  function sizeFor(w, theirSol, launch) {
    const mode = w.size === "default" ? cfg.sizeMode : w.size;
    const fixed = w.size === "fixed" && w.sol ? w.sol : cfg.buySol;
    const cap = w.size !== "default" && w.maxSol !== null ? w.maxSol : cfg.maxSol;
    // a launch has no buy of theirs to take a share of: the fixed amount
    let sol = mode === "ratio" && !launch ? theirSol * (w.size === "ratio" && w.ratioPct !== null ? w.ratioPct : cfg.ratioPct) / 100 : fixed;
    if (mode === "ratio" && cap > 0) sol = Math.min(sol, cap); // the cap belongs to the share; a fixed amount is what it says
    return Math.floor(sol * 1e6) / 1e6;
  }
  const sellsFor = w => (w.sells === "default" ? cfg.copySells : w.sells === "copy");
  const exitsFor = w => (w.exits === "none" ? null : w.exits === "own" ? w.ownExits : cfg.exits);

  // ---------- reading trades from a transaction's log ----------
  const b64 = s => Uint8Array.from(atob(s), c => c.charCodeAt(0));
  const same = (bytes, d) => d.every((x, i) => bytes[i] === x);
  const TRADE = [189, 219, 127, 211, 78, 230, 97, 238];    // pump.fun TradeEvent
  const AMM_BUY = [103, 244, 82, 31, 44, 245, 119, 119];   // PumpSwap BuyEvent
  const AMM_SELL = [62, 47, 55, 10, 165, 3, 220, 42];      // PumpSwap SellEvent
  const CREATE = [27, 114, 169, 77, 222, 235, 99, 118];    // pump.fun CreateEvent: name, symbol, uri (u32 length + text), mint, curve, user, creator
  const u64 = (bytes, o) => { let v = 0n; for (let i = 7; i >= 0; i--) v = (v << 8n) | BigInt(bytes[o + i]); return v; };
  const key = (bytes, o) => R().base58(bytes.subarray(o, o + 32));
  // The trades this wallet made in a transaction, from its log lines. Layouts from pump.fun's published IDL:
  //   TradeEvent: mint @8, sol_amount @40, token_amount @48, is_buy @56, user @57
  //   PumpSwap Buy/SellEvent: base amount @16, user's base balance before @32, quote amount @64, pool @120, user @152
  function parseLogs(logs, wallet) {
    const out = [];
    for (const line of Array.isArray(logs) ? logs : []) {
      if (typeof line !== "string" || !line.startsWith("Program data: ")) continue;
      let bytes;
      try { bytes = b64(line.slice(14).trim()); } catch { continue; }
      if (bytes.length > 20 && same(bytes, CREATE)) {
        let o = 8;
        const text = () => { const n = bytes[o] | (bytes[o + 1] << 8) | (bytes[o + 2] << 16) | (bytes[o + 3] << 24); if (n < 0 || n > 400 || o + 4 + n > bytes.length) throw new Error("bad"); const v = new TextDecoder().decode(bytes.subarray(o + 4, o + 4 + n)); o += 4 + n; return v; };
        try {
          const name = text(), symbol = text(); text();
          if (o + 128 > bytes.length) continue;
          const mint = key(bytes, o), user = key(bytes, o + 64), creator = key(bytes, o + 96);
          if (user === wallet || creator === wallet) out.push({ side: "create", mint, name: name.slice(0, 60), symbol: symbol.slice(0, 20), sol: 0, tokens: 0n, before: null, venue: "their own launch" });
        } catch { /* not readable */ }
      } else if (bytes.length >= 89 && same(bytes, TRADE)) {
        if (key(bytes, 57) !== wallet) continue;
        out.push({ side: bytes[56] ? "buy" : "sell", mint: key(bytes, 8), sol: Number(u64(bytes, 40)) / 1e9, tokens: u64(bytes, 48), before: null, venue: "pump.fun" });
      } else if (bytes.length >= 184 && (same(bytes, AMM_BUY) || same(bytes, AMM_SELL))) {
        if (key(bytes, 152) !== wallet) continue;
        const buy = same(bytes, AMM_BUY);
        out.push({ side: buy ? "buy" : "sell", pool: key(bytes, 120), mint: "", sol: Number(u64(bytes, 64)) / 1e9, tokens: u64(bytes, 16), before: buy ? null : u64(bytes, 32), venue: "PumpSwap" });
      }
    }
    return out;
  }
  // Any other venue: what the transaction did to the wallet's token balances (and SOL), read from the RPC.
  const NOT_COINS = new Set(["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"]);
  async function readTx(signature, wallet) {
    let tx = null;
    for (let i = 0; i < 6 && !tx; i++) {
      if (i) await wait(400);
      tx = await core().rpc(hot.rpcUrl, "getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]).catch(() => null);
    }
    if (!tx || !tx.meta || tx.meta.err) return { trades: [], blockTime: tx && tx.blockTime };
    const message = tx.transaction && tx.transaction.message, keys = (message && message.accountKeys || []).map(k => typeof k === "string" ? k : k && k.pubkey);
    const signers = keys.slice(0, message && message.header && message.header.numRequiredSignatures || 1);
    if (!signers.includes(wallet)) return { trades: [], blockTime: tx.blockTime }; // something sent TO them, not a trade of theirs
    const total = list => { const m = new Map(); for (const b of list || []) if (b && b.owner === wallet && b.mint) m.set(b.mint, (m.get(b.mint) || 0n) + BigInt(b.uiTokenAmount && b.uiTokenAmount.amount || "0")); return m; };
    const before = total(tx.meta.preTokenBalances), after = total(tx.meta.postTokenBalances);
    const i = keys.indexOf(wallet), solDelta = i >= 0 ? (Number(tx.meta.postBalances[i]) - Number(tx.meta.preBalances[i])) / 1e9 : 0;
    const trades = [];
    for (const mint of new Set([...before.keys(), ...after.keys()])) {
      if (NOT_COINS.has(mint)) continue;
      const a = before.get(mint) || 0n, b = after.get(mint) || 0n;
      if (b > a) trades.push({ side: "buy", mint, sol: Math.max(0, -solDelta), tokens: b - a, before: a, venue: "swap" });
      else if (b < a) trades.push({ side: "sell", mint, sol: Math.max(0, solDelta), tokens: a - b, before: a, venue: "swap" });
    }
    return { trades, blockTime: tx.blockTime };
  }
  const pools = new Map(); // PumpSwap pool -> its coin (base mint @43)
  async function poolCoin(pool) {
    if (pools.has(pool)) return pools.get(pool);
    const got = await core().rpc(hot.rpcUrl, "getAccountInfo", [pool, { encoding: "base64", commitment: "processed", dataSlice: { offset: 43, length: 32 } }]);
    const data = got && got.value && got.value.data && got.value.data[0];
    const mint = data ? R().base58(b64(data)) : "";
    if (mint) { pools.set(pool, mint); if (pools.size > 500) pools.delete(pools.keys().next().value); }
    return mint;
  }

  // ---------- state ----------
  let cfg = clean(null), ready = false;
  let st = fresh();
  // made: coins the followed wallets created (mint -> wallet)
  function fresh() { return { day: today(), buysToday: 0, coins: {}, sigs: [], log: [], last: {}, made: {} }; }
  function rollDay() { if (st.day !== today()) { st.day = today(); st.buysToday = 0; } }
  let saveTimer = null;
  function save() { if (!saveTimer) saveTimer = setTimeout(() => { saveTimer = null; chrome.storage.local.set({ [STATE_KEY]: { ...st, at: now() } }).catch(() => {}); }, 300); }
  function log(kind, text, extra = {}) {
    st.log.unshift({ at: now(), kind, text: String(text).slice(0, 440), ...extra });
    if (st.log.length > 80) st.log.length = 80;
    save();
  }
  const nameOf = address => { const w = cfg.wallets.find(x => x.address === address); return w && w.label ? w.label : `${address.slice(0, 4)}…${address.slice(-4)}`; };

  // kept ready in memory, so a copy never waits for a look-up
  const hot = { keypair: null, pub: "", rpcUrl: "", dryRun: true, balance: null, balanceAt: 0, at: 0, fee: null };
  const fee = () => (cfg.boost && hot.fee ? hot.fee.fee : cfg.priorityFee);
  const slip = () => (cfg.boost ? R().BOOST_SLIPPAGE.copy : cfg.slippage);
  async function reload() {
    const C = core();
    if (!C) return;
    try {
      const { settings } = await chrome.storage.local.get("settings");
      hot.rpcUrl = String(settings && settings.rpcUrl || (await C.settings()).rpcUrl || "");
      hot.dryRun = !settings || settings.dryRun !== false;
      const secret = await C.secret();
      hot.keypair = secret ? C.keypair(secret) : null;
      hot.pub = hot.keypair ? hot.keypair.publicKey.toBase58() : "";
      hot.at = now();
    } catch { /* keeps what it had */ }
  }
  async function warm() {
    if (!cfg.enabled) return;
    if (now() - hot.at > 120000) await reload();
    try { R().warm(); } catch { /* routes not loaded yet */ }
    if (hot.pub && hot.rpcUrl) { try { hot.balance = await core().balance(hot.rpcUrl, hot.pub); hot.balanceAt = now(); } catch { /* keeps the last one */ } }
    if (cfg.boost && hot.rpcUrl) { try { hot.fee = await R().feeEstimate(hot.rpcUrl); } catch { /* keeps the last one */ } }
  }

  // ---------- the live line to the RPC ----------
  let socket = null, socketUrl = "", socketFor = "", live = false, retry = 0, retryTimer = null, ping = null, subs = new Map();
  function connect(restart) {
    const followed = cfg.wallets.filter(w => w.on).map(w => w.address);
    const want = ready && cfg.enabled && followed.length && /^https?:\/\//i.test(hot.rpcUrl) && typeof WebSocket !== "undefined";
    const url = want ? hot.rpcUrl.replace(/^http/i, "ws") : "";
    if (socket && (restart || url !== socketUrl || !want || followed.join() !== socketFor)) { const old = socket; socket = null; live = false; clearInterval(ping); try { old.close(); } catch { /* gone */ } }
    if (!want || socket || retryTimer) return;
    let ws;
    try { ws = new WebSocket(url); } catch { return; }
    socket = ws; socketUrl = url; subs = new Map(); socketFor = followed.join();
    const wallets = followed;
    ws.onopen = () => {
      if (socket !== ws) return;
      retry = 0;
      wallets.forEach((wallet, i) => ws.send(JSON.stringify({ jsonrpc: "2.0", id: i + 1, method: "logsSubscribe", params: [{ mentions: [wallet] }, { commitment: "processed" }] })));
      clearInterval(ping); // a message every 20 s also keeps the background awake
      ping = setInterval(() => { try { ws.send(JSON.stringify({ jsonrpc: "2.0", id: 9999, method: "getHealth" })); } catch { /* closing */ } }, 20000);
    };
    ws.onmessage = event => {
      let msg;
      try { msg = JSON.parse(event.data); } catch { return; }
      if (typeof msg.id === "number" && msg.id >= 1 && msg.id <= wallets.length && typeof msg.result === "number") { subs.set(msg.result, wallets[msg.id - 1]); live = subs.size > 0; return; }
      if (msg.method !== "logsNotification") return;
      const value = msg.params && msg.params.result && msg.params.result.value, wallet = subs.get(msg.params && msg.params.subscription);
      if (value && !value.err && value.signature && wallet) onTx(value.signature, value.logs, wallet, now());
    };
    const lost = () => {
      if (socket !== ws) return;
      socket = null; live = false; clearInterval(ping);
      const delay = Math.min(30000, 1000 * 2 ** Math.min(retry++, 5));
      retryTimer = setTimeout(() => { retryTimer = null; connect(false); }, delay);
    };
    ws.onclose = lost; ws.onerror = lost;
  }

  // ---------- a transaction of a wallet you follow ----------
  function onTx(signature, logs, wallet, seenAt) {
    if (!cfg.enabled || st.sigs.includes(signature)) return;
    st.sigs.push(signature); if (st.sigs.length > 500) st.sigs.splice(0, st.sigs.length - 500);
    let trades = [];
    try { trades = parseLogs(logs, wallet); } catch { trades = []; }
    // a launch carries the dev's own first buy in the same transaction: that buy is the launch, not a second copy
    const launched = new Set(trades.filter(t => t.side === "create").map(t => t.mint));
    // (when only their buys are followed, that first buy is copied like any other buy, as before)
    if (launched.size && walletOf(wallet).what !== "buys") trades = trades.filter(t => t.side !== "buy" || !launched.has(t.mint));
    if (trades.length) { for (const t of trades) handle(t, wallet, signature, seenAt, true).catch(e => log("error", `Copy of ${nameOf(wallet)} stopped on an error: ${short(e)}`)); return; }
    // not a pump.fun / PumpSwap trade (or not a trade at all): read the transaction itself
    readTx(signature, wallet).then(({ trades: found, blockTime }) => {
      const late = cfg.maxAgeSec > 0 && blockTime && now() - blockTime * 1000 > cfg.maxAgeSec * 1000 + 1000;
      for (const t of found) {
        if (late) { log("skip", `${nameOf(wallet)} ${t.side === "buy" ? "bought" : "sold"} ${t.mint.slice(0, 6)}…, but the trade was only seen ${Math.round(now() / 1000 - blockTime)} s later (limit ${cfg.maxAgeSec} s). Not copied.`, { mint: t.mint, signature, wallet }); continue; }
        handle(t, wallet, signature, seenAt, false).catch(e => log("error", `Copy of ${nameOf(wallet)} stopped on an error: ${short(e)}`));
      }
    }).catch(() => {});
  }

  const pending = new Map(); // mint -> our buy in flight (a sell right after waits for it)
  async function handle(t, wallet, signature, seenAt, fast) {
    if (!t.mint && t.pool) t.mint = await poolCoin(t.pool).catch(() => "");
    if (!t.mint) return;
    const who = nameOf(wallet), tag = { mint: t.mint, signature, wallet }, w = walletOf(wallet);
    st.last[wallet] = { at: seenAt, side: t.side, mint: t.mint, sol: t.sol, venue: t.venue };
    save();
    if (t.side === "create") {
      st.made[t.mint] = wallet;
      const keys = Object.keys(st.made); if (keys.length > 500) delete st.made[keys[0]];
      if (w.what === "buys") return;
      return copyBuy(t, wallet, who, seenAt, tag, w, true);
    }
    if (t.side === "buy") {
      if (w.what === "launches" && st.made[t.mint] !== wallet) return; // only the coins they create
      return copyBuy(t, wallet, who, seenAt, tag, w, false);
    }
    if (sellsFor(w)) return copySell(t, wallet, who, seenAt, tag);
  }

  async function copyBuy(t, wallet, who, seenAt, tag, w, launch) {
    const coin = t.symbol ? `$${t.symbol} (${t.mint})` : t.mint;
    const theirs = launch ? "" : t.sol > 0 ? `${t.sol.toFixed(3)} SOL of ` : "";
    const did = launch ? `${who} launched ${coin}` : `${who} bought ${theirs}${t.mint.slice(0, 6)}…`;
    if (cfg.onlyPump && !/pump$/.test(t.mint)) return log("skip", `${who} bought ${theirs}${t.mint.slice(0, 6)}…: not a pump.fun coin.`, tag);
    if (cfg.oncePerCoin && st.coins[t.mint]) return log("skip", `${who} bought more ${t.mint.slice(0, 6)}…: copied their first buy of it already.`, tag);
    if (!launch && cfg.minTheirSol > 0 && t.sol < cfg.minTheirSol) return log("skip", `${who} bought ${theirs}${t.mint.slice(0, 6)}…: under your ${cfg.minTheirSol} SOL minimum.`, tag);
    const sol = sizeFor(w, t.sol, launch);
    if (!(sol >= 0.0001)) return log("skip", `${who} bought ${t.mint.slice(0, 6)}…: your copy would be ${sol} SOL, too small to send.`, tag);
    rollDay();
    if (cfg.maxPerDay > 0 && st.buysToday >= cfg.maxPerDay) return log("skip", `${who} bought ${t.mint.slice(0, 6)}…, but today's ${cfg.maxPerDay} copies are used up.`, tag);
    if (!hot.keypair) return log("error", `${who} bought ${t.mint.slice(0, 6)}…, but there is no Hatchr wallet to copy with (Settings → Account).`, tag);
    if (!hot.dryRun && hot.balance !== null && now() - hot.balanceAt < 90000 && hot.balance < sol + cfg.priorityFee + cfg.reserveSol + 0.003) {
      return log("error", `${who} bought ${t.mint.slice(0, 6)}…, but the wallet has ${hot.balance.toFixed(4)} SOL: not enough for ${sol} SOL above your ${cfg.reserveSol} SOL reserve.`, tag);
    }
    st.coins[t.mint] = { at: seenAt, wallet, sol };
    st.buysToday++;
    const undo = () => { delete st.coins[t.mint]; st.buysToday = Math.max(0, st.buysToday - 1); save(); };
    const job = (async () => {
      const C = core(), dry = hot.dryRun;
      let made, lastErr = null;
      // A coin created a moment ago can be unknown to PumpPortal and Jupiter for a second or two: a launch is tried
      // again for about 6 s before it counts as failed.
      for (const pause of launch ? [0, 250, 500, 800, 1200, 1500, 2000] : [0]) {
        if (pause) await wait(pause);
        try { made = await R().buy(t.mint, hot.keypair, hot.rpcUrl, { pub: hot.pub, sol, slippage: slip(), priorityFee: fee() }); lastErr = null; break; }
        catch (e) { lastErr = e; }
      }
      if (!made) { undo(); return log("error", launch ? `Copy of ${who}'s launch of ${coin} failed (tried for ${Math.round((now() - seenAt) / 1000)} s): ${short(lastErr, 320)}` : `Copy of ${who}'s buy of ${t.mint.slice(0, 6)}… failed: ${short(lastErr, 320)}`, tag); }
      if (dry) {
        const sim = await C.simulate(hot.rpcUrl, made.tx).catch(e => ({ err: short(e) }));
        undo();
        log("test", `TEST: ${launch ? `${who} launched ${coin}` : `${who} bought ${theirs}${t.mint}`}. Would buy ${sol} SOL through ${made.route}${cfg.boost ? ` (⚡ fee ${fee()} SOL)` : ""}; ready ${now() - seenAt} ms after their ${launch ? "launch" : "trade"} was seen.${sim.err ? ` The simulation failed: ${R().explain(sim.err)}.` : ""}`, tag);
        if (!sim.err) position(t, who, sol, null, true, w);
        return;
      }
      const signature = await C.send(hot.rpcUrl, made.tx, true).catch(e => { undo(); throw e; });
      const sent = now();
      log("buy", launch
        ? `Copied ${who}'s launch: bought ${sol} SOL of ${coin}, sent ${sent - seenAt} ms after they created it, through ${made.route}. Waiting for it to confirm…`
        : `Copied ${who}: bought ${sol} SOL of ${t.mint} (they spent ${t.sol.toFixed(3)} SOL), sent ${sent - seenAt} ms after their trade was seen, through ${made.route}. Waiting for it to confirm…`, { ...tag, signature });
      try { globalThis.HatchrPush && globalThis.HatchrPush.event(`🔁 Copy trade: ${launch ? `${who} launched ${coin}` : `${who} bought ${t.mint}`}\n${sol} SOL sent in ${sent - seenAt} ms.\nhttps://pump.fun/coin/${t.mint}`); } catch { /* bonus */ }
      let failed = "";
      try { await C.confirm(hot.rpcUrl, signature, 45000); } catch (e) { failed = R().explain(short(e, 400)); }
      let held = { ui: 0 };
      for (let i = 0; i < 4 && !(held.ui > 0); i++) { if (i) await wait(1500); held = await C.tokenBalance(hot.rpcUrl, hot.pub, t.mint).catch(() => ({ ui: 0 })); if (failed) break; }
      if (!(held.ui > 0)) { undo(); return log("error", `The copy of ${who}'s buy of ${t.mint.slice(0, 6)}… did not go through${failed ? `: ${failed}` : ""}. Only the fees were spent.`, { ...tag, signature }); }
      log("buy", `Confirmed: holding ${Math.round(held.ui).toLocaleString("en-US")} of ${t.mint.slice(0, 6)}… (copied from ${who}).`, { ...tag, signature });
      position(t, who, sol, held.ui, false, w);
      try { globalThis.HatchrCalloutAuto && globalThis.HatchrCalloutAuto.boughtElsewhere(t.mint, hot.pub, held.ui, false); } catch { /* shows up at the next wallet check */ }
    })().catch(e => log("error", `Copy of ${did} failed: ${short(e, 320)}`, tag));
    pending.set(t.mint, job);
    await job;
    pending.delete(t.mint);
  }

  function position(t, who, sol, tokens, paper, w) {
    try { globalThis.HatchrPositions && globalThis.HatchrPositions.open({ mint: t.mint, ticker: t.symbol || "", source: "Copy trade", by: who, costSol: sol, tokens, paper, exits: exitsFor(w) }); }
    catch (e) { console.warn("positions", e); }
  }

  async function copySell(t, wallet, who, seenAt, tag) {
    const mine = st.coins[t.mint];
    if (cfg.onlyCopied && !mine) return; // a coin Hatchr did not copy: theirs to sell, not yours
    if (pending.has(t.mint)) await Promise.race([pending.get(t.mint), wait(8000)]); // our buy is still on its way
    // the share of their position they sold
    let share = null;
    if (t.before && t.before > 0n) share = Number(t.tokens * 10000n / t.before) / 100;
    const [theirsLeft, ours] = await Promise.all([
      share === null ? rawBalance(wallet, t.mint) : Promise.resolve(null),
      rawBalance(hot.pub, t.mint)
    ]);
    if (share === null) share = theirsLeft === null ? 100 : Number(t.tokens * 10000n / (t.tokens + theirsLeft)) / 100;
    if (share >= 95) share = 100;
    share = Math.max(1, Math.min(100, Math.round(share)));
    if (!ours || ours <= 0n) return log("skip", `${who} sold ${share}% of ${t.mint.slice(0, 6)}…, but there is none of it in your wallet to sell.`, tag);
    const C = core();
    let made;
    try { made = await R().sell(t.mint, hot.keypair, hot.rpcUrl, { pub: hot.pub, pct: share, raw: ours.toString(), slippage: cfg.boost ? R().BOOST_SLIPPAGE.sell : cfg.slippage, priorityFee: fee() }); }
    catch (e) { return log("error", `Copy of ${who}'s sell of ${t.mint.slice(0, 6)}… failed: ${short(e, 320)}`, tag); }
    if (hot.dryRun) {
      const sim = await C.simulate(hot.rpcUrl, made.tx).catch(e => ({ err: short(e) }));
      log("test", `TEST: ${who} sold ${share}% of ${t.mint}. Would sell ${share}% of yours through ${made.route}; ready ${now() - seenAt} ms after their trade was seen.${sim.err ? ` The simulation failed: ${R().explain(sim.err)}.` : ""}`, tag);
      try { globalThis.HatchrPositions && globalThis.HatchrPositions.sold(t.mint, share, true); } catch { /* display only */ }
      return;
    }
    const signature = await C.send(hot.rpcUrl, made.tx, true);
    log("sell", `Copied ${who}: sold ${share}% of ${t.mint}, sent ${now() - seenAt} ms after their sell was seen, through ${made.route}.`, { ...tag, signature });
    if (share === 100 && mine) { mine.soldAt = now(); save(); }
    try { globalThis.HatchrPositions && globalThis.HatchrPositions.sold(t.mint, share, false); } catch { /* display only */ }
    try { globalThis.HatchrPush && globalThis.HatchrPush.event(`🔁 Copy trade: ${who} sold ${share}% of ${t.mint}; sold ${share}% of yours.`); } catch { /* bonus */ }
  }
  async function rawBalance(owner, mint) {
    try {
      const r = await core().rpc(hot.rpcUrl, "getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "processed" }]);
      let raw = 0n;
      for (const acc of r && r.value || []) { const a = acc.account && acc.account.data && acc.account.data.parsed && acc.account.data.parsed.info && acc.account.data.parsed.info.tokenAmount; if (a) raw += BigInt(a.amount || "0"); }
      return raw;
    } catch { return null; }
  }

  // ---------- start-up, settings, messages ----------
  let warmTimer = null;
  async function applyConfig(next) {
    cfg = clean(next);
    clearInterval(warmTimer); warmTimer = null;
    try { chrome.alarms.clear(ALARM); } catch { /* none */ }
    if (cfg.enabled) {
      await reload();
      warmTimer = setInterval(() => warm().catch(() => {}), 20000);
      try { chrome.alarms.create(ALARM, { periodInMinutes: 0.5 }); } catch { /* the interval still runs */ }
      warm().catch(() => {});
    }
    connect(true);
  }
  async function init() {
    for (let i = 0; i < 100 && !(core() && R()); i++) await wait(50);
    if (!core() || !R()) return;
    try {
      const got = await chrome.storage.local.get([CONFIG_KEY, STATE_KEY]);
      const s = got[STATE_KEY];
      if (s && typeof s === "object") st = { ...fresh(), ...s, coins: s.coins && typeof s.coins === "object" ? s.coins : {}, sigs: Array.isArray(s.sigs) ? s.sigs : [], log: Array.isArray(s.log) ? s.log : [], last: s.last && typeof s.last === "object" ? s.last : {}, made: s.made && typeof s.made === "object" ? s.made : {} };
      delete st.at;
      rollDay();
      ready = true;
      await applyConfig(got[CONFIG_KEY]);
    } catch (e) { console.warn("copy trade failed to start", e); ready = true; }
  }
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !ready) return;
      if (changes[CONFIG_KEY]) applyConfig(changes[CONFIG_KEY].newValue).catch(() => {});
      if (changes.settings || changes.walletSecret) reload().then(() => connect(false)).catch(() => {});
    });
    chrome.alarms.onAlarm.addListener(alarm => { if (alarm.name === ALARM && ready) { connect(false); warm().catch(() => {}); } });
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      const type = message && message.type;
      if (type !== "copyGet" && type !== "copySave" && type !== "copyClearLog") return false;
      if (sender?.id !== chrome.runtime.id || sender?.url !== chrome.runtime.getURL("sidepanel.html")) { respond({ ok: false, error: "Not allowed from here" }); return false; }
      (async () => {
        for (let i = 0; i < 60 && !ready; i++) await wait(50);
        if (type === "copySave") { const next = clean(message.config); await chrome.storage.local.set({ [CONFIG_KEY]: next }); await applyConfig(next); }
        else if (type === "copyClearLog") { st.log = []; save(); }
        if (cfg.boost && !hot.fee && hot.rpcUrl) { try { hot.fee = await R().feeEstimate(hot.rpcUrl); } catch { /* shown later */ } }
        return { config: cfg, state: { ...st, sigs: undefined, made: undefined, at: now() }, live, wallet: hot.pub, balance: hot.balance, test: hot.dryRun, rpc: /^https?:\/\//i.test(hot.rpcUrl), boostFee: hot.fee };
      })().then(data => respond({ ok: true, data }), e => respond({ ok: false, error: short(e) }));
      return true;
    });
  } catch (e) { console.warn("copy trade listeners", e); }

  globalThis.HatchrCopy = Object.freeze({ clean, parseLogs, DEFAULTS, wantsStream: () => false });
  init();
})();
