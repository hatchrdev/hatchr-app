// Offline tests: naming, Telegram parser, and the full background pipeline (bundled build)
// with stubbed chrome.* + stubbed network, including real ed25519 signature checks.
import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import vm from "node:vm";
import { Keypair, SystemProgram, TransactionMessage, VersionedTransaction, PublicKey } from "@solana/web3.js";
import bs58 from "bs58";
import { ed25519 } from "@noble/curves/ed25519";
import { heuristicName, sanitizeTicker, renderDescription } from "../src/lib/naming.js";
import { parseChannelHtml } from "../src/lib/telegram.js";

let passed = 0;
const t = async (name, fn) => {
  try { await fn(); passed++; console.log("  ✓", name); }
  catch (e) { console.log("  ✗", name, "\n   ", e.stack || e); process.exitCode = 1; }
};

console.log("naming");
await t("cashtag wins", () => {
  const r = heuristicName({ text: "buying more $DOGE today lol" });
  assert.equal(r.ticker, "DOGE");
});
await t("hashtag camelcase", () => {
  const r = heuristicName({ text: "this is wild #MarsColony" });
  assert.equal(r.name, "Mars Colony");
  assert.equal(r.ticker, "MARSCOLONY");
});
await t("all-caps shout", () => {
  const r = heuristicName({ text: "the absolute state of this. KEKIUS" });
  assert.equal(r.ticker, "KEKIUS");
});
await t("proper noun", () => {
  const r = heuristicName({ text: "I think Grok is getting smarter every day https://t.co/x" });
  assert.equal(r.name, "Grok");
});
await t("image-only fallback", () => {
  const r = heuristicName({ text: "", handle: "elonmusk" });
  assert.ok(r.name.length > 0 && r.ticker.length > 0);
});
await t("long name -> initials ticker", () => {
  const r = heuristicName({ text: '"Department Of Government Efficiency"' });
  assert.equal(r.ticker, "DOGE");
});
await t("ticker sanitize", () => assert.equal(sanitizeTicker("$pepe-2 🐸 coin", 10), "PEPE2COIN"));
await t("description template", () => {
  const d = renderDescription("{text} | {handle} | {url}", { text: "hi", handle: "a", url: "u" }, {});
  assert.equal(d, "hi | @a | u");
});

console.log("telegram");
await t("parses channel html", () => {
  const html = `<meta property="og:title" content="Breaking &amp; News">
  <div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message js-widget_message" data-post="newsch/101">
  <a class="tgme_widget_message_photo_wrap blabla" style="width:800px;background-image:url('https://cdn4.cdn-telegram.org/file/abc.jpg')"></a>
  <div class="tgme_widget_message_text js-message_text" dir="auto">BREAKING: Elon says <b>Doge</b> to Mars<br/>more &amp; more <i class="emoji" style="x"><b>🚀</b></i></div>
  <time datetime="2026-11-06T23:10:00+00:00" class="time">23:10</time></div></div>
  <div class="tgme_widget_message_wrap js-widget_message_wrap"><div class="tgme_widget_message" data-post="newsch/102">
  <div class="tgme_widget_message_text js-message_text" dir="auto">second</div><time datetime="2026-11-06T23:11:00+00:00"></time></div></div>`;
  const posts = parseChannelHtml(html, "newsch");
  assert.equal(posts.length, 2);
  assert.equal(posts[0].author, "Breaking & News");
  assert.equal(posts[0].text, "BREAKING: Elon says Doge to Mars\nmore & more 🚀");
  assert.deepEqual(posts[0].images, ["https://cdn4.cdn-telegram.org/file/abc.jpg"]);
  assert.equal(posts[0].url, "https://t.me/newsch/101");
  assert.equal(posts[1].time, Date.parse("2026-11-06T23:11:00+00:00"));
});

// ---------------- background integration ----------------
console.log("background pipeline");

function makeEnv() {
  const store = {};
  const listeners = { message: [], storage: [], alarm: [], installed: [], startup: [] };
  const clone = (v) => (v === undefined ? undefined : structuredClone(v));
  const chrome = {
    storage: {
      local: {
        async get(keys) {
          const ks = keys == null ? Object.keys(store) : Array.isArray(keys) ? keys : [keys];
          const o = {};
          for (const k of ks) if (k in store) o[k] = clone(store[k]);
          return o;
        },
        async set(obj) {
          const changes = {};
          for (const [k, v] of Object.entries(obj)) { changes[k] = { oldValue: clone(store[k]), newValue: clone(v) }; store[k] = clone(v); }
          listeners.storage.forEach((l) => l(changes, "local"));
        },
        async remove(k) { for (const x of [].concat(k)) delete store[x]; },
      },
      session: {
        data: {},
        async get(k) { const o = {}; for (const x of [].concat(k)) if (x in chrome.storage.session.data) o[x] = clone(chrome.storage.session.data[x]); return o; },
        async set(obj) { for (const [k, v] of Object.entries(obj)) chrome.storage.session.data[k] = clone(v); },
        async remove(k) { for (const x of [].concat(k)) delete chrome.storage.session.data[x]; },
      },
      onChanged: { addListener: (f) => listeners.storage.push(f) },
    },
    permissions: { granted: true, async contains() { return chrome.permissions.granted; } },
    offscreen: {
      created: 0,
      async createDocument(o) { chrome.offscreen.created++; chrome.offscreen.lastReason = o.reasons; },
    },
    runtime: {
      sent: [],
      async getContexts() { return chrome.offscreen.created ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []; },
      async sendMessage(m) {
        chrome.runtime.sent.push(m);
        if (m.type === "videoFrames") return net.videoFramesReply;
        if (m.type === "vanityStart" || m.type === "vanityStop") return { ok: true };
        if (m.type === "vanityStatus") return { ok: true, running: !!net.vanityRunning };
      },
      getManifest: () => ({ version: "9.9.9" }),
      id: "hatchr-test-id",
      getURL: (p) => `chrome-extension://hatchr-test-id/${p}`,
      onMessage: { addListener: (f) => listeners.message.push(f) },
      onInstalled: { addListener: (f) => listeners.installed.push(f) },
      onStartup: { addListener: (f) => listeners.startup.push(f) },
    },
    alarms: { set: new Map(), onAlarm: { addListener: (f) => listeners.alarm.push(f) }, create(n, o) { chrome.alarms.set.set(n, o || {}); }, async clear(n) { return chrome.alarms.set.delete(n); }, async get(n) { return chrome.alarms.set.get(n); } },
    tabs: {
      list: [], created: [], reloaded: [], updated: [],
      async query() { return chrome.tabs.list; },
      async create(o) { chrome.tabs.created.push(o); return { id: 99, url: o.url }; },
      async get(id) { const made = chrome.tabs.created.at(-1); return chrome.tabs.list.find((x) => x.id === id) || { id, url: made?.url }; },
      removed: [],
      async remove(id) { chrome.tabs.removed.push(id); },
      async reload(id) { chrome.tabs.reloaded.push(id); },
      async update(id, o) { chrome.tabs.updated.push([id, o]); },
    },
    // runs the function "in the tab": here simply in the test process, where fetch is the fake network
    scripting: { ran: [], async executeScript({ target, world, func, args }) { chrome.scripting.ran.push({ tabId: target.tabId, world }); return [{ result: await func(...args) }]; } },
    action: { async setBadgeText() {}, async setBadgeBackgroundColor() {}, async setTitle() {}, async setIcon() {} },
    sidePanel: { async setPanelBehavior() {} },
    notifications: { create() {} },
  };
  return { chrome, store, listeners };
}

class FakeCanvas {
  constructor(w, h) { this.w = w; this.h = h; }
  getContext() {
    return new Proxy({ measureText: (s) => ({ width: String(s).length * 10 }), createLinearGradient: () => ({ addColorStop() {} }) },
      { get: (o, k) => (k in o ? o[k] : () => {}), set: () => true });
  }
  async convertToBlob() { return new Blob([new Uint8Array([137, 80, 78, 71])], { type: "image/png" }); }
}

const net = { calls: [], sent: [] };
const TOKEN_ACC = Keypair.generate().publicKey.toBase58();
async function fakeFetch(url, init = {}) {
  url = String(url);
  net.calls.push(url);
  const json = (o, status = 200) => new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
  if (url.startsWith("https://pbs.twimg.com/")) return new Response(new Uint8Array([255, 216, 255]), { headers: { "content-type": "image/jpeg" } });
  if (url === "https://uploads.pinata.cloud/v3/files") {
    assert.match(init.headers.Authorization, /^Bearer jwt-test$/);
    const f = init.body.get("file");
    if (f && /json/.test(f.type)) net.lastMeta = JSON.parse(await f.text());
    else if (f) net.lastImageType = f.type;
    return json({ data: { cid: `bafy${net.calls.length}` } });
  }
  if (url === "https://pumpportal.fun/api/trade-local" && JSON.parse(init.body).action === "collectCreatorFee") {
    const b = JSON.parse(init.body);
    net.lastClaim = b;
    net.claimPending = true;
    const payer = new PublicKey(b.publicKey);
    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: bs58.encode(new Uint8Array(32).fill(5)),
      instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: payer, lamports: 1 })],
    }).compileToV0Message();
    return new Response(new VersionedTransaction(msg).serialize(), { status: 200 });
  }
  if (url === "https://pumpportal.fun/api/trade-local" && JSON.parse(init.body).action === "sell") {
    const b = JSON.parse(init.body);
    net.lastSell = b;
    const payer = new PublicKey(b.publicKey);
    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: bs58.encode(new Uint8Array(32).fill(9)),
      instructions: [SystemProgram.transfer({ fromPubkey: payer, toPubkey: new PublicKey(b.mint), lamports: 1 + Math.round((b.priorityFee || 0) * 1e9) })],
    }).compileToV0Message();
    return new Response(new VersionedTransaction(msg).serialize(), { status: 200 });
  }
  if (url === "https://pumpportal.fun/api/trade-local") {
    const b = JSON.parse(init.body);
    assert.equal(b.action, "create");
    assert.equal(b.pool, "pump");
    assert.ok(b.tokenMetadata.uri.startsWith("https://ipfs.io/ipfs/"));
    net.lastCreate = b;
    const payer = new PublicKey(b.publicKey), mint = new PublicKey(b.mint);
    const msg = new TransactionMessage({
      payerKey: payer,
      recentBlockhash: bs58.encode(new Uint8Array(32).fill(7)),
      instructions: [SystemProgram.createAccount({ fromPubkey: payer, newAccountPubkey: mint, lamports: 1, space: 0, programId: SystemProgram.programId })],
    }).compileToV0Message();
    return new Response(new VersionedTransaction(msg).serialize(), { status: 200 });
  }
  if (url.startsWith("data:")) return globalThis.fetch(url);
  if (url.includes("api.cloudflare.com/client/v4/accounts/")) {
    net.cfCalls = (net.cfCalls || 0) + 1;
    if (net.cfFail) return json({ success: false, errors: [{ message: "Authentication error" }] }, 401);
    assert.match(init.headers.Authorization, /^Bearer cf-token$/);
    const b = JSON.parse(init.body);
    net.cfPrompt = b.prompt;
    return json({ result: { image: Buffer.from([255, 216, 255, 224, 1, 2, 3]).toString("base64") }, success: true });
  }
  if (url === "https://api.openai.com/v1/models") {
    return json({ data: [{ id: "gpt-image-1.5", created: 100 }, { id: "gpt-image-2-mini", created: 300 }, { id: "gpt-image-2", created: 200 }, { id: "gpt-image-2-2026-04-21", created: 201 }, { id: "gpt-5", created: 400 }] });
  }
  if (url === "https://api.openai.com/v1/images/generations") {
    const b = JSON.parse(init.body);
    net.oaiBody = b;
    return json({ data: [{ b64_json: Buffer.from([137, 80, 78, 71, 9, 9]).toString("base64") }] });
  }
  if (url === "https://api.groq.com/openai/v1/models") {
    return json({ object: "list", data: [{ id: "whisper-large-v3" }, { id: "openai/gpt-oss-20b" }, { id: "llama-3.1-8b-instant" }] });
  }
  if (url === "https://frontend-api-v3.pump.fun/callout/create") {
    net.callouts = [...(net.callouts || []), { body: JSON.parse(init.body), credentials: init.credentials }];
    const r = net.calloutReply || { status: 201, body: { callout: { calloutId: "be6b78ef-67c2-4c2c-aabe-93173ac63a0a" } } };
    return json(r.body, r.status);
  }
  if (url === "https://api.groq.com/openai/v1/chat/completions") {
    const b = JSON.parse(init.body);
    if (Array.isArray(b.messages[0].content)) { // vision: pick a frame
      net.visionCalls = (net.visionCalls || 0) + 1;
      net.visionModel = b.model;
      return json({ choices: [{ message: { content: net.visionAnswer || "3" } }], usage: { total_tokens: 900 } });
    }
    net.aiModels = [...(net.aiModels || []), b.model];
    net.aiBodies = [...(net.aiBodies || []), b];
    const beh = (net.aiBehavior || {})[b.model];
    if (beh === "tpd") {
      return json({ error: { message: `Rate limit reached for model \`${b.model}\` in organization \`org_x\` service tier \`on_demand\` on tokens per day (TPD): Limit 200000, Used 199687, Requested 900. Please try again in 2h13m5.2s. Need more tokens?`, type: "tokens", code: "rate_limit_exceeded" } }, 429);
    }
    if (b.model === "llama-3.3-70b-versatile" && beh !== "ok") {
      return json({ error: { message: "The model `llama-3.3-70b-versatile` does not exist or you do not have access to it.", type: "invalid_request_error", code: "model_not_found" } }, 404);
    }
    const reply = net.aiReply || { name: "Boom Hero", ticker: "BOOMHERO", description: "hero", score: 7, reason: "spicy" };
    return json({ choices: [{ message: { content: JSON.stringify(reply) } }], usage: { total_tokens: 420 } });
  }
  if (url === "https://api.anthropic.com/v1/messages") {
    net.anthropic = { headers: init.headers, body: JSON.parse(init.body) };
    return json({ content: [{ type: "text", text: JSON.stringify({ name: "Claude Doge", ticker: "CDOGE", score: 8, reason: "fun" }) }], usage: { input_tokens: 300, output_tokens: 40 } });
  }
  if (url === "https://my-ai.example/v1/chat/completions") {
    net.custom = { headers: init.headers, body: JSON.parse(init.body) };
    if (net.customFail) return json({ error: { message: "Invalid API key" } }, 401);
    return json({ choices: [{ message: { content: '{"name":"Mars Dog","ticker":"MARSDOG","score":6}' } }], usage: { total_tokens: 99 } });
  }
  if (url.startsWith("https://my-ai.example/v1/models")) { net.customListed = true; return json({ data: [{ id: "pricey-model" }] }); }
  if (url.startsWith("https://api.coingecko.com/api/v3/simple/price")) {
    net.priceCalls = (net.priceCalls || 0) + 1;
    return json({ solana: { usd: 150, eur: 138, gbp: 118 } });
  }
  if (url.startsWith("https://blocked.rpc")) return json({ jsonrpc: "2.0", error: { code: 403, message: "Access forbidden" } }, 403);
  if (url.startsWith("https://api.mainnet-beta.solana.com") || url.startsWith("https://mainnet.helius-rpc.com/?api-key=held")) {
    const { method, params } = JSON.parse(init.body);
    const verify = () => {
      const tx = VersionedTransaction.deserialize(Buffer.from(params[0], "base64"));
      const m = tx.message.serialize();
      tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures).forEach((k, i) => {
        assert.ok(ed25519.verify(tx.signatures[i], m, k.toBytes()), `signature ${i} invalid`);
      });
      return tx;
    };
    switch (method) {
      case "getBalance": {
        if (net.vaults && params[0] === net.vaults.curve) return json({ result: { value: net.claimed ? 890880 : 890880 + 0.03e9 } });
        return json({ result: { value: (net.sold ? 0.6 : 0.5) * 1e9 + (net.claimed ? 0.04e9 : 0) } });
      }
      case "getAssetBatch":
        net.assetAsks = [...(net.assetAsks || []), params.ids];
        return json({ result: params.ids.map((id) => (net.assets || {})[id]).filter(Boolean) });
      case "getTokenAccountsByOwner": {
        if (params[1] && params[1].programId) { // every token account of a wallet, per token program
          const rows = ((net.wallets || {})[params[0]] || []).filter((r) => (r.program || "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") === params[1].programId);
          return json({ result: { value: rows.map((r) => ({ account: { data: { parsed: { info: { mint: r.mint, tokenAmount: { amount: String(r.ui * 1e6), decimals: 6, uiAmount: r.ui } } } } } })) } });
        }
        if (params[1] && params[1].mint === "So11111111111111111111111111111111111111112") {
          const ui = net.vaults && params[0] === net.vaults.ammAuthority && !net.claimed ? 0.01 : 0;
          return json({ result: { value: ui ? [{ account: { data: { parsed: { info: { tokenAmount: { amount: String(ui * 1e9), decimals: 9, uiAmount: ui } } } } } }] : [] } });
        }
        const amt = net.sold ? "0" : (net.tokenRaw ?? "35000000000000");
        if (net.closed) return json({ result: { value: [] } });
        return json({ result: { value: [{ pubkey: TOKEN_ACC, account: { owner: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", data: { parsed: { info: { tokenAmount: { amount: amt, decimals: 6, uiAmount: Number(amt) / 1e6 } } } } } }] } });
      }
      case "getSlot": return json({ result: 123 });
      case "getLatestBlockhash": return json({ result: { value: { blockhash: bs58.encode(new Uint8Array(32).fill(3)), lastValidBlockHeight: 1 } } });
      case "simulateTransaction":
        verify();
        if (net.simErr) return json({ result: { value: { err: net.simErr, logs: ["Program 11111111111111111111111111111111 failed: insufficient lamports"], unitsConsumed: 100 } } });
        return json({ result: { value: { err: null, logs: ["ok"], unitsConsumed: 4242 } } });
      case "sendTransaction": {
        const tx = verify(); net.sent.push(tx);
        const keys = tx.message.staticAccountKeys.map((k) => k.toBase58());
        if (keys.includes("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA") && keys.includes(TOKEN_ACC)) { net.closeTx = tx; net.closed = true; return json({ result: bs58.encode(tx.signatures[0]) }); }
        if (net.lastSell && net.dropFirstSell) { net.dropFirstSell = false; net.dropped = bs58.encode(tx.signatures[0]); return json({ result: net.dropped }); }
        if (net.lastSell && net.sellPending) { net.sold = true; net.sellPending = false; }
        if (net.claimPending) { net.claimed = true; net.claimPending = false; }
        return json({ result: bs58.encode(tx.signatures[0]) });
      }
      case "getSignatureStatuses":
        if (params[0][0] === net.dropped) return json({ result: { value: [null] } });
        return json({ result: { value: [{ confirmationStatus: "confirmed", err: null }] } });
    }
  }
  throw new Error(`unexpected fetch ${url}`);
}

async function boot(settings, secret, extraGlobals = {}) {
  const env = makeEnv();
  env.store.settings = settings;
  if (secret) env.store.walletSecret = secret;
  const code = readFileSync(new URL("../extension/background.js", import.meta.url), "utf8");
  const ctx = vm.createContext({
    chrome: env.chrome, fetch: fakeFetch, Response, Blob, FormData, File, URL, TextEncoder, TextDecoder,
    crypto: globalThis.crypto, atob, btoa, getManifest: null,
    createImageBitmap: async () => ({ width: 540, height: 960 }), setTimeout, clearTimeout, console, structuredClone, OffscreenCanvas: FakeCanvas,
    Uint8Array, ArrayBuffer, DataView, Math, Date, JSON, Promise, Error, Map, Set, AbortController,
    ...extraGlobals,
  });
  ctx.self = ctx; ctx.globalThis = ctx;
  // the service worker loads the callout sender first (importScripts); here it is run into the same context
  vm.runInContext(readFileSync(new URL("../extension/callout-client.js", import.meta.url), "utf8"), ctx);
  vm.runInContext(code, ctx);
  await Promise.all(env.listeners.installed.map((f) => f()));
  // Hatchr always starts paused; most tests want it running unless they say otherwise
  if (settings && !settings.paused && env.store.settings) env.store.settings = { ...env.store.settings, paused: false };
  const msg = (m) => new Promise((res) => {
    const ret = env.listeners.message[0](m, { id: "hatchr-test-id", url: "chrome-extension://hatchr-test-id/sidepanel.html" }, res); // sent by the side panel
    if (ret === false && m.type === "post") {} // fire-and-forget
  });
  return { env, msg };
}

const settle = (ms = 300) => new Promise((r) => setTimeout(r, ms));
const baseSettings = (extra) => ({ mode: "auto", dryRun: true, xHandles: "elonmusk", autoCooldownSec: 300, autoMaxPerHour: 5, autoMaxPerDay: 5, ...extra });
const post = (id, text, extra = {}) => ({ source: "x", postId: id, handle: "elonmusk", author: "Elon", text, url: `https://x.com/elonmusk/status/${id}`, images: [], avatar: null, time: Date.now(), ...extra });

await t("bundle loads in a worker-like context and installs defaults", async () => {
  const { env } = await boot(undefined);
  assert.equal(env.store.settings.mode, "auto", "new installs start in auto mode…");
  assert.equal(env.store.settings.dryRun, true, "…in test mode");
  assert.equal(env.store.settings.aiProvider, "groq");
  assert.equal(env.store.settings.dryRun, true);
});

await t("filters: wrong handle, old post, duplicate", async () => {
  const { env, msg } = await boot(baseSettings({ mode: "manual" }));
  msg({ type: "post", post: post("1", "hello", { handle: "randomguy" }) });
  msg({ type: "post", post: post("2", "old one", { time: Date.now() - 3600_000 }) });
  msg({ type: "post", post: post("3", "Grok rocks") });
  msg({ type: "post", post: post("3", "Grok rocks") });
  await settle();
  assert.equal(env.store.feed.length, 1);
  assert.equal(env.store.feed[0].name, "Grok");
});

await t("auto dry-run without wallet: launches preview, then cooldown + exclude rules skip", async () => {
  const { env, msg } = await boot(baseSettings());
  msg({ type: "post", post: post("10", "Introducing Grokipedia") });
  await settle(500);
  msg({ type: "post", post: post("11", "MARSHIP is coming") });
  msg({ type: "post", post: post("12", "RIP to a legend") });
  await settle(500);
  const byId = Object.fromEntries(env.store.feed.map((c) => [c.id, c]));
  assert.equal(byId["x:10"].status, "dry-ok", JSON.stringify(byId["x:10"]));
  assert.match(byId["x:11"].autoSkip, /Cooldown/);
  assert.match(byId["x:12"].autoSkip, /Excluded keyword "rip"/);
  assert.equal(env.store.deploys.length, 1);
  assert.equal(env.store.deploys[0].mode, "auto");
});

const kp = Keypair.generate();
const secretB58 = bs58.encode(kp.secretKey);

await t("dry run with wallet: builds create tx, signs with mint + wallet, simulates", async () => {
  const { env, msg } = await boot(baseSettings({ mode: "manual" }), secretB58);
  msg({ type: "post", post: post("20", "Doge to Mars", { images: ["https://pbs.twimg.com/media/abc.jpg"] }) });
  await settle();
  const r = await msg({ type: "deploy", id: "x:20", overrides: { ticker: "dogem", name: "Doge Mars" } });
  assert.ok(r.ok, r.error);
  assert.equal(r.data.simulated, true);
  assert.equal(r.data.unitsConsumed, 4242);
  assert.equal(env.store.feed[0].status, "dry-ok");
  assert.equal(net.lastCreate.tokenMetadata.symbol, "dogem", "typed case is kept (lowercase metas)");
  assert.equal(net.lastCreate.publicKey, kp.publicKey.toBase58());
});

await t("LIVE manual deploy: Pinata uploads, valid signatures sent, confirmed", async () => {
  net.sent.length = 0;
  const { env, msg } = await boot(baseSettings({ mode: "manual", dryRun: false, pinataJwt: "jwt-test", devBuySol: 0.001 }), secretB58);
  msg({ type: "post", post: post("30", "Starship launch tomorrow #Starship") });
  await settle();
  const r = await msg({ type: "deploy", id: "x:30" });
  assert.ok(r.ok, r.error);
  assert.equal(r.data.confirmed, true);
  assert.equal(net.sent.length, 1);
  assert.equal(net.lastCreate.amount, 0.001);
  assert.equal(net.lastCreate.mint, r.data.mint);
  assert.equal(net.lastMeta.twitter, "https://x.com/elonmusk/status/30", "tweet must be linked in socials");
  assert.equal(net.lastMeta.symbol, net.lastCreate.tokenMetadata.symbol);
  const card = env.store.feed[0];
  assert.equal(card.status, "launched");
  assert.equal(env.store.deploys[0].dryRun, false);
});

await t("LIVE auto: daily SOL cap blocks launch", async () => {
  const { env, msg } = await boot(baseSettings({ dryRun: false, pinataJwt: "jwt-test", autoMaxSolPerDay: 0.01, devBuySol: 0.001 }), secretB58);
  msg({ type: "post", post: post("40", "TESLABOT time") });
  await settle(500);
  assert.match(env.store.feed[0].autoSkip, /Daily SOL cap/);
  assert.equal(net.sent.length, 1); // unchanged from previous test
});

await t("LIVE auto: passes rules and launches", async () => {
  net.sent.length = 0;
  const { env, msg } = await boot(baseSettings({ dryRun: false, pinataJwt: "jwt-test", autoMaxSolPerDay: 1, devBuySol: 0.001, minBalanceSol: 0.1 }), secretB58);
  msg({ type: "post", post: post("50", "TESLABOT time") });
  await settle(800);
  assert.equal(env.store.feed[0].status, "launched", JSON.stringify(env.store.feed[0]));
  assert.equal(net.sent.length, 1);
});

await t("axiom: repost uses original tweet, filters by type, dedupes with X tab", async () => {
  const { env, msg } = await boot(baseSettings({ mode: "manual", axiomReplies: false }));
  const ax = (id, type, extra = {}) => ({ source: "axiom", postId: id, dedupeKey: `tw:${extra.mainId || id}`, tweetType: type, tracked: "elonmusk", handle: "elonmusk", author: "Elon", text: "Kekius Maximus", context: "", url: `https://x.com/elonmusk/status/${id}`, images: [], time: Date.now(), ...extra });
  msg({ type: "post", post: ax("900", "TWEET") });
  msg({ type: "post", post: ax("901", "REPLY", { text: "lol" }) });
  await settle();
  // same tweet arrives from the X tab: must not create a second card
  msg({ type: "post", post: { ...post("900", "Kekius Maximus"), dedupeKey: "tw:900" } });
  await settle();
  assert.equal(env.store.feed.length, 1, JSON.stringify(env.store.feed.map((c) => c.id)));
  assert.equal(env.store.feed[0].id, "tw:900");
  assert.equal(env.store.feed[0].source, "axiom");
  assert.equal(env.store.feed[0].ticker, "KEKIUS");
});

await t("axiom: bare reply is named from the post it replies to", async () => {
  const { env, msg } = await boot(baseSettings({ mode: "manual" }));
  msg({ type: "post", post: { source: "axiom", postId: "950", dedupeKey: "tw:950", tweetType: "REPLY", tracked: "elonmusk", handle: "elonmusk", author: "Elon", text: "!!", context: "Replying to @SpaceX: Starship Flight 12 is GO", url: "https://x.com/elonmusk/status/950", images: [], time: Date.now() } });
  await settle();
  assert.equal(env.store.feed[0].name, "Starship Flight");
  assert.equal(env.store.feed[0].ticker, "STARSHIP");
});

await t("RPC 403: clear message, failed record keeps the ticker", async () => {
  const { env, msg } = await boot(baseSettings({ mode: "manual", dryRun: false, pinataJwt: "jwt-test", rpcUrl: "https://blocked.rpc" }), secretB58);
  msg({ type: "post", post: post("60", "BONKMARS soon") });
  await settle();
  const r = await msg({ type: "deploy", id: "tw:60" in {} ? "tw:60" : env.store.feed[0].id });
  assert.equal(r.ok, false);
  assert.match(r.error, /Helius/);
  assert.equal(env.store.deploys[0].ticker, "BONKMARS");
});

await t("junk reply ('3k?') is named from the replied-to post", async () => {
  const r = heuristicName({ text: "3k?", context: "Replying to @hyler88: just buy a Pepecoin bag" });
  assert.equal(r.name, "Pepecoin");
});

await t("watchdog: opens pinned Axiom once, reloads a stale background tab, never the active one", async () => {
  const { env } = await boot(baseSettings({ mode: "manual" }));
  const fire = () => Promise.all(env.listeners.alarm.map((f) => f({ name: "axiom-watchdog" })));
  const tabs = env.chrome.tabs;
  tabs.created.length = 0; tabs.reloaded.length = 0;
  await fire(); await settle(100);
  assert.equal(tabs.created.length, 1);
  assert.equal(tabs.created[0].pinned, true);
  assert.equal(tabs.created[0].active, false);
  await fire(); await settle(100);
  assert.equal(tabs.created.length, 1, "must not open a second tab within 5 min");
  // a tab exists but is the active one and stale: no reload
  tabs.list = [{ id: 5, active: true, discarded: false }];
  await fire(); await settle(100);
  assert.equal(tabs.reloaded.length, 0);
  assert.ok(tabs.updated.some(([id, o]) => id === 5 && o.autoDiscardable === false));
  // stale background tab: reload
  tabs.list = [{ id: 5, active: true }, { id: 6, active: false }];
  await fire(); await settle(100);
  assert.deepEqual(tabs.reloaded, [6]);
  // fresh heartbeat: nothing happens
  tabs.reloaded.length = 0;
  env.store.axiomStatus = { live: true, hooked: true, at: Date.now() };
  env.store.axiomKeeper = {};
  await fire(); await settle(100);
  assert.equal(tabs.reloaded.length, 0);
});

await t("live launch opens Axiom when enabled; Sell all sells 100%, updates holding + sold", async () => {
  net.sold = false; net.lastSell = null;
  const { env, msg } = await boot(baseSettings({ mode: "manual", dryRun: false, pinataJwt: "jwt-test", openAxiomAfterLaunch: true, sellSlippage: 30 }), secretB58);
  env.chrome.tabs.created.length = 0;
  msg({ type: "post", post: post("70", "MOONDOG is here") });
  await settle();
  const r = await msg({ type: "deploy", id: env.store.feed[0].id });
  assert.ok(r.ok, r.error);
  await settle(50);
  assert.equal(env.chrome.tabs.created.at(-1).url, `https://axiom.trade/token/${r.data.mint}?chain=sol`);
  const dep = env.store.deploys[0];
  const h = await msg({ type: "holdings", ids: [dep.id] });
  assert.equal(h.data[dep.id], 35000000);
  assert.equal(env.store.deploys[0].holding, 35000000);
  net.sellPending = true;
  const s = await msg({ type: "sell", id: dep.id });
  assert.ok(s.ok, s.error);
  assert.equal(net.lastSell.amount, "100%");
  assert.equal(net.lastSell.denominatedInSol, "false");
  assert.equal(net.lastSell.pool, "auto");
  assert.equal(net.lastSell.slippage, 30);
  const after = env.store.deploys[0];
  assert.equal(after.sold, true);
  assert.equal(after.holding, 0);
  assert.equal(after.receivedSol, 0.1);
  assert.ok(net.closeTx, "empty token account closed after the sell");
  net.sold = false; net.closed = false;
});

await t("Sell all in dry run only simulates", async () => {
  const { env, msg } = await boot(baseSettings({ mode: "manual", dryRun: true }), secretB58);
  env.store.deploys = [{ id: "d1", ok: true, dryRun: false, mint: Keypair.generate().publicKey.toBase58(), signature: "sig", ticker: "X", time: Date.now() }];
  const sentBefore = net.sent.length;
  const s = await msg({ type: "sell", id: "d1" });
  assert.ok(s.ok, s.error);
  assert.equal(net.sent.length, sentBefore);
  assert.equal(env.store.deploys[0].sellDryOk, true);
  assert.notEqual(env.store.deploys[0].sold, true);
});

await t("AI: refused model -> switches to one the key can use, saves it, scores the post", async () => {
  net.aiModels = [];
  const { env, msg } = await boot(baseSettings({ mode: "manual", aiEnabled: true, aiKey: "gsk_test", aiUrl: "https://api.groq.com/openai/v1/chat/completions", aiModel: "llama-3.3-70b-versatile", aiPrompt: "x" }));
  msg({ type: "post", post: post("80", "Boom is a hero") });
  await settle(400);
  const c = env.store.feed[0];
  assert.equal(c.namingBy, "ai", c.aiError);
  assert.equal(c.score, 7);
  assert.equal(c.ticker, "BOOMHERO");
  assert.deepEqual(net.aiModels, ["llama-3.3-70b-versatile", "llama-3.1-8b-instant"]);
  assert.equal(env.store.settings.aiModel, "llama-3.1-8b-instant");
});

await t("AI image (Cloudflare): used at launch when the post has no image, with the AI subject", async () => {
  net.cfFail = false; net.cfCalls = 0;
  const { env, msg } = await boot(baseSettings({ mode: "manual", dryRun: false, pinataJwt: "jwt-test", imageAiProvider: "cloudflare", imageAiWhen: "no-post-image", cfAccountId: "acc123", cfToken: "cf-token" }), secretB58);
  msg({ type: "post", post: post("90", "Frogs to the moon") });
  await settle();
  await env.chrome.storage.local.set({ feed: env.store.feed.map((c) => ({ ...c, aiImagePrompt: "a frog astronaut on a rocket" })) });
  const r = await msg({ type: "deploy", id: env.store.feed[0].id });
  assert.ok(r.ok, r.error);
  assert.equal(net.cfCalls, 1);
  assert.match(net.cfPrompt, /frog astronaut/);
  assert.match(net.cfPrompt, /no text/);
  assert.equal(net.lastImageType, "image/jpeg");
  assert.equal(env.store.feed[0].imageKind, "ai");
});

await t("AI image: posts with their own picture keep it (no-post-image rule)", async () => {
  net.cfCalls = 0;
  const { env, msg } = await boot(baseSettings({ mode: "manual", dryRun: false, pinataJwt: "jwt-test", imageAiProvider: "cloudflare", imageAiWhen: "no-post-image", cfAccountId: "acc123", cfToken: "cf-token" }), secretB58);
  msg({ type: "post", post: post("91", "Look at this", { images: ["https://pbs.twimg.com/media/pic.jpg"] }) });
  await settle();
  const r = await msg({ type: "deploy", id: env.store.feed[0].id });
  assert.ok(r.ok, r.error);
  assert.equal(net.cfCalls, 0);
  assert.equal(env.store.feed[0].imageKind, "post");
});

await t("AI image failure falls back to the tweet screenshot, launch still goes through", async () => {
  net.cfFail = true;
  const { env, msg } = await boot(baseSettings({ mode: "manual", dryRun: false, pinataJwt: "jwt-test", imageAiProvider: "cloudflare", imageAiWhen: "always", cfAccountId: "acc123", cfToken: "bad" }), secretB58);
  msg({ type: "post", post: post("92", "Something big") });
  await settle();
  const r = await msg({ type: "deploy", id: env.store.feed[0].id });
  assert.ok(r.ok, r.error);
  assert.equal(env.store.feed[0].imageKind, "tweet");
  net.cfFail = false;
});

await t("AI image (OpenAI): picks the newest full GPT Image model, low quality, 🎨 stores preview", async () => {
  const { env, msg } = await boot(baseSettings({ mode: "manual", imageAiProvider: "openai", openaiKey: "sk-test", openaiImageModel: "auto", openaiImageQuality: "low" }), secretB58);
  msg({ type: "post", post: post("93", "Robots everywhere") });
  await settle();
  const r = await msg({ type: "aiImage", id: env.store.feed[0].id });
  assert.ok(r.ok, r.error);
  assert.equal(net.oaiBody.model, "gpt-image-2");
  assert.equal(net.oaiBody.quality, "low");
  assert.equal(net.oaiBody.size, "1024x1024");
  const c = env.store.feed[0];
  assert.match(c.aiImage, /^data:image\/png;base64,/);
  assert.equal(c.imageChoice, "ai");
});

await t("old saved AI prompt gets upgraded to ask for an image idea", async () => {
  const { OLD_PROMPTS, DEFAULT_PROMPT } = await import("../src/lib/settings.js");
  const { env } = await boot(baseSettings({ aiPrompt: OLD_PROMPTS[0] }));
  assert.equal(env.store.settings.aiPrompt, DEFAULT_PROMPT);
  assert.match(DEFAULT_PROMPT, /image_prompt/);
});

const aiSettings = (extra) => baseSettings({ mode: "manual", aiEnabled: true, aiKey: "gsk_test", aiUrl: "https://api.groq.com/openai/v1/chat/completions", aiPrompt: "x", ...extra });

await t("AI: daily limit -> uses next model, remembers cool-down, saved model unchanged, counts usage", async () => {
  net.aiModels = []; net.aiBodies = [];
  net.aiBehavior = { "openai/gpt-oss-20b": "tpd" };
  const { env, msg } = await boot(aiSettings({ aiModel: "openai/gpt-oss-20b" }));
  msg({ type: "post", post: post("100", "Grok goes interplanetary") });
  await settle(400);
  assert.equal(env.store.feed[0].namingBy, "ai", env.store.feed[0].aiError);
  assert.deepEqual(net.aiModels, ["openai/gpt-oss-20b", "llama-3.1-8b-instant"]);
  assert.equal(net.aiBodies[0].reasoning_effort, "low", "gpt-oss should think less");
  assert.equal(net.aiBodies[0].include_reasoning, false);
  assert.ok(net.aiBodies[1].max_completion_tokens <= 300);
  const until = env.store.aiCooldowns["openai/gpt-oss-20b"];
  assert.ok(until > Date.now() + 2 * 3600e3 && until < Date.now() + 2.3 * 3600e3, "cool-down from 'try again in 2h13m'");
  assert.equal(env.store.settings.aiModel, "openai/gpt-oss-20b", "rate limit must not change the saved model");
  assert.equal(env.store.aiUsage.tokens, 420);
  // next post: the exhausted model is not called again
  net.aiModels = [];
  msg({ type: "post", post: post("101", "Tesla Robotaxi everywhere") });
  await settle(400);
  assert.deepEqual(net.aiModels, ["llama-3.1-8b-instant"]);
});

await t("AI: every model at its limit -> clear message, auto skips, rules-fallback launches", async () => {
  net.aiBehavior = { "openai/gpt-oss-20b": "tpd", "llama-3.1-8b-instant": "tpd" };
  const { env, msg } = await boot(aiSettings({ mode: "auto", aiModel: "openai/gpt-oss-20b" }));
  msg({ type: "post", post: post("110", "DOGEFATHER returns") });
  await settle(500);
  const c = env.store.feed[0];
  assert.match(c.aiError, /limit reached on every model/);
  assert.match(c.aiError, /2h 14m|2h 13m/);
  assert.match(c.autoSkip, /AI unavailable/);
  // later posts don't even call the API while everything is cooling down
  net.aiModels = [];
  const { env: env2, msg: msg2 } = await boot(aiSettings({ mode: "auto", aiModel: "openai/gpt-oss-20b", aiFallback: "rules" }));
  env2.store.aiCooldowns = { ...env.store.aiCooldowns };
  msg2({ type: "post", post: post("111", "MARSWALK today") });
  await settle(500);
  assert.equal(net.aiModels.length, 0, JSON.stringify(net.aiModels));
  assert.equal(env2.store.feed[0].status, "dry-ok", JSON.stringify(env2.store.feed[0]));
  net.aiBehavior = {};
});

await t("AI saves tokens: excluded or cooldown-blocked posts are not sent to the AI; ↻ still works", async () => {
  net.aiModels = [];
  net.aiBehavior = { "llama-3.3-70b-versatile": "ok" };
  const { env, msg } = await boot(aiSettings({ mode: "auto", aiModel: "llama-3.3-70b-versatile" }));
  msg({ type: "post", post: post("120", "RIP to a true legend") });
  await settle(300);
  assert.equal(net.aiModels.length, 0);
  assert.match(env.store.feed[0].aiSkipped, /Excluded keyword/);
  // put auto mode in cooldown
  env.store.deploys = [{ id: "d", mode: "auto", dryRun: true, ok: true, time: Date.now(), ticker: "OLD", name: "Old" }];
  msg({ type: "post", post: post("121", "Brand new meme NEWTHING") });
  await settle(300);
  assert.equal(net.aiModels.length, 0);
  const card = env.store.feed.find((c) => c.id.endsWith(":121"));
  assert.match(card.aiSkipped, /Cooldown/);
  const r = await msg({ type: "regen", id: card.id });
  assert.ok(r.ok, r.error);
  assert.equal(net.aiModels.length, 1);
  assert.equal(env.store.feed.find((c) => c.id === card.id).namingBy, "ai");
  net.aiBehavior = {};
});

await t("retry time parsing", async () => {
  const { parseRetry } = await import("../src/lib/naming.js");
  assert.equal(parseRetry("Please try again in 2h13m5.2s."), (2 * 3600 + 13 * 60 + 5.2) * 1000);
  assert.equal(parseRetry("Please try again in 7.5s"), 7500);
  assert.equal(parseRetry("Please try again in 340ms"), 340);
  assert.equal(parseRetry("nothing here", "12"), 12000);
});

await t("backup: export everything with password -> fresh install -> import restores it all", async () => {
  const { env, msg } = await boot(baseSettings({ pinataJwt: "jwt-test", aiKey: "gsk_secret", rpcUrl: "https://mainnet.helius-rpc.com/?api-key=abc", cfToken: "cf-token", openaiKey: "sk-x" }), secretB58);
  env.store.deploys = [{ id: "d1", ok: true, dryRun: false, mint: "M1", signature: "S1", ticker: "OLD", time: 1000 }];
  const ex = await msg({ type: "exportBackup", password: "hunter22", includeHistory: true });
  assert.ok(ex.ok, ex.error);
  const file = JSON.stringify(ex.data);
  assert.equal(ex.data.encrypted, true);
  assert.equal(ex.data.extVersion, "9.9.9");
  assert.ok(!file.includes("gsk_secret") && !file.includes(secretB58), "secrets must not be readable in a locked file");

  const fresh = await boot(undefined); // reinstall: defaults, no wallet
  const noPw = await fresh.msg({ type: "importBackup", file });
  assert.equal(noPw.ok, false);
  assert.match(noPw.error, /password-protected/);
  const bad = await fresh.msg({ type: "importBackup", file, password: "wrong" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Wrong password/);
  const ok = await fresh.msg({ type: "importBackup", file, password: "hunter22" });
  assert.ok(ok.ok, ok.error);
  assert.equal(ok.data.wallet, kp.publicKey.toBase58());
  assert.equal(ok.data.historyAdded, 1);
  const st = fresh.env.store;
  assert.equal(st.walletSecret, secretB58);
  assert.equal(st.settings.pinataJwt, "jwt-test");
  assert.equal(st.settings.aiKey, "gsk_secret");
  assert.equal(st.settings.rpcUrl, "https://mainnet.helius-rpc.com/?api-key=abc");
  assert.equal(st.settings.cfToken, "cf-token");
  assert.equal(st.settings.openaiKey, "sk-x");
  assert.equal(st.deploys[0].ticker, "OLD");
  // importing the same file twice doesn't duplicate history
  const again = await fresh.msg({ type: "importBackup", file, password: "hunter22" });
  assert.equal(again.data.historyAdded, 0);
  assert.equal(fresh.env.store.deploys.length, 1);
});

await t("backup: unlocked export is plain JSON; junk files and bad wallet keys are rejected", async () => {
  const { msg } = await boot(baseSettings({ aiKey: "gsk_plain" }), secretB58);
  const ex = await msg({ type: "exportBackup", password: "", includeHistory: false });
  assert.equal(ex.data.encrypted, false);
  assert.equal(ex.data.data.settings.aiKey, "gsk_plain");
  assert.equal(ex.data.data.deploys, undefined);
  const fresh = await boot(undefined);
  const junk = await fresh.msg({ type: "importBackup", file: "{\"hello\":1}" });
  assert.match(junk.error, /isn't a Hatchr backup/);
  assert.equal(ex.data.app, "hatchr");
  const legacy = await (await boot(undefined)).msg({ type: "importBackup", file: JSON.stringify({ ...ex.data, app: "tweet2coin" }) });
  assert.ok(legacy.ok, "backups made under the old name still import: " + legacy.error);
  const broken = JSON.stringify({ ...ex.data, data: { ...ex.data.data, walletSecret: "notakey" } });
  const r = await fresh.msg({ type: "importBackup", file: broken });
  assert.equal(r.ok, false);
  assert.equal(fresh.env.store.walletSecret, undefined, "nothing saved when the wallet key is invalid");
});

await t("bell: ding-ding on live launch, soft ding on dry run, none when off, test button forces it", async () => {
  const bells = (env) => env.chrome.runtime.sent.filter((m) => m.type === "playBell");
  const live = await boot(baseSettings({ mode: "manual", dryRun: false, pinataJwt: "jwt-test", soundVolume: 40 }), secretB58);
  live.msg({ type: "post", post: post("130", "BELLCOIN rings") });
  await settle();
  const r = await live.msg({ type: "deploy", id: live.env.store.feed[0].id });
  assert.ok(r.ok, r.error);
  await settle(50);
  assert.deepEqual(bells(live.env).map((m) => [m.target, m.kind, m.volume]), [["offscreen", "live", 40]]);
  assert.ok(JSON.stringify(live.env.chrome.offscreen.lastReason).includes("AUDIO_PLAYBACK"));

  const dry = await boot(baseSettings({ mode: "manual" }));
  dry.msg({ type: "post", post: post("131", "DRYBELL") });
  await settle();
  await dry.msg({ type: "deploy", id: dry.env.store.feed[0].id });
  await settle(50);
  assert.deepEqual(bells(dry.env).map((m) => m.kind), ["dry"]);

  const off = await boot(baseSettings({ mode: "manual", soundEnabled: false }));
  off.msg({ type: "post", post: post("132", "QUIETCOIN") });
  await settle();
  await off.msg({ type: "deploy", id: off.env.store.feed[0].id });
  await settle(50);
  assert.equal(bells(off.env).length, 0);
  const tst = await off.msg({ type: "testSound" });
  assert.equal(tst.data, true);
  assert.equal(bells(off.env).length, 1, "Test sound plays even when bells are off");
});

await t("naming cleanup: no 'Token' tacked on, cut-off tickers completed, real names kept", async () => {
  const { tidyNaming } = await import("../src/lib/naming.js");
  const iran = { text: "The U.S. is offering $20 MILLION to anyone who can help expose Iran's nuclear program" };
  assert.deepEqual(tidyNaming("Nuclear Leak Token", "NUCLEA", iran), { name: "Nuclear Leak", ticker: "NUCLEAR" });
  assert.deepEqual(tidyNaming("Nuclear", "NUCLEA", iran), { name: "Nuclear", ticker: "NUCLEAR" });
  assert.deepEqual(tidyNaming("Grok Coin", "GROKCOIN", { text: "Grok 5 is coming" }), { name: "Grok", ticker: "GROK" });
  assert.deepEqual(tidyNaming("Doge Coin", "DOGECOIN", { text: "doge coin to the moon" }), { name: "Doge Coin", ticker: "DOGECOIN" }, "keeps it when the post says it");
  assert.deepEqual(tidyNaming("Pepe", "PEP", { text: "pepe is back" }), { name: "Pepe", ticker: "PEPE" });
  assert.deepEqual(tidyNaming("Kekius Maximus", "KEKIUS", { text: "Kekius Maximus" }), { name: "Kekius Maximus", ticker: "KEKIUS" });
});

await t("AI picks the image: tweet screenshot for news, AI mascot for a character, post photo when it has one", async () => {
  const run = async (reply, extraPost = {}) => {
    net.aiReply = reply; net.cfCalls = 0;
    const { env, msg } = await boot(aiSettings({ dryRun: false, pinataJwt: "jwt-test", aiModel: "llama-3.3-70b-versatile", imageAiProvider: "cloudflare", imageAiWhen: "no-post-image", cfAccountId: "acc", cfToken: "cf-token" }), secretB58);
    net.aiBehavior = { "llama-3.3-70b-versatile": "ok" };
    msg({ type: "post", post: post(String(Math.random()).slice(2, 8), "some post", extraPost) });
    await settle(300);
    const c = env.store.feed[0];
    const r = await msg({ type: "deploy", id: c.id });
    assert.ok(r.ok, r.error);
    return { kind: env.store.feed[0].imageKind, cf: net.cfCalls, card: env.store.feed[0] };
  };
  let r = await run({ name: "Nuclear", ticker: "NUCLEAR", image: "tweet", score: 7 });
  assert.equal(r.kind, "tweet"); assert.equal(r.cf, 0, "no AI image for news");
  r = await run({ name: "Floki", ticker: "FLOKI", image: "ai", image_prompt: "a viking dog", score: 8 });
  assert.equal(r.kind, "ai"); assert.equal(r.cf, 1); assert.equal(r.card.aiImageKind, "ai");
  r = await run({ name: "Floki", ticker: "FLOKI", image: "post", score: 8 }, { images: ["https://pbs.twimg.com/media/dog.jpg"] });
  assert.equal(r.kind, "post"); assert.equal(r.cf, 0);
  r = await run({ name: "Floki", ticker: "FLOKI", image: "ai", score: 8 }, { images: ["https://pbs.twimg.com/media/dog.jpg"] });
  assert.equal(r.kind, "post", "'no-post-image' setting still wins over the AI");
  net.aiReply = null; net.aiBehavior = {};
});

await t("saved previous default prompt is upgraded to the memecoin-savvy one", async () => {
  const { OLD_PROMPTS, DEFAULT_PROMPT } = await import("../src/lib/settings.js");
  assert.ok(OLD_PROMPTS.length >= 2);
  const { env } = await boot(baseSettings({ aiPrompt: OLD_PROMPTS[1] }));
  assert.equal(env.store.settings.aiPrompt, DEFAULT_PROMPT);
  assert.match(DEFAULT_PROMPT, /NUCLEAR, not NUCLEA/);
});

await t("creator rewards: reads both vaults, claims all at once, records it, plays sound", async () => {
  const { creatorVaults } = await import("../src/lib/deploy.js");
  net.vaults = creatorVaults(kp.publicKey.toBase58()); net.claimed = false;
  const { env, msg } = await boot(baseSettings({ mode: "manual", dryRun: false }), secretB58);
  const r = await msg({ type: "rewards" });
  assert.ok(r.ok, r.error);
  assert.equal(+r.data.unclaimed.toFixed(6), 0.04, "0.03 bonding curve + 0.01 PumpSwap");
  const c = await msg({ type: "claimRewards" });
  assert.ok(c.ok, c.error);
  assert.equal(net.lastClaim.publicKey, kp.publicKey.toBase58());
  const rw = env.store.rewards;
  assert.equal(rw.history.length, 1);
  assert.equal(+rw.history[0].sol.toFixed(6), 0.04);
  assert.equal(+rw.claimedTotal.toFixed(6), 0.04);
  await settle(100);
  assert.ok(env.chrome.runtime.sent.some((m) => m.type === "playBell"));
  assert.equal(env.store.rewards.unclaimed, 0, "re-read after claim");
  net.claimed = false;
});

await t("creator rewards: dry run only simulates; auto-claim waits for the minimum", async () => {
  net.claimed = false;
  const dry = await boot(baseSettings({ mode: "manual", dryRun: true }), secretB58);
  const sent = net.sent.length;
  const c = await dry.msg({ type: "claimRewards" });
  assert.ok(c.ok, c.error);
  assert.equal(net.sent.length, sent);
  assert.equal(dry.env.store.rewards.dryClaimOk, true);

  const fire = (env) => Promise.all(env.listeners.alarm.map((f) => f({ name: "axiom-watchdog" })));
  const hi = await boot(baseSettings({ mode: "manual", dryRun: false, keepAxiomOpen: false, autoClaimRewards: true, autoClaimMinSol: 0.1 }), secretB58);
  await fire(hi.env); await settle(300);
  assert.equal(hi.env.store.rewards.history, undefined, "0.04 < 0.1 minimum: no claim");
  const lo = await boot(baseSettings({ mode: "manual", dryRun: false, keepAxiomOpen: false, autoClaimRewards: true, autoClaimMinSol: 0.02 }), secretB58);
  await fire(lo.env); await settle(400);
  assert.equal(lo.env.store.rewards.history?.[0]?.mode, "auto");
  net.claimed = false;
});

await t("image 'no good picture': post photo > famous face > AI image (news outlets get AI)", async () => {
  const { autoImageKind } = await import("../src/lib/image.js");
  const s = { imageAiProvider: "cloudflare", imageAiWhen: "no-good-image", imageLetAiChoose: true };
  const elon = { handle: "elonmusk", avatar: "https://pbs.twimg.com/profile_images/1/e_normal.jpg" };
  assert.equal(autoImageKind({ ...elon, images: ["https://pbs.twimg.com/media/x.jpg"] }, s), "post");
  assert.equal(autoImageKind({ ...elon, images: [] }, s), "avatar", "famous person without AI judgement");
  assert.equal(autoImageKind({ handle: "DailyMail", avatar: "https://pbs.twimg.com/profile_images/2/dm.jpg", images: [] }, s), "ai");
  assert.equal(autoImageKind({ handle: "someguy", avatar: "x", avatarOk: true, images: [] }, s), "avatar", "AI judged famous");
  assert.equal(autoImageKind({ ...elon, avatarOk: false, images: [], aiImageKind: "tweet" }, s), "ai", "AI judgement wins, rule beats the tweet pick");
  assert.equal(autoImageKind({ handle: "nypost", images: [] }, { ...s, imageAiProvider: "off" }), "tweet", "no generator: screenshot");
});

const pulseRows = [
  { address: "a1", name: "Dickcoin", ticker: "DICKCOIN", table: "migrated", mc: "420K" },
  { address: "a2", name: "Asscoin", ticker: "ASSCOIN", table: "finalStretch", mc: "61.2K" },
  { address: "a3", name: "titcoin", ticker: "titcoin", table: "newPairs", mc: "4.1K" },
  { address: "a4", name: "Fat Shane", ticker: "SHANE", table: "migrated", mc: "49.4K" },
  { address: "a5", name: "Fat Duve", ticker: "Duve", table: "newPairs", mc: "5.31K" },
  { address: "a6", name: "Fat Elon", ticker: "FATELON", table: "newPairs", mc: "3K" },
  { address: "a7", name: "GTA6", ticker: "GTA6", table: "migrated", mc: "123K" },
  { address: "a8", name: "kfc", ticker: "kfc", table: "newPairs", mc: "1.12K" },
];

await t("meta: hot coins, spreading patterns ('___coin', 'fat ___') and coins with the post's words", async () => {
  const { mergePulse, buildMeta, parseMc } = await import("../src/lib/meta.js");
  assert.equal(parseMc("61.2K"), 61200);
  assert.equal(parseMc("1.5M"), 1500000);
  const now = Date.now();
  let store = mergePulse({}, pulseRows, now);
  store = mergePulse(store, [{ address: "a2", name: "Asscoin", ticker: "ASSCOIN", table: "migrated", mc: "40K" }], now + 1000);
  assert.equal(store.a2.maxMc, 61200, "remembers the peak");
  assert.equal(store.a2.best, "migrated");
  const m = buildMeta(store, now + 2000, { postText: "Elon just tweeted about pussy lol" });
  assert.equal(m.hot[0].name, "Dickcoin");
  const shapes = m.patterns.map((p) => p.shape);
  assert.ok(shapes.includes("___coin"), shapes.join(","));
  assert.ok(shapes.includes("fat ___"), shapes.join(","));
  assert.ok(m.suffixes.includes("coin"));
  assert.ok(m.related.some((t) => t.name === "Fat Elon"), "post mentions Elon");
  assert.match(m.text, /Running hot: Dickcoin \(\$DICKCOIN, \$420K, migrated\)/);
  // old coins drop out of the window
  const later = mergePulse(store, [], now + 4 * 3600e3, 180);
  assert.equal(Object.keys(later).length, 0);
});

await t("meta in the pipeline: Pulse rows stored, AI gets the meta, Pussycoin keeps its 'coin', lowercase kept", async () => {
  net.aiBodies = []; net.aiModels = [];
  net.aiBehavior = { "llama-3.3-70b-versatile": "ok" };
  net.aiReply = { name: "Pussycoin", ticker: "PUSSYCOIN", image: "tweet", score: 9, reason: "meta: ___coin" };
  const { env, msg } = await boot(aiSettings({ aiModel: "llama-3.3-70b-versatile", aiMeta: true }));
  await msg({ type: "pulse", rows: pulseRows });
  await settle(100);
  assert.equal(Object.keys(env.store.metaTokens).length, 8);
  msg({ type: "post", post: post("140", "pussy") });
  await settle(400);
  const userMsg = net.aiBodies.at(-1).messages[1].content;
  assert.match(userMsg, /Current pump.fun meta/);
  assert.match(userMsg, /"___coin"/);
  const c = env.store.feed[0];
  assert.equal(c.name, "Pussycoin", "meta suffix must not be stripped");
  assert.equal(c.ticker, "PUSSYCOIN");
  // lowercase meta ticker kept
  net.aiReply = { name: "kfc", ticker: "kfc", image: "tweet", score: 6 };
  msg({ type: "post", post: post("141", "KFC is giving away free chicken") });
  await settle(400);
  assert.equal(env.store.feed[0].ticker, "kfc");
  // meta off: nothing extra sent
  net.aiReply = { name: "Pussy Coin", ticker: "PUSSYCOIN", image: "tweet", score: 9 };
  const off = await boot(aiSettings({ aiModel: "llama-3.3-70b-versatile", aiMeta: false }));
  await off.msg({ type: "pulse", rows: pulseRows });
  await settle(100);
  off.msg({ type: "post", post: post("142", "pussy") });
  await settle(400);
  assert.doesNotMatch(net.aiBodies.at(-1).messages[1].content, /meta/i);
  assert.equal(off.env.store.feed[0].name, "Pussy", "without a ___coin meta, a tacked-on ' Coin' is stripped");
  assert.equal(off.env.store.feed[0].ticker, "PUSSY");
  net.aiReply = null; net.aiBehavior = {};
});

await t("named animals: detected in many phrasings, not fooled by 'bear market' or 'K9 unit'", async () => {
  const { findNamedAnimal: f } = await import("../src/lib/naming.js");
  const n = (t) => { const r = f(t); return r && `${r.fullName}|${r.name}`; };
  assert.equal(n("K9 Neo has the coastline locked down."), "K9 Neo|Neo");
  assert.equal(n("Shoutout to Officer Smith and K-9 Rex for the arrest"), "K-9 Rex|Rex");
  assert.equal(n("Moo Deng the baby hippo is back"), "Moo Deng|Moo Deng");
  assert.equal(n("Meet Pnut, the squirrel who lives with me"), "Pnut|Pnut");
  assert.equal(n("RIP Pnut the squirrel"), "Pnut|Pnut");
  assert.equal(n("Our dog Floki is the CEO now"), "Floki|Floki");
  assert.equal(n("This cat named Luna stole a fish"), "Luna|Luna");
  assert.equal(n("Introducing our new office pup, Waffles!"), "Waffles|Waffles");
  assert.equal(n("Say hi to Biscuit 🐶"), "Biscuit|Biscuit");
  for (const t of ["Bear market incoming", "The bull run is here", "K9 unit deployed at the border", "Hey Cat Daddy, nice move", "Elon Musk says AI will change everything", "The dog, which was found in a park", "BREAKING: DOG FOUND IN PARK"]) {
    assert.equal(f(t), null, t);
  }
});

await t("named animal: AI says 'K9' score 4 during cooldown -> still launches as K9 Neo / $NEO", async () => {
  net.aiBehavior = { "llama-3.3-70b-versatile": "ok" };
  net.aiReply = { name: "K9", ticker: "K9", image: "tweet", score: 4, reason: "meh" };
  const { env, msg } = await boot(aiSettings({ mode: "auto", aiModel: "llama-3.3-70b-versatile", autoCooldownSec: 300, autoMaxPerHour: 5 }));
  env.store.deploys = [{ id: "old", mode: "auto", dryRun: true, ok: true, time: Date.now() - 10_000, ticker: "OLD", name: "Old" }];
  msg({ type: "post", post: post("150", "K9 Neo has the coastline locked down.", { handle: "elonmusk", tweetType: "RETWEET" }) });
  await settle(600);
  const c = env.store.feed.find((x) => x.id.endsWith(":150"));
  assert.equal(c.name, "K9 Neo");
  assert.equal(c.ticker, "NEO");
  assert.equal(c.score, 8);
  assert.equal(c.namedAnimal.name, "Neo");
  assert.match(c.nameFixed, /AI said K9/);
  assert.equal(c.aiImageKind, "ai");
  assert.equal(c.status, "dry-ok", c.autoSkip || c.error);
  // a normal post right after is still held by the cooldown
  net.aiReply = { name: "Rates", ticker: "RATES", image: "tweet", score: 9 };
  msg({ type: "post", post: post("151", "Fed cuts rates again") });
  await settle(600);
  assert.match(env.store.feed.find((x) => x.id.endsWith(":151")).autoSkip, /Cooldown/);
  net.aiReply = null; net.aiBehavior = {};
});

await t("named animal: 'never' keywords and the rule switch are respected", async () => {
  net.aiBehavior = { "llama-3.3-70b-versatile": "ok" };
  net.aiReply = { name: "Pnut", ticker: "PNUT", image: "ai", score: 9 };
  const ex = await boot(aiSettings({ mode: "auto", aiModel: "llama-3.3-70b-versatile" }));
  ex.msg({ type: "post", post: post("160", "RIP Pnut the squirrel") });
  await settle(500);
  assert.match(ex.env.store.feed[0].autoSkip, /Excluded keyword "rip"/);
  net.aiReply = { name: "K9", ticker: "K9", image: "tweet", score: 4 };
  const off = await boot(aiSettings({ mode: "auto", aiModel: "llama-3.3-70b-versatile", namedAnimals: false }));
  off.msg({ type: "post", post: post("161", "K9 Neo has the coastline locked down.") });
  await settle(500);
  assert.equal(off.env.store.feed[0].name, "K9");
  assert.match(off.env.store.feed[0].autoSkip, /AI score 4 < 6/);
  net.aiReply = null; net.aiBehavior = {};
});

await t("video post: K9 Neo video -> frames grabbed, AI picks the frame with the dog, launched with it", async () => {
  const px = "data:image/jpeg;base64," + Buffer.from([255, 216, 255, 224, 0, 16]).toString("base64");
  net.videoFramesReply = { ok: true, duration: 6, frames: [
    { t: 0.6, score: 0, dataUrl: px }, { t: 1.6, score: 27 }, { t: 2.6, score: 28 }, { t: 3.6, score: 26 }, { t: 4.6, score: 30 }, { t: 5.6, score: 25 },
  ].map((f) => ({ ...f, dataUrl: px })) };
  net.aiBehavior = { "llama-3.3-70b-versatile": "ok" };
  net.aiReply = { name: "K9", ticker: "K9", image: "tweet", score: 4 };
  net.visionCalls = 0; net.visionAnswer = "2";
  const { env, msg } = await boot(aiSettings({ dryRun: false, pinataJwt: "jwt-test", aiModel: "llama-3.3-70b-versatile", imageAiProvider: "cloudflare", cfAccountId: "a", cfToken: "cf-token" }), secretB58);
  msg({ type: "post", post: post("170", "K9 Neo has the coastline locked down.", { videos: ["https://video.twimg.com/ext_tw_video/1/pu/vid/avc1/720x1280/a.mp4"] }) });
  await settle(400);
  const c0 = env.store.feed[0];
  assert.equal(c0.aiImageKind, "post", "named animal with a video uses the video");
  net.cfCalls = 0;
  const r = await msg({ type: "deploy", id: c0.id });
  assert.ok(r.ok, r.error);
  const c = env.store.feed[0];
  assert.equal(c.name, "K9 Neo");
  assert.equal(c.imageKind, "video");
  assert.equal(c.videoFramePick, "AI pick");
  assert.equal(c.videoFrameAt, 2.6, "frame #2 of the usable ones (black first frame dropped)");
  assert.equal(net.visionCalls, 1);
  assert.equal(net.visionModel, "meta-llama/llama-4-scout-17b-16e-instruct");
  assert.equal(net.cfCalls, 0, "no AI-generated image when the video has the animal");
  assert.ok(env.chrome.runtime.sent.some((m) => m.type === "videoFrames" && /video\.twimg\.com/.test(m.url)));
  net.aiReply = null; net.aiBehavior = {};
});

await t("video post without AI: sharpest frame is used; failure falls back to the screenshot", async () => {
  const px = "data:image/jpeg;base64," + Buffer.from([255, 216, 255, 224]).toString("base64");
  net.videoFramesReply = { ok: true, frames: [{ t: 1, score: 5, dataUrl: px }, { t: 2, score: 40, dataUrl: px }, { t: 3, score: 9, dataUrl: px }] };
  const { env, msg } = await boot(baseSettings({ mode: "manual", dryRun: false, pinataJwt: "jwt-test" }), secretB58);
  msg({ type: "post", post: post("171", "Look at this", { videos: ["https://video.twimg.com/x.mp4"] }) });
  await settle();
  let r = await msg({ type: "deploy", id: env.store.feed[0].id });
  assert.ok(r.ok, r.error);
  assert.equal(env.store.feed[0].videoFrameAt, 2);
  assert.equal(env.store.feed[0].videoFramePick, "sharpest frame");
  net.videoFramesReply = { ok: false, error: "video could not be decoded" };
  msg({ type: "post", post: post("172", "Another one", { videos: ["https://video.twimg.com/y.mp4"] }) });
  await settle();
  r = await msg({ type: "deploy", id: env.store.feed[0].id });
  assert.ok(r.ok, r.error);
  assert.equal(env.store.feed[0].imageKind, "tweet");
});

await t("test setup reports", async () => {
  const { msg } = await boot(baseSettings({ pinataJwt: "jwt-test" }), secretB58);
  const r = await msg({ type: "test" });
  assert.ok(r.ok);
  const labels = r.data.map((x) => `${x.label}:${x.ok}`);
  assert.ok(labels.includes("Wallet:true") && labels.includes("RPC:true") && labels.includes("Create tx (test):true"), labels.join(", "));
});


await t("test mode: a test launch becomes a simulated coin in Launched (tokens, cost, picture); test Sell all needs no chain", async () => {
  const sentBefore = net.sent.length;
  const { env, msg } = await boot(baseSettings({ mode: "manual", devBuySol: 0.01, priorityFee: 0.00005 }), secretB58);
  msg({ type: "post", post: post("400", "MOONCAT has landed") });
  await settle();
  const r = await msg({ type: "deploy", id: env.store.feed[0].id });
  assert.ok(r.ok, r.error);
  const d = env.store.deploys[0];
  assert.equal(d.simulated, true);
  assert.equal(d.dryRun, true);
  assert.equal(d.chainCheck, "passed");
  assert.equal(d.mint, r.data.mint);
  assert.ok(d.holding > 340000 && d.holding < 360000, `tokens ${d.holding}`); // 0.01 SOL on a fresh curve ≈ 350K
  assert.ok(Math.abs(d.spentSol - (0.01 + 0.00005 + 0.00001 + 0.025)) < 1e-6, `cost ${d.spentSol}`);
  assert.match(d.image || "", /^data:image\/jpeg;base64,/);
  const s = await msg({ type: "sell", id: d.id });
  assert.ok(s.ok, s.error);
  const after = env.store.deploys[0];
  assert.equal(after.sold, true);
  assert.equal(after.holding, 0);
  assert.ok(after.receivedSol > 0.0095 && after.receivedSol < 0.012, `back ${after.receivedSol}`); // dev buy minus fees, plus rent back
  assert.equal(net.sent.length, sentBefore, "nothing sent on-chain");
  const again = await msg({ type: "sell", id: d.id });
  assert.equal(again.ok, false);
});

await t("test mode works with no wallet and with an empty wallet (shown as 'needs SOL', not as a failure)", async () => {
  let { env, msg } = await boot(baseSettings({ mode: "manual" }));
  msg({ type: "post", post: post("401", "Grok Jr is born") });
  await settle();
  let r = await msg({ type: "deploy", id: env.store.feed[0].id });
  assert.ok(r.ok, r.error);
  assert.equal(env.store.deploys[0].simulated, true);
  assert.equal(env.store.deploys[0].chainCheck, "skipped");
  assert.ok(env.store.deploys[0].mint);
  ({ env, msg } = await boot(baseSettings({ mode: "manual" }), secretB58));
  net.simErr = "AccountNotFound";
  msg({ type: "post", post: post("402", "PEPE2 incoming") });
  await settle();
  r = await msg({ type: "deploy", id: env.store.feed[0].id });
  net.simErr = null;
  assert.ok(r.ok, r.error);
  assert.equal(env.store.feed[0].status, "dry-ok");
  assert.equal(env.store.deploys[0].chainCheck, "needs-funds");
  assert.equal(env.store.deploys[0].ok, true);
  // RPC not set up yet (public RPC blocks extensions): still a test coin, with the reason
  ({ env, msg } = await boot(baseSettings({ mode: "manual", rpcUrl: "https://blocked.rpc/x" }), secretB58));
  msg({ type: "post", post: post("403", "WIFHAT returns") });
  await settle();
  r = await msg({ type: "deploy", id: env.store.feed[0].id });
  assert.ok(r.ok, r.error);
  assert.equal(env.store.deploys[0].simulated, true);
  assert.equal(env.store.deploys[0].chainCheck, "unavailable");
  assert.match(env.store.deploys[0].checkError, /RPC blocked/);
});

await t("burner wallet: create, reveal/export, replacing keeps the old key, switch back, backup carries both", async () => {
  const { env, msg } = await boot(baseSettings({ mode: "manual" }), secretB58);
  const first = kp.publicKey.toBase58();
  const c = await msg({ type: "createWallet" });
  assert.ok(c.ok, c.error);
  assert.notEqual(c.data, first);
  const rv = await msg({ type: "revealWallet" });
  assert.equal(rv.data.pub, c.data);
  assert.equal(Keypair.fromSecretKey(bs58.decode(rv.data.secret)).publicKey.toBase58(), c.data, "base58 key opens the same wallet");
  assert.equal(JSON.parse(rv.data.array).length, 64);
  let arch = (await msg({ type: "walletArchive" })).data;
  assert.deepEqual(arch.map((w) => w.pub), [first]);
  assert.equal(arch[0].secret, undefined, "the list never carries keys");
  const old = await msg({ type: "revealWallet", pub: first });
  assert.equal(old.data.secret, secretB58);
  await msg({ type: "setWallet", secret: "" }); // remove: still archived
  arch = (await msg({ type: "walletArchive" })).data;
  assert.deepEqual(arch.map((w) => w.pub).sort(), [first, c.data].sort());
  const back = await msg({ type: "useArchivedWallet", pub: first });
  assert.equal(back.data, first);
  assert.equal((await msg({ type: "walletPub" })).data, first);
  assert.deepEqual((await msg({ type: "walletArchive" })).data.map((w) => w.pub), [c.data]);
  const file = (await msg({ type: "exportBackup", password: "pw" })).data;
  const fresh = await boot(undefined);
  const imp = await fresh.msg({ type: "importBackup", file: JSON.stringify(file), password: "pw" });
  assert.ok(imp.ok, imp.error);
  assert.equal(imp.data.wallet, first);
  assert.deepEqual((await fresh.msg({ type: "walletArchive" })).data.map((w) => w.pub), [c.data]);
});

await t("cheap sell: lowest priority fee, resent once with 10x if not confirmed, empty token account closed for rent", async () => {
  net.sold = false; net.closed = false; net.closeTx = null; net.lastSell = null;
  const { env, msg } = await boot(baseSettings({ mode: "manual", dryRun: false, sellConfirmMs: 200 }), secretB58);
  env.store.deploys = [{ id: "c1", ok: true, dryRun: false, mint: Keypair.generate().publicKey.toBase58(), signature: "sig", ticker: "CHEAP", time: Date.now() }];
  const fees = [];
  const origSell = net.lastSell;
  net.dropFirstSell = true;
  net.sellPending = true;
  const before = net.sent.length;
  const s = await msg({ type: "sell", id: "c1" });
  assert.ok(s.ok, s.error);
  const sells = net.calls.filter((u) => u === "https://pumpportal.fun/api/trade-local");
  assert.ok(sells.length >= 2);
  assert.equal(net.lastSell.priorityFee, 0.00001, "second try uses 10x the tiny fee");
  assert.equal(net.sent.length - before, 3, "sell, resend, close account");
  assert.ok(net.closeTx, "close-account tx sent");
  const ix = net.closeTx.message.compiledInstructions[0];
  assert.deepEqual([...ix.data], [9]);
  const d = env.store.deploys[0];
  assert.equal(d.sold, true);
  assert.equal(d.sellRetried, true);
  assert.equal(d.rentBack, true);
  net.sold = false; net.closed = false;
});

await t("cheap sell: first try uses the tiny fee", async () => {
  net.sold = false; net.closed = false; net.lastSell = null;
  const { env, msg } = await boot(baseSettings({ mode: "manual", dryRun: false }), secretB58);
  env.store.deploys = [{ id: "c2", ok: true, dryRun: false, mint: Keypair.generate().publicKey.toBase58(), signature: "sig", ticker: "CHEAP", time: Date.now() }];
  net.sellPending = true;
  const s = await msg({ type: "sell", id: "c2" });
  assert.ok(s.ok, s.error);
  assert.equal(net.lastSell.priorityFee, 0.000001);
  assert.equal(net.lastSell.slippage, 15);
  assert.equal(env.store.deploys[0].sellRetried, false);
  net.sold = false; net.closed = false;
});

await t("own AI: Anthropic format (x-api-key, system prompt) and any OpenAI-compatible API with extra headers, no costly model hopping", async () => {
  let { env, msg } = await boot(baseSettings({ mode: "manual", aiEnabled: true, aiProvider: "anthropic", aiFormat: "anthropic", aiUrl: "https://api.anthropic.com/v1/messages", aiKey: "sk-ant-x", aiModel: "claude-haiku-5-5", aiPrompt: "PROMPT" }));
  msg({ type: "post", post: post("500", "doge is back") });
  await settle();
  assert.equal(env.store.feed[0].ticker, "CDOGE");
  assert.equal(net.anthropic.headers["x-api-key"], "sk-ant-x");
  assert.equal(net.anthropic.headers["anthropic-version"], "2023-06-01");
  assert.equal(net.anthropic.body.system, "PROMPT");
  assert.equal(net.anthropic.body.messages[0].role, "user");
  ({ env, msg } = await boot(baseSettings({ mode: "manual", aiEnabled: true, aiProvider: "custom", aiFormat: "openai", aiUrl: "https://my-ai.example/v1/chat/completions", aiKey: "", aiHeaders: "api-key: abc123\nX-Org: me", aiModel: "my-model", aiPrompt: "P" })));
  msg({ type: "post", post: post("501", "mars dog") });
  await settle();
  assert.equal(env.store.feed[0].ticker, "MARSDOG");
  assert.equal(net.custom.headers["api-key"], "abc123");
  assert.equal(net.custom.headers["X-Org"], "me");
  assert.equal(net.custom.headers.Authorization, undefined, "no empty bearer for keyless APIs");
  assert.equal(net.custom.body.model, "my-model");
  net.customFail = true; net.customListed = false;
  const tr = await msg({ type: "testAi", patch: {} });
  net.customFail = false;
  assert.equal(tr.ok, false);
  assert.match(tr.error, /401/);
  assert.equal(net.customListed, false, "a paid/custom API never hops to other models");
  const ok = await msg({ type: "testAi", patch: {} });
  assert.equal(ok.data.ticker, "MARSDOG");
});

await t("settings saved before v3.1 get the right AI provider", async () => {
  const { env } = await boot({ aiUrl: "https://generativelanguage.googleapis.com/v1beta/openai/chat/completions", mode: "manual" });
  assert.equal(env.store.settings.aiProvider, "gemini");
  assert.equal(env.store.settings.mode, "manual", "an existing choice of mode is kept");
});

await t("translations: every UI string has Dutch, German and Spanish", async () => {
  const { keys } = await import("../tools/i18n-keys.mjs");
  for (const lang of ["nl", "de", "es"]) {
    const dict = (await import(`../src/i18n/${lang}.js`)).default;
    const missing = keys.filter((k) => !dict[k]);
    assert.equal(missing.length, 0, `${lang} missing ${missing.length}:\n${missing.slice(0, 40).join("\n")}`);
    for (const [k, v] of Object.entries(dict)) {
      const ph = (s) => (s.match(/\{\w+\}/g) || []).sort().join();
      assert.equal(ph(v), ph(k), `${lang}: placeholders differ in "${k}"`);
    }
  }
});

await t("pump.fun live stream: one connection, new launches + graduations feed the meta, closes when meta is off", async () => {
  class FakeWS {
    static all = [];
    constructor(url) { this.url = url; this.sent = []; this.readyState = 0; FakeWS.all.push(this); setTimeout(() => { this.readyState = 1; this.onopen && this.onopen(); }, 5); }
    send(m) { this.sent.push(JSON.parse(m)); }
    close() { this.readyState = 3; this.closed = true; this.onclose && this.onclose(); }
    emit(o) { this.onmessage && this.onmessage({ data: JSON.stringify(o) }); }
  }
  const { env, msg } = await boot(baseSettings({ mode: "manual", aiEnabled: true, aiMeta: true, aiKey: "gsk", pumpFlushMs: 30 }), null, { WebSocket: FakeWS });
  await settle(30);
  assert.equal(FakeWS.all.length, 1);
  const ws = FakeWS.all[0];
  assert.equal(ws.url, "wss://pumpportal.fun/api/data");
  assert.deepEqual(ws.sent.map((x) => x.method), ["subscribeNewToken", "subscribeMigration"]);
  ws.emit({ message: "Successfully subscribed to token creation events." });
  for (const [mint, name, symbol] of [["M1", "Fat Pepe", "FPEPE"], ["M2", "Fat Doge", "FDOGE"], ["M3", "Fat Cat", "FCAT"], ["M4", "Moon Frog", "FROG"]]) {
    ws.emit({ signature: "s", mint, txType: "create", name, symbol, marketCapSol: 28, pool: "pump" });
  }
  ws.emit({ signature: "s2", mint: "M2", txType: "migrate", pool: "pump-amm" });
  await settle(120);
  const tok = env.store.metaTokens;
  assert.ok(tok.M1 && tok.M3 && tok.M4);
  assert.equal(tok.M2.best, "migrated");
  assert.equal(env.store.pumpStatus.seen, 4);
  const m = (await msg({ type: "metaPreview", text: "fat" })).data;
  assert.match(m.text, /Running hot: Fat Doge \(\$FDOGE, migrated\)/);
  assert.match(m.text, /"fat ___" \(3 coins, 1 hot\)/);
  for (const l of env.listeners.alarm) l({ name: "axiom-watchdog" });
  await settle(30);
  assert.equal(FakeWS.all.length, 1, "never a second connection");
  await msg({ type: "saveSettings", patch: { aiMeta: false } });
  await settle(30);
  assert.equal(ws.closed, true, "stops when the meta isn't used");
  assert.equal(FakeWS.all.length, 1);
});

await t("open coins in your trading site: GMGN after a live launch; links for every platform", async () => {
  const { PLATFORMS, coinUrl } = await import("../src/lib/platforms.js");
  const mint = "So1anaMint1111111111111111111111111111111pump";
  assert.equal(coinUrl("gmgn", mint), `https://gmgn.ai/sol/token/${mint}`);
  assert.equal(coinUrl("pumpfun", mint), `https://pump.fun/coin/${mint}`);
  assert.equal(coinUrl("nope", mint), `https://axiom.trade/token/${mint}?chain=sol`);
  for (const p of Object.values(PLATFORMS)) assert.match(p.url(mint), new RegExp(`^https://[^ ]+${mint}`));
  const { env, msg } = await boot(baseSettings({ mode: "manual", dryRun: false, pinataJwt: "jwt-test", openAxiomAfterLaunch: true, openIn: "gmgn" }), secretB58);
  msg({ type: "post", post: post("600", "GMGNDOG is here") });
  await settle();
  const r = await msg({ type: "deploy", id: env.store.feed[0].id });
  assert.ok(r.ok, r.error);
  await settle(50);
  assert.equal(env.chrome.tabs.created.at(-1).url, `https://gmgn.ai/sol/token/${r.data.mint}`);
});

await t("store listing name comes from the manifest", async () => {
  const man = JSON.parse(readFileSync(new URL("../src/manifest.json", import.meta.url), "utf8"));
  assert.ok(man.name.length <= 75 && man.name.startsWith("Hatchr"));
  assert.equal(man.short_name, "Hatchr");
  assert.ok(man.description.length <= 132, `description ${man.description.length} chars`);
});

await t("always starts paused: install, update and every Chrome start; Start un-pauses", async () => {
  const fresh = await boot(undefined);
  assert.equal(fresh.env.store.settings.paused, true);
  const { env, msg } = await boot({ ...baseSettings(), paused: true });
  await msg({ type: "saveSettings", patch: { paused: false } });
  assert.equal(env.store.settings.paused, false);
  await Promise.all(env.listeners.startup.map((f) => f())); // Chrome restarts
  assert.equal(env.store.settings.paused, true);
  msg({ type: "post", post: post("700", "PAUSEDOG is here") });
  await settle();
  assert.equal(env.store.feed[0].status, "new", "no auto launch while paused");
  assert.equal(env.store.deploys?.length || 0, 0);
});

await t("vanity wallet: odds, bad characters, and a found key really opens that address", async () => {
  const { vanityTries, badChars, vanityMatch } = await import("../src/lib/vanity.js");
  assert.equal(Math.round(vanityTries("ab", "", true)), 58 * 58);
  assert.equal(Math.round(vanityTries("x", "", false)), 29); // x and X
  assert.equal(Math.round(vanityTries("o", "", false)), 58); // only lowercase o exists
  assert.deepEqual(badChars("PEPE0lI"), ["0", "l", "I"]);
  assert.ok(vanityMatch("PePe123xyz", "pepe", "XYZ", false));
  assert.ok(!vanityMatch("PePe123xyz", "pepe", "", true));
  const { tryBatch } = await import("../src/vanity-worker.js");
  let hit = null;
  for (let i = 0; i < 40 && !hit; i++) hit = tryBatch(500, "", "z", false);
  assert.ok(hit, "a 1-letter suffix is found quickly");
  assert.match(hit.pub, /z$/i);
  const kp2 = Keypair.fromSecretKey(bs58.decode(hit.secret));
  assert.equal(kp2.publicKey.toBase58(), hit.pub, "the secret key opens exactly that address");
  const { env, msg } = await boot(baseSettings({ mode: "manual" }), secretB58);
  const r = await msg({ type: "setWallet", secret: hit.secret });
  assert.equal(r.data, hit.pub);
  assert.deepEqual((await msg({ type: "walletArchive" })).data.map((w) => w.pub), [kp.publicKey.toBase58()], "old wallet kept");
});

await t("PnL: live vs test, this wallet vs all wallets, time range, creator rewards counted", async () => {
  const { computePnl } = await import("../src/lib/pnl.js");
  const now = Date.parse("2026-11-08T12:00:00Z"), H = 3600e3;
  const deploys = [
    { ok: true, time: now - H, wallet: "A", spentSol: 0.03, sold: true, receivedSol: 0.05, ticker: "WIN" },
    { ok: true, time: now - 2 * H, wallet: "A", spentSol: 0.03, holding: 1000, ticker: "HOLD" },
    { ok: true, time: now - 10 * 24 * H, wallet: "B", spentSol: 0.02, sold: true, receivedSol: 0.001, ticker: "OLD" },
    { ok: false, time: now - H, wallet: "A", spentSol: 0.5 },
    { ok: true, dryRun: true, simulated: true, time: now - H, spentSol: 0.025, sold: true, receivedSol: 0.011, ticker: "SIM" },
  ];
  const rewards = { wallet: "A", unclaimed: 0.004, history: [{ time: now - 3 * H, sol: 0.02, wallet: "A" }, { time: now - 20 * 24 * H, sol: 0.1, wallet: "B" }] };
  const a = computePnl({ deploys, rewards, wallet: "A", scope: "wallet", range: "all", now });
  assert.equal(a.launches, 2);
  assert.ok(Math.abs(a.pnl - (0.05 + 0.02 - 0.06)) < 1e-9, a.pnl);
  assert.equal(a.holding, 1);
  assert.equal(a.best.ticker, "WIN");
  assert.equal(a.unclaimed, 0.004);
  const all = computePnl({ deploys, rewards, wallet: "A", scope: "all", range: "all", now });
  assert.equal(all.launches, 3);
  assert.ok(Math.abs(all.pnl - (0.05 + 0.001 + 0.12 - 0.08)) < 1e-9, all.pnl);
  const week = computePnl({ deploys, rewards, wallet: "A", scope: "all", range: "week", now });
  assert.equal(week.launches, 2);
  assert.equal(week.rewards, 0.02);
  const test = computePnl({ deploys, rewards, wallet: "A", scope: "wallet", range: "all", test: true, now });
  assert.equal(test.launches, 1);
  assert.equal(test.rewards, 0);
  assert.ok(Math.abs(test.pnl - (0.011 - 0.025)) < 1e-9);
});

await t("launches remember their wallet; older ones get the current wallet once; SOL price is cached", async () => {
  const pub = kp.publicKey.toBase58();
  const { env, msg } = await (async () => {
    const e = makeEnv();
    return boot({ ...baseSettings({ mode: "manual" }) }, secretB58);
  })();
  msg({ type: "post", post: post("800", "WALLETCAT appears") });
  await settle();
  await msg({ type: "deploy", id: env.store.feed[0].id });
  assert.equal(env.store.deploys[0].wallet, pub);
  net.priceCalls = 0;
  const p1 = await msg({ type: "solPrice" });
  const p2 = await msg({ type: "solPrice" });
  assert.equal(p1.data.usd, 150);
  assert.equal(p2.data.eur, 138);
  assert.equal(net.priceCalls, 1, "second call uses the cache");
  // migration of older launches
  const old = await (async () => {
    const e2 = makeEnv();
    return e2;
  })();
  const b = await boot(baseSettings(), secretB58);
  b.env.store.deploys = [{ id: "o1", ok: true, time: 1, mint: "m" }, { id: "o2", ok: true, dryRun: true, time: 2 }];
  b.env.store.pnlMigrated = false;
  await Promise.all(b.env.listeners.startup.map((f) => f()));
  assert.equal(b.env.store.deploys[0].wallet, pub);
  assert.equal(b.env.store.deploys[1].wallet, undefined);
});

await t("vanity search runs in the background: progress, chime + notification when found, use it later; dead searches are marked", async () => {
  const notes = [];
  const { env, msg } = await boot(baseSettings({ mode: "manual", soundEnabled: true }), secretB58);
  env.chrome.notifications.create = (id, o) => notes.push({ id, ...o });
  const bad = await msg({ type: "vanityStart", prefix: "P0", suffix: "" });
  assert.equal(bad.ok, false);
  assert.match(bad.error, /Not possible/);
  const r = await msg({ type: "vanityStart", prefix: "ab", suffix: "", caseSensitive: false });
  assert.ok(r.ok, r.error);
  const id = r.data.id;
  assert.ok(env.chrome.runtime.sent.some((m) => m.target === "offscreen" && m.type === "vanityStart" && m.job.prefix === "ab"));
  assert.equal(env.store.vanityJob.status, "running");
  env.listeners.message[0]({ type: "vanityProgress", id, tried: 5000, ms: 1000 }, {}, () => {});
  await settle(30);
  assert.equal(env.store.vanityJob.tried, 5000);
  // the panel can be closed meanwhile; the offscreen page finds one
  const found = Keypair.generate();
  const pub = found.publicKey.toBase58();
  env.listeners.message[0]({ type: "vanityFound", id, tried: 7000, ms: 1500, pub, secret: bs58.encode(found.secretKey) }, {}, () => {});
  await settle(50);
  assert.equal(env.store.vanityJob.status, "found");
  assert.equal(env.store.vanityJob.seen, false);
  assert.ok(env.chrome.runtime.sent.some((m) => m.type === "playBell" && m.kind === "vanity"), "its own chime");
  assert.ok(notes.some((n) => /Vanity wallet found/.test(n.title)));
  assert.equal(env.store.walletSecret, secretB58, "your wallet isn't touched until you choose");
  const use = await msg({ type: "vanityUse" });
  assert.equal(use.data, pub);
  assert.equal(env.store.vanityResult, null);
  assert.deepEqual((await msg({ type: "walletArchive" })).data.map((w) => w.pub), [kp.publicKey.toBase58()]);
  // a search whose helper died (Chrome restarted) is marked as stopped
  const r2 = await msg({ type: "vanityStart", prefix: "zz" });
  env.store.vanityJob = { ...env.store.vanityJob, updatedAt: Date.now() - 60_000 };
  net.vanityRunning = false;
  for (const l of env.listeners.alarm) l({ name: "axiom-watchdog" });
  await settle(50);
  assert.equal(env.store.vanityJob.status, "stopped");
  assert.equal(env.store.vanityJob.error, "interrupted");
  assert.ok(r2.ok);
});

console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);

console.log("$HATCHR holder perks");
{
  const { tierFor, nextTier, hasPerk, normalizeConfig, loadTokenConfig, PERKS, TOKEN_DEFAULT, PREVIEW_BUILD } = await import("../src/lib/token.js");
  await t("tiers: nothing below Holder, Holder from 100K, Gold from 1M, progress to the next tier", () => {
    assert.equal(tierFor(99_999), null);
    assert.equal(tierFor(100_000).id, "holder");
    assert.equal(tierFor(5_000_000).id, "gold");
    assert.equal(nextTier(0).tier.id, "holder");
    const n = nextTier(550_000);
    assert.equal(n.tier.id, "gold"); assert.equal(n.missing, 450_000); assert.equal(n.progress, 0.5);
    assert.equal(nextTier(1_000_000), null);
  });
  await t("perks: Holder gets the Holder perks only, Gold gets everything, no tier gets nothing", () => {
    const by = (id) => PERKS.find((p) => p.id === id);
    assert.equal(hasPerk(by("badge"), null), false);
    assert.equal(hasPerk(by("badge"), tierFor(100_000)), true);
    assert.equal(hasPerk(by("card"), tierFor(100_000)), false);
    assert.ok(PERKS.every((p) => hasPerk(p, tierFor(1_000_000))));
  });
  await t("token file: only a well-formed address and sane tiers are used; anything else keeps the defaults", () => {
    assert.equal(normalizeConfig(null).mint, "");
    assert.equal(normalizeConfig({ mint: "<script>" }).mint, "");
    assert.equal(normalizeConfig({ mint: " 7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU " }).mint, "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU");
    assert.deepEqual(normalizeConfig({ tiers: [{ id: "holder", min: 50_000 }, { id: "gold", min: -1 }] }).tiers.map((x) => x.min), [50_000, 1_000_000]);
    assert.deepEqual(normalizeConfig({ tiers: [{ id: "holder", min: 9e9 }] }).tiers, TOKEN_DEFAULT.tiers); // Holder above Gold: ignored
  });
  await t("token file: fetched from hatchr.pro, cached, and a failed fetch falls back without throwing", async () => {
    const mem = {};
    const storage = { get: async (k) => ({ [k]: mem[k] }), set: async (o) => Object.assign(mem, o) };
    let calls = 0;
    const ok = async () => { calls++; return { ok: true, json: async () => ({ mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU" }) }; };
    const down = async () => { calls++; throw new Error("offline"); };
    assert.equal((await loadTokenConfig({ storage: { get: async () => ({}), set: async () => {} }, fetchImpl: down })).mint, "");
    assert.equal((await loadTokenConfig({ storage, fetchImpl: ok, now: 1000 })).mint.length, 44);
    assert.equal((await loadTokenConfig({ storage, fetchImpl: down, now: 2000 })).mint.length, 44); // from the cache, no fetch
    assert.equal(calls, 2);
    assert.equal((await loadTokenConfig({ storage, fetchImpl: down, now: 1000 + 7 * 3_600_000 })).mint.length, 44); // stale + offline: last good file
  });
  await t("launch day: before the address is published the file is re-read after a few minutes, and the address then switches on by itself", async () => {
    const MINT = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU";
    let saved = {}, calls = 0, file = { mint: "" };
    const storage = { get: async () => saved, set: async (o) => { saved = { ...saved, ...o }; } };
    const fetchImpl = async () => { calls++; return { ok: true, json: async () => file }; };
    assert.equal((await loadTokenConfig({ storage, fetchImpl, now: 0 })).mint, "");
    file = { mint: MINT }; // the address goes up on hatchr.pro
    assert.equal((await loadTokenConfig({ storage, fetchImpl, now: 60_000 })).mint, ""); // a minute later: still the cached answer
    assert.equal((await loadTokenConfig({ storage, fetchImpl, now: 5 * 60_000 })).mint, MINT); // five minutes later: picked up, nobody pressed Refresh
    assert.equal(calls, 2);
    await loadTokenConfig({ storage, fetchImpl, now: 60 * 60_000 }); // once launched, it's cached for hours again
    assert.equal(calls, 2);
  });
  await t("store build: the tier preview switch is off", () => assert.equal(PREVIEW_BUILD, false));
}
console.log("Audit fixes");
await t("settings: two saves at the same moment both land, so a Pause click is never lost", async () => {
  const { env, msg } = await boot(baseSettings({ paused: false }));
  await Promise.all([msg({ type: "saveSettings", patch: { aiModel: "m-1" } }), msg({ type: "saveSettings", patch: { paused: true } })]);
  assert.equal(env.store.settings.paused, true);
  assert.equal(env.store.settings.aiModel, "m-1");
  await Promise.all([msg({ type: "saveSettings", patch: { paused: false } }), msg({ type: "saveSettings", patch: { aiModel: "m-2" } }), msg({ type: "saveSettings", patch: { devBuySol: 0.02 } })]);
  assert.equal(env.store.settings.paused, false);
  assert.equal(env.store.settings.aiModel, "m-2");
  assert.equal(env.store.settings.devBuySol, 0.02);
});
await t("backup import: a crafted file can't start auto mode, set nonsense amounts or add unknown settings", async () => {
  const { msg } = await boot(baseSettings(), secretB58);
  const ex = await msg({ type: "exportBackup", password: "", includeHistory: false });
  const hostile = { ...ex.data, data: { ...ex.data.data, settings: { ...ex.data.data.settings, paused: false, dryRun: false, mode: "auto", autoMaxSolPerDay: -5, devBuySol: "lots", notifyDeploys: "yes", evilKey: "x", rpcUrl: "https://rpc.example" } } };
  const fresh = await boot(undefined);
  const r = await fresh.msg({ type: "importBackup", file: JSON.stringify(hostile) });
  assert.ok(r.ok, r.error);
  const s = fresh.env.store.settings, d = (await boot(undefined)).env.store.settings;
  assert.equal(s.paused, true, "auto mode always comes back paused");
  assert.equal(s.evilKey, undefined, "unknown settings are dropped");
  assert.equal(s.autoMaxSolPerDay, d.autoMaxSolPerDay, "a negative amount is ignored");
  assert.equal(s.devBuySol, d.devBuySol, "a non-number amount is ignored");
  assert.equal(s.notifyDeploys, d.notifyDeploys, "an on/off setting must be on or off");
  assert.equal(s.rpcUrl, "https://rpc.example", "ordinary settings still restore");
});
await t("launch: a post that is already a live coin can't be launched a second time", async () => {
  const { env, msg } = await boot(baseSettings({ mode: "manual" }));
  msg({ type: "post", post: post("77", "Grok rocks") });
  await settle();
  const id = env.store.feed[0].id;
  env.store.feed = env.store.feed.map((c) => ({ ...c, status: "launched" }));
  const before = (env.store.deploys || []).length;
  const r = await msg({ type: "deploy", id });
  assert.equal(r.ok, false);
  assert.match(r.error, /already launched/);
  assert.equal(env.store.feed[0].status, "launched", "the card keeps its state");
  assert.equal((env.store.deploys || []).length, before, "nothing is recorded or spent");
});
await t("manual post: a local file address in the picture field is ignored", async () => {
  const { env, msg } = await boot(baseSettings({ mode: "manual" }));
  await msg({ type: "manualPost", text: "Breaking: a cat named Whiskers became mayor", image: "file:///C:/Users/me/private.png" });
  await settle();
  assert.equal(env.store.feed.length, 1);
  assert.ok(!JSON.stringify(env.store.feed).includes("file:///"));
  await msg({ type: "manualPost", text: "Breaking: a dog named Biscuit became mayor", image: "https://example.com/dog.png" });
  await settle();
  assert.ok(JSON.stringify(env.store.feed).includes("https://example.com/dog.png"), "web pictures still work");
});
console.log("X page script");
{
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  // the real content-x.js, run against a stand-in page
  const runXScript = async () => {
    let tick = null;
    const state = { clicks: 0, window: { scrollY: 0 } };
    const pill = { closest: () => ({ click: () => state.clicks++ }) };
    vm.runInNewContext(readFileSync(new URL("../src/content-x.js", import.meta.url), "utf8"), {
      window: state.window, location: { pathname: "/home" }, Node: { TEXT_NODE: 3 }, Date, atob, setTimeout,
      document: { documentElement: { scrollTop: 0 }, querySelector: (s) => (s.includes("pillLabel") ? pill : null), querySelectorAll: () => [] },
      chrome: { runtime: { sendMessage: async () => null }, storage: { local: { get: async () => ({}), remove: async () => {} }, onChanged: { addListener() {} } } },
      MutationObserver: class { observe() {} disconnect() {} }, setInterval: (f) => { tick = f; return 1; }, clearInterval() {}, clearTimeout,
    });
    await new Promise((r) => setTimeout(r, 10));
    return { state, tick: () => tick() };
  };
  await t("X tab: 'Show new posts' is only clicked while the page is at the top, so reading further down is never thrown back up", async () => {
    const { state, tick } = await runXScript();
    state.window.scrollY = 2400; tick(); tick(); tick();
    assert.equal(state.clicks, 0, "scrolled down: nothing is clicked");
    state.window.scrollY = 0; tick();
    assert.equal(state.clicks, 1, "back at the top: new posts load again");
  });
}
console.log("Main switch (Hatchr off)");
{
  const { readFileSync } = await import("node:fs");
  const vm = await import("node:vm");
  await t("off: the background ignores page posts, drops its half-minute alarm, opens no tab or stream and lets tabs sleep; a pasted post still works", async () => {
    let sockets = 0;
    class FakeWS { constructor() { sockets++; } send() {} close() {} }
    const { env, msg } = await boot(baseSettings({ mode: "manual", aiEnabled: true, aiMeta: true, pumpMeta: true }), null, { WebSocket: FakeWS });
    const alarm = () => { env.listeners.alarm.forEach((f) => f({ name: "axiom-watchdog" })); return settle(120); };
    assert.ok(env.chrome.alarms.set.has("axiom-watchdog"), "on: the alarm exists");
    env.chrome.tabs.list = [{ id: 5, url: "https://axiom.trade/pulse" }];
    await msg({ type: "saveSettings", patch: { watching: false } });
    await settle();
    assert.ok(!env.chrome.alarms.set.has("axiom-watchdog"), "off: nothing wakes the background");
    assert.ok(env.chrome.tabs.updated.some(([id, o]) => id === 5 && o.autoDiscardable === true), "off: Chrome may put the Axiom tab to sleep again");
    env.chrome.tabs.list = []; env.chrome.tabs.created.length = 0; env.chrome.tabs.updated.length = 0; sockets = 0;
    await alarm();
    assert.equal(env.chrome.tabs.created.length, 0, "off: no Axiom tab is opened");
    assert.equal(sockets, 0, "off: no pump.fun stream");
    msg({ type: "post", post: post("901", "Grok rocks") });
    msg({ type: "axiomStatus", status: { live: true, hooked: true } });
    msg({ type: "hello" });
    await settle();
    assert.equal((env.store.feed || []).length, 0, "off: posts from pages are ignored");
    assert.equal(env.store.axiomStatus, undefined, "off: no status is written");
    assert.equal(env.chrome.tabs.updated.length, 0, "off: tabs are not kept awake");
    await msg({ type: "manualPost", text: "Breaking: a cat named Whiskers became mayor" });
    await settle();
    assert.equal(env.store.feed.length, 1, "off: making a coin from pasted text still works");
    await msg({ type: "saveSettings", patch: { watching: true } });
    await settle();
    assert.ok(env.chrome.alarms.set.has("axiom-watchdog"), "on again: the alarm is back");
    await alarm();
    assert.equal(env.chrome.tabs.created.length, 1, "on again: the Axiom tab is reopened");
    assert.equal(sockets, 1, "on again: the pump.fun stream connects");
    msg({ type: "post", post: post("902", "Doge rocks") });
    await settle();
    assert.equal(env.store.feed.length, 2, "on again: posts arrive");
  });
  await t("off: the alarm stays only while a vanity search runs", async () => {
    const { env, msg } = await boot(baseSettings({ mode: "manual", watching: false }));
    await settle();
    assert.ok(!env.chrome.alarms.set.has("axiom-watchdog"), "off from the start: no alarm");
    const r = await msg({ type: "vanityStart", prefix: "ab" });
    assert.ok(r.ok, r.error);
    assert.ok(env.chrome.alarms.set.has("axiom-watchdog"), "a running search keeps its check");
    await msg({ type: "vanityStop" });
    env.listeners.alarm.forEach((f) => f({ name: "axiom-watchdog" }));
    await settle();
    assert.ok(!env.chrome.alarms.set.has("axiom-watchdog"), "search over: the alarm is removed again");
  });
  await t("off: the X page script has no timer and no page observer, reads no posts and clicks nothing; it starts when switched on", async () => {
    const st = { observing: false, intervals: new Set(), sent: 0, clicks: 0, changed: null, n: 0 };
    const pill = { closest: () => ({ click: () => st.clicks++ }) };
    vm.runInNewContext(readFileSync(new URL("../src/content-x.js", import.meta.url), "utf8"), {
      window: { scrollY: 0 }, location: { pathname: "/home" }, Node: { TEXT_NODE: 3 }, Date, atob, setTimeout, clearTimeout,
      document: { documentElement: { scrollTop: 0 }, querySelector: (q) => (q.includes("pillLabel") ? pill : null), querySelectorAll: () => [] },
      chrome: { runtime: { sendMessage: async (m) => { if (m.type === "post") st.sent++; return null; } },
        storage: { local: { get: async (k) => (k === "settings" ? { settings: { watching: false } } : {}), remove: async () => {} }, onChanged: { addListener: (f) => { st.changed = f; } } } },
      MutationObserver: class { observe() { st.observing = true; } disconnect() { st.observing = false; } },
      setInterval: (f) => { const id = ++st.n; st.intervals.add(id); st.tick = f; return id; }, clearInterval: (id) => st.intervals.delete(id),
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(st.observing, false, "off: the page is not observed");
    assert.equal(st.intervals.size, 0, "off: no timer");
    st.changed({ settings: { newValue: { watching: true } } }, "local");
    assert.equal(st.observing, true, "on: the page is observed");
    assert.equal(st.intervals.size, 1, "on: the timer runs");
    st.tick();
    assert.equal(st.clicks, 1, "on: new posts are loaded");
    st.changed({ settings: { newValue: { watching: false } } }, "local");
    assert.equal(st.observing, false, "off again: observer stopped");
    assert.equal(st.intervals.size, 0, "off again: timer stopped");
  });
  await t("off: the Axiom page script is idle and shows the tracker panel again; on: it reads the tweet stream and hides the panel", async () => {
    const st = { timers: new Set(), n: 0, observing: false, handlers: [], posted: [], styles: [] };
    class FakeWS { constructor(url) { this.url = url; this.l = {}; this.readyState = 1; } addEventListener(k, f) { (this.l[k] ||= []).push(f); } }
    const win = { WebSocket: FakeWS, addEventListener: (k, f) => { if (k === "message") st.handlers.push(f); }, postMessage: (d) => st.posted.push(d) };
    const liveStyle = () => st.styles.find((x) => !x.removed) || null;
    vm.runInNewContext(readFileSync(new URL("../src/content-axiom-main.js", import.meta.url), "utf8"), {
      window: win, location: { origin: "https://axiom.trade" }, console, Date, JSON, URL,
      setInterval: () => { const id = ++st.n; st.timers.add(id); return id; }, clearInterval: (id) => st.timers.delete(id),
      setTimeout: () => { const id = ++st.n; st.timers.add(id); return id; }, clearTimeout: (id) => st.timers.delete(id),
      MutationObserver: class { observe() { st.observing = true; } disconnect() { st.observing = false; } },
      getComputedStyle: () => ({ position: "static" }),
      document: { documentElement: {}, body: {}, readyState: "complete", head: { appendChild: (el) => st.styles.push(el) },
        getElementById: (id) => (id === "t2c-hide-tracker" ? liveStyle() : null), querySelectorAll: () => [],
        createElement: () => ({ remove() { this.removed = true; } }) },
    });
    const config = (c) => st.handlers.forEach((f) => f({ source: win, data: { __t2c: "axiom-config", ...c } }));
    const ws = new win.WebSocket("wss://cluster.axiom.trade/socials");
    const tweet = (id) => ws.l.message.forEach((f) => f({ data: JSON.stringify({ kind: "tweet", handle: "elonmusk", payload: { tweet: { id, body: { text: "hello" }, author: { handle: "elonmusk" }, created_at: new Date().toISOString() } } }) }));
    const posts = () => st.posted.filter((d) => d.__t2c === "axiom-post").length;
    assert.equal(st.timers.size, 0, "before any word from the extension: no timers");
    config({ on: false, keep: false, hide: false });
    tweet("1");
    assert.equal(posts(), 0, "off: tweets are not read");
    assert.equal(st.timers.size, 0, "off: no timers");
    assert.equal(st.observing, false, "off: the page is not observed");
    assert.equal(liveStyle(), null, "off: nothing hides the tracker panel");
    config({ on: true, keep: true, hide: true });
    tweet("2");
    assert.equal(posts(), 1, "on: tweets are read");
    assert.ok(st.timers.size >= 4, "on: its timers run");
    assert.equal(st.observing, true, "on: the page is observed");
    assert.ok(liveStyle(), "on: the tracker panel is hidden");
    config({ on: false, keep: true, hide: true });
    tweet("3");
    assert.equal(posts(), 1, "off again: tweets are not read");
    assert.equal(st.timers.size, 0, "off again: every timer is stopped");
    assert.equal(st.observing, false, "off again: observer stopped");
    assert.equal(liveStyle(), null, "off again: the tracker panel shows");
  });
  await t("off: the Axiom bridge tells the page script to stop and keeps no timer of its own", async () => {
    const st = { intervals: new Set(), n: 0, posted: [], settings: { watching: false }, changed: null };
    const win = { addEventListener() {}, postMessage: (d) => st.posted.push(d) };
    vm.runInNewContext(readFileSync(new URL("../src/content-axiom.js", import.meta.url), "utf8"), {
      window: win, location: { origin: "https://axiom.trade" }, Number, Date, Array,
      setInterval: () => { const id = ++st.n; st.intervals.add(id); return id; }, clearInterval: (id) => st.intervals.delete(id), setTimeout: () => 0,
      chrome: { runtime: { sendMessage: async () => null }, storage: { local: { get: async () => ({ settings: st.settings }) }, onChanged: { addListener: (f) => { st.changed = f; } } } },
    });
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual({ ...st.posted.at(-1) }, { __t2c: "axiom-config", on: false, keep: false, hide: false });
    assert.equal(st.intervals.size, 0, "off: no timer");
    st.settings = { watching: true };
    st.changed({ settings: {} }, "local");
    await new Promise((r) => setTimeout(r, 10));
    assert.deepEqual({ ...st.posted.at(-1) }, { __t2c: "axiom-config", on: true, keep: true, hide: true });
    assert.equal(st.intervals.size, 1, "on: it repeats the settings every few seconds, as before");
    st.settings = { watching: false };
    st.changed({ settings: {} }, "local");
    await new Promise((r) => setTimeout(r, 10));
    assert.equal(st.intervals.size, 0, "off again: timer stopped");
  });
}
console.log("Callouts (pump.fun)");
{
  const { cleanCallout, makesPromise, builtInCallouts, validMint } = await import("../src/lib/callout.js");
  const MINT = "93p4QaYFhJyQZSwKbHXLWexVxtLr7HiR35ZdBnUzpump";
  const held = (extra = {}) => ({ id: "d1", cardId: "tw:77", time: Date.now() - 12 * 60_000, mode: "manual", dryRun: false, ok: true, ticker: "BISCUIT", name: "Biscuit", handle: "sunnypaws", mint: MINT, signature: "Sig", holding: 17_000_000, description: "Meet Biscuit, 8 weeks old", ...extra });
  const card = { id: "tw:77", handle: "sunnypaws", text: "Meet Biscuit, our newest resident. 8 weeks old and already running the place", status: "launched" };
  await t("callout text: tidied to one short paragraph, and anything that promises money is recognised", async () => {
    assert.equal(cleanCallout('  "Biscuit is the\n cutest coin  on the timeline #pump #sol"  '), "Biscuit is the cutest coin on the timeline");
    assert.ok(cleanCallout("word ".repeat(100)).length <= 221);
    for (const bad of ["Easy 100x from here", "guaranteed winner", "this can't lose", "will moon tonight", "up 300% soon", "free money", "not a rug"]) assert.ok(makesPromise(bad), bad);
    for (const ok of ["Biscuit is the puppy everyone is posting today, and I'm holding.", "Early, small and fun. I'm in."]) assert.ok(!makesPromise(ok), ok);
    const built = builtInCallouts({ name: "Biscuit", ticker: "BISCUIT", handle: "sunnypaws", postText: card.text });
    assert.ok(built.length >= 2 && built.every((x) => x.includes("$BISCUIT") && !makesPromise(x) && x.length <= 221), JSON.stringify(built));
    assert.ok(validMint(MINT) && !validMint("https://evil.example/x") && !validMint("abc"));
  });
  await t("callout: the AI writes the texts from the coin's own facts, and a text that promises money is replaced", async () => {
    net.aiBehavior = { "llama-3.3-70b-versatile": "ok" }; net.aiBodies = [];
    net.aiReply = { callouts: ["Biscuit the rescue pup just took over the timeline and I'm holding a bag.", "Easy 100x, guaranteed, load up now!", "Eight weeks old and already running the place. That's the whole pitch."] };
    const { env, msg } = await boot(baseSettings({ mode: "manual", aiEnabled: true, aiKey: "gsk_test", aiUrl: "https://api.groq.com/openai/v1/chat/completions", aiModel: "llama-3.3-70b-versatile" }));
    env.store.deploys = [held()]; env.store.feed = [card];
    const r = await msg({ type: "calloutTexts", id: "d1" });
    assert.ok(r.ok, r.error);
    assert.equal(r.data.by, "ai");
    assert.equal(r.data.texts.length, 3);
    assert.ok(!r.data.texts.some((x) => /100x|guaranteed/i.test(x)), "the promise is gone");
    assert.ok(r.data.texts[0].startsWith("Biscuit the rescue pup"));
    const sent = net.aiBodies.at(-1);
    assert.match(sent.messages.at(-1).content, /Biscuit \(\$BISCUIT\)/);
    assert.match(sent.messages.at(-1).content, /already running the place/, "the post text is given to the AI");
    assert.match(sent.messages[0].content, /Never promise or predict price/);
    net.aiReply = null; net.aiBehavior = null;
  });
  await t("callout: without an AI it still gives built-in texts", async () => {
    const { env, msg } = await boot(baseSettings({ mode: "manual", aiEnabled: false }));
    env.store.deploys = [held()]; env.store.feed = [card];
    const r = await msg({ type: "calloutTexts", id: "d1" });
    assert.ok(r.ok, r.error);
    assert.equal(r.data.by, "built-in");
    assert.ok(r.data.texts.length >= 2 && r.data.texts[0].includes("$BISCUIT"));
  });
  await t("callout, send: leaves from a pump.fun tab with the browser's own login, once, and the coin is marked as called", async () => {
    net.callouts = []; net.calloutReply = null;
    const { env, msg } = await boot(baseSettings({ mode: "manual" }));
    env.store.deploys = [held()];
    const r = await msg({ type: "calloutCreate", id: "d1", mint: MINT, text: "  Holding $BISCUIT.  " });
    assert.ok(r.ok && r.data.sent, JSON.stringify(r));
    assert.equal(r.data.url, `https://pump.fun/callouts/${MINT}/be6b78ef-67c2-4c2c-aabe-93173ac63a0a`);
    assert.deepEqual(net.callouts, [{ body: { coinMint: MINT, thesis: "Holding $BISCUIT.", chainId: 1399811149, version: 2 }, credentials: "include" }]);
    // pump.fun's API only answers its own site, so the request is made inside a pump.fun tab: none was open,
    // so one is opened in the background and closed again
    assert.deepEqual(env.chrome.tabs.created.map((x) => [x.url.startsWith("https://pump.fun/"), x.active]), [[true, false]]);
    assert.deepEqual(env.chrome.scripting.ran, [{ tabId: 99, world: "MAIN" }]);
    assert.deepEqual(env.chrome.tabs.removed, [99], "the tab Hatchr opened is closed afterwards");
    assert.ok(env.store.deploys[0].calledAt > 0 && env.store.deploys[0].calloutUrl === r.data.url, "the coin remembers its callout");
    assert.ok(!JSON.stringify(env.store).includes("auth_token"), "nothing about the login is stored");
    const again = await msg({ type: "calloutCreate", id: "d1", mint: MINT, text: "Holding $BISCUIT." });
    assert.ok(again.data.sent);
    assert.equal(net.callouts.length, 1, "pressing Send again right away does not post a second time");
  });
  await t("callout, send: refusals are explained, a lost answer blocks a blind retry, and only the panel may send", async () => {
    net.callouts = [];
    const { env, msg } = await boot(baseSettings({ mode: "manual" }));
    env.store.deploys = [held(), held({ id: "d2", mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", ticker: "NEO" }), held({ id: "d3", dryRun: true })];
    net.calloutReply = { status: 401, body: { message: "Unauthorized" } };
    let r = await msg({ type: "calloutCreate", id: "d1", mint: MINT, text: "Holding $BISCUIT." });
    assert.equal(r.data.sent, false);
    assert.equal(r.data.reason, "not-signed-in");
    assert.equal(env.store.deploys[0].calledAt, undefined);
    net.calloutReply = { status: 502, body: {} };
    r = await msg({ type: "calloutCreate", id: "d2", mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", text: "Holding $NEO." });
    assert.equal(r.data.reason, "unknown", "a server error may still have posted");
    const before = net.callouts.length;
    net.calloutReply = null;
    r = await msg({ type: "calloutCreate", id: "d2", mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", text: "Holding $NEO." });
    assert.equal(r.data.reason, "unknown");
    assert.equal(net.callouts.length, before, "not sent again until you say you checked pump.fun");
    r = await msg({ type: "calloutCreate", id: "d2", mint: "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJosgAsU", text: "Holding $NEO.", checkedNotPosted: true });
    assert.ok(r.data.sent, "after the check it is sent");
    r = await msg({ type: "calloutCreate", id: "d3", mint: MINT, text: "x" });
    assert.equal(r.ok, false, "a test coin can't be called out");
    r = await msg({ type: "calloutCreate", id: "d1", mint: "https://evil.example/steal", text: "x" });
    assert.equal(r.ok, false);
    env.chrome.permissions.granted = false;
    r = await msg({ type: "calloutCreate", id: "d1", mint: MINT, text: "Holding $BISCUIT again." });
    assert.equal(r.data.reason, "no-permission");
    env.chrome.permissions.granted = true;
    const n = net.callouts.length;
    for (const sender of [{ tab: { id: 7 }, id: "hatchr-test-id", url: "https://axiom.trade/pulse" }, { id: "other-extension", url: "chrome-extension://hatchr-test-id/sidepanel.html" }, {}]) {
      const out = await new Promise((res) => env.listeners.message[0]({ type: "calloutCreate", id: "d1", mint: MINT, text: "x" }, sender, res));
      assert.equal(out.ok, false, "only the side panel may send a callout");
    }
    assert.equal(net.callouts.length, n);
    net.calloutReply = null;
  });
}
console.log("Other coins you hold");
{
  const MINT = "93p4QaYFhJyQZSwKbHXLWexVxtLr7HiR35ZdBnUzpump", MINT2 = "7xKXtg2CW87d97TXJSDpbD5jBkheTqA83TZRuJospump", OTHER = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";
  const PUMPWALLET = "4Nd1mBQtrMJVYVfKf2PJy9NZUZdTAsp7D4xWLs4gDB4T";
  await t("held coins: pump.fun coins in the Hatchr wallet and in your pump.fun wallet are listed, with names from the RPC; other tokens and empty accounts are not", async () => {
    const { env, msg } = await boot(baseSettings({ mode: "manual", dryRun: false, rpcUrl: "https://mainnet.helius-rpc.com/?api-key=held", calloutWallet: PUMPWALLET }), secretB58);
    const own = (await msg({ type: "walletPub" })).data;
    net.wallets = {
      [own]: [{ mint: MINT, ui: 1_500_000 }, { mint: OTHER, ui: 25 }, { mint: "ZeroBa1ance11111111111111111111111111111pump", ui: 0 }],
      [PUMPWALLET]: [{ mint: MINT2, ui: 420_000, program: "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb" }],
    };
    net.assets = { [MINT]: { id: MINT, content: { metadata: { name: "wifgiving", symbol: "wifgiving", description: "24/7 flywheel for charity" }, links: { image: "https://ipfs.io/ipfs/pic" } } },
      [MINT2]: { id: MINT2, content: { metadata: { name: "K9 Neo", symbol: "NEO" }, links: { image: "javascript:alert(1)" } } } };
    net.assetAsks = [];
    const r = await msg({ type: "scanHeld" });
    assert.ok(r.ok, r.error);
    const held = env.store.heldCoins;
    assert.deepEqual(held.map((c) => c.mint), [MINT, MINT2], "only pump.fun coins with a balance");
    assert.deepEqual([held[0].name, held[0].ticker, held[0].amount, held[0].wallet], ["wifgiving", "WIFGIVING", 1_500_000, own]);
    assert.equal(held[0].image, "https://ipfs.io/ipfs/pic");
    assert.deepEqual([held[1].ticker, held[1].wallet, held[1].image], ["NEO", PUMPWALLET, ""], "the second wallet is read too; a picture that is not a web address is dropped");
    assert.equal(held[0].id, `held:${MINT}`);
    await msg({ type: "scanHeld" });
    assert.equal(net.assetAsks.length, 1, "names already known are not asked for again");
  });
  await t("held coins: a coin launched here that you still hold is not listed twice, and without a wallet nothing is read", async () => {
    let { env, msg } = await boot(baseSettings({ mode: "manual", dryRun: false, rpcUrl: "https://mainnet.helius-rpc.com/?api-key=held" }), secretB58);
    const own = (await msg({ type: "walletPub" })).data;
    net.wallets = { [own]: [{ mint: MINT, ui: 100 }, { mint: MINT2, ui: 200 }] };
    net.assets = {};
    env.store.deploys = [{ id: "d1", ok: true, dryRun: false, mint: MINT, signature: "Sig", holding: 100, ticker: "WIF", name: "wifgiving" }];
    await msg({ type: "scanHeld" });
    assert.deepEqual(env.store.heldCoins.map((c) => c.mint), [MINT2]);
    ({ env, msg } = await boot(baseSettings({ mode: "manual", dryRun: false })));
    await msg({ type: "scanHeld" });
    assert.deepEqual(env.store.heldCoins, []);
    assert.equal(env.store.heldInfo.error, "no-wallet");
  });
  await t("held coins: when the wallet can't be read, the list from last time stays and the reason is kept", async () => {
    const { env, msg } = await boot(baseSettings({ mode: "manual", dryRun: false, rpcUrl: "https://blocked.rpc" }), secretB58);
    env.store.heldCoins = [{ id: `held:${MINT}`, mint: MINT, name: "wifgiving", ticker: "WIFGIVING", amount: 5, ok: true, dryRun: false }];
    const r = await msg({ type: "scanHeld" });
    assert.ok(r.ok, r.error);
    assert.deepEqual(env.store.heldCoins.map((c) => c.mint), [MINT], "the coins found earlier are still listed");
    assert.ok(env.store.heldInfo.error, "the reason is stored for the panel");
  });
  await t("held coins: a callout on a held coin is written from its name and description, sent directly and remembered", async () => {
    net.callouts = []; net.calloutReply = null; net.aiBodies = [];
    net.aiBehavior = { "llama-3.3-70b-versatile": "ok" };
    net.aiReply = { callouts: ["wifgiving gives its fees to charity around the clock, and I'm holding.", "A flywheel for charity that never sleeps.", "Holding wifgiving for the story."] };
    const { env, msg } = await boot(baseSettings({ mode: "manual", dryRun: false, aiEnabled: true, aiKey: "gsk_test", aiUrl: "https://api.groq.com/openai/v1/chat/completions", aiModel: "llama-3.3-70b-versatile" }), secretB58);
    env.store.heldCoins = [{ id: `held:${MINT}`, mint: MINT, name: "wifgiving", ticker: "WIFGIVING", description: "24/7 flywheel for charity", amount: 5, ok: true, dryRun: false },
      { id: `held:${MINT2}`, mint: MINT2, name: "", ticker: "", amount: 5, ok: true, dryRun: false }];
    let r = await msg({ type: "calloutTexts", id: `held:${MINT}` });
    assert.ok(r.ok && r.data.by === "ai" && r.data.texts.length === 3, JSON.stringify(r));
    assert.match(net.aiBodies.at(-1).messages.at(-1).content, /flywheel for charity/);
    r = await msg({ type: "calloutTexts", id: `held:${MINT2}` });
    assert.equal(r.data.texts.length, 0, "nothing is known about a coin without a name, so no text is made up");
    r = await msg({ type: "calloutCreate", id: `held:${MINT}`, mint: MINT, text: "Holding wifgiving for the story." });
    assert.ok(r.ok && r.data.sent, JSON.stringify(r));
    assert.equal(net.callouts.at(-1).body.coinMint, MINT);
    assert.ok(env.store.heldCoins[0].calledAt > 0 && /\/callouts\//.test(env.store.heldCoins[0].calloutUrl), "the held coin remembers its callout");
    r = await msg({ type: "calloutCreate", id: `held:${MINT}`, mint: MINT2, text: "x" });
    assert.equal(r.ok, false, "the address must be the held coin's own");
    net.aiReply = null; net.aiBehavior = null;
  });
}
console.log(`\n${passed} passed${process.exitCode ? ", some FAILED" : ""}`);
