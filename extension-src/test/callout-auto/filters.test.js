// Tests for the callout automode's filters, copy guard and Axiom filter import (src/callout-filters.js).
// Run by `npm test` against the built extension; or by hand: node test/callout-auto/filters.test.js [folder with the built files]
const path = require("path").resolve(process.argv[2] || require("path").join(__dirname, "../../extension"));
require(path + "/callout-filters.js");
const F = globalThis.HatchrCalloutFilters;
const assert = require("assert");
let n = 0; const t = (name, fn) => { fn(); n++; console.log("ok  " + name); };

t("defaults clean and stable", () => {
  const c = F.cleanConfig(null);
  assert.strictEqual(c.enabled, false);
  assert.strictEqual(c.buyUsd, 1.5);
  assert.deepStrictEqual(F.cleanConfig(c), c);
  // no minimums or maximums on any setting
  const free = F.cleanConfig({ buyUsd: 0.2, slippage: 0, priorityFee: 0.5, minIntervalMin: 0, maxPerDay: 5000, reserveSol: 0, filters: { cloneWindowMin: 0, maxSameName: 3000, maxDevCoins: "" } });
  assert.deepStrictEqual([free.buyUsd, free.slippage, free.priorityFee, free.minIntervalMin, free.maxPerDay, free.reserveSol], [0.2, 0, 0.5, 0, 5000, 0]);
  assert.deepStrictEqual([free.filters.cloneWindowMin, free.filters.maxSameName, free.filters.maxDevCoins], [0, 3000, null]);
  assert.strictEqual(F.cleanConfig({ minIntervalMin: 1 }).minIntervalMin, 1); assert.strictEqual(F.cleanConfig({ maxPerDay: 0 }).maxPerDay, 0);
  assert.strictEqual(F.cleanConfig({ maxPerDay: "abc" }).maxPerDay, 4, "not a number -> default");
  assert.deepStrictEqual(F.cleanConfig(free), free);
  // when the callout goes out
  const d = F.cleanConfig({});
  assert.deepStrictEqual([d.ownDelaySec, d.ownMinMcUsd, d.autoDelaySec, d.autoMinMcUsd, d.waitMaxMin], [0, null, 0, null, null]);
  const w = F.cleanConfig({ ownDelaySec: "45", ownMinMcUsd: "20k", autoDelaySec: 0.5, autoMinMcUsd: "", waitMaxMin: "30" });
  assert.deepStrictEqual([w.ownDelaySec, w.ownMinMcUsd, w.autoDelaySec, w.autoMinMcUsd, w.waitMaxMin], [45, 20000, 0.5, null, 30]);
  assert.deepStrictEqual(F.cleanConfig(w), w);
  // texts
  assert.strictEqual(F.cleanConfig({}).texts.length, 3);
  assert.deepStrictEqual(F.cleanConfig({ texts: "one {ticker}\n\n  two {name}  \none {ticker}" }).texts, ["one {ticker}", "two {name}"]);
  assert.deepStrictEqual(F.cleanConfig({ texts: "" }).texts, [], "emptied on purpose stays empty");
  assert.strictEqual(F.fillText("${ticker} / {ticker} is {name}", { ticker: "FROG", name: "Moon Frog" }), "$FROG / $FROG is Moon Frog");
  assert.strictEqual(F.fillText("Just bought {ticker}.", {}), "Just bought this one.");
  assert.deepStrictEqual(F.cleanConfig({ filters: { holders: { min: "50", max: "10" } } }).filters.holders, { min: 10, max: 50 });
  assert.deepStrictEqual(F.cleanFilters({ marketCapUsd: { min: "5k", max: "$1.2m" } }).marketCapUsd, { min: 5000, max: 1200000 });
});

const base = (over = {}) => ({ mint: "AAApump", name: "Moon Frog", ticker: "FROG", uri: "https://ipfs.io/ipfs/QmAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA", creator: "DEV", createdAt: 0,
  devBuySol: 1, txns: 40, buys: 30, sells: 10, volSol: 12, vSol: 40, vTokens: 900e6, mcSol: 45,
  balances: new Map([["DEV", 20e6], ...Array.from({ length: 20 }, (_, i) => ["w" + i, 5e6])]),
  meta: { twitter: "https://x.com/a", website: "", telegram: "", description: "a frog" }, ...over });
const ctx = (over = {}) => ({ now: 60000, solUsd: 150, clones: { sameName: 0, sameTicker: 0, sameImage: 0, devCoins: 0 }, ...over });
const f = F.cleanFilters(F.DEFAULT_FILTERS);

t("a healthy coin passes the defaults", () => {
  const r = F.evaluate(base(), f, ctx());
  assert.strictEqual(r.pass, true, r.why.join("; "));
  assert.strictEqual(Math.round(r.metrics.marketCapUsd), 6750);
  assert.strictEqual(r.metrics.holders, 21);
  assert.strictEqual(+r.metrics.devHoldingPct.toFixed(2), 2);
  assert.strictEqual(+r.metrics.top10Pct.toFixed(2), 6.5);
});
t("too young waits, too old is dead", () => {
  const young = F.evaluate(base(), f, ctx({ now: 5000 }));
  assert.strictEqual(young.pass, false); assert.strictEqual(young.dead, false);
  const old = F.evaluate(base(), f, ctx({ now: 700000 }));
  assert.strictEqual(old.pass, false); assert.strictEqual(old.dead, true);
});
t("dev holding over the limit fails but can recover", () => {
  const r = F.evaluate(base({ balances: new Map([["DEV", 200e6], ...Array.from({ length: 20 }, (_, i) => ["w" + i, 1e6])]) }), f, ctx());
  assert.strictEqual(r.pass, false); assert.strictEqual(r.dead, false);
  assert.ok(r.why.some(w => /Dev holding/.test(w)));
});
t("copies and vamps are dead", () => {
  assert.strictEqual(F.evaluate(base(), f, ctx({ clones: { sameName: 3, sameTicker: 0, sameImage: 0, devCoins: 0 } })).dead, true);
  assert.strictEqual(F.evaluate(base(), f, ctx({ clones: { sameName: 0, sameTicker: 1, sameImage: 0, devCoins: 0 } })).dead, true);
  assert.strictEqual(F.evaluate(base(), f, ctx({ clones: { sameName: 0, sameTicker: 0, sameImage: 1, devCoins: 0 } })).dead, true);
  assert.strictEqual(F.evaluate(base(), f, ctx({ clones: { sameName: 0, sameTicker: 0, sameImage: 0, devCoins: 2 } })).dead, true);
  const loose = F.cleanFilters({ ...f, maxSameName: 3 });
  assert.strictEqual(F.evaluate(base(), loose, ctx({ clones: { sameName: 3, sameTicker: 0, sameImage: 0, devCoins: 0 } })).pass, true);
  const anyDev = F.cleanFilters({ ...f, maxDevCoins: "", maxSameName: "" });
  assert.strictEqual(F.evaluate(base(), anyDev, ctx({ clones: { sameName: 500, sameTicker: 500, sameImage: 0, devCoins: 3000 } })).pass, true, "empty = no limit");
  const off = F.cleanFilters({ ...f, cloneGuard: false });
  assert.strictEqual(F.evaluate(base(), off, ctx({ clones: { sameName: 9, sameTicker: 9, sameImage: 9, devCoins: 9 } })).pass, true);
});
t("links: unknown is never waved through", () => {
  const unread = F.evaluate(base({ meta: null }), f, ctx());
  assert.strictEqual(unread.pass, false); assert.strictEqual(unread.dead, false);
  const failed = F.evaluate(base({ meta: null, metaFailed: true }), f, ctx());
  assert.strictEqual(failed.dead, true);
  const none = F.evaluate(base({ meta: { twitter: "", website: "", telegram: "", description: "" } }), f, ctx());
  assert.strictEqual(none.dead, true);
});
t("unknown SOL price means $ filters do not pass", () => {
  const r = F.evaluate(base(), f, ctx({ solUsd: 0 }));
  assert.strictEqual(r.pass, false); assert.ok(r.why.some(w => /Volume.*not known/.test(w)));
});
t("keywords", () => {
  const inc = F.cleanFilters({ ...f, includeKeywords: "cat, dog" });
  assert.strictEqual(F.evaluate(base(), inc, ctx()).dead, true);
  assert.strictEqual(F.evaluate(base({ meta: null }), inc, ctx()).dead, false, "description not read yet");
  assert.strictEqual(F.evaluate(base({ name: "Dog Frog" }), inc, ctx()).pass, true);
  const exc = F.cleanFilters({ ...f, excludeKeywords: ["frog"] });
  assert.strictEqual(F.evaluate(base(), exc, ctx()).dead, true);
});
t("worthWatching only uses the cheap checks", () => {
  const fresh = base({ txns: 1, buys: 1, volSol: 1, balances: new Map([["DEV", 30e6]]), meta: null });
  assert.strictEqual(F.worthWatching(fresh, f, ctx({ now: 100 })).ok, true);
  assert.strictEqual(F.worthWatching(fresh, f, ctx({ now: 100, clones: { sameName: 1, sameTicker: 1, sameImage: 0, devCoins: 0 } })).ok, false);
  const devCap = F.cleanFilters({ ...f, devBuySol: { min: null, max: 0.5 } });
  assert.strictEqual(F.worthWatching(fresh, devCap, ctx({ now: 100 })).ok, false);
});
t("clone index", () => {
  const ix = F.createIndex();
  const a = { mint: "m1", name: "PEPE", ticker: "PEPE", uri: "https://ipfs.io/ipfs/QmXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", creator: "d1" };
  assert.deepStrictEqual(ix.check(a, 1000, 180), { sameName: 0, sameTicker: 0, sameImage: 0, devCoins: 0 });
  ix.add(a, 1000);
  const b = { mint: "m2", name: "P é p e!", ticker: "pepe", uri: "https://other.gateway/ipfs/QmXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXXX", creator: "d1" };
  assert.deepStrictEqual(ix.check(b, 2000, 180), { sameName: 1, sameTicker: 1, sameImage: 1, devCoins: 1 });
  assert.deepStrictEqual(ix.check(b, 1000 + 181 * 60000, 180), { sameName: 0, sameTicker: 0, sameImage: 0, devCoins: 0 }, "outside the window");
  assert.deepStrictEqual(ix.check(a, 2000, 180), { sameName: 0, sameTicker: 0, sameImage: 0, devCoins: 0 }, "a coin is not its own copy");
  const copy = F.createIndex(); copy.load(JSON.parse(JSON.stringify(ix.dump())));
  assert.strictEqual(copy.check(b, 2000, 180).sameName, 1);
});

// ---- Axiom import: the shapes such an export can plausibly take ----
t("import: nested per-column {min,max}", () => {
  const file = { newPairs: { protocols: { pump: true, bonk: false }, searchKeywords: ["cat"], excludeKeywords: ["scam", "rug"],
      age: { min: null, max: 5 }, top10Holders: { min: null, max: 35 }, devHolding: { min: null, max: 8 }, snipers: { min: null, max: 10 },
      insiders: { min: null, max: null }, bundle: { min: null, max: 20 }, holders: { min: 25, max: null }, proTraders: { min: 3, max: null },
      liquidity: { min: null, max: null }, volume: { min: 500, max: null }, marketCap: { min: 5000, max: 60000 }, txns: { min: 30, max: null },
      numBuys: { min: 10, max: null }, numSells: { min: null, max: null }, bondingCurve: { min: 5, max: 80 },
      twitter: false, website: false, telegram: true, atLeastOneSocial: true, dexPaid: false },
    finalStretch: { marketCap: { min: 20000, max: null } }, migrated: {} };
  const r = F.importAxiom(JSON.stringify(file), "newPairs");
  assert.strictEqual(r.tab, "newPairs");
  assert.deepStrictEqual(r.patch.ageSec, { min: null, max: 300 }, "minutes -> seconds");
  assert.deepStrictEqual(r.patch.top10Pct, { min: null, max: 35 });
  assert.deepStrictEqual(r.patch.devHoldingPct, { min: null, max: 8 });
  assert.deepStrictEqual(r.patch.holders, { min: 25, max: null });
  assert.deepStrictEqual(r.patch.volumeUsd, { min: 500, max: null });
  assert.deepStrictEqual(r.patch.marketCapUsd, { min: 5000, max: 60000 });
  assert.deepStrictEqual(r.patch.txns, { min: 30, max: null });
  assert.deepStrictEqual(r.patch.buys, { min: 10, max: null });
  assert.deepStrictEqual(r.patch.bondingCurvePct, { min: 5, max: 80 });
  assert.deepStrictEqual(r.patch.liquidityUsd, { min: null, max: null });
  assert.deepStrictEqual(r.patch.includeKeywords, ["cat"]);
  assert.deepStrictEqual(r.patch.excludeKeywords, ["scam", "rug"]);
  assert.strictEqual(r.patch.telegram, true); assert.strictEqual(r.patch.anySocial, true); assert.strictEqual(r.patch.twitter, false);
  const keys = r.unsupported.map(u => u.key);
  for (const k of ["snipers", "bundle", "proTraders", "protocols"]) assert.ok(keys.includes(k), k + " must be reported");
  assert.ok(!keys.includes("insiders"), "an empty filter is not reported");
  assert.strictEqual(r.unknown.length, 0, JSON.stringify(r.unknown));
  assert.ok(!("cloneGuard" in r.patch) && !("devBuySol" in r.patch), "Hatchr-only settings untouched");
  const fs = F.importAxiom(JSON.stringify(file), "finalStretch");
  assert.deepStrictEqual(fs.patch.marketCapUsd, { min: 20000, max: null });
  assert.deepStrictEqual(fs.patch.holders, { min: null, max: null }, "import replaces, does not merge");
});
t("import: flat minX / xMax keys, strings, age unit", () => {
  const r = F.importAxiom(JSON.stringify({ filters: { pulse: { new_pairs: { minMarketCap: "5K", maxMarketCap: "", volumeMin: 1000, maxDevHolding: 10, "top10HoldersMax": 40,
    ageMax: 30, ageUnit: "s", minHolders: 12, snipersMax: 15, keywords: "ai, agent", socials: { twitter: true, website: false } } } } }));
  assert.deepStrictEqual(r.patch.marketCapUsd, { min: 5000, max: null });
  assert.deepStrictEqual(r.patch.volumeUsd, { min: 1000, max: null });
  assert.deepStrictEqual(r.patch.devHoldingPct, { min: null, max: 10 });
  assert.deepStrictEqual(r.patch.top10Pct, { min: null, max: 40 });
  assert.deepStrictEqual(r.patch.ageSec, { min: null, max: 30 });
  assert.deepStrictEqual(r.patch.holders, { min: 12, max: null });
  assert.deepStrictEqual(r.patch.includeKeywords, ["ai", "agent"]);
  assert.strictEqual(r.patch.twitter, true);
  assert.deepStrictEqual(r.unsupported.map(u => u.key), ["snipersMax"]);
});
t("import: [min,max] arrays, no columns, base64", () => {
  const txt = Buffer.from(JSON.stringify({ marketCap: [4000, 90000], holders: [20, null], weirdThing: 7 })).toString("base64");
  const r = F.importAxiom(txt);
  assert.strictEqual(r.tab, null);
  assert.deepStrictEqual(r.patch.marketCapUsd, { min: 4000, max: 90000 });
  assert.deepStrictEqual(r.patch.holders, { min: 20, max: null });
  assert.deepStrictEqual(r.unknown, [{ key: "weirdThing", value: "7" }]);
});
t("import: rubbish is refused, an imported patch survives cleaning", () => {
  assert.throws(() => F.importAxiom("hello"), /not a filter file/);
  assert.throws(() => F.importAxiom(""), /empty/);
  const r = F.importAxiom(JSON.stringify({ newPairs: { marketCap: { min: 5000 } } }));
  const merged = F.cleanFilters({ ...F.DEFAULT_FILTERS, ...r.patch });
  assert.deepStrictEqual(merged.marketCapUsd, { min: 5000, max: null });
  assert.strictEqual(merged.cloneGuard, true);
  assert.deepStrictEqual(merged.holders, { min: null, max: null });
});
console.log(`\n${n} filter tests passed`);
