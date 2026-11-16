// Tests for CA buy (src/ca-buy.js) and pump alerts (src/pump-alerts.js): the built files run here against a stand-in
// wallet, RPC, PumpPortal, DexScreener and Telegram. Nothing leaves this machine and nothing is bought or sent.
// Run by `npm test` against the built extension; or by hand: node test/callout-auto/extras.test.js [folder with the built files]
const fs = require("fs"), vm = require("vm"), assert = require("assert");
const dir = require("path").resolve(process.argv[2] || require("path").join(__dirname, "../../extension"));
const SRC = name => fs.readFileSync(dir + "/" + name, "utf8");
const sleep = ms => new Promise(r => setTimeout(r, ms));
const PANEL = "chrome-extension://abc/sidepanel.html";
const CA = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", PUMP = "93p4QaYFhJyQZSwKbHXLWexVxtLr7HiR35ZdBnUzpump", OTHER = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const SIGNATURE = "5VERv8NMvzbJMEkV8xnrLkEaWRtSz9CosKDYjCJjBRnbJLgp8uirBgmQpjKhoR4tjF3ZpRzrFmBV6UjKdiSZkQUW";

function boot(files, o = {}) {
  const w = { clock: 1_800_000_000_000, calls: [], fetches: [], sent: [], sims: 0, notes: [], sounds: 0, tg: [], expect: [], handed: [], storage: { local: {} },
    settings: { rpcUrl: "https://rpc", dryRun: !!o.dryRun, watching: true, ...(o.settings || {}) }, balanceSol: o.balanceSol ?? 5, walletTokens: o.walletTokens ?? 1000,
    portal: o.portal || 200, jup: o.jup || "route", quoteMint: o.quoteMint || null, rpcHangs: !!o.rpcHangs, jupImpact: o.jupImpact ?? 0.0145, dex: o.dex || [], curves: {}, updates: o.updates || [],
    feeLevels: o.feeLevels, recentFees: o.recentFees, files: o.files || {}, accounts: o.accounts || {}, txs: o.txs || {}, owned: o.owned || {}, sockets: [] };
  const changed = [], alarms = [], messages = [];
  w.storage.local.settings = w.settings;
  Object.assign(w.storage.local, o.store || {});
  const area = { get: async keys => { const out = {}; for (const k of [].concat(keys)) if (k in w.storage.local) out[k] = JSON.parse(JSON.stringify(w.storage.local[k])); return out; },
    set: async obj => { const ch = {}; for (const [k, v] of Object.entries(obj)) { ch[k] = { oldValue: w.storage.local[k], newValue: JSON.parse(JSON.stringify(v)) }; w.storage.local[k] = ch[k].newValue; } changed.forEach(fn => fn(ch, "local")); } };
  class FakeDate extends Date { constructor(...a) { super(...(a.length ? a : [w.clock])); } static now() { return w.clock; } }
  const ok = body => ({ ok: true, status: 200, json: async () => body, text: async () => JSON.stringify(body), arrayBuffer: async () => new ArrayBuffer(8) });
  const ctx = vm.createContext({ console, setTimeout, clearTimeout, setInterval: () => 0, clearInterval: () => {}, Date: FakeDate, atob, btoa, Uint8Array, BigInt, Math, JSON, Map, Set, Promise, Object, Array, String, Number, Error, RegExp, TextEncoder, Infinity,
    chrome: { storage: { local: area, onChanged: { addListener: fn => changed.push(fn) } }, alarms: { create: () => {}, clear: () => {}, onAlarm: { addListener: fn => alarms.push(fn) } },
      runtime: { id: "abc", getURL: p => "chrome-extension://abc/" + p, onMessage: { addListener: fn => messages.push(fn) } } },
    fetch: async (url, init = {}) => {
      const body = init.body ? JSON.parse(init.body) : null;
      w.fetches.push({ url, method: init.method || "GET", body }); w.calls.push("fetch:" + url.replace(/^https:\/\//, "").split(/[/?]/)[0]);
      if (/pumpportal/.test(url)) return init.method === "OPTIONS" ? ok({}) : w.portal === 200 ? ok({}) : { ok: false, status: w.portal, statusText: "Bad Request", text: async () => "no pool for this mint" };
      if (/lite-api\.jup\.ag/.test(url)) {
        if (init.method === "OPTIONS") return ok({});
        if (/\/quote\?/.test(url)) {
          if (w.jup === "hang") return new Promise(() => {});
          if (w.jup === "none") return { ok: false, status: 400, json: async () => ({ error: "Could not find any route", errorCode: "COULD_NOT_FIND_ANY_ROUTE" }) };
          return ok({ inputMint: "So11111111111111111111111111111111111111112", outAmount: "817911729288", priceImpactPct: String(w.jupImpact), routePlan: [{ swapInfo: { label: "Meteora DLMM" } }, { swapInfo: { label: "Pump.fun Amm" } }] });
        }
        return w.jup === "nobuild" ? { ok: false, status: 500, json: async () => ({ error: "could not build" }) } : ok({ swapTransaction: btoa("transaction") });
      }
      if (/dexscreener/.test(url)) return w.dexDown ? { ok: false, status: 503 } : ok(typeof w.dex === "function" ? w.dex(url) : w.dex);
      if (url in w.files) { // coin metadata (json) and pictures ({ pic })
        const f = w.files[url];
        if (f === "fail") return { ok: false, status: 404 };
        return { ok: true, status: 200, json: async () => f, blob: async () => ({ pic: f.pic }) };
      }
      if (/api\.telegram\.org/.test(url)) {
        const method = url.split("/").pop();
        if (method === "getMe") return ok({ ok: true, result: { username: "my_hatchr_bot" } });
        if (method === "getUpdates") return ok({ ok: true, result: w.updates });
        w.tg.push(body); return ok({ ok: true, result: {} });
      }
      throw new Error("unexpected fetch " + url);
    } });
  // pictures: a picture is a seed; a "copy" of a picture (another size, re-saved) is the same seed with a little noise
  const pixels = pic => { const [seed, noisy] = String(pic).split("~"); let x = [...seed].reduce((a, c) => a * 31 + c.charCodeAt(0), 7) >>> 0; const out = new Uint8ClampedArray(9 * 8 * 4);
    for (let i = 0; i < 72; i++) { x = (x * 1103515245 + 12345) >>> 0; const v = (x >>> 16) % 200 + 20 + (noisy && i % 7 === 0 ? 1 : 0); out[i * 4] = out[i * 4 + 1] = out[i * 4 + 2] = v; out[i * 4 + 3] = 255; } return out; };
  ctx.createImageBitmap = async blob => ({ pic: blob.pic });
  ctx.OffscreenCanvas = class { getContext() { return { drawImage(b) { this.pic = b.pic; }, getImageData() { return { data: pixels(this.pic) }; } }; } };
  ctx.AbortController = AbortController;
  ctx.WebSocket = class { constructor(url) { this.url = url; this.sent = []; w.sockets.push(this); setTimeout(() => this.onopen && this.onopen(), 5); } send(m) { this.sent.push(JSON.parse(m)); } close() { this.closed = true; } };
  ctx.globalThis = ctx;
  ctx.HatchrCore = { settings: async () => ({ ...w.storage.local.settings }), secret: async () => (o.noWallet ? "" : "secret"), keypair: () => ({ publicKey: { toBase58: () => "WALLETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx" } }),
    rpc: async (u, method, params) => { w.calls.push("rpc:" + method); if (method === "getPriorityFeeEstimate") return w.feeLevels ? { priorityFeeLevels: w.feeLevels } : null; if (method === "getRecentPrioritizationFees") return w.recentFees || []; if (method === "getAccountInfo" && params[0] in w.accounts) return { value: { data: [w.accounts[params[0]], "base64"] } }; if (method === "getTransaction") return w.txs[params[0]] || null; if (method === "getTokenAccountsByOwner") { const raw = (w.owned[params[0]] || {})[params[1].mint]; return { value: raw === undefined ? [] : [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(raw) } } } } } }] }; } if (method === "getAccountInfo") { if (w.rpcHangs) return new Promise(() => {}); return { value: w.quoteMint ? { data: [btoa(String.fromCharCode(...w.quoteMint)), "base64"] } : null }; } if (method === "getMultipleAccounts") return { value: params[0].map(k => w.curves[k] ? { data: [w.curves[k], "base64"] } : null) }; throw new Error("unexpected rpc " + method); },
    balance: async () => { w.calls.push("balance"); return w.balanceSol; }, tokenBalance: async () => { w.calls.push("tokenBalance"); return { ui: w.walletTokens }; },
    send: async (u, tx, skip) => { w.calls.push("send"); if (w.sendFails) throw new Error("RPC refused the transaction"); w.sent.push({ skip, at: w.clock }); return "SIG" + w.sent.length; }, simulate: async () => { w.sims++; w.calls.push("simulate"); return { err: o.simErr || null }; },
    confirm: async () => { w.calls.push("confirm"); if (o.confirmFails) throw new Error('Transaction failed on-chain: {"InstructionError":[3,{"Custom":6002}]}'); return {}; },
    Tx: { deserialize: () => ({ sign() {} }) },
    PublicKey: class { constructor(k) { if (!/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(String(k))) throw new Error("bad key"); this.k = String(k); } toBytes() { return new Uint8Array(32); } toBase58() { return this.k; } static findProgramAddressSync(seeds) { return [{ toBase58: () => "CURVE-OF-PENDING" }, 255]; } },
    solPrice: async () => ({ usd: 150 }), notify: (...a) => w.notes.push(a), sound: () => { w.sounds++; }, watching: s => !s || s.watching !== false, scanHeld: async () => [], isDesktop: false };
  ctx.HatchrCalloutAuto = { expectBuy: mint => { w.expect.push(mint); w.calls.push("expectBuy"); }, boughtElsewhere: (...a) => w.handed.push(a) };
  if (o.extra) Object.assign(ctx, o.extra(w)); // stand-ins for other modules
  ctx.TextDecoder = TextDecoder;
  for (const f of files) vm.runInContext(SRC(f), ctx);
  const ask = (message, sender = { id: "abc", url: PANEL }) => new Promise(res => { let kept = false; for (const fn of messages) kept = fn(message, sender, res) || kept; if (!kept) setTimeout(() => res({ ok: false, error: "unhandled" }), 20); });
  return { w, ctx, ask, alarm: async name => { for (const fn of alarms) fn({ name }); await sleep(60); } };
}
const post = (over = {}) => ({ source: "axiom", postId: String(Math.floor(Math.random() * 1e12)), tweetType: "TWEET", tracked: "caller", handle: "Caller", text: `new one ${CA} lfg`, context: "", url: "https://x.com/Caller/status/1", time: 1_800_000_000_000 - 900, ...over });
let count = 0;
const t = async (name, fn) => { await fn(); count++; console.log("ok  " + name); };

(async () => {
  // ------------------------------------------------------------------ CA buy
  const caCfg = (over = {}) => ({ enabled: true, handles: "@Caller", buySol: 0.2, slippage: 25, priorityFee: 0.002, ...over });
  const caBoot = async (o = {}) => { const e = boot(["trade-routes.js", "ca-buy.js"], { ...o, store: { caBuy: o.cfg === undefined ? caCfg() : o.cfg, ...(o.store || {}) } }); await sleep(150); e.w.calls.length = 0; e.w.fetches.length = 0; return e; };
  const caState = async e => (await e.ask({ type: "caBuyGet" })).data;

  await t("CA buy: settings and address finding", async () => {
    const e = await caBoot();
    const B = e.ctx.HatchrCaBuy;
    assert.deepStrictEqual([...B.clean({ handles: "@Foo, https://x.com/Bar/status/1\nbaz_9  @foo" }).handles], ["foo", "bar", "baz_9"]);
    assert.strictEqual(B.clean({}).enabled, false); assert.strictEqual(B.clean({ buySol: "0,5" }).buySol, 0.5); assert.strictEqual(B.clean({ maxPerDay: 0 }).maxPerDay, 0);
    assert.strictEqual(B.findAddress(`CA: ${CA}`, {}), CA);
    assert.strictEqual(B.findAddress(`https://pump.fun/coin/${PUMP}?x=1`, {}), PUMP);
    assert.strictEqual(B.findAddress(`tx ${SIGNATURE}`, {}), "", "a piece of a longer run (a transaction signature) is not an address");
    assert.strictEqual(B.findAddress("pay So11111111111111111111111111111111111111112 now", {}), "", "wrapped SOL is not a coin to buy");
    assert.strictEqual(B.findAddress(`${CA} and ${PUMP}`, { onlyPump: true }), PUMP);
    assert.strictEqual(B.findAddress("no address here, just words and 12345", {}), "");
  });

  await t("CA buy LIVE: two network calls from post to sent, nothing else waited for", async () => {
    const e = await caBoot({ jup: "hang" }); // Jupiter never answers: the normal path must not wait for it
    e.ctx.HatchrCaBuy.onPost(post({ text: `new one ${PUMP} lfg` }));
    await sleep(80);
    const untilSend = e.w.calls.slice(0, e.w.calls.indexOf("send") + 1);
    assert.deepStrictEqual(untilSend, ["fetch:pumpportal.fun", "fetch:lite-api.jup.ag", "rpc:getAccountInfo", "expectBuy", "send"], "three requests leave at once, then mark and send: no balance look-up, no simulation, and Jupiter's answer is not waited for");
    const buy = e.w.fetches.find(f => f.method === "POST" && /pumpportal/.test(f.url)).body;
    assert.deepStrictEqual(buy, { publicKey: "WALLETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", action: "buy", mint: PUMP, denominatedInSol: "true", amount: 0.2, slippage: 25, priorityFee: 0.002, pool: "auto" });
    assert.strictEqual(e.w.sent[0].skip, true, "sent without the RPC's own dry run");
    assert.strictEqual(e.w.sims, 0);
    const s = await caState(e);
    assert.ok(s.state.log.some(l => l.kind === "buy" && /Confirmed: holding 1,000/.test(l.text)), JSON.stringify(s.state.log.map(l => l.text)));
    assert.ok(s.state.log.some(l => /sent \d+ ms after the post reached Hatchr/.test(l.text)));
    assert.strictEqual(s.state.buysToday, 1);
    assert.deepStrictEqual(JSON.parse(JSON.stringify(e.w.handed)), [[PUMP, "WALLETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx", 1000, false]], "handed to the holdings list, no callout asked");
  });

  await t("CA buy: only the chosen accounts, the chosen kinds of post, fresh posts, and each address once", async () => {
    const e = await caBoot();
    const on = p => e.ctx.HatchrCaBuy.onPost(p);
    on(post({ handle: "SomeoneElse", tracked: "someoneelse" })); await sleep(40);
    assert.strictEqual(e.w.sent.length, 0, "another account");
    on(post({ tweetType: "RETWEET", handle: "Stranger", tracked: "caller" })); await sleep(40);
    assert.strictEqual(e.w.sent.length, 0, "reposts are off by default");
    on(post({ text: "gm, no address today" })); await sleep(40);
    assert.strictEqual(e.w.sent.length, 0, "no address in the post");
    on(post({ time: e.w.clock - 60000 })); await sleep(40);
    assert.strictEqual(e.w.sent.length, 0, "a minute old: too late");
    assert.ok((await caState(e)).state.log.some(l => /already 60 s old/.test(l.text)));
    on(post({ text: `quoting`, context: `Quoting @x: ${CA}` })); await sleep(40);
    assert.strictEqual(e.w.sent.length, 0, "an address in the quoted post does not count unless switched on");
    on(post({ handle: "CALLER", tweetType: "REPLY", text: `it's ${OTHER}` })); await sleep(60);
    assert.strictEqual(e.w.sent.length, 1, "their reply with an address: bought (handle matched whatever the capitals)");
    on(post({ text: `again ${OTHER}` })); await sleep(60);
    assert.strictEqual(e.w.sent.length, 1, "the same address is never bought twice");
    const same = post({ text: `one ${PUMP}` }); on(same); on(same); await sleep(60);
    assert.strictEqual(e.w.sent.length, 2, "the same post arriving twice buys once");
    // with reposts and quoted posts switched on
    const r = await caBoot({ cfg: caCfg({ types: { TWEET: true, REPLY: true, QUOTE: true, RETWEET: true }, quoted: true }) });
    r.ctx.HatchrCaBuy.onPost(post({ tweetType: "RETWEET", handle: "Stranger", tracked: "caller" })); await sleep(60);
    assert.strictEqual(r.w.sent.length, 1, "a repost by the chosen account");
    r.ctx.HatchrCaBuy.onPost(post({ text: "this", context: `Quoting @x: ${PUMP}` })); await sleep(60);
    assert.strictEqual(r.w.sent.length, 2, "the address in the quoted post");
  });

  await t("CA buy: TEST mode, daily number, pause per account, reserve, no wallet, off", async () => {
    const e = await caBoot({ dryRun: true });
    e.ctx.HatchrCaBuy.onPost(post()); await sleep(80);
    assert.strictEqual(e.w.sent.length, 0); assert.strictEqual(e.w.sims, 1);
    assert.ok((await caState(e)).state.log.some(l => l.kind === "test" && /TEST: would buy 0\.2 SOL of \w+ from @caller's post/.test(l.text)));
    const d = await caBoot({ cfg: caCfg({ maxPerDay: 1 }) });
    d.ctx.HatchrCaBuy.onPost(post()); await sleep(60); d.ctx.HatchrCaBuy.onPost(post({ text: `two ${OTHER}` })); await sleep(60);
    assert.strictEqual(d.w.sent.length, 1, "one per day");
    const c = await caBoot({ cfg: caCfg({ cooldownSec: 60 }) });
    c.ctx.HatchrCaBuy.onPost(post()); await sleep(60); c.ctx.HatchrCaBuy.onPost(post({ text: `two ${OTHER}` })); await sleep(60);
    assert.strictEqual(c.w.sent.length, 1, "pause after a buy from that account");
    c.w.clock += 61000; c.ctx.HatchrCaBuy.onPost(post({ text: `three ${PUMP}`, time: c.w.clock - 500 })); await sleep(60);
    assert.strictEqual(c.w.sent.length, 2);
    const low = await caBoot({ balanceSol: 0.1 });
    await low.ctx.HatchrCaBuy; await sleep(50);
    low.ctx.HatchrCaBuy.onPost(post()); await sleep(60);
    assert.strictEqual(low.w.sent.length, 0, "0.1 SOL in the wallet cannot pay a 0.2 SOL buy");
    const nw = await caBoot({ noWallet: true });
    nw.ctx.HatchrCaBuy.onPost(post()); await sleep(60);
    assert.strictEqual(nw.w.sent.length, 0); assert.ok((await caState(nw)).state.log.some(l => /no Hatchr wallet/.test(l.text)));
    const off = await caBoot({ cfg: caCfg({ enabled: false }) });
    off.ctx.HatchrCaBuy.onPost(post()); await sleep(60);
    assert.strictEqual(off.w.fetches.length, 0, "switched off: not even a request");
    // CA buy has its own switch: launching from posts (the Feed's switch) off does not stop it
    const main = await caBoot({ settings: { watching: false } });
    main.ctx.HatchrCaBuy.onPost(post()); await sleep(60);
    assert.strictEqual(main.w.sent.length, 1, "bought with the Feed switched off");
  });

  await t("CA buy: a post that wakes the background is not lost; what reaches it is noted per account", async () => {
    // the post arrives in the same moment the background starts, before the settings are read
    const e = boot(["trade-routes.js", "ca-buy.js"], { store: { caBuy: caCfg() } });
    e.ctx.HatchrCaBuy.onPost(post({ text: `first ${PUMP}` }));
    await sleep(200);
    assert.strictEqual(e.w.sent.length, 1, "handled once CA buy had started");
    const s0 = (await caState(e)).state;
    assert.ok(s0.seen.caller && s0.seen.caller.why === "had an address", JSON.stringify(s0.seen));
    // posts from the chosen account without an address, of a kind that is off, and from others
    e.ctx.HatchrCaBuy.onPost(post({ text: "gm" })); await sleep(20);
    assert.strictEqual((await caState(e)).state.seen.caller.why, "no contract address in it");
    e.ctx.HatchrCaBuy.onPost(post({ tweetType: "RETWEET", handle: "Other", tracked: "caller", text: `rt ${OTHER}` })); await sleep(20);
    assert.ok(/a repost, and those are switched off/.test((await caState(e)).state.seen.caller.why));
    e.ctx.HatchrCaBuy.onPost(post({ handle: "Nobody", tracked: "nobody", source: "x" })); await sleep(400);
    const s1 = (await caState(e)).state;
    assert.strictEqual(s1.lastPost.handle, "Nobody"); assert.strictEqual(s1.lastPost.source, "x");
    assert.ok(!s1.seen.nobody, "only the chosen accounts are noted");
    const got = (await caState(e));
    assert.ok("sources" in got, "the panel is told where posts come from");
    assert.strictEqual(e.ctx.HatchrCaBuy.wantsPosts(), true);
  });

  await t("CA buy: a buy that fails is reported; a coin PumpPortal cannot build may be tried again; callout hand-off", async () => {
    const f = await caBoot({ confirmFails: true, walletTokens: 0 });
    f.ctx.HatchrCaBuy.onPost(post()); await sleep(120);
    const s = await caState(f);
    assert.ok(s.state.log.some(l => l.kind === "error" && /price moved more than your slippage allows/.test(l.text)), JSON.stringify(s.state.log.map(l => l.text)));
    assert.strictEqual(s.state.buysToday, 0, "a failed buy does not use up the day's number");
    const p = await caBoot({ portal: 400, jup: "none" });
    p.ctx.HatchrCaBuy.onPost(post()); await sleep(80);
    assert.strictEqual(p.w.sent.length, 0);
    const why = (await caState(p)).state.log.find(l => l.kind === "error").text;
    assert.ok(/no route to buy it with SOL\. PumpPortal: 400 no pool for this mint\. Jupiter: Could not find any route/.test(why), why);
    assert.strictEqual((await caState(p)).state.buysToday, 0);
    p.w.portal = 200; p.ctx.HatchrCaBuy.onPost(post()); await sleep(80);
    assert.strictEqual(p.w.sent.length, 1, "bought when it can be built later");
    const c = await caBoot({ cfg: caCfg({ callout: true }) });
    c.ctx.HatchrCaBuy.onPost(post()); await sleep(80);
    assert.deepStrictEqual([...c.w.expect], [CA]); assert.strictEqual(c.w.handed[0][3], true, "callout asked for");
    const bad = await c.ask({ type: "caBuySave", config: caCfg({ handles: "evil" }) }, { id: "abc", url: "https://evil.example/" });
    assert.strictEqual(bad.ok, false, "only the side panel may change the settings");
  });

  await t("CA buy: a coin PumpPortal cannot buy (paired with another coin or USDC) goes through Jupiter", async () => {
    const e = await caBoot({ portal: 400 });
    e.ctx.HatchrCaBuy.onPost(post({ text: `ca ${PUMP}` })); await sleep(120);
    assert.deepStrictEqual(e.w.calls.slice(0, e.w.calls.indexOf("send") + 1), ["fetch:pumpportal.fun", "fetch:lite-api.jup.ag", "rpc:getAccountInfo", "fetch:lite-api.jup.ag", "expectBuy", "send"], "one request more than the normal path, still no dry run");
    const quote = new URL(e.w.fetches.find(f => /jup\.ag\/swap\/v1\/quote/.test(f.url)).url).searchParams;
    assert.deepStrictEqual(Object.fromEntries(quote), { inputMint: "So11111111111111111111111111111111111111112", outputMint: PUMP, amount: "200000000", slippageBps: "2500", restrictIntermediateTokens: "false" });
    const swap = e.w.fetches.find(f => f.method === "POST" && /jup\.ag/.test(f.url)).body;
    assert.strictEqual(swap.userPublicKey, "WALLETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx"); assert.strictEqual(swap.prioritizationFeeLamports, 2000000); assert.strictEqual(swap.quoteResponse.outAmount, "817911729288");
    assert.strictEqual(e.w.sent.length, 1);
    const log = (await caState(e)).state.log.map(l => l.text).join("\n");
    assert.ok(/through Jupiter \(Meteora DLMM → Pump\.fun Amm\), because PumpPortal cannot buy this coin \(400 no pool for this mint\)/.test(log), log);
    assert.ok(/Confirmed: holding 1,000/.test(log));
    // a route so thin that this buy alone would move the price more than the slippage: left alone, and may be tried again
    const thin = await caBoot({ portal: 400, jupImpact: 0.4 });
    thin.ctx.HatchrCaBuy.onPost(post()); await sleep(100);
    assert.strictEqual(thin.w.sent.length, 0);
    assert.ok(/too thin: a 0\.2 SOL buy would move the price 40\.0%, more than your 25% slippage/.test((await caState(thin)).state.log[0].text), (await caState(thin)).state.log[0].text);
    thin.w.jupImpact = 0.02; thin.ctx.HatchrCaBuy.onPost(post()); await sleep(100);
    assert.strictEqual(thin.w.sent.length, 1);
    // Jupiter has a price but cannot build the transaction
    const nb = await caBoot({ portal: 400, jup: "nobuild" });
    nb.ctx.HatchrCaBuy.onPost(post()); await sleep(100);
    assert.strictEqual(nb.w.sent.length, 0); assert.ok(/Jupiter found a price but could not build the buy: could not build/.test((await caState(nb)).state.log[0].text));
    // PumpPortal unreachable: Jupiter still buys
    const down = await caBoot({ portal: 503 });
    down.ctx.HatchrCaBuy.onPost(post()); await sleep(100);
    assert.strictEqual(down.w.sent.length, 1);
    // TEST mode names the route and sends nothing
    const dry = await caBoot({ portal: 400, dryRun: true });
    dry.ctx.HatchrCaBuy.onPost(post()); await sleep(100);
    assert.strictEqual(dry.w.sent.length, 0);
    assert.ok(/TEST: would buy 0\.2 SOL of \w+ from @caller's post, through Jupiter \(Meteora DLMM → Pump\.fun Amm\)/.test((await caState(dry)).state.log[0].text));
  });

  await t("CA buy: a coin on the bonding curve priced in another token, for which PumpPortal still answers 200", async () => {
    const SPCX = Uint8Array.from({ length: 32 }, (_, i) => i + 1); // any non-zero 32 bytes: the curve's quote mint
    // PumpPortal's transaction would fail (error 6063): it is not sent, Jupiter's is
    const e = await caBoot({ quoteMint: SPCX, simErr: { InstructionError: [3, { Custom: 6063 }] } });
    e.ctx.HatchrCaBuy.onPost(post({ text: `ca ${PUMP}` })); await sleep(140);
    assert.strictEqual(e.w.sims, 1, "PumpPortal's transaction got a dry run");
    assert.strictEqual(e.w.sent.length, 1);
    assert.strictEqual(e.w.fetches.filter(f => f.method === "POST" && /jup\.ag/.test(f.url)).length, 1, "Jupiter built the buy");
    const log = (await caState(e)).state.log.map(l => l.text).join("\n");
    assert.ok(/through Jupiter \(Meteora DLMM → Pump\.fun Amm\), because PumpPortal cannot buy this coin \(priced in another token, .{4}…\)/.test(log), log);
    // PumpPortal's transaction does work for such a coin: then it is the one that is sent
    const fine = await caBoot({ quoteMint: SPCX });
    fine.ctx.HatchrCaBuy.onPost(post({ text: `ca ${PUMP}` })); await sleep(140);
    assert.strictEqual(fine.w.sent.length, 1); assert.ok(/through PumpPortal\./.test((await caState(fine)).state.log.map(l => l.text).join("\n")));
    // neither works: nothing is sent, and the address may be tried again
    const none = await caBoot({ quoteMint: SPCX, simErr: { InstructionError: [3, { Custom: 6063 }] }, jup: "none" });
    none.ctx.HatchrCaBuy.onPost(post({ text: `ca ${PUMP}` })); await sleep(140);
    assert.strictEqual(none.w.sent.length, 0); assert.strictEqual((await caState(none)).state.buysToday, 0);
    assert.ok(/no route to buy it with SOL\. PumpPortal: priced in another token, .{4}…\. Jupiter: Could not find any route/.test((await caState(none)).state.log[0].text), (await caState(none)).state.log[0].text);
    // priced in another pump coin: pump.fun's own multi-hop route (lib/hops.js) builds it when the others cannot
    const asked = [];
    const hops = await caBoot({ quoteMint: SPCX, simErr: { InstructionError: [3, { Custom: 6063 }] }, jup: "none",
      extra: () => ({ HatchrHops: { buy: async a => { asked.push(a); return { tx: { sign() {}, serialize: () => new Uint8Array(8) }, path: "SOL → 4FP2… → DqyA…" }; } } }) });
    hops.ctx.HatchrCaBuy.onPost(post({ text: `ca ${PUMP}` })); await sleep(160);
    assert.strictEqual(hops.w.sent.length, 1, "sent through pump.fun's route");
    assert.strictEqual(asked[0].mint, PUMP); assert.strictEqual(asked[0].sol, caCfg().buySol);
    assert.ok(/through pump\.fun's multi-hop route \(SOL → 4FP2… → DqyA…\)/.test((await caState(hops)).state.log.map(l => l.text).join("\n")), (await caState(hops)).state.log.map(l => l.text).join("\n"));
    // an address that is not a pump.fun one: the curve is not asked
    const plain = await caBoot({ quoteMint: SPCX });
    plain.ctx.HatchrCaBuy.onPost(post()); await sleep(100);
    assert.ok(!plain.w.calls.includes("rpc:getAccountInfo")); assert.strictEqual(plain.w.sent.length, 1); assert.strictEqual(plain.w.sims, 0);
    // an RPC that does not answer holds the buy up for a quarter of a second at most
    const slow = await caBoot({ rpcHangs: true });
    slow.ctx.HatchrCaBuy.onPost(post({ text: `ca ${PUMP}` })); await sleep(150);
    assert.strictEqual(slow.w.sent.length, 0, "still inside the quarter second");
    await sleep(250);
    assert.strictEqual(slow.w.sent.length, 1, "sent without the answer");
  });

  await t("CA buy: a post's age is taken from X's own post number, to the millisecond", async () => {
    const id = String(((BigInt(1_800_000_000_000) + 620n - 1288834974657n) << 22n) + 5n); // a post made at ...000.620
    const e = await caBoot({ cfg: caCfg({ maxAgeSec: 1 }) });
    // the feed says ...000 (whole seconds); Hatchr gets it at ...001.500: 1.5 s by the feed, 0.88 s in truth
    e.w.clock = 1_800_000_001_500;
    e.ctx.HatchrCaBuy.onPost(post({ postId: id, time: 1_800_000_000_000 })); await sleep(100);
    assert.strictEqual(e.w.sent.length, 1, "inside the 1 s limit by the exact time");
    assert.ok(/the post was 0\.9 s old by then/.test((await caState(e)).state.log.map(l => l.text).join("\n")));
    // a number that disagrees with the feed's time (a repost carrying the original's number): the feed's time counts
    const r = await caBoot({ cfg: caCfg({ maxAgeSec: 5 }) });
    r.ctx.HatchrCaBuy.onPost(post({ postId: String(((BigInt(1_700_000_000_000) - 1288834974657n) << 22n)), text: `x ${OTHER}` })); await sleep(100);
    assert.strictEqual(r.w.sent.length, 1);
  });

  // ------------------------------------------------------------------ launch watch (CA buy without an address)
  const DEV = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D8DWLiTTpmXy", FAKEDEV = "9WzDXwBbmkg8ZTbNMqUxvQRAyrZzDsGYdLVL9zYtAWWM";
  const coinMint = n => `${"Coin" + n}${"x".repeat(36 - String(n).length)}pump`.slice(0, 44);
  const created = (mint, symbol, name, uri, creator) => ({ txType: "create", mint, symbol, name, uri, traderPublicKey: creator, pool: "pump" });
  const TEASE = "https://pbs.twimg.com/media/coin.jpg";
  const meta = (n, pic) => ({ [`https://ipfs.io/ipfs/META${n}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`]: { image: `https://ipfs.io/ipfs/IMG${n}bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`, twitter: "" }, [`https://ipfs.io/ipfs/IMG${n}bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb`]: { pic } });
  const uri = n => `https://ipfs.io/ipfs/META${n}aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa`;
  const watchLog = async e => (await caState(e)).state.log.map(l => l.text).join("\n");

  await t("launch watch: \"$COIN · Just a social experiment\" + picture → the first new coin with that ticker AND that picture is bought; fakes are not", async () => {
    const e = await caBoot({ cfg: caCfg({ smart: true }), files: { [TEASE]: { pic: "gold" }, ...meta(1, "other"), ...meta(2, "gold~"), ...meta(3, "gold") } });
    const W = e.ctx.HatchrCaBuy;
    W.onPost(post({ text: "$COIN\nJust a social experiment", images: [TEASE] })); await sleep(60);
    let st = (await caState(e)).state;
    assert.strictEqual(st.seen.caller.why, "watching for $COIN + its picture");
    assert.ok(/@caller posted \$COIN \+ its picture without an address\. Watching new pump\.fun coins for 120 s/.test(st.log[0].text), st.log[0].text);
    assert.strictEqual(e.w.sent.length, 0);
    W.onStream(created(coinMint(1), "COIN", "Coin", uri(1), FAKEDEV)); await sleep(80);
    assert.strictEqual(e.w.sent.length, 0, "a fake: right ticker, another picture");
    W.onStream(created(coinMint(9), "DOGE", "Doge", uri(9), FAKEDEV)); await sleep(30);
    assert.ok(!e.w.fetches.some(f => f.url.includes("META9")), "another ticker: its details are not even read");
    W.onStream(created(coinMint(2), "coin", "Coin", uri(2), DEV)); await sleep(150);
    assert.strictEqual(e.w.sent.length, 1, "right ticker and the same picture (re-saved): bought");
    assert.strictEqual(e.w.fetches.find(f => f.method === "POST" && /pumpportal/.test(f.url)).body.mint, coinMint(2));
    assert.ok(/Bought \$coin \(Coin2x+pump\) for @caller's launch post, matched on ticker \+ picture: 0\.2 SOL sent \d+ ms after the coin appeared on pump\.fun/.test(await watchLog(e)), await watchLog(e));
    W.onStream(created(coinMint(3), "COIN", "Coin", uri(3), DEV)); await sleep(120);
    assert.strictEqual(e.w.sent.length, 1, "one buy per post: the watch is over");
    st = (await caState(e)).state;
    assert.strictEqual(st.watches[0].state, "bought");
  });

  await t("launch watch: ticker only is instant; $SOL and posts without a ticker or picture start nothing; the words filter", async () => {
    const e = await caBoot({ cfg: caCfg({ smart: true, smartMatch: "ticker" }) });
    const W = e.ctx.HatchrCaBuy;
    W.onPost(post({ text: "$SOL looks strong today" })); await sleep(30);
    assert.strictEqual((await caState(e)).state.seen.caller.why, "no address and no $ticker to watch for");
    W.onPost(post({ text: "soon. $FROG", images: [TEASE] })); await sleep(30);
    e.w.calls.length = 0;
    W.onStream(created(coinMint(4), "FROG", "Frog", uri(4), FAKEDEV)); await sleep(80);
    assert.strictEqual(e.w.sent.length, 1);
    assert.strictEqual(e.w.calls[0], "fetch:pumpportal.fun", "nothing is looked up first: the buy is the first request");
    const words = await caBoot({ cfg: caCfg({ smart: true, smartMatch: "ticker", smartWords: "launch, live" }) });
    words.ctx.HatchrCaBuy.onPost(post({ text: "$CAT is cute" })); await sleep(30);
    assert.strictEqual((await caState(words)).state.seen.caller.why, "no address, and none of your launch-watch words");
    words.ctx.HatchrCaBuy.onPost(post({ text: "$CAT LIVE now" })); await sleep(30);
    assert.strictEqual((await caState(words)).state.seen.caller.why, "watching for $CAT");
    // off: a post without an address does nothing
    const off = await caBoot({ cfg: caCfg({ smart: false }) });
    off.ctx.HatchrCaBuy.onPost(post({ text: "$COIN", images: [TEASE] })); await sleep(30);
    assert.strictEqual((await caState(off)).state.seen.caller.why, "no contract address in it");
  });

  await t("launch watch: the account's dev wallet is learned from a coin it posts, and then only that wallet's coins are bought", async () => {
    const e = await caBoot({ cfg: caCfg({ smart: true, smartMatch: "ticker", smartLearn: true, maxPerDay: 0 }) });
    const W = e.ctx.HatchrCaBuy, OLD = coinMint(5);
    W.onStream(created(OLD, "OLD", "Old", uri(5), DEV));
    e.w.clock += 90000;
    W.onPost(post({ text: `ca ${OLD}`, time: e.w.clock - 500 })); await sleep(80); // its own launch, posted 90 s after it was made
    assert.ok(/Learned @caller's dev wallet 4Nd1…pmXy/.test(await watchLog(e)), await watchLog(e));
    const before = e.w.sent.length;
    W.onPost(post({ text: "$NEXT tomorrow?", time: e.w.clock })); await sleep(30);
    W.onStream(created(coinMint(6), "NEXT", "Next", uri(6), FAKEDEV)); await sleep(60);
    assert.strictEqual(e.w.sent.length, before, "same ticker from another wallet: a fake, not bought");
    W.onStream(created(coinMint(7), "NEXT", "Next", uri(7), DEV)); await sleep(80);
    assert.strictEqual(e.w.sent.length, before + 1, "from the known dev wallet: bought");
    assert.ok(/matched on ticker \+ dev wallet/.test(await watchLog(e)));
    // the panel can forget learned wallets
    const r = await e.ask({ type: "caBuyForgetDevs" });
    assert.deepStrictEqual({ ...r.data.state.devs }, {});
  });

  await t("launch watch: coins made just before the post count; the watch ends after its time; TEST mode only reports", async () => {
    const e = await caBoot({ cfg: caCfg({ smart: true, smartMatch: "ticker", handles: "@Caller\n@Other", smartWindowSec: 60 }) });
    const W = e.ctx.HatchrCaBuy;
    W.onStream(created(coinMint(8), "EARLY", "Early", uri(8), DEV));
    e.w.clock += 10000;
    W.onPost(post({ text: "$EARLY", time: e.w.clock })); await sleep(80);
    assert.strictEqual(e.w.sent.length, 1, "made 10 s before the post: bought straight away");
    W.onPost(post({ text: "$LATE", handle: "Other", tracked: "other", time: e.w.clock })); await sleep(20);
    e.w.clock += 61000;
    W.onStream(created(coinMint(10), "LATE", "Late", uri(10), DEV)); await sleep(60);
    assert.strictEqual(e.w.sent.length, 1, "after the 60 s window: not bought");
    assert.ok(/Launch watch for @other's \$LATE ended: no coin matched in time/.test(await watchLog(e)), await watchLog(e));
    const dry = await caBoot({ dryRun: true, cfg: caCfg({ smart: true, smartMatch: "ticker" }) });
    dry.ctx.HatchrCaBuy.onPost(post({ text: "$TEST" })); await sleep(20);
    dry.ctx.HatchrCaBuy.onStream(created(coinMint(11), "TEST", "Test", uri(11), DEV)); await sleep(80);
    assert.strictEqual(dry.w.sent.length, 0);
    assert.ok(/TEST: would buy 0\.2 SOL of \$TEST \(Coin11x+pump\) for @caller's launch post, matched on ticker/.test(await watchLog(dry)), await watchLog(dry));
  });

  // ------------------------------------------------------------------ copy trade
  const B58 = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  const unb58 = str => { let n = 0n; for (const c of str) n = n * 58n + BigInt(B58.indexOf(c)); const out = new Uint8Array(32); for (let i = 31; i >= 0; i--) { out[i] = Number(n & 255n); n >>= 8n; } return out; };
  const putU64 = (b, o, v) => { let x = BigInt(v); for (let i = 0; i < 8; i++) { b[o + i] = Number(x & 255n); x >>= 8n; } };
  const data = bytes => "Program data: " + Buffer.from(bytes).toString("base64");
  const tradeEvent = (mint, lamports, tokens, isBuy, user) => { const b = new Uint8Array(200); b.set([189, 219, 127, 211, 78, 230, 97, 238]); b.set(unb58(mint), 8); putU64(b, 40, lamports); putU64(b, 48, tokens); b[56] = isBuy ? 1 : 0; b.set(unb58(user), 57); return data(b); };
  const ammEvent = (buy, pool, base, before, quote, user) => { const b = new Uint8Array(400); b.set(buy ? [103, 244, 82, 31, 44, 245, 119, 119] : [62, 47, 55, 10, 165, 3, 220, 42]); putU64(b, 16, base); putU64(b, 32, before); putU64(b, 64, quote); b.set(unb58(pool), 120); b.set(unb58(user), 152); return data(b); };
  const WHALE = "5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1", ME = "WALLETxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx";
  const ctBoot = async (cfg = {}, o = {}) => {
    const e = boot(["trade-routes.js", "copytrade.js"], { ...o, store: { copyTrade: { enabled: true, wallets: `whale: ${WHALE}`, buySol: 0.1, ...cfg } } });
    await sleep(150);
    const sock = e.w.sockets[e.w.sockets.length - 1];
    sock.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", id: 1, result: 77 }) });
    e.w.calls.length = 0; e.w.fetches.length = 0;
    let n = 0;
    e.tx = (logs, sig = `SIG-${++n}-${Math.random()}`) => sock.onmessage({ data: JSON.stringify({ method: "logsNotification", params: { subscription: 77, result: { value: { signature: sig, err: null, logs } } } }) });
    return { ...e, sock };
  };
  const ctState = async e => (await e.ask({ type: "copyGet" })).data;
  const ctLog = async e => (await ctState(e)).state.log.map(l => l.text).join("\n");

  await t("copy trade: a pump.fun buy of a followed wallet is copied straight from the log line (fixed size, first buy only)", async () => {
    assert.strictEqual(unb58(WHALE).length, 32);
    const e = await ctBoot();
    assert.deepStrictEqual(e.sock.sent.map(m => [m.method, m.params[0].mentions[0], m.params[1].commitment]), [["logsSubscribe", WHALE, "processed"]], "one live line per wallet, at the fastest commitment");
    assert.ok(/^wss:\/\/rpc/.test(e.sock.url));
    e.tx(["Program log: Instruction: Buy", tradeEvent(PUMP, 1.5e9, 3_000_000_000, true, WHALE)]); await sleep(120);
    assert.deepStrictEqual(e.w.calls.slice(0, e.w.calls.indexOf("send") + 1).filter(c => c !== "rpc:getAccountInfo" && c !== "fetch:lite-api.jup.ag"), ["fetch:pumpportal.fun", "send"], "nothing looked up before the copy is built");
    const body = e.w.fetches.find(f => f.method === "POST" && /pumpportal/.test(f.url)).body;
    assert.strictEqual(body.action, "buy"); assert.strictEqual(body.mint, PUMP); assert.strictEqual(body.amount, 0.1);
    assert.ok(/Copied whale: bought 0\.1 SOL of 93p4/.test(await ctLog(e)) && /they spent 1\.500 SOL/.test(await ctLog(e)), await ctLog(e));
    e.tx([tradeEvent(PUMP, 2e9, 1_000_000_000, true, WHALE)]); await sleep(80);
    assert.strictEqual(e.w.sent.length, 1, "their second buy of the same coin is not copied");
    assert.ok(/copied their first buy of it already/.test(await ctLog(e)));
    e.tx([tradeEvent(CA, 2e9, 1_000_000_000, true, FAKEDEV)]); await sleep(80);
    assert.strictEqual(e.w.sent.length, 1, "a trade in the same transaction by someone else is not theirs");
  });

  await t("copy trade: size as a share of theirs with a cap, their minimum, TEST mode, per-day number", async () => {
    const e = await ctBoot({ sizeMode: "ratio", ratioPct: 50, maxSol: 0.5, minTheirSol: 0.2 });
    e.tx([tradeEvent(PUMP, 1.5e9, 1e9, true, WHALE)]); await sleep(100);
    assert.strictEqual(e.w.fetches.find(f => f.method === "POST" && /pumpportal/.test(f.url)).body.amount, 0.5, "50% of 1.5 SOL is 0.75, capped at 0.5");
    e.tx([tradeEvent(CA, 0.1e9, 1e9, true, WHALE)]); await sleep(60);
    assert.ok(/under your 0\.2 SOL minimum/.test(await ctLog(e)));
    const dry = await ctBoot({}, { dryRun: true });
    dry.tx([tradeEvent(PUMP, 1e9, 1e9, true, WHALE)]); await sleep(100);
    assert.strictEqual(dry.w.sent.length, 0); assert.strictEqual(dry.w.sims, 1);
    assert.ok(/TEST: whale bought 1\.000 SOL of 93p4\w+\. Would buy 0\.1 SOL/.test(await ctLog(dry)), await ctLog(dry));
    const day = await ctBoot({ maxPerDay: 1 });
    day.tx([tradeEvent(PUMP, 1e9, 1e9, true, WHALE)]); await sleep(80);
    day.tx([tradeEvent(CA, 1e9, 1e9, true, WHALE)]); await sleep(80);
    assert.strictEqual(day.w.sent.length, 1);
  });

  await t("copy trade: sells — the same share of yours, only coins it copied, PumpSwap read from the event", async () => {
    const POOL = "8sLbNZoA1cfnvMJLPfp98ZLAnFSYCFApfJKMbiXNLwxj";
    const e = await ctBoot({}, { owned: { [ME]: { [PUMP]: 1000, [CA]: 4000 }, [WHALE]: { [PUMP]: 1_500_000_000 } }, accounts: { [POOL]: Buffer.from(unb58(CA)).toString("base64") } });
    e.tx([tradeEvent(PUMP, 1e9, 3_000_000_000, true, WHALE)]); await sleep(100);
    e.w.fetches.length = 0;
    e.tx([tradeEvent(PUMP, 0.5e9, 1_500_000_000, false, WHALE)]); await sleep(120); // sold 1.5bn, 1.5bn left: half
    const sell = e.w.fetches.find(f => f.method === "POST" && /pumpportal/.test(f.url)).body;
    assert.strictEqual(sell.action, "sell"); assert.strictEqual(sell.amount, "50%"); assert.strictEqual(sell.mint, PUMP);
    assert.ok(/Copied whale: sold 50% of 93p4/.test(await ctLog(e)), await ctLog(e));
    // a coin Hatchr did not copy: their sell is theirs
    e.w.fetches.length = 0;
    e.tx([ammEvent(false, POOL, 1000, 1000, 2e9, WHALE)]); await sleep(120);
    assert.ok(!e.w.fetches.some(f => f.method === "POST" && /pumpportal/.test(f.url)), "not copied: not sold");
    // with "only coins it copied" off, the PumpSwap sell of everything sells all of yours
    const all = await ctBoot({ onlyCopied: false }, { owned: { [ME]: { [CA]: 4000 } }, accounts: { [POOL]: Buffer.from(unb58(CA)).toString("base64") } });
    all.tx([ammEvent(false, POOL, 1000, 1000, 2e9, WHALE)]); await sleep(120);
    const s2 = all.w.fetches.find(f => f.method === "POST" && /pumpportal/.test(f.url)).body;
    assert.strictEqual(s2.mint, CA, "the coin is read from the pool"); assert.strictEqual(s2.amount, "100%");
    // copy sells off
    const keep = await ctBoot({ copySells: false, onlyCopied: false }, { owned: { [ME]: { [CA]: 4000 } }, accounts: { [POOL]: Buffer.from(unb58(CA)).toString("base64") } });
    keep.tx([ammEvent(false, POOL, 1000, 1000, 2e9, WHALE)]); await sleep(120);
    assert.ok(!keep.w.fetches.some(f => f.method === "POST" && /pumpportal/.test(f.url)));
  });

  await t("copy trade: other exchanges are read from the transaction (a second slower); a trade seen too late is not copied", async () => {
    const tx = (blockTime, signer = WHALE) => ({ blockTime, meta: { err: null, preBalances: [10e9, 0], postBalances: [8e9, 0],
      preTokenBalances: [], postTokenBalances: [{ owner: WHALE, mint: OTHER, uiTokenAmount: { amount: "5000" } }] },
      transaction: { message: { accountKeys: [signer, "Jup"], header: { numRequiredSignatures: 1 } } } });
    const e = await ctBoot({}, { txs: { SLOW1: tx(1_800_000_000) } });
    e.tx(["Program JUP6Lkb invoke [1]", "Program log: Instruction: Route"], "SLOW1"); await sleep(150);
    assert.strictEqual(e.w.sent.length, 1);
    assert.strictEqual(e.w.fetches.find(f => f.method === "POST" && /pumpportal/.test(f.url)).body.mint, OTHER);
    assert.ok(/they spent 2\.000 SOL/.test(await ctLog(e)), await ctLog(e));
    const late = await ctBoot({}, { txs: { SLOW2: tx(1_800_000_000 - 60) } });
    late.tx(["Program log: Instruction: Route"], "SLOW2"); await sleep(150);
    assert.strictEqual(late.w.sent.length, 0); assert.ok(/only seen 60 s later \(limit 10 s\)/.test(await ctLog(late)), await ctLog(late));
    const gift = await ctBoot({}, { txs: { GIFT: tx(1_800_000_000, FAKEDEV) } });
    gift.tx(["Program log: transfer"], "GIFT"); await sleep(150);
    assert.strictEqual(gift.w.sent.length, 0, "tokens sent TO them by someone else: not a buy of theirs");
  });

  await t("copy trade: wallet list, settings, and only the panel may change them", async () => {
    const e = await ctBoot();
    const C = e.ctx.HatchrCopy;
    const c = C.clean({ wallets: `whale: ${WHALE}\n${CA} friend\nnot an address\n${WHALE}` });
    assert.strictEqual(JSON.stringify(c.wallets.map(w => [w.label, w.address])), JSON.stringify([["whale", WHALE], ["friend", CA]]));
    assert.strictEqual(C.clean({}).enabled, false); assert.strictEqual(C.clean({ sizeMode: "x" }).sizeMode, "fixed");
    const bad = await e.ask({ type: "copySave", config: { enabled: true, wallets: CA } }, { id: "abc", url: "https://evil.example/" });
    assert.strictEqual(bad.ok, false);
    const off = await e.ask({ type: "copySave", config: { enabled: false, wallets: `whale: ${WHALE}` } });
    assert.strictEqual(off.data.config.enabled, false);
    assert.ok(e.sock.closed, "switched off: the live line is closed");
  });

  // ------------------------------------------------------------------ Boost (the network's fee of the moment)
  await t("Boost: the fee follows the network (Helius levels, else recent pump.fun fees), within the cap; CA buy uses it", async () => {
    const e = boot(["trade-routes.js"], { settings: { rpcUrl: "https://mainnet.helius-rpc.com/?api-key=k" } });
    const R = e.ctx.HatchrRoutes;
    e.w.feeLevels = { low: 1000, medium: 50000, high: 2_000_000, veryHigh: 9_000_000 };
    let f = await R.feeEstimate("https://mainnet.helius-rpc.com/?api-key=k");
    assert.strictEqual(f.fee, 0.0003); assert.ok(/Helius estimate, high/.test(f.how));
    const e2 = boot(["trade-routes.js"]);
    e2.w.recentFees = [0, 0, 1000, 2000, 3000, 400000].map(x => ({ slot: 1, prioritizationFee: x }));
    f = await e2.ctx.HatchrRoutes.feeEstimate("https://rpc");
    assert.ok(/75th percentile/.test(f.how)); assert.strictEqual(f.fee, 0.0001, "3000 µ-lamports × 150k CU is under the floor: 0.0001");
    const e3 = boot(["trade-routes.js"]);
    e3.w.recentFees = [{ prioritizationFee: 50_000_000 }];
    f = await e3.ctx.HatchrRoutes.feeEstimate("https://rpc");
    assert.strictEqual(f.fee, 0.003); assert.strictEqual(f.capped, true, "never above the cap");
    // CA buy with Boost: the fee and slippage of the moment go into the buy
    const c = await caBoot({ cfg: caCfg({ boost: true }), settings: { rpcUrl: "https://mainnet.helius-rpc.com/?api-key=k" }, feeLevels: { high: 4_000_000 } });
    c.ctx.HatchrCaBuy.onPost(post()); await sleep(100);
    const body = c.w.fetches.find(f => f.method === "POST" && /pumpportal/.test(f.url)).body;
    assert.strictEqual(body.priorityFee, 0.0006); assert.strictEqual(body.slippage, 30);
  });

  // ------------------------------------------------------------------ positions and automatic exits
  const curveAt = (vTokRaw, vSolLamports, complete = 0) => { const b = Buffer.alloc(120); b.writeBigUInt64LE(BigInt(vTokRaw), 8); b.writeBigUInt64LE(BigInt(vSolLamports), 16); b[48] = complete; return b.toString("base64"); };
  const P0 = 30e9; // price 3e-5 SOL per token with 1e12 raw (1e6) tokens
  const posBoot = async (o = {}) => { const e = boot(["trade-routes.js", "positions.js"], o); await sleep(150); e.w.curves["CURVE-OF-PENDING"] = curveAt(1e12, P0); e.w.calls.length = 0; e.w.fetches.length = 0; return e; };
  const posState = async e => (await e.ask({ type: "posGet" })).data;
  const posLog = async e => (await posState(e)).log.map(l => l.text).join("\n");
  const sells = e => e.w.fetches.filter(f => f.method === "POST" && /pumpportal/.test(f.url) && f.body.action === "sell").map(f => f.body.amount);
  const tickAt = async (e, price) => { e.w.curves["CURVE-OF-PENDING"] = curveAt(1e12, Math.round(P0 * price)); await e.alarm("positionsTick"); await sleep(80); };

  await t("exits: take profit in steps from the curve (at once), then everything; the position closes", async () => {
    const e = await posBoot();
    e.ctx.HatchrPositions.open({ mint: PUMP, ticker: "PEPE", source: "CA buy", by: "@caller", costSol: 0.1, tokens: 3333.3333, exits: { on: true, tp: [{ up: 100, sell: 50 }, { up: 300, sell: 100 }], sl: 50 } });
    await tickAt(e, 1.0); assert.deepStrictEqual(sells(e), [], "at cost: nothing");
    await tickAt(e, 2.1); assert.deepStrictEqual(sells(e), ["50%"], "+110%: the first step sells half, straight from the curve");
    e.w.walletTokens = 1666.66;
    await tickAt(e, 2.2); assert.deepStrictEqual(sells(e), ["50%"], "a step sells once");
    await tickAt(e, 4.1); assert.deepStrictEqual(sells(e), ["50%", "100%"], "+310%: the rest");
    const d = await posState(e);
    assert.strictEqual(d.list[0].status, "closed");
    assert.ok(/Sold 50% of \$PEPE \(take profit \+100%/.test(await posLog(e)), await posLog(e));
    assert.strictEqual(e.w.sent.length, 2);
  });

  await t("exits: stop loss, trailing stop (only once in profit), market cap, time; called-out coins never", async () => {
    const sl = await posBoot();
    sl.ctx.HatchrPositions.open({ mint: PUMP, costSol: 0.1, tokens: 3333.3333, exits: { on: true, sl: 40 } });
    await tickAt(sl, 0.7); assert.deepStrictEqual(sells(sl), []);
    await tickAt(sl, 0.55); assert.deepStrictEqual(sells(sl), ["100%"], "-45%: stop loss sells everything");
    const tr = await posBoot();
    tr.ctx.HatchrPositions.open({ mint: PUMP, costSol: 0.1, tokens: 3333.3333, exits: { on: true, trail: 20 } });
    await tickAt(tr, 0.75); assert.deepStrictEqual(sells(tr), [], "down 25% before ever being in profit: the trailing stop is not armed");
    await tickAt(tr, 2.0); await tickAt(tr, 1.7); assert.deepStrictEqual(sells(tr), [], "15% under the top");
    await tickAt(tr, 1.55); assert.deepStrictEqual(sells(tr), ["100%"], "22% under the top: sold");
    const mc = await posBoot();
    mc.ctx.HatchrPositions.open({ mint: PUMP, costSol: 0.1, tokens: 3333.3333, exits: { on: true, mcUsd: 9_000_000, mcSell: 25 } });
    await tickAt(mc, 1.5); assert.deepStrictEqual(sells(mc), [], "market cap $6.75M");
    await tickAt(mc, 2.0); assert.deepStrictEqual(sells(mc), ["25%"], "$9M: a quarter");
    const tm = await posBoot();
    tm.ctx.HatchrPositions.open({ mint: PUMP, costSol: 0.1, tokens: 3333.3333, exits: { on: true, afterMin: 1 } });
    await tickAt(tm, 1.0); assert.deepStrictEqual(sells(tm), []);
    tm.w.clock += 61000; await tickAt(tm, 1.0); assert.deepStrictEqual(sells(tm), ["100%"], "a minute is up");
    const co = await posBoot();
    co.ctx.HatchrPositions.open({ mint: PUMP, costSol: 0.1, tokens: 3333.3333, calledOut: true, exits: { on: true, sl: 10, tp: [{ up: 50, sell: 100 }] } });
    await tickAt(co, 3); await tickAt(co, 0.2);
    assert.deepStrictEqual(sells(co), [], "a coin Hatchr called out is never sold automatically");
    assert.ok(/Called out on pump\.fun: no automatic exits/.test(await posLog(co)));
    const r = await co.ask({ type: "posSell", mint: PUMP, pct: 50 });
    assert.strictEqual(r.ok, true); assert.deepStrictEqual(sells(co), ["50%"], "…but it can be sold by hand");
  });

  await t("exits: a DexScreener price has to say it twice; TEST positions start at the price of the moment and only report", async () => {
    const e = await posBoot({ dex: [] });
    const pairAt = price => [{ pairAddress: "POOL1", baseToken: { address: CA, symbol: "DOGE" }, priceUsd: String(price), liquidity: { usd: 9000 }, marketCap: price * 1e9 }];
    e.ctx.HatchrPositions.open({ mint: CA, costSol: 0.1, tokens: 1000, exits: { on: true, tp: [{ up: 100, sell: 100 }] } }); // CA is not a pump address: priced by DexScreener
    const at = async price => { e.w.dex = pairAt(price); e.w.clock += 7000; await e.alarm("positionsTick"); await sleep(80); };
    await at(0.015); // 0.1 SOL at $150 = $15 for 1000 tokens: cost price
    await at(0.031); assert.deepStrictEqual(sells(e), [], "+107% once: wait for the next reading");
    await at(0.032); assert.deepStrictEqual(sells(e), ["100%"], "twice: sold");
    const p = await posBoot();
    p.ctx.HatchrPositions.open({ mint: PUMP, source: "Copy trade", by: "whale", costSol: 0.1, tokens: null, paper: true, exits: { on: true, tp: [{ up: 50, sell: 50 }] } });
    await tickAt(p, 1.0);
    let d = await posState(p);
    assert.ok(Math.abs(d.list[0].tokens - 3333.333) < 1, "tokens from the price of the moment: " + d.list[0].tokens);
    await tickAt(p, 1.6);
    assert.deepStrictEqual(sells(p), [], "TEST: nothing is sent");
    assert.ok(/TEST: would sell 50% of 93p4\w*… \(take profit \+50%/.test(await posLog(p)), await posLog(p));
    d = await posState(p);
    assert.ok(Math.abs(d.list[0].tokens - 1666.666) < 1);
    // per-coin exits from the panel
    const r = await p.ask({ type: "posExits", mint: PUMP, paper: true, exits: { on: true, sl: 10 } });
    assert.strictEqual(r.data.list[0].exits.sl, 10);
  });

  await t("exits: a failed sell is tried again a little later, and paused after five", async () => {
    const e = await posBoot();
    e.w.sendFails = true;
    e.ctx.HatchrPositions.open({ mint: PUMP, costSol: 0.1, tokens: 3333.3333, exits: { on: true, sl: 10 } });
    for (let i = 0; i < 7; i++) { await tickAt(e, 0.5); e.w.clock += 61000; }
    const d = await posState(e);
    assert.strictEqual(sells(e).length, 5, "five tries");
    assert.strictEqual(d.list[0].paused, true);
    assert.ok(/Automatic exits for this coin are paused; sell it by hand/.test(await posLog(e)));
  });

  // ------------------------------------------------------------------ copy trade: per wallet, launches, positions
  const createEvent = (mint, name, symbol, user) => { const enc = new TextEncoder(), parts = [Buffer.from([27, 114, 169, 77, 222, 235, 99, 118])];
    for (const t of [name, symbol, "https://ipfs.io/ipfs/x"]) { const b = enc.encode(t), len = Buffer.alloc(4); len.writeUInt32LE(b.length); parts.push(len, Buffer.from(b)); }
    parts.push(Buffer.from(unb58(mint)), Buffer.alloc(32), Buffer.from(unb58(user)), Buffer.from(unb58(user)), Buffer.alloc(80));
    return data(Buffer.concat(parts)); };
  const opened = [];
  const ctBoot2 = async (cfg, o = {}) => {
    opened.length = 0;
    const e = boot(["trade-routes.js", "copytrade.js"], { ...o, store: { copyTrade: { enabled: true, buySol: 0.1, ...cfg } }, extra: () => ({ HatchrPositions: { open: p => opened.push(p), sold: () => {}, cleanExits: x => (x && typeof x === "object" ? x : null) } }) });
    await sleep(150);
    const sock = e.w.sockets[e.w.sockets.length - 1];
    sock.sent.forEach((m, i) => sock.onmessage({ data: JSON.stringify({ jsonrpc: "2.0", id: m.id, result: 100 + i }) }));
    e.w.calls.length = 0; e.w.fetches.length = 0;
    e.tx = (logs, sub = 100, sig = `S-${Math.random()}`) => sock.onmessage({ data: JSON.stringify({ method: "logsNotification", params: { subscription: sub, result: { value: { signature: sig, err: null, logs } } } }) });
    return { ...e, sock };
  };
  const buys = e => e.w.fetches.filter(f => f.method === "POST" && /pumpportal/.test(f.url) && f.body.action === "buy").map(f => f.body.amount);

  await t("copy trade per wallet: 0.5 SOL for one wallet, 0.25 for another; a switched-off wallet is not followed", async () => {
    const e = await ctBoot2({ wallets: [{ address: WHALE, label: "big", size: "fixed", sol: 0.5 }, { address: DEV, label: "small", size: "fixed", sol: 0.25 }, { address: FAKEDEV, label: "off", on: false }] });
    assert.deepStrictEqual(e.sock.sent.map(m => m.params[0].mentions[0]), [WHALE, DEV], "two lines: the third wallet is switched off");
    e.tx([tradeEvent(PUMP, 1e9, 1e9, true, WHALE)], 100); await sleep(100);
    e.tx([tradeEvent(CA, 1e9, 1e9, true, DEV)], 101); await sleep(100);
    assert.deepStrictEqual(buys(e), [0.5, 0.25]);
    assert.strictEqual(opened.length, 2); assert.strictEqual(opened[0].by, "big"); assert.strictEqual(opened[0].costSol, 0.5); assert.strictEqual(opened[1].source, "Copy trade");
    // a share for one wallet (capped), the page default for another
    const r = await ctBoot2({ sizeMode: "fixed", buySol: 0.2, wallets: [{ address: WHALE, size: "ratio", ratioPct: 50, maxSol: 0.3 }, { address: DEV }] });
    r.tx([tradeEvent(PUMP, 2e9, 1e9, true, WHALE)], 100); await sleep(100);
    r.tx([tradeEvent(CA, 2e9, 1e9, true, DEV)], 101); await sleep(100);
    assert.deepStrictEqual(buys(r), [0.3, 0.2], "50% of 2 SOL capped at 0.3; the other wallet takes the page's 0.2");
  });

  await t("copy trade: only the coins a wallet creates — bought in the same moment, once, with the fixed amount", async () => {
    const LAUNCH = "LaunchCoinxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump";
    const e = await ctBoot2({ wallets: [{ address: WHALE, label: "dev", what: "launches", size: "fixed", sol: 0.4 }], oncePerCoin: false });
    e.tx([tradeEvent(PUMP, 1e9, 1e9, true, WHALE)]); await sleep(80);
    assert.deepStrictEqual(buys(e), [], "a buy of someone else's coin: not copied");
    e.tx(["Program log: Instruction: Create", createEvent(LAUNCH, "Dev Coin", "DEVC", WHALE), tradeEvent(LAUNCH, 2e9, 5e9, true, WHALE)]); await sleep(120);
    assert.deepStrictEqual(buys(e), [0.4], "their launch: bought once (their own first buy in it is the launch)");
    assert.strictEqual(e.w.fetches.find(f => f.body && f.body.action === "buy").body.mint, LAUNCH);
    assert.ok(/Copied dev's launch: bought 0\.4 SOL of \$DEVC/.test(await ctLog(e)), await ctLog(e));
    assert.strictEqual(opened[0].ticker, "DEVC");
    e.tx([tradeEvent(LAUNCH, 1e9, 1e9, true, WHALE)]); await sleep(80);
    assert.deepStrictEqual(buys(e), [0.4, 0.4], "a later buy of their own coin is copied too (every buy is copied here), with this wallet's size");
  });

  await t("copy trade 3.9.1: a coin a followed wallet creates is copied by default, also without a buy of their own", async () => {
    const LAUNCH = "NoDevBuyCoinxxxxxxxxxxxxxxxxxxxxxxxxxxxpump";
    // a wallet added without a choice, and a wallet 3.9.0 saved as "their buys" (no v): both copy the launch
    const e = await ctBoot2({ wallets: [{ address: WHALE, label: "new" }, { address: DEV, label: "old", what: "buys" }] });
    assert.strictEqual(JSON.stringify(e.ctx.HatchrCopy.clean({ wallets: [{ address: WHALE }] }).wallets.map(w => w.what)), '["both"]');
    e.tx(["Program log: Instruction: Create", createEvent(LAUNCH, "No Buy", "NOB", WHALE)], 100); await sleep(120);
    e.tx(["Program log: Instruction: Create", createEvent(CA, "Old Saved", "OLD", DEV)], 101); await sleep(120);
    assert.deepStrictEqual(buys(e), [0.1, 0.1], "both launches bought, without a dev buy in them");
    // a choice saved by 3.9.1 (v 2) stays: "their buys" really means only their buys
    const k = await ctBoot2({ v: 2, wallets: [{ address: WHALE, label: "buys only", what: "buys" }] });
    k.tx(["Program log: Instruction: Create", createEvent(LAUNCH, "No Buy", "NOB", WHALE)]); await sleep(120);
    assert.deepStrictEqual(buys(k), [], "kept as chosen");
  });

  await t("copy trade 3.9.1: a launch the trade services do not know yet is tried again for a few seconds", async () => {
    const LAUNCH = "TooNewCoinxxxxxxxxxxxxxxxxxxxxxxxxxxxxxpump";
    const e = await ctBoot2({ wallets: [{ address: WHALE, label: "dev" }] });
    e.w.portal = 400; e.w.jup = "none";
    e.tx(["Program log: Instruction: Create", createEvent(LAUNCH, "Too New", "NEW", WHALE)]); await sleep(600);
    assert.ok(!/failed/.test(await ctLog(e)), "not given up after the first refusals");
    e.w.portal = 200; e.w.jup = "route";
    await sleep(1500);
    assert.ok(/Copied dev's launch: bought 0\.1 SOL of \$NEW/.test(await ctLog(e)), await ctLog(e));
    // never known: one clear failure, about launches
    const f = await ctBoot2({ wallets: [{ address: WHALE, label: "dev" }] });
    f.w.portal = 400; f.w.jup = "none";
    f.tx(["Program log: Instruction: Create", createEvent(LAUNCH, "Too New", "NEW", WHALE)]); await sleep(7000);
    assert.ok(/Copy of dev's launch of \$NEW .* failed \(tried for \d+ s\)/.test(await ctLog(f)), await ctLog(f));
  });

  await t("copy trade: a wallet that should not have its sells copied; TEST copies open TEST positions with the wallet's exits", async () => {
    const e = await ctBoot2({ copySells: true, wallets: [{ address: WHALE, label: "w", sells: "no" }] }, { owned: { [ME]: { [PUMP]: 1000 }, [WHALE]: { [PUMP]: 0 } } });
    e.tx([tradeEvent(PUMP, 1e9, 1e9, true, WHALE)]); await sleep(100);
    e.w.fetches.length = 0;
    e.tx([tradeEvent(PUMP, 1e9, 1e9, false, WHALE)]); await sleep(120);
    assert.ok(!e.w.fetches.some(f => f.body && f.body.action === "sell"), "their sell is not copied for this wallet");
    const own = { on: true, tp: [{ up: 200, sell: 100 }] };
    const dry = await ctBoot2({ wallets: [{ address: WHALE, label: "w", exits: "own", ownExits: own }] }, { dryRun: true });
    dry.tx([tradeEvent(PUMP, 1e9, 1e9, true, WHALE)]); await sleep(100);
    assert.strictEqual(opened.length, 1); assert.strictEqual(opened[0].paper, true); assert.strictEqual(opened[0].tokens, null);
    assert.strictEqual(JSON.stringify(opened[0].exits), JSON.stringify(own), "the wallet's own exits");
  });

  // ------------------------------------------------------------------ pump alerts
  const pair = (mint, price, sym, liq = 20000) => ({ baseToken: { address: mint, name: sym + " Coin", symbol: sym }, priceUsd: String(price), liquidity: { usd: liq }, marketCap: price * 1e9 });
  const held = (mint, ticker, amount = 1e6) => ({ id: "held:" + mint, mint, ticker, name: ticker + " Coin", amount, ok: true });
  const paBoot = async (o = {}) => { const e = boot(["pump-alerts.js"], { ...o, store: { pumpAlerts: { enabled: true, ...(o.cfg || {}) }, heldCoins: o.heldCoins || [held(PUMP, "AAA"), held(CA, "BBB")], ...(o.store || {}) } }); await sleep(150); return e; };
  const tick = async e => { await e.ctx.HatchrPumpAlerts.poll(); await sleep(30); };
  const paState = async e => (await e.ask({ type: "pumpGet" })).data;

  await t("pump alerts: the rules (up X% since the mark, sudden move; seen on two readings in a row; the mark moves up after an alert)", async () => {
    const e = boot(["pump-alerts.js"]); await sleep(120);
    const judge = e.ctx.HatchrPumpAlerts.judge, min = 60000, rules = { risePct: 50, fastPct: 30, fastMin: 5 }, src = { src: "dex:P1" };
    const rec = {};
    assert.strictEqual(judge(rec, 1.00, 0, rules, src), null, "first reading sets the mark");
    assert.strictEqual(judge(rec, 1.20, 10 * min, rules, src), null, "+20% over 10 minutes: nothing");
    assert.strictEqual(judge(rec, 1.52, 20 * min, rules, src), null, "+52%, first reading: wait for the next one");
    let a = judge(rec, 1.53, 20 * min + 20000, rules, src);
    assert.strictEqual(a.kind, "rise"); assert.strictEqual(Math.round(a.up), 53, "still there 20 s later: alert");
    assert.strictEqual(judge(rec, 1.60, 30 * min, rules, src), null, "the mark is now 1.53: +5% is nothing");
    judge(rec, 2.30, 60 * min, rules, src);
    a = judge(rec, 2.31, 60 * min + 20000, rules, src);
    assert.strictEqual(a.kind, "rise"); assert.strictEqual(Math.round(a.up), 51, "another 50% from the new mark alerts again");
    const r2 = {};
    judge(r2, 1.00, 0, rules, src); judge(r2, 1.02, 1 * min, rules, src);
    assert.strictEqual(judge(r2, 1.35, 3 * min, rules, src), null);
    a = judge(r2, 1.36, 3 * min + 20000, rules, src);
    assert.strictEqual(a.kind, "fast"); assert.strictEqual(a.minutes, 5); assert.strictEqual(Math.round(a.up), 36);
    assert.strictEqual(judge(r2, 1.37, 3.5 * min, rules, src), null, "not again for the same move");
    const r3 = {}; judge(r3, 1.00, 0, rules, src); judge(r3, 0.60, 2 * min, rules, src);
    assert.strictEqual(judge(r3, 0.70, 30 * min, rules, src), null, "a coin that is down and recovers a bit over half an hour is not a pump");
    // one odd reading between normal ones never alerts
    const r4 = {}; judge(r4, 1.00, 0, rules, src); judge(r4, 1.00, 20000, rules, src);
    assert.strictEqual(judge(r4, 1.90, 40000, rules, src), null); assert.strictEqual(judge(r4, 1.00, 60000, rules, src), null);
    assert.strictEqual(judge(r4, 1.01, 80000, rules, src), null, "the spike was a single reading: no alert");
    // no trades = the price cannot have moved
    const r5 = {}, quiet = { src: "dex:P1", trades5: 0, trades60: 0 };
    judge(r5, 1.00, 0, rules, quiet); judge(r5, 1.9, 20000, rules, quiet);
    assert.strictEqual(judge(r5, 1.9, 40000, rules, quiet), null, "DexScreener counts no trades: no alert");
    const off = {}; judge(off, 1, 0, { risePct: null, fastPct: null, fastMin: null }, src);
    assert.strictEqual(judge(off, 9, min, { risePct: null, fastPct: null, fastMin: null }, src), null, "both rules off");
  });

  await t("pump alerts: a coin that does not move is never reported, even when its price comes from different pools (the $GLITCH case)", async () => {
    // GLITCH sat still for two hours; DexScreener lists it in more than one pool, priced differently, and a reading
    // could fall back to the bonding curve. Before 3.7.4 these were compared with each other: 47%, 51%, 94% "pumps".
    const G = PUMP;
    const pump = (price, liq) => ({ pairAddress: "PUMPFUN", baseToken: { address: G, name: "Glitch", symbol: "GLITCH" }, priceUsd: String(price), liquidity: liq === undefined ? undefined : { usd: liq }, marketCap: price * 1e9, txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 } }, volume: { h24: 900 } });
    const other = price => ({ pairAddress: "OTHERPOOL", baseToken: { address: G, name: "Glitch", symbol: "GLITCH" }, priceUsd: String(price), liquidity: { usd: 0 }, marketCap: price * 1e9, txns: { m5: { buys: 0, sells: 0 }, h1: { buys: 0, sells: 0 } }, volume: { h24: 50 } });
    const answers = [[pump(0.0000055), other(0.0000106)], [other(0.0000106), pump(0.0000055)], [pump(0.0000055), other(0.000016)], [], [other(0.000016)], [pump(0.0000055), other(0.0000106)]];
    let n = 0;
    const e = await paBoot({ heldCoins: [held(G, "GLITCH")], dex: () => answers[Math.min(n++, answers.length - 1)] });
    const curve = (vTokens, vSol) => { const b = Buffer.alloc(180); b.writeBigUInt64LE(BigInt(Math.round(vTokens * 1e6)), 8); b.writeBigUInt64LE(BigInt(Math.round(vSol * 1e9)), 16); return b.toString("base64"); };
    e.w.curves["CURVE-OF-PENDING"] = curve(500e6, 20); // a curve price far from both pools
    for (let i = 0; i < answers.length + 4; i++) { await tick(e); e.w.clock += 20000; }
    assert.strictEqual(e.w.notes.length, 0, JSON.stringify(e.w.notes));
    assert.ok(!e.w.calls.includes("rpc:getMultipleAccounts"), "a coin DexScreener knows is never priced from the curve in between");
    // and when it really moves, in its own pool, with trades: alerted
    const moved = price => [{ ...pump(price), txns: { m5: { buys: 12, sells: 3 }, h1: { buys: 30, sells: 9 } } }, other(0.0000106)];
    e.w.dex = moved(0.000012); n = 999; answers.length = 0;
    await tick(e); e.w.clock += 20000; await tick(e);
    assert.strictEqual(e.w.notes.length, 1, "a real jump in the pool it is priced from ");
    assert.ok(/\$GLITCH is up \d+%/.test(e.w.notes[0][0]), e.w.notes[0][0]);
  });

  await t("pump alerts: a coin you hold pumps -> notification, sound and a message on the phone", async () => {
    const e = await paBoot({ cfg: { tgOn: true, tgToken: "123456789:AAExampleTokenExampleTokenExample12", tgChat: "777000" }, dex: [pair(PUMP, 0.0001, "AAA"), pair(CA, 0.002, "BBB")] });
    await tick(e);
    assert.strictEqual(e.w.notes.length, 0, "first reading only sets the marks");
    e.w.clock += 5 * 60000; e.w.dex = [pair(PUMP, 0.00011, "AAA"), pair(CA, 0.0031, "BBB")];      // BBB +55%, AAA +10%
    await tick(e);
    assert.strictEqual(e.w.notes.length, 0, "seen once: waits for the next reading");
    e.w.clock += 20000; await tick(e);
    assert.strictEqual(e.w.notes.length, 1); assert.ok(/\$BBB is up 55% /.test(e.w.notes[0][0]), e.w.notes[0][0]);
    assert.strictEqual(e.w.sounds, 1);
    assert.strictEqual(e.w.tg.length, 1); assert.strictEqual(e.w.tg[0].chat_id, "777000");
    assert.ok(/\$BBB is up 55%[\s\S]*Your holding is worth about \$3,100[\s\S]*pump\.fun\/coin\//.test(e.w.tg[0].text), e.w.tg[0].text);
    const s = await paState(e);
    assert.strictEqual(s.state.log.length, 1); assert.strictEqual(s.state.watched, 2);
    e.w.clock += 20000; await tick(e);
    assert.strictEqual(e.w.notes.length, 1, "no repeat for the same price");
    // a coin stays with the pool it was priced from; another pool's price is never compared with it
    for (let i = 0; i < 3; i++) { e.w.clock += 20000; e.w.dex = [pair(PUMP, 0.00011, "AAA"), pair(CA, 0.0031, "BBB"), pair(CA, 0.9, "BBB", 5)]; await tick(e); }
    assert.strictEqual(e.w.notes.length, 1, "a tiny pool with a silly price is ignored");
  });

  await t("pump alerts: a coin paired with another coin gets its dollar price through that coin", async () => {
    const QUOTE = "ysPp2Bt2j2UQu2tZwtSJz7JxyrmQ8GJcNJE5NyDoS5a";
    const paired = native => ({ baseToken: { address: PUMP, name: "E-tards", symbol: "E-TARDS" }, quoteToken: { address: QUOTE, symbol: "MUSK4" }, priceNative: String(native) }); // no priceUsd, as DexScreener gives it
    let native = 0.000005, asked = [];
    const e = await paBoot({ heldCoins: [held(PUMP, "E-TARDS")], dex: url => { asked.push(url.split("/").pop()); return url.endsWith(QUOTE) ? [pair(QUOTE, 0.94, "MUSK4", 73000)] : [paired(native)]; } });
    await tick(e);
    assert.deepStrictEqual(asked.slice(-2), [PUMP, QUOTE], "the coin, then the coin it is paired with");
    const first = (await paState(e)).state;
    assert.strictEqual(first.watched, 1, JSON.stringify(first).slice(0, 300));
    e.w.clock += 5 * 60000; native = 0.000008; await tick(e); // +60% in the other coin, that coin's own price unchanged
    e.w.clock += 20000; await tick(e);
    assert.strictEqual(e.w.notes.length, 1); assert.ok(/\$E-TARDS is up 60% /.test(e.w.notes[0][0]), e.w.notes[0][0]);
  });

  await t("pump alerts: small holdings, hidden coins and sold coins; prices from the bonding curve when DexScreener has none", async () => {
    const e = await paBoot({ cfg: { minValueUsd: 50 }, heldCoins: [held(PUMP, "AAA", 1000), held(CA, "BBB", 1e6)], store: { coHidden: [CA] }, dex: [pair(PUMP, 0.001, "AAA"), pair(CA, 0.002, "BBB")] });
    await tick(e);
    e.w.clock += 60000; e.w.dex = [pair(PUMP, 0.002, "AAA"), pair(CA, 0.004, "BBB")]; await tick(e);
    assert.strictEqual(e.w.notes.length, 0, "AAA is worth $2 (under $50) and BBB is hidden");
    assert.strictEqual((await paState(e)).state.watched, 1);
    // sold, bought back later: a fresh mark
    const s = await paBoot({ dex: [pair(PUMP, 0.001, "AAA")], heldCoins: [held(PUMP, "AAA")] });
    await tick(s); s.w.storage.local.heldCoins = []; s.w.clock += 60000; await tick(s);
    s.w.storage.local.heldCoins = [held(PUMP, "AAA")]; s.w.dex = [pair(PUMP, 0.01, "AAA")]; s.w.clock += 60000; await tick(s);
    assert.strictEqual(s.w.notes.length, 0, "ten times the old price, but it was sold in between: measured from the new buy");
    // a coin too new for DexScreener
    const c = await paBoot({ dex: [], heldCoins: [held(PUMP, "NEW")] });
    const curve = (vTokens, vSol) => { const b = Buffer.alloc(180); b.writeBigUInt64LE(BigInt(Math.round(vTokens * 1e6)), 8); b.writeBigUInt64LE(BigInt(Math.round(vSol * 1e9)), 16); return b.toString("base64"); };
    c.w.curves["CURVE-OF-PENDING"] = curve(1000e6, 30); await tick(c);
    c.w.clock += 120000; c.w.curves["CURVE-OF-PENDING"] = curve(700e6, 43); await tick(c);
    c.w.clock += 20000; await tick(c);
    assert.strictEqual(c.w.notes.length, 1, "read from its bonding curve"); assert.ok(/\$NEW is up 105%/.test(c.w.notes[0][0]), c.w.notes[0][0]);
    // DexScreener down and nothing on-chain: said plainly, no false alert
    const d = await paBoot({ heldCoins: [held(CA, "BBB")] }); d.w.dexDown = true; await tick(d);
    assert.ok(/DexScreener answered 503/.test((await paState(d)).state.error));
  });

  await t("pump alerts: connecting the phone, the test message, bad tokens, and only the panel may ask", async () => {
    const e = await paBoot({ cfg: { enabled: false }, updates: [{ message: { chat: { id: 4242, first_name: "Sol" } } }] });
    const token = "123456789:AAExampleTokenExampleTokenExample12";
    const got = await e.ask({ type: "pumpConnect", token });
    assert.strictEqual(got.ok, true); assert.strictEqual(got.data.chat, "4242"); assert.strictEqual(got.data.bot, "my_hatchr_bot");
    const sent = await e.ask({ type: "pumpTest", config: { tgToken: token, tgChat: "4242" } });
    assert.strictEqual(sent.ok, true); assert.strictEqual(e.w.tg[0].chat_id, "4242");
    const none = boot(["pump-alerts.js"]); await sleep(120);
    const empty = await none.ask({ type: "pumpConnect", token });
    assert.strictEqual(empty.ok, false); assert.ok(/press Start/.test(empty.error), empty.error);
    assert.strictEqual((await e.ask({ type: "pumpConnect", token: "not a token" })).ok, false);
    assert.strictEqual(e.ctx.HatchrPumpAlerts.clean({ tgToken: "nope", tgChat: "abc" }).tgToken, "");
    assert.strictEqual((await e.ask({ type: "pumpSave", config: { enabled: true } }, { id: "abc", url: "https://evil.example/" })).ok, false);
    const c = e.ctx.HatchrPumpAlerts.clean({ risePct: "", fastPct: "40", fastMin: "" });
    assert.deepStrictEqual([c.risePct, c.fastPct, c.fastMin], [null, 40, null], "an emptied box switches that rule off");
    assert.deepStrictEqual([e.ctx.HatchrPumpAlerts.clean({}).risePct, e.ctx.HatchrPumpAlerts.clean({}).fastPct], [50, 30]);
  });

  console.log(`\n${count} CA buy and pump alert tests passed`);
  process.exit(0);
})().catch(e => { console.error("FAILED:", e); process.exit(1); });
