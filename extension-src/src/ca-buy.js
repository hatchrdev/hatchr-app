/* CA buy: buys a coin the moment one of the X accounts you chose posts its contract address.
   Built for speed. A post reaches this file straight from the page that saw it (Axiom's X tracker, or X itself),
   before anything else in Hatchr looks at it. Everything needed for the buy is kept ready in memory (wallet key,
   RPC address, settings), so on the normal path there are two network calls between "post arrives" and "transaction
   sent": PumpPortal builds the transaction, your RPC takes it. No balance look-up, no simulation, no waiting for other
   work. At the same moment Jupiter is asked for a price and the RPC for what the coin is priced in; both matter only
   for a coin that is not priced in SOL, which PumpPortal cannot buy. That path is one request longer.
   Launch watch ("smart"): a post from one of those accounts WITHOUT an address, but with a $TICKER and/or a picture,
   usually means the coin follows within a minute or two. Hatchr then watches every new pump.fun coin (PumpPortal's
   stream) for a while and buys the first one whose ticker / name / picture matches the post, from the right dev
   wallet if it knows it.
   Runs in the background next to background.js, which hands over what it needs as globalThis.HatchrCore.
   Transactions are built by trade-routes.js (globalThis.HatchrRoutes). */
(() => {
  "use strict";
  if (globalThis.HatchrCaBuy) return;
  const CONFIG_KEY = "caBuy", STATE_KEY = "caBuyState";
  const core = () => globalThis.HatchrCore;
  const now = () => Date.now();
  const today = () => new Date().toISOString().slice(0, 10);
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const short = (e, n = 200) => String(e && e.message || e || "").slice(0, n);

  // ---------- settings ----------
  const TYPES = ["TWEET", "REPLY", "QUOTE", "RETWEET"];
  const DEFAULTS = Object.freeze({
    enabled: false,
    handles: [],            // X accounts whose posts are acted on (without the @)
    buySol: 0.05,           // SOL per buy
    slippage: 30,           // %; a coin an account just posted moves fast
    priorityFee: 0.001,     // SOL; this is what gets the transaction in early
    types: Object.freeze({ TWEET: true, REPLY: true, QUOTE: true, RETWEET: false }),
    quoted: false,          // also take an address from the post they quote or reply to
    onlyPump: false,        // only addresses ending in "pump" (pump.fun coins)
    maxAgeSec: 20,          // ignore a post older than this when it arrives (0 = any age)
    cooldownSec: 0,         // after a buy, ignore the same account for this long (0 = no pause)
    maxPerDay: 0,           // buys per day (0 = no limit)
    reserveSol: 0.02,       // never spend the wallet below this
    callout: false,         // call the coin out on pump.fun after the buy
    boost: false,           // ⚡ fee from the network right now (fast, capped) and Boost slippage, instead of the fields
    exits: null,            // automatic exits for these buys (positions.js); null = none
    // launch watch: a post with a $TICKER and/or a picture but no address
    smart: false,
    smartWindowSec: 120,    // how long after such a post new coins are watched
    smartBeforeSec: 30,     // also coins created this long before the post (some devs launch first, then post)
    smartMatch: "all",      // "all": every sign the post gives (ticker AND picture when it has both); "either"; "ticker"; "picture"
    smartName: true,        // a coin whose NAME is the ticker counts as a ticker match too
    smartWords: "",         // only posts with one of these words (comma separated); empty: any post with a $TICKER or picture
    smartLearn: false,      // once Hatchr knows an account's dev wallet, only coins made by that wallet
    smartDevs: Object.freeze([]), // dev wallets to accept (for every account); empty: any creator
    smartLink: false        // the coin must name the account in its links (X / website)
  });
  const MATCHES = ["all", "either", "ticker", "picture"];
  const walletList = v => [...new Set((Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : []).filter(x => typeof x === "string" && /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(x.trim())).map(x => x.trim()))].slice(0, 100);
  const num = (v, fallback) => { if (v === null || v === undefined || v === "" || typeof v === "boolean") return fallback; const n = Number(String(v).replace(",", ".")); return Number.isFinite(n) && n >= 0 ? n : fallback; };
  const handleList = v => {
    const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[\s,]+/) : [];
    return [...new Set(list.filter(x => typeof x === "string").map(x => x.trim().replace(/^https?:\/\/(?:www\.)?(?:x|twitter)\.com\//i, "").replace(/^@/, "").replace(/[/?#].*$/, "").toLowerCase()).filter(x => /^[a-z0-9_]{1,30}$/.test(x)))].slice(0, 500);
  };
  function clean(input) {
    const c = input && typeof input === "object" ? input : {};
    const types = {};
    for (const t of TYPES) types[t] = c.types && t in c.types ? c.types[t] === true : DEFAULTS.types[t];
    return {
      enabled: c.enabled === true,
      handles: handleList(c.handles),
      buySol: num(c.buySol, DEFAULTS.buySol) || DEFAULTS.buySol,
      slippage: num(c.slippage, DEFAULTS.slippage),
      priorityFee: num(c.priorityFee, DEFAULTS.priorityFee),
      types,
      quoted: c.quoted === true,
      onlyPump: c.onlyPump === true,
      maxAgeSec: num(c.maxAgeSec, DEFAULTS.maxAgeSec),
      cooldownSec: num(c.cooldownSec, DEFAULTS.cooldownSec),
      maxPerDay: Math.floor(num(c.maxPerDay, DEFAULTS.maxPerDay)),
      reserveSol: num(c.reserveSol, DEFAULTS.reserveSol),
      callout: c.callout === true,
      boost: c.boost === true,
      exits: globalThis.HatchrPositions ? globalThis.HatchrPositions.cleanExits(c.exits) : (c.exits && typeof c.exits === "object" ? c.exits : null),
      smart: c.smart === true,
      smartWindowSec: num(c.smartWindowSec, DEFAULTS.smartWindowSec),
      smartBeforeSec: num(c.smartBeforeSec, DEFAULTS.smartBeforeSec),
      smartMatch: MATCHES.includes(c.smartMatch) ? c.smartMatch : DEFAULTS.smartMatch,
      smartName: c.smartName !== false,
      smartWords: typeof c.smartWords === "string" ? c.smartWords.slice(0, 400) : "",
      smartLearn: c.smartLearn === true,
      smartDevs: walletList(c.smartDevs),
      smartLink: c.smartLink === true
    };
  }

  // ---------- finding a contract address in a post ----------
  const B58 = "1-9A-HJ-NP-Za-km-z";
  const ADDRESS = new RegExp(`(?<![${B58}])[${B58}]{32,44}(?![${B58}])`, "g"); // a whole base58 run of address length, not a piece of a longer one
  // Addresses that are never a coin to buy.
  const NOT_COINS = new Set(["So11111111111111111111111111111111111111112", "11111111111111111111111111111111", "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb", "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA",
    "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB", "ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL"]);
  function isAddress(text) {
    try { return new (core().PublicKey)(text).toBytes().length === 32; } catch { return false; }
  }
  // The first usable address in the text, or "".
  function findAddress(text, cfg, own) {
    for (const hit of String(text || "").match(ADDRESS) || []) {
      if (NOT_COINS.has(hit) || hit === own) continue;
      if (cfg.onlyPump && !/pump$/.test(hit)) continue;
      if (isAddress(hit)) return hit;
    }
    return "";
  }

  // ---------- state ----------
  let cfg = clean(null), ready = false;
  let st = fresh();
  // seen: the last post that reached Hatchr from each chosen account, so the panel can show whether posts arrive at all
  // devs: dev wallets learned per account; watches: the launch watches, newest first (for the panel)
  function fresh() { return { day: today(), buysToday: 0, bought: [], posts: [], lastBy: {}, log: [], seen: {}, lastPost: null, devs: {}, watches: [] }; }
  function rollDay() { if (st.day !== today()) { st.day = today(); st.buysToday = 0; } }
  let saveTimer = null;
  function save() {
    if (saveTimer) return;
    saveTimer = setTimeout(() => { saveTimer = null; chrome.storage.local.set({ [STATE_KEY]: { ...st, at: now() } }).catch(() => {}); }, 300); // off the hot path
  }
  function log(kind, text, extra = {}) {
    st.log.unshift({ at: now(), kind, text: String(text).slice(0, 440), ...extra });
    if (st.log.length > 60) st.log.length = 60;
    save();
  }

  // ---------- kept ready, so a buy never waits for a look-up ----------
  const hot = { keypair: null, pub: "", rpcUrl: "", dryRun: true, skipPreflight: true, balance: null, balanceAt: 0, at: 0, fee: null };
  let warmTimer = null;
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
  // Every 20 s while switched on: a tiny request to PumpPortal and to the RPC keeps both connections open (a cold
  // connection costs a few hundred ms of handshake at the worst moment), and the wallet balance is noted for the reserve.
  async function warm() {
    if (!cfg.enabled) return;
    if (now() - hot.at > 120000) await reload();
    R().warm();
    if (hot.pub && hot.rpcUrl) {
      try { hot.balance = await core().balance(hot.rpcUrl, hot.pub); hot.balanceAt = now(); } catch { /* keeps the last one */ }
    }
    if (cfg.boost && hot.rpcUrl) { try { hot.fee = await R().feeEstimate(hot.rpcUrl); } catch { /* keeps the last one */ } } // ready before a post comes
  }
  // what a buy pays and allows: Boost takes the network's fee of the moment and its own slippage
  const fee = () => (cfg.boost && hot.fee ? hot.fee.fee : cfg.priorityFee);
  const slip = () => (cfg.boost ? R().BOOST_SLIPPAGE.buy : cfg.slippage);
  function keepWarm() {
    if (warmTimer) { clearInterval(warmTimer); warmTimer = null; }
    if (!cfg.enabled) return;
    warmTimer = setInterval(() => warm().catch(() => {}), 20000);
    reload().then(warm).catch(() => {});
  }

  // When the post was made. The feed gives whole seconds; X's own post number holds the millisecond, so that is used
  // when the two agree (they do not for a repost, whose number may be the original post's).
  function postedAt(post) {
    const given = Number(post.time);
    try {
      if (/^\d{15,20}$/.test(String(post.postId || ""))) {
        const exact = Number((BigInt(post.postId) >> 22n) + 1288834974657n);
        if (Math.abs(exact - given) < 1500) return exact;
      }
    } catch { /* keeps the feed's time */ }
    return given;
  }

  // ---------- a post arrives ----------
  // Called synchronously by background.js for every post, before its own handling. Everything here that can say "no"
  // is a memory look-up; the first await is the request that builds the transaction.
  // CA buy has its own switch: it works whether or not Hatchr launches coins from posts (the Feed's switch).
  // A post that wakes the background arrives before the settings are read; it waits here and is handled right after.
  let early = [];
  function onPost(post, got = now()) {
    if (!post) return;
    if (!ready) { if (early.length < 20) early.push([post, got]); return; }
    if (!cfg.enabled || !cfg.handles.length) return;
    const type = String(post.tweetType || "TWEET").toUpperCase();
    st.lastPost = { at: got, source: String(post.source || ""), handle: String(post.handle || "").slice(0, 40) };
    // who did it: for a repost the account that reposted, otherwise the author
    const actor = String((type === "RETWEET" ? post.tracked || post.handle : post.handle) || "").replace(/^@/, "").toLowerCase();
    if (!actor || !cfg.handles.includes(actor)) { save(); return; }
    const seen = st.seen[actor] = { at: got, type, url: typeof post.url === "string" ? post.url.slice(0, 200) : "", why: "" };
    save();
    if (cfg.types[TYPES.includes(type) ? type : "TWEET"] !== true) { seen.why = `${type === "RETWEET" ? "a repost" : type === "REPLY" ? "a reply" : type === "QUOTE" ? "a quote" : "a post"}, and those are switched off below`; return; }
    const mint = findAddress(cfg.quoted ? `${post.text || ""} ${post.context || ""}` : post.text, cfg, hot.pub);
    if (!mint) { seen.why = cfg.smart ? arm(post, actor, got) : "no contract address in it"; return; }
    seen.why = "had an address";
    addressPosted(actor, mint, got);

    const postId = String(post.dedupeKey || `${post.source || ""}:${post.postId || ""}`), age = post.time ? got - postedAt(post) : 0;
    const tag = { mint, handle: actor, url: typeof post.url === "string" ? post.url : "" };
    if (st.posts.includes(postId)) return;
    st.posts.push(postId); if (st.posts.length > 400) st.posts.splice(0, st.posts.length - 400);
    if (st.bought.includes(mint)) return log("skip", `@${actor} posted ${mint.slice(0, 6)}… again. It was bought before, so not again.`, tag);
    if (cfg.maxAgeSec > 0 && age > cfg.maxAgeSec * 1000) return log("skip", `@${actor} posted ${mint.slice(0, 6)}…, but the post was already ${Math.round(age / 1000)} s old when it arrived (limit ${cfg.maxAgeSec} s). Not bought.`, tag);
    rollDay();
    if (cfg.maxPerDay > 0 && st.buysToday >= cfg.maxPerDay) return log("skip", `@${actor} posted ${mint.slice(0, 6)}…, but today's ${cfg.maxPerDay} buys are used up.`, tag);
    if (cfg.cooldownSec > 0 && got - (st.lastBy[actor] || 0) < cfg.cooldownSec * 1000) return log("skip", `@${actor} posted ${mint.slice(0, 6)}… inside the ${cfg.cooldownSec} s pause after the last buy from that account.`, tag);
    if (!hot.keypair) return log("error", `@${actor} posted ${mint.slice(0, 6)}…, but there is no Hatchr wallet to buy with (Settings → Account).`, tag);
    if (!hot.dryRun && hot.balance !== null && now() - hot.balanceAt < 90000 && hot.balance < cfg.buySol + cfg.priorityFee + cfg.reserveSol + 0.003) {
      return log("error", `@${actor} posted ${mint.slice(0, 6)}…, but the wallet has ${hot.balance.toFixed(4)} SOL: not enough for a ${cfg.buySol} SOL buy above your ${cfg.reserveSol} SOL reserve.`, tag);
    }
    st.bought.push(mint); if (st.bought.length > 2000) st.bought.splice(0, st.bought.length - 2000);
    st.lastBy[actor] = got;
    st.buysToday++;
    buy(mint, actor, got, age, tag).catch(e => log("error", `Buy of ${mint.slice(0, 6)}… from @${actor}'s post failed: ${short(e, 320)}`, tag));
  }

  const R = () => globalThis.HatchrRoutes; // trade-routes.js: building the transaction (PumpPortal, or Jupiter)
  const explain = err => R().explain(err);

  // how: for a launch-watch buy { coin: "$COIN", why: "ticker + picture" }; the times then count from the coin's creation
  async function buy(mint, actor, got, age, tag, how) {
    const what = how ? `${how.coin} (${mint}) for @${actor}'s launch post, matched on ${how.why}` : `${mint} from @${actor}'s post`;
    const clock = how ? "after the coin appeared on pump.fun" : "after the post reached Hatchr";
    const C = core(), dry = hot.dryRun, keypair = hot.keypair, rpcUrl = hot.rpcUrl;
    const undo = () => { st.bought = st.bought.filter(m => m !== mint); st.buysToday = Math.max(0, st.buysToday - 1); }; // nothing happened: the address may be tried again
    let made;
    try { made = await R().buy(mint, keypair, rpcUrl, { pub: hot.pub, sol: cfg.buySol, slippage: slip(), priorityFee: fee() }); }
    catch (e) { undo(); throw e; }
    const tx = made.tx, built = now();
    if (dry) {
      const sim = await C.simulate(rpcUrl, tx).catch(e => ({ err: short(e) }));
      st.buysToday = Math.max(0, st.buysToday - 1);
      log("test", `TEST: would buy ${cfg.buySol} SOL of ${what}, through ${made.route}${cfg.boost ? ` (⚡ fee ${fee()} SOL)` : ""}; the transaction was ready ${built - got} ms ${clock}.${sim.err ? ` The simulation failed: ${explain(sim.err)}.` : ""}`, tag);
      if (!sim.err) openPosition(mint, actor, how, null, true); // a paper position: your exits run on it at the price of now
      return;
    }
    // straight to the RPC, without the RPC's own dry run first (that costs time)
    const callouts = globalThis.HatchrCalloutAuto;
    try { callouts && callouts.expectBuy && callouts.expectBuy(mint); } catch { /* only stops a double callout */ }
    let signature = "", held = { ui: 0 }, sending = tx;
    // A slippage miss (the price ran past your slippage before the buy landed) is tried once more at the new price,
    // with the same SOL and slippage, while it is still fresh.
    for (let attempt = 1; ; attempt++) {
      signature = await C.send(rpcUrl, sending, true);
      const sent = now();
      log("buy", attempt > 1
        ? `Trying once more at the new price: ${cfg.buySol} SOL of ${mint.slice(0, 6)}… sent through ${made.route}. Waiting for it to confirm…`
        : `Bought ${what}: ${cfg.buySol} SOL sent ${sent - got} ms ${clock}${!how && age > 0 ? ` (the post was ${(age / 1000).toFixed(1)} s old by then)` : ""}, through ${made.route}. Waiting for it to confirm…`, { ...tag, signature });
      if (attempt === 1) { try { globalThis.HatchrPush && globalThis.HatchrPush.event(`🎯 ${how ? `Launch watch: @${actor}'s ${how.coin}` : `CA buy: @${actor} posted ${mint}`}\n${cfg.buySol} SOL sent in ${sent - got} ms.\nhttps://pump.fun/coin/${mint}`); } catch { /* phone message is a bonus */ } }

      // everything after this is off the clock
      let failed = "", why = null;
      try { await C.confirm(rpcUrl, signature, 45000); } catch (e) { why = await R().explainTx(rpcUrl, signature, short(e, 400), { slippage: slip() }); failed = why.text; }
      held = { ui: 0 };
      for (let i = 0; i < 4 && !(held.ui > 0); i++) { if (i) await wait(1500); held = await C.tokenBalance(rpcUrl, hot.pub, mint).catch(() => ({ ui: 0 })); if (failed) break; }
      if (held.ui > 0) break;
      if (why && why.slippage && attempt === 1 && now() - got < 20000) {
        log("skip", `The buy of ${mint.slice(0, 6)}… missed: ${failed}. Only the fees were spent.`, { ...tag, signature });
        try { made = await R().buy(mint, keypair, rpcUrl, { pub: hot.pub, sol: cfg.buySol, slippage: slip(), priorityFee: fee() }); sending = made.tx; continue; }
        catch (e) { failed = `${failed}; trying again was not possible: ${short(e, 160)}`; }
      }
      st.buysToday = Math.max(0, st.buysToday - 1);
      log("error", `The buy of ${how ? how.coin + " " : ""}${mint.slice(0, 6)}… from @${actor}'s post did not go through${failed ? `: ${failed}` : ""}. Only the fees were spent.${why && why.slippage ? " Coins that run this fast need more slippage (Buy section on this page)." : ""}`, { ...tag, signature });
      try { globalThis.HatchrPush && globalThis.HatchrPush.event(`⚠️ CA buy of ${mint.slice(0, 6)}… did not go through${failed ? `: ${failed}` : ""}.`); } catch { /* bonus */ }
      return;
    }
    log("buy", `Confirmed: holding ${Math.round(held.ui).toLocaleString("en-US")} of ${mint.slice(0, 6)}… (from @${actor}).`, { ...tag, signature });
    openPosition(mint, actor, how, held.ui, false);
    try { callouts && callouts.boughtElsewhere && callouts.boughtElsewhere(mint, hot.pub, held.ui, cfg.callout); } catch { /* the coin still shows up at the next wallet check */ }
  }

  // =====================================================================================================
  // Launch watch
  // =====================================================================================================
  // Tickers that are never a launch tease
  const NOT_TICKERS = new Set(["sol", "btc", "eth", "usdc", "usdt", "usd1", "bnb", "xrp"]);
  const norm = t => String(t || "").replace(/^\$/, "").trim().toLowerCase();
  const cashtags = text => [...new Set((String(text || "").match(/(?:^|[^\w$])\$([A-Za-z][A-Za-z0-9]{0,11})(?![\w])/g) || []).map(m => norm(m.replace(/^[^$]*\$/, ""))))].filter(t => t && !NOT_TICKERS.has(t)).slice(0, 4);
  const watches = [];     // active ones, in memory
  const recent = new Map(); // mint -> new coin from the stream, last 15 minutes (lookback and dev-wallet learning)
  const metaCache = new Map(), hashCache = new Map();
  let metaRunning = 0;
  const metaQueue = [];

  function devsFor(handle) {
    const learned = cfg.smartLearn ? (st.devs[handle] || []) : [];
    return [...new Set([...cfg.smartDevs, ...learned])];
  }
  // The post had no address. Start a watch if it gives something to look for; returns what the panel shows for it.
  function arm(post, actor, got) {
    const text = `${post.text || ""}${cfg.quoted ? " " + (post.context || "") : ""}`;
    const words = cfg.smartWords.split(",").map(w => w.trim().toLowerCase()).filter(Boolean);
    if (words.length && !words.some(w => text.toLowerCase().includes(w))) return "no address, and none of your launch-watch words";
    const tickers = cashtags(text);
    const pics = (Array.isArray(post.images) ? post.images : []).filter(u => typeof u === "string" && /^https:\/\//.test(u)).slice(0, 2);
    const usePics = cfg.smartMatch !== "ticker" ? pics : [];
    if (cfg.smartMatch === "ticker" && !tickers.length) return "no address and no $ticker to watch for";
    if (cfg.smartMatch === "picture" && !pics.length) return "no address and no picture to watch for";
    if (!tickers.length && !usePics.length) return "no address, no $ticker and no picture to watch for";
    const postId = String(post.dedupeKey || `${post.source || ""}:${post.postId || ""}`);
    if (watches.some(w => w.postId === postId)) return "watching";
    // the same account teasing again replaces its running watch
    for (const old of watches.filter(w => w.handle === actor)) end(old, "replaced by a newer post");
    const w = {
      id: `${got}-${actor}`, postId, handle: actor, tickers, pics: usePics, hashes: null, startedAt: got, until: got + cfg.smartWindowSec * 1000,
      url: typeof post.url === "string" ? post.url.slice(0, 200) : "", done: false, checked: 0
    };
    w.hashing = Promise.all(usePics.map(u => hashImage(u).catch(() => null))).then(list => { w.hashes = list.filter(Boolean); return w.hashes; });
    watches.push(w);
    const label = describe(w);
    st.watches.unshift({ id: w.id, handle: actor, label, startedAt: got, until: w.until, url: w.url, state: "watching", result: "" });
    if (st.watches.length > 20) st.watches.length = 20;
    log("watch", `@${actor} posted ${label} without an address. Watching new pump.fun coins for ${Math.round(cfg.smartWindowSec)} s.`, { handle: actor, url: w.url });
    w.timer = setTimeout(() => end(w, "no coin matched in time"), Math.max(1000, w.until - now() + 50));
    // coins that were already made a moment before the post
    for (const coin of recent.values()) if (coin.at >= got - cfg.smartBeforeSec * 1000) consider(coin, w);
    return `watching for ${label}`;
  }
  function describe(w) {
    const parts = [w.tickers.length ? w.tickers.map(t => "$" + t.toUpperCase()).join(" / ") : "", w.pics.length ? (w.tickers.length ? "its picture" : "a picture") : ""].filter(Boolean);
    return parts.join(" + ");
  }
  function end(w, result, bought) {
    if (w.done && !bought) return;
    w.done = true;
    clearTimeout(w.timer);
    const i = watches.indexOf(w); if (i >= 0) watches.splice(i, 1);
    const row = st.watches.find(r => r.id === w.id);
    if (row) { row.state = bought ? "bought" : "ended"; row.result = result; row.endedAt = now(); }
    if (!bought) log("skip", `Launch watch for @${w.handle}'s ${describe(w)} ended: ${result}.`, { handle: w.handle, url: w.url });
    save();
  }
  // The account posted an address: that ends its watch, and a coin made in the 10 minutes before is very likely its own.
  function addressPosted(actor, mint, got) {
    for (const w of watches.filter(x => x.handle === actor)) end(w, "the account posted the address itself");
    const coin = recent.get(mint);
    if (coin && coin.creator && got - coin.at < 10 * 60000) {
      const list = st.devs[actor] || [];
      if (!list.includes(coin.creator)) { st.devs[actor] = [coin.creator, ...list].slice(0, 10); log("watch", `Learned @${actor}'s dev wallet ${coin.creator.slice(0, 4)}…${coin.creator.slice(-4)} from the coin it just posted.`, { handle: actor }); }
    }
  }

  // ---------- new coins from PumpPortal's stream (background.js passes every message on) ----------
  function onStream(m) {
    if (!ready || !cfg.enabled || !cfg.smart || !m || typeof m.mint !== "string" || m.txType !== "create") return;
    const coin = { mint: m.mint, name: String(m.name || "").slice(0, 60), symbol: String(m.symbol || "").slice(0, 20), uri: typeof m.uri === "string" ? m.uri.slice(0, 400) : "", creator: String(m.traderPublicKey || ""), at: now() };
    recent.set(coin.mint, coin);
    if (recent.size > 3000 || (recent.size % 200 === 0)) for (const [k, c] of recent) { if (coin.at - c.at > 15 * 60000 || recent.size > 3000) recent.delete(k); else break; }
    for (const w of [...watches]) consider(coin, w);
  }
  function consider(coin, w) {
    if (w.done) return;
    if (now() > w.until) return end(w, "no coin matched in time");
    if (coin.at < w.startedAt - cfg.smartBeforeSec * 1000) return;
    const devs = devsFor(w.handle);
    if (devs.length && !devs.includes(coin.creator)) return;
    w.checked++;
    const tickerHit = w.tickers.length > 0 && (w.tickers.includes(norm(coin.symbol)) || (cfg.smartName && w.tickers.includes(norm(coin.name))));
    const mode = cfg.smartMatch;
    const needTicker = mode === "ticker" || (mode === "all" && w.tickers.length > 0);
    const needPic = mode === "picture" || (mode === "all" && w.pics.length > 0) || (mode === "either" && !tickerHit);
    if (needTicker && !tickerHit) return;
    if (needPic && !w.pics.length) return;
    const why = [tickerHit ? "ticker" : "", needPic ? "picture" : "", devs.length ? "dev wallet" : ""].filter(Boolean);
    if (!needPic && !cfg.smartLink) return hit(coin, w, why);
    meta(coin).then(async info => {
      if (w.done || !info) return;
      if (cfg.smartLink && !linksTo(info, w.handle)) return;
      let reasons = why;
      if (needPic) {
        const theirs = await (w.hashes || w.hashing);
        if (!theirs.length && tickerHit) reasons = [...why.filter(x => x !== "picture"), "(the post's picture could not be read)"]; // the ticker has to do
        else {
          if (!theirs.length || !info.image) return;
          const mine = await hashImage(info.image).catch(() => null);
          if (!mine || !theirs.some(h => distance(h, mine) <= 10)) return;
        }
      }
      hit(coin, w, cfg.smartLink ? [...reasons, "links to the account"] : reasons);
    }).catch(() => {});
  }
  function linksTo(info, handle) {
    const h = handle.toLowerCase();
    return [info.twitter, info.website].some(link => typeof link === "string" && new RegExp(`(?:x|twitter)\\.com/${h}(?:[/?#]|$)`, "i").test(link));
  }
  function hit(coin, w, why) {
    if (w.done) return;
    const coinLabel = coin.symbol ? "$" + coin.symbol : coin.name || coin.mint.slice(0, 6);
    end(w, `bought ${coinLabel} (${coin.mint.slice(0, 6)}…)`, true);
    const tag = { mint: coin.mint, handle: w.handle, url: w.url };
    if (st.bought.includes(coin.mint)) return log("skip", `${coinLabel} matched @${w.handle}'s post, but it was bought before.`, tag);
    rollDay();
    if (cfg.maxPerDay > 0 && st.buysToday >= cfg.maxPerDay) return log("skip", `${coinLabel} matched @${w.handle}'s post, but today's ${cfg.maxPerDay} buys are used up.`, tag);
    if (!hot.keypair) return log("error", `${coinLabel} matched @${w.handle}'s post, but there is no Hatchr wallet to buy with (Settings → Account).`, tag);
    if (!hot.dryRun && hot.balance !== null && now() - hot.balanceAt < 90000 && hot.balance < cfg.buySol + cfg.priorityFee + cfg.reserveSol + 0.003) {
      return log("error", `${coinLabel} matched @${w.handle}'s post, but the wallet has ${hot.balance.toFixed(4)} SOL: not enough for a ${cfg.buySol} SOL buy above your ${cfg.reserveSol} SOL reserve.`, tag);
    }
    st.bought.push(coin.mint); if (st.bought.length > 2000) st.bought.splice(0, st.bought.length - 2000);
    st.lastBy[w.handle] = now();
    st.buysToday++;
    buy(coin.mint, w.handle, coin.at, 0, tag, { coin: coinLabel, why: why.join(" + ") || "a match" })
      .catch(e => log("error", `Buy of ${coinLabel} (${coin.mint.slice(0, 6)}…) for @${w.handle}'s launch post failed: ${short(e, 320)}`, tag));
  }

  // ---------- a coin's metadata and pictures ----------
  async function fetchWithin(url, ms, as) {
    const controller = new AbortController(), timer = setTimeout(() => controller.abort(), ms);
    try {
      const response = await fetch(url, { signal: controller.signal, credentials: "omit", redirect: "follow" });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return as === "blob" ? await response.blob() : await response.json();
    } finally { clearTimeout(timer); }
  }
  const httpsOnly = v => (typeof v === "string" && /^https:\/\//i.test(v.trim()) ? v.trim().slice(0, 400) : "");
  const ipfsUrl = v => { const m = String(v || "").match(/^ipfs:\/\/(?:ipfs\/)?([A-Za-z0-9]{32,})/); return m ? `https://ipfs.io/ipfs/${m[1]}` : httpsOnly(v); };
  function meta(coin) {
    if (metaCache.has(coin.mint)) return metaCache.get(coin.mint);
    const job = new Promise(resolve => metaQueue.push({ coin, resolve }));
    metaCache.set(coin.mint, job);
    if (metaCache.size > 500) metaCache.delete(metaCache.keys().next().value);
    pump();
    return job;
  }
  function pump() {
    while (metaRunning < 8 && metaQueue.length) {
      const { coin, resolve } = metaQueue.shift();
      metaRunning++;
      (async () => {
        const uri = ipfsUrl(coin.uri);
        if (!uri) return null;
        const cid = (uri.match(/\/ipfs\/([A-Za-z0-9]{32,})/) || [])[1];
        for (const url of [uri, cid && !/^https:\/\/ipfs\.io\//i.test(uri) ? `https://ipfs.io/ipfs/${cid}` : ""].filter(Boolean)) {
          try {
            const data = await fetchWithin(url, 4000, "json");
            if (data && typeof data === "object") return { image: ipfsUrl(data.image), twitter: httpsOnly(data.twitter), website: httpsOnly(data.website) };
          } catch { /* next gateway */ }
        }
        return null;
      })().then(resolve, () => resolve(null)).finally(() => { metaRunning--; pump(); });
    }
  }
  // A 64-bit "difference hash" of a picture: the same picture at another size or quality gives (nearly) the same hash.
  async function hashImage(url) {
    if (hashCache.has(url)) return hashCache.get(url);
    const job = (async () => {
      const blob = await fetchWithin(url, 5000, "blob");
      const bitmap = await createImageBitmap(blob);
      const canvas = new OffscreenCanvas(9, 8), ctx = canvas.getContext("2d");
      ctx.drawImage(bitmap, 0, 0, 9, 8);
      const px = ctx.getImageData(0, 0, 9, 8).data;
      const grey = i => px[i * 4] * 0.299 + px[i * 4 + 1] * 0.587 + px[i * 4 + 2] * 0.114;
      let hash = 0n;
      for (let y = 0; y < 8; y++) for (let x = 0; x < 8; x++) hash = (hash << 1n) | (grey(y * 9 + x) > grey(y * 9 + x + 1) ? 1n : 0n);
      return hash;
    })();
    hashCache.set(url, job);
    if (hashCache.size > 400) hashCache.delete(hashCache.keys().next().value);
    job.catch(() => hashCache.delete(url));
    return job;
  }
  function distance(a, b) { let x = a ^ b, n = 0; while (x) { n += Number(x & 1n); x >>= 1n; } return n; }

  // Where posts come from, for the panel: Axiom tabs (the fast route) and X tabs, and whether they are connected.
  async function sources() {
    const out = { axiomTabs: null, xTabs: null, axiom: null, desktop: !!(core() && core().isDesktop) };
    try { const got = await chrome.storage.local.get("axiomStatus"); out.axiom = got.axiomStatus || null; } catch { /* unknown */ }
    try {
      if (chrome.tabs && chrome.tabs.query && !out.desktop) {
        out.axiomTabs = (await chrome.tabs.query({ url: ["https://axiom.trade/*"] })).length;
        out.xTabs = (await chrome.tabs.query({ url: ["https://x.com/*", "https://twitter.com/*"] })).length;
      }
    } catch { /* unknown */ }
    return out;
  }

  function openPosition(mint, actor, how, tokens, paper) {
    try {
      globalThis.HatchrPositions && globalThis.HatchrPositions.open({ mint, ticker: how && how.coin ? how.coin.replace(/^\$/, "") : "", source: how ? "Launch watch" : "CA buy", by: "@" + actor,
        costSol: cfg.buySol, tokens, paper, exits: cfg.exits, calledOut: cfg.callout });
    } catch (e) { console.warn("positions", e); }
  }

  // ---------- start-up, settings, messages ----------
  async function applyConfig(next) {
    cfg = clean(next);
    keepWarm();
    // the launch watch needs PumpPortal's stream of new coins (background.js keeps one shared connection)
    if (ready && cfg.enabled && cfg.smart && cfg.handles.length) { try { core().reconnect().catch(() => {}); } catch { /* opened at the next half-minute check */ } }
  }
  async function init() {
    for (let i = 0; i < 100 && !core(); i++) await wait(50);
    if (!core()) return;
    try {
      const got = await chrome.storage.local.get([CONFIG_KEY, STATE_KEY]);
      const s = got[STATE_KEY];
      if (s && typeof s === "object") st = { ...fresh(), ...s, bought: Array.isArray(s.bought) ? s.bought : [], posts: Array.isArray(s.posts) ? s.posts : [], log: Array.isArray(s.log) ? s.log : [], lastBy: s.lastBy && typeof s.lastBy === "object" ? s.lastBy : {} };
      delete st.at;
      if (!st.seen || typeof st.seen !== "object") st.seen = {};
      if (!st.devs || typeof st.devs !== "object") st.devs = {};
      st.watches = (Array.isArray(st.watches) ? st.watches : []).map(w => (w.state === "watching" ? { ...w, state: "ended", result: "Hatchr restarted" } : w));
      rollDay();
      await reload();
      await applyConfig(got[CONFIG_KEY]); // the settings first: a post may be waiting
    } catch (e) { console.warn("CA buy failed to start", e); }
    ready = true;
    if (cfg.enabled && cfg.smart && cfg.handles.length) { try { core().reconnect().catch(() => {}); } catch { /* opened at the next half-minute check */ } }
    const waiting = early; early = [];
    for (const [post, got] of waiting) { try { onPost(post, got); } catch (e) { console.warn("CA buy", e); } }
  }
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local" || !ready) return;
      if (changes[CONFIG_KEY]) applyConfig(changes[CONFIG_KEY].newValue).catch(() => {});
      if (changes.settings || changes.walletSecret) reload().catch(() => {});
    });
    chrome.runtime.onMessage.addListener((message, sender, respond) => {
      const type = message && message.type;
      if (type !== "caBuyGet" && type !== "caBuySave" && type !== "caBuyClearLog" && type !== "caBuyForgetDevs") return false;
      if (sender?.id !== chrome.runtime.id || sender?.url !== chrome.runtime.getURL("sidepanel.html")) { respond({ ok: false, error: "Not allowed from here" }); return false; }
      (async () => {
        for (let i = 0; i < 60 && !ready; i++) await wait(50);
        if (type === "caBuySave") { const next = clean(message.config); await chrome.storage.local.set({ [CONFIG_KEY]: next }); await applyConfig(next); }
        else if (type === "caBuyClearLog") { st.log = []; st.watches = st.watches.filter(w => w.state === "watching"); save(); }
        else if (type === "caBuyForgetDevs") { st.devs = {}; save(); }
        if (cfg.boost && !hot.fee && hot.rpcUrl) { try { hot.fee = await R().feeEstimate(hot.rpcUrl); } catch { /* shown later */ } }
        return { config: cfg, state: { ...st, at: now() }, wallet: hot.pub, balance: hot.balance, test: hot.dryRun, sources: await sources(), boostFee: hot.fee };
      })().then(data => respond({ ok: true, data }), e => respond({ ok: false, error: short(e) }));
      return true;
    });
  } catch (e) { console.warn("CA buy listeners", e); }

  const wantsPosts = () => !!(cfg.enabled && cfg.handles.length);
  const wantsStream = () => !!(ready && cfg.enabled && cfg.smart && cfg.handles.length); // the launch watch reads new coins
  globalThis.HatchrCaBuy = Object.freeze({ onPost, onStream, wantsStream, clean, wantsPosts, findAddress: (text, c) => findAddress(text, clean(c), hot.pub), DEFAULTS });
  init();
})();
