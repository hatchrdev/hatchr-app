// Tests for the callout automode engine (src/callout-auto.js): the built file runs here against a stand-in wallet, RPC,
// pump.fun stream and pump.fun callout API. Nothing leaves this machine and nothing is bought or posted.
// Run by `npm test` against the built extension; or by hand: node test/callout-auto/engine.test.js [folder with the built files]
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const dir = require("path").resolve(process.argv[2] || require("path").join(__dirname, "../../extension"));
const SRC = ["callout-filters.js", "callout-auto.js"].map(f => fs.readFileSync(dir + "/" + f, "utf8"));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PANEL = "chrome-extension://abc/sidepanel.html";

const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
function unbase58(str) { let n = 0n; for (const c of str) n = n * 58n + BigInt(B58.indexOf(c)); const out = Buffer.alloc(32); for (let i = 31; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; } return out; }
const WSOL = unbase58("So11111111111111111111111111111111111111112"), USDC = unbase58("EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v");
function curveData({ vTokens = 900e6, vSol = 40, complete = 0, quote = null } = {}) {
  const b = Buffer.alloc(180);
  if (quote) quote.copy(b, 83);
  b.writeBigUInt64LE(BigInt(Math.round(vTokens * 1e6)), 8);
  b.writeBigUInt64LE(BigInt(Math.round(vSol * 1e9)), 16);
  b[48] = complete;
  return b.toString("base64");
}

async function boot(o = {}) {
  const w = { clock: 1_800_000_000_000, sent: [], fetches: [], wsSent: [], callouts: [], notes: [], reconnects: 0, storage: { local: {}, session: {} },
    walletTokens: o.walletTokens ?? 350000, devTokensOnChain: o.devTokensOnChain ?? 10e6, calloutResults: o.calloutResults || [{ sent: true, url: "https://pump.fun/callouts/M/1", calledAt: 1 }],
    curve: o.curve || {}, settings: { rpcUrl: "https://rpc", dryRun: !!o.dryRun, watching: true, skipPreflight: false, notifyDeploys: false, ...(o.settings || {}) }, balanceSol: o.balanceSol ?? 1,
    perm: o.perm ?? true, holdings: o.holdings || { WALLET: [] }, walletReads: 0, sims: 0, sigs: o.sigs || {}, txs: {}, curves: {}, mcReads: 0, sigReads: 0, txReads: 0, feeds: [], scan: o.scan, meta: o.meta ?? { twitter: "https://x.com/frog", description: "a frog" } };
  const changed = [], alarms = [], messages = [];
  const area = name => ({
    get: async keys => { const out = {}; for (const k of [].concat(keys)) if (k in w.storage[name]) out[k] = JSON.parse(JSON.stringify(w.storage[name][k])); return out; },
    set: async obj => { const ch = {}; for (const [k, v] of Object.entries(obj)) { ch[k] = { oldValue: w.storage[name][k], newValue: JSON.parse(JSON.stringify(v)) }; w.storage[name][k] = ch[k].newValue; } changed.forEach(fn => fn(ch, name)); },
  });
  w.storage.local.settings = w.settings;
  if (o.config) w.storage.local.coAuto = o.config;
  if (!o.oldSetup) w.storage.local.coAutoState = { noWaitMoved: true };
  const RealDate = Date;
  class FakeDate extends RealDate { constructor(...a) { super(...(a.length ? a : [w.clock])); } static now() { return w.clock; } }
  const ws = { readyState: 1, send: m => w.wsSent.push(JSON.parse(m)) };
  class FakeFeed { constructor(url) { this.url = url; this.sent = []; this.readyState = 0; w.feeds.push(this); setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 5); }
    send(m) { const j = JSON.parse(m); this.sent.push(j); if (j.method === "logsSubscribe") setTimeout(() => this.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", id: j.id, result: 100 + j.id }) }), 5); }
    close() { this.readyState = 3; this.onclose && this.onclose(); }
    notify(sub, signature, err = null) { this.onmessage({ data: JSON.stringify({ method: "logsNotification", params: { subscription: sub, result: { value: { signature, err, logs: [] } } } }) }); } }
  const ctx = vm.createContext({ ...(o.feed ? { WebSocket: FakeFeed } : {}), console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, Date: FakeDate, atob, btoa, AbortController, Uint8Array, BigInt, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Error, TextEncoder,
    chrome: { storage: { local: area("local"), session: area("session"), onChanged: { addListener: fn => changed.push(fn) } },
      alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: fn => alarms.push(fn) } },
      permissions: { contains: async () => w.perm },
      runtime: { id: "abc", getURL: p => "chrome-extension://abc/" + p, onMessage: { addListener: fn => messages.push(fn) } } },
    fetch: async (url, init) => {
      w.fetches.push({ url, body: init && init.body ? JSON.parse(init.body) : null });
      if (/pumpportal/.test(url)) return { status: 200, ok: true, arrayBuffer: async () => new ArrayBuffer(8), text: async () => "" };
      if (w.meta === "fail") throw new Error("net");
      return { ok: true, status: 200, text: async () => JSON.stringify(w.meta) };
    } });
  ctx.globalThis = ctx;
  ctx.HatchrCore = { settings: async () => ({ ...w.storage.local.settings }), secret: async () => (o.noWallet ? "" : "secret"), keypair: () => ({ publicKey: { toBase58: () => "WALLET" } }),
    rpc: async (u, method, params) => {
      if (method === "getSignaturesForAddress") { w.sigReads++; if (w.walletRpcDown) throw new Error("429"); return (w.sigs[params[0]] || []).slice(0, params[1].limit); }
      if (method === "getMultipleAccounts") { w.mcReads++; return { value: params[0].map(k => w.curves[k] ? { data: [curveData(w.curves[k]), "base64"] } : null) }; }
      if (method === "getTransaction") { w.txReads++; return w.txs[params[0]] || null; }
      if (method === "getTokenAccountsByOwner") { w.walletReads++; if (w.walletRpcDown) throw new Error("429");
        const mine = (w.holdings[params[0]] || []); return { value: params[1].programId.startsWith("Tokenkeg") ? mine.map(mint => ({ account: { data: { parsed: { info: { mint, tokenAmount: { uiAmount: 1000 } } } } } })) : [] }; }
      if (method === "getAccountInfo") { if (o.rpcDown) throw new Error("RPC rate limit hit (429)"); return { value: { data: [curveData(w.curve), "base64"] } }; } throw new Error("unexpected rpc " + method); },
    balance: async () => w.balanceSol, tokenBalance: async (u, owner) => (w.balanceReads = (w.balanceReads || 0) + 1, { ui: owner === "WALLET" ? w.walletTokens : w.devTokensOnChain, raw: "1" }),
    send: async () => { w.sent.push(w.clock); return "SIG" + w.sent.length; }, simulate: async () => { w.sims++; return { err: o.simErr || null }; }, confirm: async () => ({}), Tx: { deserialize: () => ({ sign() {} }) },
    texts: async () => ({ texts: ["AI TEXT $FROG"], by: "ai" }), useAi: () => true, saveHeld: async () => {}, lock: fn => fn(), solPrice: async () => ({ usd: 150 }),
    scanHeld: async () => w.scan || [], PublicKey: class { constructor(k) { this.k = String(k); } toBytes() { return new Uint8Array(32); } toBase58() { return this.k; } static findProgramAddressSync(seeds, program) { return [{ toBase58: () => "PDA" + w.lastMintForPda }, 255]; } }, notify: (...a) => w.notes.push(a), watching: s => !s || s.watching !== false, socket: () => ws, reconnect: async () => { w.reconnects++; }, isDesktop: false };
  ctx.HatchrCallouts = { create: async input => { w.callouts.push({ ...input, at: w.clock }); return w.calloutResults.length > 1 ? w.calloutResults.shift() : w.calloutResults[0]; } };
  for (const src of SRC) vm.runInContext(src, ctx);
  await sleep(120);
  const api = ctx.HatchrCalloutAuto;
  const ask = (message, sender = { id: "abc", url: PANEL }) => new Promise(res => { let kept = false; for (const fn of messages) kept = fn(message, sender, res) || kept; if (!kept) setTimeout(() => res({ ok: false, error: "unhandled" }), 20); });
  const create = (mint, over = {}) => api.onStream({ txType: "create", mint, name: "Moon Frog", symbol: "FROG", uri: "https://ipfs.io/ipfs/Qm" + "A".repeat(40) + mint.slice(0, 5), traderPublicKey: "DEV" + mint.slice(0, 3), bondingCurveKey: "CURVE" + mint,
    initialBuy: 20e6, solAmount: 0.6, vTokensInBondingCurve: 1053e6, vSolInBondingCurve: 30.6, marketCapSol: 29, pool: "pump", ...over });
  const trades = (mint, n = 24, each = 5e6) => { for (let i = 0; i < n; i++) api.onStream({ txType: "buy", mint, traderPublicKey: "buyer" + i, tokenAmount: each, newTokenBalance: each, solAmount: 0.5, vTokensInBondingCurve: 1053e6 - each * (i + 1), vSolInBondingCurve: 30.6 + 0.5 * (i + 1), marketCapSol: 29 + i }); };
  const tickAlarm = async () => { for (const fn of alarms) fn({ name: "coAutoTick" }); await sleep(60); };
  const state = async () => (await ask({ type: "coAutoGet" })).data.state;
  return { w, api, ask, create, trades, tickAlarm, state, settle: async () => { await tickAlarm(); await sleep(150); } };
}

const cfg = (over = {}, filters = {}) => ({ enabled: true, buyUsd: 1.5, minIntervalMin: 180, maxPerDay: 4, reserveSol: 0.02, ...over,
  filters: { ageSec: { min: null, max: 600 }, volumeUsd: { min: 1000, max: null }, holders: { min: 15, max: null }, top10Pct: { min: null, max: 40 }, devHoldingPct: { min: null, max: 10 }, anySocial: true, ...filters } });
const MINT = n => `Mint${n}xxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump`;
let count = 0;
const t = async (name, fn) => { await fn(); count++; console.log("ok  " + name); };

(async () => {
  await t("off by default: stream ignored, nothing bought", async () => {
    const e = await boot();
    assert.strictEqual(e.api.wantsStream(), false);
    e.create(MINT(1)); e.trades(MINT(1)); await e.settle();
    assert.strictEqual(e.w.fetches.length, 0); assert.strictEqual(e.w.sent.length, 0);
  });

  await t("TEST mode: reports what it would do, buys and posts nothing", async () => {
    const e = await boot({ config: cfg(), dryRun: true });
    assert.strictEqual(e.api.wantsStream(), true);
    e.create(MINT(1)); await sleep(30); e.trades(MINT(1)); await e.settle();
    assert.strictEqual(e.w.sent.length, 0); assert.strictEqual(e.w.callouts.length, 0);
    const s = await e.state();
    assert.ok(s.log.some(l => l.kind === "test" && /Would buy/.test(l.text)), JSON.stringify(s.log));
    assert.strictEqual(s.buysToday, 0);
  });

  await t("LIVE: one smallest buy, holding checked, callout posted, never a sell", async () => {
    const e = await boot({ config: cfg() });
    e.create(MINT(1)); await sleep(30);
    assert.deepStrictEqual(e.w.wsSent[0], { method: "subscribeTokenTrade", keys: [MINT(1)] });
    e.trades(MINT(1)); await e.settle();
    const buys = e.w.fetches.filter(f => /pumpportal/.test(f.url));
    assert.strictEqual(buys.length, 1);
    assert.strictEqual(buys[0].body.action, "buy"); assert.strictEqual(buys[0].body.mint, MINT(1));
    assert.strictEqual(buys[0].body.amount, 0.01, "$1.50 at $150/SOL"); assert.strictEqual(buys[0].body.denominatedInSol, "true");
    assert.strictEqual(e.w.sent.length, 1);
    assert.strictEqual(e.w.callouts.length, 1);
    assert.strictEqual(e.w.callouts[0].id, "held:" + MINT(1));
    assert.strictEqual(e.w.callouts[0].text, "$FROG just passed my filters, picked up a small bag.");
    assert.ok(e.w.storage.local.heldCoins.some(c => c.id === "held:" + MINT(1) && c.ok && !c.dryRun));
    const s = await e.state();
    assert.strictEqual(s.callsToday, 1); assert.strictEqual(s.buysToday, 1); assert.strictEqual(s.pending.length, 0);
    assert.strictEqual(s.nextSlotAt - e.w.clock, 180 * 60000);
    assert.ok(e.w.wsSent.some(m => m.method === "unsubscribeTokenTrade"));
    // a second good coin right away: the slot is used, so it is not even watched
    e.create(MINT(2), { name: "Other Cat", symbol: "CAT" }); await sleep(30); e.trades(MINT(2)); await e.settle();
    assert.strictEqual(e.w.sent.length, 1); assert.strictEqual(e.w.callouts.length, 1);
    assert.ok(!e.w.fetches.some(f => f.body && f.body.action === "sell"), "no sell, ever");
    // after the interval the next coin is taken
    e.w.clock += 181 * 60000;
    e.create(MINT(3), { name: "Third Dog", symbol: "DOG" }); await sleep(30); e.trades(MINT(3)); await e.settle();
    assert.strictEqual(e.w.sent.length, 2); assert.strictEqual(e.w.callouts.length, 2);
  });

  await t("Hatchr's own callout texts when chosen", async () => {
    const e = await boot({ config: cfg({ textMode: "auto" }) });
    e.create(MINT(1)); await sleep(30); e.trades(MINT(1)); await e.settle();
    assert.strictEqual(e.w.callouts[0].text, "AI TEXT $FROG");
  });

  await t("filters hold: too few holders, no links, a copy, a serial dev -> no buy", async () => {
    const e = await boot({ config: cfg() });
    e.create(MINT(1)); await sleep(30); e.trades(MINT(1), 8); await e.settle();
    assert.strictEqual(e.w.sent.length, 0, "8 holders < 15");
    const e2 = await boot({ config: cfg(), meta: { description: "no links" } });
    e2.create(MINT(1)); await sleep(30); e2.trades(MINT(1)); await e2.settle();
    assert.strictEqual(e2.w.sent.length, 0, "no links");
    const e3 = await boot({ config: cfg(), meta: "fail" });
    e3.create(MINT(1)); await sleep(30); e3.trades(MINT(1)); await e3.settle();
    assert.strictEqual(e3.w.sent.length, 0, "links unreadable");
    const e4 = await boot({ config: cfg({ enabled: true }) });
    e4.create(MINT(9), { initialBuy: 0, solAmount: 0 }); // the original, not good enough to buy
    await sleep(30);
    e4.create(MINT(1)); await sleep(30); e4.trades(MINT(1)); await e4.settle(); // same name + ticker = copy
    assert.strictEqual(e4.w.sent.length, 0, "copy");
    assert.ok(!e4.w.wsSent.some(m => m.keys[0] === MINT(1)), "a copy is not even watched");
    const e5 = await boot({ config: cfg({}, { maxDevCoins: 0 }) });
    e5.create(MINT(8), { name: "Aaa", symbol: "AAA", traderPublicKey: "SAMEDEV" }); await sleep(20);
    e5.create(MINT(1), { traderPublicKey: "SAMEDEV" }); await sleep(30); e5.trades(MINT(1)); await e5.settle();
    assert.ok(!e5.w.callouts.some(c => c.mint === MINT(1)), "serial dev");
  });

  await t("on-chain check has the last word (dev holds too much / curve finished / RPC down)", async () => {
    const e = await boot({ config: cfg(), devTokensOnChain: 300e6 });
    e.create(MINT(1)); await sleep(30); e.trades(MINT(1)); await e.settle();
    assert.strictEqual(e.w.sent.length, 0);
    const e2 = await boot({ config: cfg(), curve: { complete: 1 } });
    e2.create(MINT(1)); await sleep(30); e2.trades(MINT(1)); await e2.settle();
    assert.strictEqual(e2.w.sent.length, 0);
    const e3 = await boot({ config: cfg(), rpcDown: true });
    e3.create(MINT(1)); await sleep(30); e3.trades(MINT(1)); await e3.settle();
    assert.strictEqual(e3.w.sent.length, 0);
    assert.ok((await e3.state()).log.some(l => /not bought/.test(l.text)));
  });

  await t("not held after the buy -> no callout", async () => {
    const e = await boot({ config: cfg(), walletTokens: 0 });
    e.create(MINT(1)); await sleep(30); e.trades(MINT(1)); await e.settle(); await sleep(3000);
    assert.strictEqual(e.w.sent.length, 1); assert.strictEqual(e.w.callouts.length, 0);
    assert.ok((await e.state()).log.some(l => /did not go through/.test(l.text)));
  });

  await t("pump.fun says 'not holding' -> retried a few times, then given up, no second buy meanwhile", async () => {
    const e = await boot({ config: cfg(), calloutResults: [{ sent: false, reason: "cannot-call" }] });
    e.create(MINT(1)); await sleep(30); e.trades(MINT(1)); await e.settle();
    assert.strictEqual(e.w.callouts.length, 1);
    let s = await e.state(); assert.strictEqual(s.pending.length, 1);
    e.create(MINT(2), { name: "Cat", symbol: "CAT" }); await sleep(30); e.trades(MINT(2)); await e.settle();
    assert.strictEqual(e.w.sent.length, 1, "nothing new is bought while a callout is pending");
    for (let i = 0; i < 4; i++) { e.w.clock += 21000; await e.tickAlarm(); }
    assert.strictEqual(e.w.callouts.length, 4);
    s = await e.state(); assert.strictEqual(s.pending.length, 0); assert.strictEqual(s.callsToday, 0);
    assert.ok(s.log.some(l => /does not hold \$1/.test(l.text)));
  });

  await t("rate limit backs off; not signed in pauses until Resume", async () => {
    const e = await boot({ config: cfg(), calloutResults: [{ sent: false, reason: "rate-limited" }, { sent: true, url: "u", calledAt: 1 }] });
    e.create(MINT(1)); await sleep(30); e.trades(MINT(1)); await e.settle();
    e.w.clock += 60000; await e.tickAlarm();
    assert.strictEqual(e.w.callouts.length, 1, "waits 30 minutes");
    e.w.clock += 30 * 60000; await e.tickAlarm();
    assert.strictEqual(e.w.callouts.length, 2); assert.strictEqual((await e.state()).callsToday, 1);

    const p = await boot({ config: cfg(), calloutResults: [{ sent: false, reason: "not-signed-in" }, { sent: true, url: "u", calledAt: 1 }] });
    p.create(MINT(1)); await sleep(30); p.trades(MINT(1)); await p.settle();
    let s = await p.state(); assert.strictEqual(s.paused, "not-signed-in"); assert.strictEqual(s.pending.length, 1);
    p.w.clock += 60000; await p.tickAlarm(); assert.strictEqual(p.w.callouts.length, 1, "paused: no retries");
    await p.ask({ type: "coAutoResume" }); await p.tickAlarm();
    s = await p.state(); assert.strictEqual(s.paused, ""); assert.strictEqual(p.w.callouts.length, 2); assert.strictEqual(s.pending.length, 0);
  });

  await t("unconfirmed callout is never sent twice", async () => {
    const e = await boot({ config: cfg(), calloutResults: [{ sent: false, reason: "unknown" }] });
    e.create(MINT(1)); await sleep(30); e.trades(MINT(1)); await e.settle();
    e.w.clock += 60000; await e.tickAlarm(); await e.tickAlarm();
    assert.strictEqual(e.w.callouts.length, 1);
    assert.strictEqual((await e.state()).pending.length, 0);
  });

  await t("safety stops: low balance, no wallet, daily cap, main switch off", async () => {
    const e = await boot({ config: cfg(), balanceSol: 0.02 });
    e.create(MINT(1)); await sleep(30); e.trades(MINT(1)); await e.settle();
    assert.strictEqual(e.w.sent.length, 0); assert.strictEqual((await e.state()).paused, "low-balance");
    const e2 = await boot({ config: cfg(), noWallet: true });
    e2.create(MINT(1)); await sleep(30); e2.trades(MINT(1)); await e2.settle();
    assert.strictEqual((await e2.state()).paused, "no-wallet");
    const e3 = await boot({ config: cfg({ maxPerDay: 1, minIntervalMin: 10 }) });
    e3.create(MINT(1)); await sleep(30); e3.trades(MINT(1)); await e3.settle();
    e3.w.clock += 11 * 60000;
    e3.create(MINT(2), { name: "Cat", symbol: "CAT" }); await sleep(30); e3.trades(MINT(2)); await e3.settle();
    assert.strictEqual(e3.w.sent.length, 1, "1 per day");
    const e4 = await boot({ config: cfg(), settings: { watching: false } });
    assert.strictEqual(e4.api.wantsStream(), false);
    e4.create(MINT(1)); await sleep(30); e4.trades(MINT(1)); await e4.settle();
    assert.strictEqual(e4.w.sent.length, 0);
    const e5 = await boot({ config: cfg(), perm: false });
    e5.create(MINT(1)); await sleep(30); e5.trades(MINT(1)); await e5.settle();
    assert.strictEqual(e5.w.sent.length, 0, "no buy when the callout could not be sent anyway");
    assert.strictEqual((await e5.state()).paused, "no-permission");
  });

  await t("messages: only the side panel may change it; saving cleans the config", async () => {
    const e = await boot();
    const bad = await e.ask({ type: "coAutoSave", config: cfg() }, { id: "abc", url: "https://evil.example/" });
    assert.strictEqual(bad.ok, false); assert.strictEqual(e.api.wantsStream(), false);
    const good = await e.ask({ type: "coAutoSave", config: { enabled: true, buyUsd: 0.01, maxPerDay: 999 } });
    assert.strictEqual(good.ok, true); assert.strictEqual(good.data.config.buyUsd, 0.01); assert.strictEqual(good.data.config.maxPerDay, 999);
    assert.strictEqual(e.api.wantsStream(), true); assert.ok(e.w.reconnects >= 1);
    assert.strictEqual(e.w.storage.local.coAuto.enabled, true);
  });

  await t("a sell by the dev seen on the stream lowers dev holding; non-pump coins ignored", async () => {
    const e = await boot({ config: cfg({}, { devHoldingPct: { min: null, max: 1 } }), devTokensOnChain: 0 });
    e.create(MINT(1)); await sleep(30); e.trades(MINT(1)); await e.settle();
    assert.strictEqual(e.w.sent.length, 0, "dev still holds 2%");
    e.api.onStream({ txType: "sell", mint: MINT(1), traderPublicKey: "DEV" + MINT(1).slice(0, 3), tokenAmount: 20e6, newTokenBalance: 0, solAmount: 0.6, vTokensInBondingCurve: 950e6, vSolInBondingCurve: 41, marketCapSol: 50 });
    await sleep(800); e.api.onStream({ txType: "buy", mint: MINT(1), traderPublicKey: "late", tokenAmount: 1e6, newTokenBalance: 1e6, solAmount: 0.1, vTokensInBondingCurve: 949e6, vSolInBondingCurve: 41.1, marketCapSol: 50 });
    await e.settle();
    assert.strictEqual(e.w.sent.length, 1);
    const e2 = await boot({ config: cfg() });
    e2.create("BonkMintxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxbonk", { pool: "bonk" }); await sleep(30);
    assert.strictEqual(e2.w.wsSent.length, 0);
  });

  await t("a coin priced in another token than SOL (the $Mew failure, pump.fun error 6063) is never sent", async () => {
    const e = await boot({ config: cfg(), curve: { quote: USDC } });
    e.create(MINT(1)); await sleep(30); e.trades(MINT(1)); await e.settle();
    assert.strictEqual(e.w.fetches.filter(f => /pumpportal/.test(f.url)).length, 0, "not even built");
    assert.strictEqual(e.w.sent.length, 0);
    let s = await e.state();
    assert.ok(s.log.some(l => l.kind === "info" && /priced in another token than SOL/.test(l.text)), JSON.stringify(s.log));
    assert.strictEqual(s.buysToday, 0); assert.strictEqual(s.skips["not priced in SOL"], 1);
    // the next good coin is taken straight away: no penalty pause for this
    e.w.curve = { quote: WSOL };
    e.create(MINT(2), { name: "Tidy Otter", symbol: "OTTER" }); await sleep(30); e.trades(MINT(2)); await e.settle();
    assert.strictEqual(e.w.sent.length, 1, "a coin whose quote is wrapped SOL is fine: " + JSON.stringify((await e.state()).log.map(l => l.text)) + JSON.stringify((await e.state()).skips));
    // told by the stream itself: not even watched
    const e2 = await boot({ config: cfg() });
    e2.create(MINT(1), { quoteMint: "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v" }); await sleep(30);
    assert.strictEqual(e2.w.wsSent.filter(m => m.method === "subscribeTokenTrade").length, 0);
  });

  await t("every buy is simulated first: one that would fail is not sent and costs nothing", async () => {
    const e = await boot({ config: cfg(), simErr: { InstructionError: [3, { Custom: 6063 }] } });
    e.create(MINT(1)); await sleep(30); e.trades(MINT(1)); await e.settle();
    assert.strictEqual(e.w.sims, 1); assert.strictEqual(e.w.sent.length, 0);
    const s = await e.state();
    assert.ok(s.log.some(l => /priced in another token than SOL, pump.fun error 6063/.test(l.text) && /cost nothing/.test(l.text)), JSON.stringify(s.log));
    assert.strictEqual(s.buysToday, 0);
  });

  await t("a buy that fails on-chain does not use up the day's buys; four in a row pause it", async () => {
    const e = await boot({ config: cfg({ minIntervalMin: 10 }), walletTokens: 0 });
    const names = [["Aaa", "AAA"], ["Bbb", "BBB"], ["Ccc", "CCC"], ["Ddd", "DDD"]];
    for (let i = 0; i < 4; i++) {
      e.create(MINT(i + 1), { name: names[i][0], symbol: names[i][1], traderPublicKey: "DEVNO" + i }); await sleep(30); e.trades(MINT(i + 1)); await e.settle(); await sleep(2800);
      const s = await e.state();
      assert.strictEqual(s.buysToday, 0, "failed buys are not counted");
      assert.strictEqual(e.w.sent.length, i + 1);
      e.w.clock += 3 * 60000;
    }
    const s = await e.state();
    assert.strictEqual(s.paused, "buy-fails");
    e.create(MINT(9), { name: "Eee", symbol: "EEE", traderPublicKey: "DEVNO9" }); await sleep(30); e.trades(MINT(9)); await e.settle();
    assert.strictEqual(e.w.sent.length, 4, "paused: no fifth attempt");
  });

  const own = (over = {}) => cfg({ enabled: false, ownBuys: true, ...over });
  const myBuy = (e, mint, who = "WALLET", signature = "") => e.api.onStream({ txType: "buy", mint, signature, traderPublicKey: who, tokenAmount: 5e5, newTokenBalance: 5e5, solAmount: 0.05, vTokensInBondingCurve: 1e9, vSolInBondingCurve: 31, marketCapSol: 30, pool: "pump" });
  const step = async (e, ms) => { e.w.clock += ms; await e.tickAlarm(); await sleep(40); };
  // a transaction as the RPC returns it: who signed, and the wallet's coin balances before and after
  let sigNo = 0;
  const addTx = (e, wallet, mint, { signer = wallet, before = 0, after = 1000, err = null } = {}) => {
    const signature = "sig" + (++sigNo);
    e.w.txs[signature] = { meta: { err, preTokenBalances: before ? [{ owner: wallet, mint, uiTokenAmount: { uiAmount: before } }] : [], postTokenBalances: [{ owner: wallet, mint, uiTokenAmount: { uiAmount: after } }] },
      transaction: { message: { header: { numRequiredSignatures: 1 }, accountKeys: [signer, "x", "y"] } } };
    (e.w.sigs[wallet] = e.w.sigs[wallet] || []).unshift({ signature, err, blockTime: Math.floor(e.w.clock / 1000) });
    return signature;
  };

  await t("own buys, instant: pump.fun's stream names your wallet -> callout goes out within a second", async () => {
    const e = await boot({ config: own() });
    assert.strictEqual(e.api.wantsStream(), true);
    await step(e, 1000);
    e.create(MINT(1), { name: "Tidy Otter", symbol: "OTTER" });
    myBuy(e, MINT(1), "WALLET", "sigA");
    await sleep(80);
    assert.strictEqual(e.w.callouts.length, 1, "sent at once: no waiting for a timer, the RPC or the minute alarm");
    assert.strictEqual(e.w.walletReads, 0, "the buy itself was seen: no RPC look-up before sending");
    assert.strictEqual(e.w.callouts[0].id, "held:" + MINT(1)); assert.strictEqual(e.w.callouts[0].text, "Just bought $OTTER.");
    assert.strictEqual(e.w.sent.length, 0, "this switch never buys");
    const s = await e.state();
    assert.ok(s.log.some(l => /You bought \$OTTER \(seen by the stream/.test(l.text)), JSON.stringify(s.log.map(l => l.text)));
    myBuy(e, MINT(1), "WALLET", "sigB"); await step(e, 3000);
    assert.strictEqual(e.w.callouts.length, 1, "a coin already called is not called again");
    myBuy(e, MINT(2), "SOMEONE_ELSE"); await step(e, 3000);
    assert.strictEqual(e.w.callouts.length, 1, "other people's buys are ignored");
  });

  await t("own buys, instant: your RPC reports the transaction (any venue) -> read, verified, called", async () => {
    const e = await boot({ config: own(), feed: true });
    await sleep(80);
    const feed = e.w.feeds.at(-1);
    assert.ok(feed && feed.url === "wss://rpc", "a live line to your own RPC");
    assert.deepStrictEqual(feed.sent[0].params[0], { mentions: ["WALLET"] });
    const sig = addTx(e, "WALLET", MINT(3));
    feed.notify(101, sig); await sleep(200);
    assert.strictEqual(e.w.callouts.length, 1); assert.strictEqual(e.w.callouts[0].mint, MINT(3));
    assert.strictEqual(e.w.callouts[0].text, "Just bought this one.", "ticker unknown: the text does not fake one");
    // a top-up of a coin you already held counts as a buy too
    const sig2 = addTx(e, "WALLET", MINT(4), { before: 500, after: 900 });
    feed.notify(101, sig2); await sleep(200);
    assert.strictEqual(e.w.callouts.length, 2);
    // NOT buys: a coin somebody sends you (airdrop / spam), a sell, a failed transaction
    feed.notify(101, addTx(e, "WALLET", MINT(5), { signer: "SPAMMER" })); await sleep(150);
    feed.notify(101, addTx(e, "WALLET", MINT(6), { before: 900, after: 100 })); await sleep(150);
    feed.notify(101, addTx(e, "WALLET", MINT(7), { err: { InstructionError: [0, "x"] } }), { x: 1 }); await sleep(150);
    assert.strictEqual(e.w.callouts.length, 2, "airdrops, sells and failed transactions are never called");
    // the same transaction seen again by the slower check does nothing
    await step(e, 61000); await step(e, 61000);
    assert.strictEqual(e.w.callouts.length, 2);
  });

  await t("own buys, fallback: with no live line the wallet is checked every ~10 s; history before switching on is ignored", async () => {
    const e = await boot({ holdings: { WALLET: [] } });
    addTx(e, "WALLET", MINT(1)); addTx(e, "WALLET", MINT(2));                  // bought before the switch was on
    const r = await e.ask({ type: "coAutoSave", config: { ownBuys: true } });
    assert.strictEqual(r.data.config.ownBuys, true); assert.strictEqual(r.data.config.enabled, false);
    await step(e, 10000); await step(e, 10000);
    assert.strictEqual(e.w.callouts.length, 0, "old buys are not called");
    addTx(e, "WALLET", MINT(3));
    await step(e, 10000); await sleep(100);
    assert.strictEqual(e.w.callouts.length, 1); assert.strictEqual(e.w.callouts[0].mint, MINT(3));
    e.w.walletRpcDown = true; await step(e, 10000); e.w.walletRpcDown = false;
    addTx(e, "WALLET", MINT(4)); await step(e, 10000); await sleep(100);
    assert.strictEqual(e.w.callouts.length, 2, "picks up again after an RPC hiccup");
  });

  await t("own buys: pump.fun lagging behind the chain is retried within seconds; TEST posts nothing", async () => {
    const e = await boot({ config: own(), calloutResults: [{ sent: false, reason: "cannot-call" }, { sent: false, reason: "cannot-call" }, { sent: true, url: "u", calledAt: 1 }] });
    await step(e, 1000);
    e.create(MINT(1), { name: "Tidy Otter", symbol: "OTTER" }); myBuy(e, MINT(1), "WALLET", "s1");
    await sleep(80); assert.strictEqual(e.w.callouts.length, 1);
    await step(e, 1600); assert.strictEqual(e.w.callouts.length, 2, "second try after 1.5 s");
    await step(e, 2600); assert.strictEqual(e.w.callouts.length, 3, "third try after 2.5 s");
    const s = await e.state();
    assert.strictEqual(s.pending.length, 0);
    assert.ok(s.log.some(l => /Called out \$OTTER.*after Hatchr saw the buy \(pump.fun took .* after refusing 2 times/.test(l.text)), JSON.stringify(s.log.map(l => l.text)));
    assert.ok(s.log.some(l => /does not show your \$OTTER yet/.test(l.text)));
    const t2 = await boot({ config: own(), dryRun: true });
    await step(t2, 1000);
    t2.create(MINT(1), { name: "Tidy Otter", symbol: "OTTER" }); myBuy(t2, MINT(1), "WALLET", "s2"); await sleep(100);
    assert.strictEqual(t2.w.callouts.length, 0);
    assert.ok((await t2.state()).log.some(l => l.kind === "test" && /you bought \$OTTER/.test(l.text)));
  });

  await t("own buys: the second wallet (the one you use on pump.fun) is watched too", async () => {
    const W2 = "Wa2222222222222222222222222222222222222w";
    const e = await boot({ config: own(), feed: true, settings: { calloutWallet: W2 } });
    await sleep(80);
    const feed = e.w.feeds.at(-1);
    assert.deepStrictEqual(feed.sent.filter(m => m.method === "logsSubscribe").map(m => m.params[0].mentions[0]), ["WALLET", W2]);
    assert.ok(e.w.wsSent.some(m => m.method === "subscribeAccountTrade" && m.keys.includes(W2)));
    feed.notify(102, addTx(e, W2, MINT(6))); await sleep(200);
    assert.strictEqual(e.w.callouts.length, 1); assert.strictEqual(e.w.callouts[0].mint, MINT(6));
  });

  await t("both switches: the automode's own purchase is not called a second time as 'your buy'", async () => {
    const e = await boot({ config: cfg({ ownBuys: true }), feed: true });
    await sleep(80);
    e.create(MINT(1)); await sleep(30); e.trades(MINT(1));
    await e.settle();
    assert.strictEqual(e.w.sent.length, 1); assert.strictEqual(e.w.callouts.length, 1);
    myBuy(e, MINT(1), "WALLET", "auto1");                                       // the stream echoes Hatchr's own buy
    e.w.feeds.at(-1).notify(101, addTx(e, "WALLET", MINT(1)));                  // and so does the RPC
    await step(e, 3000); await step(e, 11000);
    assert.strictEqual(e.w.callouts.length, 1);
    assert.strictEqual(e.w.callouts[0].text, "$FROG just passed my filters, picked up a small bag.");
    // your own buy still goes out even though the automatic slot is closed for 3 hours
    e.create(MINT(2), { name: "Tidy Otter", symbol: "OTTER" }); myBuy(e, MINT(2), "WALLET", "mine2");
    await sleep(100);
    assert.strictEqual(e.w.callouts.length, 2); assert.strictEqual(e.w.callouts[1].text, "Just bought $OTTER.");
    assert.strictEqual(e.w.sent.length, 1, "still only the one automatic buy");
  });

  await t("no limits: 0 minutes and 0 per day buy every coin that passes; any dev count allowed when left empty", async () => {
    const e = await boot({ config: cfg({ minIntervalMin: 0, maxPerDay: 0 }, { maxDevCoins: "", cloneWindowMin: 0 }) });
    const names = ["Aaa", "Bbb", "Ccc", "Ddd", "Eee", "Fff"];
    for (let i = 0; i < 6; i++) { e.create(MINT(i + 1), { name: names[i], symbol: names[i].toUpperCase(), traderPublicKey: "ONEDEV" }); await sleep(30); e.trades(MINT(i + 1)); await e.settle(); }
    assert.strictEqual(e.w.sent.length, 6); assert.strictEqual(e.w.callouts.length, 6);
    const c = (await e.ask({ type: "coAutoGet" })).data.config;
    assert.strictEqual(c.minIntervalMin, 0); assert.strictEqual(c.maxPerDay, 0); assert.strictEqual(c.filters.maxDevCoins, null);
    // look back 0: an exact copy made a moment later is not seen as a copy
    e.create(MINT(7), { name: "Aaa", symbol: "AAA", traderPublicKey: "ONEDEV" }); await sleep(30); e.trades(MINT(7)); await e.settle();
    assert.strictEqual(e.w.sent.length, 7);
  });

  await t("my callout texts: used by the automodes when chosen, and offered in the callout window", async () => {
    const e = await boot({ config: cfg({ textMode: "list", texts: "{ticker} one\n{name} two" }) });
    e.create(MINT(1)); await sleep(30); e.trades(MINT(1)); await e.settle();
    assert.ok(["$FROG one", "Moon Frog two"].includes(e.w.callouts[0].text), e.w.callouts[0].text);
    e.w.storage.local.heldCoins = [{ id: "held:X", mint: "X", name: "Dacity Coin", ticker: "DACITY", ok: true }];
    const ai = async () => ({ texts: ["AI says hi"], by: "ai" }), dead = async () => ({ texts: ["built-in"], by: "built-in", error: "AI error 500" });
    assert.deepStrictEqual(await e.api.windowTexts("held:X", ai), { texts: ["AI says hi"], by: "ai" }, "a working AI still wins");
    const mine = await e.api.windowTexts("held:X", dead);
    assert.strictEqual(mine.by, "custom"); assert.strictEqual(mine.error, "AI error 500");
    assert.deepStrictEqual([...mine.texts].sort(), ["$DACITY one", "Dacity Coin two"]);
    await e.ask({ type: "coAutoSave", config: cfg({ textsOnly: true, texts: "only {ticker}" }) });
    let asked = 0;
    assert.strictEqual(JSON.stringify(await e.api.windowTexts("held:X", async () => { asked++; return { texts: ["AI"], by: "ai" }; })), JSON.stringify({ texts: ["only $DACITY"], by: "custom" }));
    assert.strictEqual(asked, 0, "the AI is not even asked");
    await e.ask({ type: "coAutoSave", config: cfg({ texts: "" }) });
    assert.deepStrictEqual(await e.api.windowTexts("held:X", dead), { texts: ["built-in"], by: "built-in", error: "AI error 500" }, "emptied list -> Hatchr's built-in texts again");
  });

  await t("own buys still go out while the automatic buying is paused (failed buys, low balance) or busy with a buy", async () => {
    const e = await boot({ config: cfg({ ownBuys: true }), balanceSol: 0.001 });
    e.create(MINT(1)); await sleep(30); e.trades(MINT(1)); await e.settle();
    assert.strictEqual((await e.state()).paused, "low-balance");
    e.create(MINT(2), { name: "Tidy Otter", symbol: "OTTER" }); myBuy(e, MINT(2), "WALLET", "p1"); await sleep(100);
    assert.strictEqual(e.w.callouts.length, 1, "a buying problem does not stop your own callouts");
    assert.strictEqual(e.w.callouts[0].mint, MINT(2));
    // a pause about pump.fun itself (not signed in) does hold them, until Resume
    const p = await boot({ config: own(), calloutResults: [{ sent: false, reason: "not-signed-in" }, { sent: true, url: "u", calledAt: 1 }] });
    p.create(MINT(1), { name: "Tidy Otter", symbol: "OTTER" }); myBuy(p, MINT(1), "WALLET", "p2"); await sleep(100);
    assert.strictEqual((await p.state()).paused, "not-signed-in");
    await step(p, 5000); assert.strictEqual(p.w.callouts.length, 1);
    await p.ask({ type: "coAutoResume" }); await step(p, 100);
    assert.strictEqual(p.w.callouts.length, 2);
  });

  await t("own buys: a transaction the RPC cannot show yet is read again, not written off", async () => {
    const e = await boot({ config: own(), feed: true });
    await sleep(80);
    const sig = addTx(e, "WALLET", MINT(1));
    const real = e.w.txs[sig]; delete e.w.txs[sig];                               // RPC: "not found" for now
    e.w.feeds.at(-1).notify(101, sig);
    await sleep(3200);                                                            // 8 quick tries, all empty
    assert.strictEqual(e.w.callouts.length, 0);
    e.w.txs[sig] = real;                                                          // now it is there
    await sleep(1800);
    assert.strictEqual(e.w.callouts.length, 1, "picked up on the next look");
  });

  await t("callout timing: wait N seconds after your own buy, and the wallet is looked at again before it goes out", async () => {
    const e = await boot({ config: own({ ownDelaySec: 30 }) });
    await step(e, 1000);
    e.create(MINT(1), { name: "Tidy Otter", symbol: "OTTER" }); myBuy(e, MINT(1), "WALLET", "d1");
    await sleep(100); assert.strictEqual(e.w.callouts.length, 0, "not at once");
    await step(e, 20000); assert.strictEqual(e.w.callouts.length, 0, "not after 20 s");
    let s = await e.state();
    assert.ok(s.log.some(l => /You bought \$OTTER\. Its callout goes out in 30 s\./.test(l.text)), JSON.stringify(s.log.map(l => l.text)));
    await step(e, 10500);
    assert.strictEqual(e.w.callouts.length, 1, "after 30 s");
    assert.ok(e.w.balanceReads > 0, "holding checked again after the wait");
    // sold during the wait -> not called
    const e2 = await boot({ config: own({ ownDelaySec: 30 }) });
    await step(e2, 1000);
    e2.create(MINT(1), { name: "Tidy Otter", symbol: "OTTER" }); myBuy(e2, MINT(1), "WALLET", "d2");
    e2.w.walletTokens = 0;
    await step(e2, 31000); await step(e2, 2100); await step(e2, 2100); await step(e2, 2100);
    assert.strictEqual(e2.w.callouts.length, 0);
    assert.ok((await e2.state()).log.some(l => /sold before its callout was due/.test(l.text)));
  });

  await t("callout timing: only once the market cap is reached (live from the stream, or read from the chain)", async () => {
    const e = await boot({ config: own({ ownMinMcUsd: 20000 }) });                 // SOL = $150 in this test
    await step(e, 1000);
    e.create(MINT(1), { name: "Tidy Otter", symbol: "OTTER" }); myBuy(e, MINT(1), "WALLET", "m1"); // market cap 30 SOL = $4,500
    await step(e, 3000);
    assert.strictEqual(e.w.callouts.length, 0);
    assert.ok(e.w.wsSent.some(m => m.method === "subscribeTokenTrade" && m.keys[0] === MINT(1)), "its trades are followed for the market cap");
    let s = await e.state();
    assert.ok(s.log.some(l => /once its market cap reaches \$20,000 \(now \$4,500\)/.test(l.text)), JSON.stringify(s.log.map(l => l.text)));
    e.api.onStream({ txType: "buy", mint: MINT(1), traderPublicKey: "whale", tokenAmount: 1e6, solAmount: 5, marketCapSol: 120, vTokensInBondingCurve: 6e8, vSolInBondingCurve: 70 }); // $18,000
    await sleep(80); assert.strictEqual(e.w.callouts.length, 0, "$18,000 is not enough");
    e.api.onStream({ txType: "buy", mint: MINT(1), traderPublicKey: "whale2", tokenAmount: 1e6, solAmount: 5, marketCapSol: 140, vTokensInBondingCurve: 5e8, vSolInBondingCurve: 80 }); // $21,000
    await sleep(120);
    assert.strictEqual(e.w.callouts.length, 1, "called the moment it crossed");
    // quiet stream: the number comes from the chain
    const c = await boot({ config: own({ ownMinMcUsd: 20000 }), feed: true });
    await sleep(80);
    c.w.lastMintForPda = MINT(2);
    c.w.feeds.at(-1).notify(101, addTx(c, "WALLET", MINT(2)));
    c.w.curves["PDA" + MINT(2)] = { vTokens: 900e6, vSol: 40 };                    // 44.4 SOL = $6,667
    await sleep(150); await step(c, 5000);
    assert.strictEqual(c.w.callouts.length, 0); assert.ok(c.w.mcReads > 0);
    c.w.curves["PDA" + MINT(2)] = { vTokens: 500e6, vSol: 80 };                    // 160 SOL = $24,000
    await step(c, 5000); await sleep(80);
    assert.strictEqual(c.w.callouts.length, 1);
  });

  await t("callout timing for automatic buys: waiting coins do not hold up the next buy; the wait can run out", async () => {
    const e = await boot({ config: cfg({ minIntervalMin: 0, maxPerDay: 0, autoMinMcUsd: 50000, waitMaxMin: 10 }, { cloneWindowMin: 0, maxDevCoins: "" }) });
    e.create(MINT(1), { name: "Aaa", symbol: "AAA" }); await sleep(30); e.trades(MINT(1)); await e.settle();
    assert.strictEqual(e.w.sent.length, 1); assert.strictEqual(e.w.callouts.length, 0, "bought, callout waits for $50,000");
    e.create(MINT(2), { name: "Bbb", symbol: "BBB" }); await sleep(30); e.trades(MINT(2)); await e.settle();
    assert.strictEqual(e.w.sent.length, 2, "the next coin is still bought");
    e.api.onStream({ txType: "buy", mint: MINT(2), traderPublicKey: "whale", tokenAmount: 1e6, solAmount: 9, marketCapSol: 400, vTokensInBondingCurve: 3e8, vSolInBondingCurve: 110 }); // $60,000
    await sleep(150);
    assert.strictEqual(e.w.callouts.length, 1); assert.strictEqual(e.w.callouts[0].mint, MINT(2));
    await step(e, 11 * 60000);
    const s = await e.state();
    assert.strictEqual(s.pending.length, 0);
    assert.ok(s.log.some(l => /\$AAA did not reach \$50,000 within 10 min/.test(l.text)), JSON.stringify(s.log.map(l => l.text)));
    assert.strictEqual(e.w.callouts.length, 1);
    assert.ok(!e.w.fetches.some(f => f.body && f.body.action === "sell"), "never sold");
    // delay only, for automatic buys
    const d = await boot({ config: cfg({ autoDelaySec: 60 }) });
    d.create(MINT(1)); await sleep(30); d.trades(MINT(1)); await d.settle();
    assert.strictEqual(d.w.sent.length, 1); assert.strictEqual(d.w.callouts.length, 0);
    await step(d, 61000);
    assert.strictEqual(d.w.callouts.length, 1);
  });

  await t("no waiting by default; the old 180-minute default is moved to 0 once; a new setting counts at once; Skip the wait", async () => {
    assert.strictEqual((await (await boot()).ask({ type: "coAutoGet" })).data.config.minIntervalMin, 0, "fresh setup: no waiting");
    // a setup made before 3.6.7, still on the old default, in the middle of its wait
    const e = await boot({ config: cfg({ minIntervalMin: 180 }), oldSetup: true });
    let c = (await e.ask({ type: "coAutoGet" })).data;
    assert.strictEqual(c.config.minIntervalMin, 0); assert.strictEqual(e.w.storage.local.coAuto.minIntervalMin, 0);
    assert.ok(c.state.log.some(l => /180-minute wait between automatic buys is switched off/.test(l.text)));
    e.create(MINT(1), { name: "Aaa", symbol: "AAA", traderPublicKey: "D1" }); await sleep(30); e.trades(MINT(1)); await e.settle();
    e.create(MINT(2), { name: "Bbb", symbol: "BBB", traderPublicKey: "D2" }); await sleep(30); e.trades(MINT(2)); await e.settle();
    assert.strictEqual(e.w.sent.length, 2, "two buys in a row, no wait in between");
    // a wait you set yourself is kept (not moved a second time), and counts immediately
    await e.ask({ type: "coAutoSave", config: cfg({ minIntervalMin: 180 }) });
    c = (await e.ask({ type: "coAutoGet" })).data;
    assert.strictEqual(c.config.minIntervalMin, 180); assert.strictEqual(c.state.nextSlotAt - e.w.clock, 180 * 60000);
    e.create(MINT(3), { name: "Ccc", symbol: "CCC", traderPublicKey: "D3" }); await sleep(30); e.trades(MINT(3)); await e.settle();
    assert.strictEqual(e.w.sent.length, 2, "waiting, as set");
    await e.ask({ type: "coAutoSkipWait" });
    e.create(MINT(4), { name: "Ddd", symbol: "DDD", traderPublicKey: "D4" }); await sleep(30); e.trades(MINT(4)); await e.settle();
    assert.strictEqual(e.w.sent.length, 3, "Skip the wait");
    // changing the wait to 0 while a wait is running ends it at once
    await e.ask({ type: "coAutoSave", config: cfg({ minIntervalMin: 0 }) });
    e.create(MINT(5), { name: "Eee", symbol: "EEE", traderPublicKey: "D5" }); await sleep(30); e.trades(MINT(5)); await e.settle();
    assert.strictEqual(e.w.sent.length, 4);
  });

  await t("Coins you hold: Refresh finds a buy made seconds ago even when the RPC's wallet list has not caught up", async () => {
    const e = await boot({ scan: [] });                                           // both switches off: this is the plain Refresh button
    e.w.storage.local.heldCoins = [];
    const lagging = async () => { await e.w.storage.local; e.w.storage.local.heldCoins = []; return []; }; // the RPC list: still empty
    e.w.clock += 1000;
    addTx(e, "WALLET", MINT(1), { after: 157500 });                               // bought 20 s ago
    addTx(e, "WALLET", MINT(2), { signer: "SPAMMER" });                           // an airdrop: must not be listed as a buy
    e.w.clock += 20000;
    const list = JSON.parse(JSON.stringify(await e.api.scanHeld(lagging)));
    assert.deepStrictEqual(list.map(c => c.mint), [MINT(1)]);
    assert.strictEqual(list[0].amount, 157500); assert.strictEqual(list[0].id, "held:" + MINT(1)); assert.strictEqual(list[0].ok, true);
    assert.deepStrictEqual(e.w.storage.local.heldCoins.map(c => c.mint), [MINT(1)]);
    // once the RPC list has it, nothing is doubled
    const caught = async () => { e.w.storage.local.heldCoins = [{ id: "held:" + MINT(1), mint: MINT(1), amount: 157500, ok: true }]; return e.w.storage.local.heldCoins; };
    assert.strictEqual((await e.api.scanHeld(caught)).length, 1);
    // two Refresh presses at once share one read
    let runs = 0; const slow = async () => { runs++; await sleep(50); return []; };
    await Promise.all([e.api.scanHeld(slow), e.api.scanHeld(slow)]);
    assert.strictEqual(runs, 1);
    // old buys (over 4 minutes) are left to the RPC list
    const e2 = await boot({ scan: [] });
    addTx(e2, "WALLET", MINT(3)); e2.w.clock += 10 * 60000;
    assert.strictEqual((await e2.api.scanHeld(async () => [])).length, 0);
  });

  await t("own buys: the RPC's wallet list lagging does not hold the callout back", async () => {
    const e = await boot({ config: own(), feed: true, walletTokens: 0 });       // tokenBalance says 0: the list has not caught up
    await sleep(80);
    e.w.feeds.at(-1).notify(101, addTx(e, "WALLET", MINT(1), { after: 5000 }));
    await sleep(150);
    assert.strictEqual(e.w.callouts.length, 1, "goes out at once on what the transaction itself showed");
    assert.ok(e.w.storage.local.heldCoins.some(c => c.mint === MINT(1) && c.amount === 5000));
  });

  console.log(`\n${count} engine tests passed`);
  process.exit(0);
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
