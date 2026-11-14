/* Filters for the callout automode. Pure logic: no storage, no network, no chrome.* — runs in the background worker,
   the side panel and plain Node (for tests). These filters are Hatchr's own and are kept separate from Axiom's;
   an Axiom Pulse filter export can be imported into them. */
(() => {
  "use strict";

  // ---------- what can be filtered on ----------
  // Ranges: { min, max }, null = no limit. All are measured by Hatchr itself from pump.fun's trade stream.
  const RANGES = [
    { key: "ageSec", label: "Age (seconds)", help: "How long the coin has existed. A minimum lets the first trades come in before it is judged." },
    { key: "marketCapUsd", label: "Market cap ($)" },
    { key: "liquidityUsd", label: "Liquidity ($)", help: "Approximate: both sides of the bonding curve, the way trading terminals show it." },
    { key: "volumeUsd", label: "Volume ($)", help: "Traded since the coin was created." },
    { key: "txns", label: "Transactions" },
    { key: "buys", label: "Buys" },
    { key: "sells", label: "Sells" },
    { key: "holders", label: "Holders" },
    { key: "bondingCurvePct", label: "Bonding curve (%)" },
    { key: "top10Pct", label: "Top 10 holders (%)" },
    { key: "devHoldingPct", label: "Dev holding (%)" },
    { key: "devBuySol", label: "Dev's first buy (SOL)" }
  ];
  const RANGE_KEYS = RANGES.map(r => r.key);
  const FLAGS = ["twitter", "website", "telegram", "anySocial"];

  const DEFAULT_FILTERS = Object.freeze({
    includeKeywords: [],
    excludeKeywords: [],
    ageSec: { min: 30, max: 600 },
    marketCapUsd: { min: null, max: null },
    liquidityUsd: { min: null, max: null },
    volumeUsd: { min: 1000, max: null },
    txns: { min: null, max: null },
    buys: { min: null, max: null },
    sells: { min: null, max: null },
    holders: { min: 15, max: null },
    bondingCurvePct: { min: null, max: null },
    top10Pct: { min: null, max: 40 },
    devHoldingPct: { min: null, max: 10 },
    devBuySol: { min: null, max: null },
    twitter: false,
    website: false,
    telegram: false,
    anySocial: true,
    // clone / vamp guard (not an Axiom filter)
    cloneGuard: true,
    cloneWindowMin: 180,
    maxSameName: 0,
    blockSameImage: true,
    maxDevCoins: 1
  });

  const DEFAULT_CONFIG = Object.freeze({
    enabled: false,
    buyUsd: 1.5,
    slippage: 20,
    priorityFee: 0.0003,
    minIntervalMin: 0,        // minutes the automatic buys wait after one; 0 = no waiting
    maxPerDay: 4,
    reserveSol: 0.02,
    // Your own callout texts: offered in the callout window, and usable by both automatic switches.
    texts: Object.freeze([
      "{ticker} JUST HIT MY RADAR AND I'M ALREADY IN. {name} is too funny to fade \u{1F525}",
      "aped {ticker}. {name}. that's it, that's the callout",
      "{name} ({ticker}) is cooking in the trenches rn and I got my bag. LFG"
    ]),
    textsOnly: false,     // callout window: always offer your texts, never ask the AI
    textMode: "template", // "template" = the one text set for that switch, "list" = a random one of your texts, "auto" = Hatchr's AI texts
    template: "{ticker} just passed my filters, picked up a small bag.",
    ownBuys: false,           // call out a coin right after you buy it yourself
    // When the callout goes out after a buy. Seconds to wait, and a market cap the coin must reach first (empty = no condition).
    ownDelaySec: 0, ownMinMcUsd: null,     // for coins you buy yourself
    autoDelaySec: 0, autoMinMcUsd: null,   // for coins the automode buys
    waitMaxMin: null,                      // stop waiting for the market cap after this many minutes (empty = wait as long as you hold it)
    keepTab: true,            // keep one pump.fun tab open in the background, so a callout does not first have to open one
    ownTemplate: "Just bought {ticker}.",
    filters: DEFAULT_FILTERS
  });

  // ---------- cleaning up whatever comes in (UI, storage, import) ----------
  const num = v => {
    if (v === null || v === undefined || v === "" || typeof v === "boolean") return null;
    if (typeof v === "string") {
      const m = v.replace(/[$,%\s]/g, "").match(/^(\d*\.?\d+)([kmb])?$/i); // "5K", "1.2m", "$3,000"
      if (!m) return null;
      v = Number(m[1]) * ({ k: 1e3, m: 1e6, b: 1e9 }[(m[2] || "").toLowerCase()] || 1);
    }
    const n = Number(v);
    return Number.isFinite(n) && n >= 0 ? n : null;
  };
  const range = v => {
    const r = { min: num(v && v.min), max: num(v && v.max) };
    if (r.min !== null && r.max !== null && r.min > r.max) [r.min, r.max] = [r.max, r.min];
    return r;
  };
  const words = v => {
    const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/[,\n]/) : [];
    return [...new Set(list.filter(x => typeof x === "string" || typeof x === "number").map(x => String(x).trim().toLowerCase().slice(0, 100)).filter(Boolean))].slice(0, 1000);
  };
  // Your numbers are taken as you type them: no minimums, no maximums. Only something that is not a number
  // (or is negative) falls back to the default.
  const amount = (v, fallback) => { const n = num(v); return n === null ? fallback : n; };
  const whole = (v, fallback) => { const n = num(v); return n === null ? fallback : Math.floor(n); };
  // A limit that can be left empty: empty = no limit.
  const limit = (f, key, fallback) => (key in f ? (num(f[key]) === null ? null : Math.floor(num(f[key]))) : fallback);

  // One callout text per line (or an array of them).
  const textList = v => {
    const list = Array.isArray(v) ? v : typeof v === "string" ? v.split(/\r?\n/) : [];
    return [...new Set(list.filter(x => typeof x === "string").map(x => x.trim().slice(0, 2000)).filter(Boolean))].slice(0, 500); // 2000 = pump.fun's own length limit
  };
  // {ticker} -> $TICKER, {name} -> the coin's name. Without a known ticker the text says "this one" rather than "$?".
  function fillText(template, coin) {
    const ticker = coin && coin.ticker ? `$${String(coin.ticker).replace(/^\$/, "")}` : "this one";
    const name = coin && (coin.name || coin.ticker) || "this coin";
    return String(template || "").replace(/\$?\{ticker\}/gi, ticker).replace(/\{name\}/gi, name).replace(/[ \t]+/g, " ").trim().slice(0, 2000);
  }

  function cleanFilters(input) {
    const f = input && typeof input === "object" ? input : {};
    const out = {
      includeKeywords: words(f.includeKeywords),
      excludeKeywords: words(f.excludeKeywords)
    };
    for (const key of RANGE_KEYS) out[key] = range(key in f ? f[key] : DEFAULT_FILTERS[key]);
    for (const key of FLAGS) out[key] = key in f ? f[key] === true : DEFAULT_FILTERS[key];
    out.cloneGuard = "cloneGuard" in f ? f.cloneGuard !== false : true;
    out.cloneWindowMin = amount(f.cloneWindowMin, DEFAULT_FILTERS.cloneWindowMin); // 0 = remembers nothing, so nothing counts as a copy
    out.maxSameName = limit(f, "maxSameName", DEFAULT_FILTERS.maxSameName);   // empty = any number of same-named coins
    out.blockSameImage = "blockSameImage" in f ? f.blockSameImage !== false : true;
    out.maxDevCoins = limit(f, "maxDevCoins", DEFAULT_FILTERS.maxDevCoins);   // empty = the dev may have made any number of coins
    return out;
  }

  function cleanConfig(input) {
    const c = input && typeof input === "object" ? input : {};
    return {
      enabled: c.enabled === true,
      // No limits on any of these: they are yours to set. (pump.fun itself only takes a callout for a coin you hold $1 of.)
      buyUsd: amount(c.buyUsd, DEFAULT_CONFIG.buyUsd) || DEFAULT_CONFIG.buyUsd, // a buy of 0 is no buy
      slippage: amount(c.slippage, DEFAULT_CONFIG.slippage),
      priorityFee: amount(c.priorityFee, DEFAULT_CONFIG.priorityFee),
      minIntervalMin: amount(c.minIntervalMin, DEFAULT_CONFIG.minIntervalMin), // 0 = no waiting between callouts
      maxPerDay: whole(c.maxPerDay, DEFAULT_CONFIG.maxPerDay),                // 0 = no daily limit
      reserveSol: amount(c.reserveSol, DEFAULT_CONFIG.reserveSol),
      texts: "texts" in c ? textList(c.texts) : [...DEFAULT_CONFIG.texts],
      textsOnly: c.textsOnly === true,
      textMode: c.textMode === "auto" || c.textMode === "list" ? c.textMode : "template",
      template: typeof c.template === "string" && c.template.trim() ? c.template.trim().slice(0, 2000) : DEFAULT_CONFIG.template,
      ownBuys: c.ownBuys === true,
      ownDelaySec: amount(c.ownDelaySec, 0), ownMinMcUsd: num(c.ownMinMcUsd) || null,
      autoDelaySec: amount(c.autoDelaySec, 0), autoMinMcUsd: num(c.autoMinMcUsd) || null,
      waitMaxMin: num(c.waitMaxMin) || null,
      keepTab: c.keepTab !== false,
      ownTemplate: typeof c.ownTemplate === "string" && c.ownTemplate.trim() ? c.ownTemplate.trim().slice(0, 2000) : DEFAULT_CONFIG.ownTemplate,
      filters: cleanFilters(c.filters)
    };
  }

  // ---------- names, clones, vamps ----------
  // "PEPE", "Pepe!", "pépé" and "P E P E" are the same coin name as far as a copy is concerned.
  const norm = s => String(s || "").normalize("NFKD").replace(/[̀-ͯ]/g, "").toLowerCase().replace(/[^a-z0-9À-￿]/g, "").slice(0, 60);
  const uriKey = u => {
    const s = String(u || "").trim();
    if (!s) return "";
    const cid = s.match(/(?:ipfs\/|ipfs:\/\/)([A-Za-z0-9]{32,})/);
    return cid ? cid[1] : s.replace(/^https?:\/\//, "").replace(/[?#].*$/, "").slice(0, 200);
  };

  // Remembers the coins seen lately, to answer "has this name / ticker / picture / dev been here before?"
  function createIndex(max = 30000) {
    let items = []; // { n, t, u, d, at, m }
    const prune = (now, windowMs) => {
      if (items.length > max) items = items.slice(items.length - max);
      if (windowMs && items.length && now - items[0].at > windowMs * 4) items = items.filter(i => now - i.at <= windowMs * 4);
    };
    return {
      // How many EARLIER coins share this one's name, ticker, picture or dev within the window.
      check(token, now, windowMin) {
        const since = now - windowMin * 60000;
        const n = norm(token.name), t = norm(token.ticker), u = uriKey(token.uri), d = String(token.creator || "");
        let sameName = 0, sameTicker = 0, sameImage = 0, devCoins = 0;
        if (!(windowMin > 0)) return { sameName, sameTicker, sameImage, devCoins }; // look back 0: nothing is remembered
        for (const i of items) {
          if (i.at < since || i.m === token.mint) continue;
          if (n && i.n === n) sameName++;
          if (t && i.t === t) sameTicker++;
          if (u && i.u === u) sameImage++;
          if (d && i.d === d) devCoins++;
        }
        return { sameName, sameTicker, sameImage, devCoins };
      },
      add(token, now) {
        items.push({ n: norm(token.name), t: norm(token.ticker), u: uriKey(token.uri), d: String(token.creator || ""), at: now, m: token.mint,
          nm: String(token.name || "").slice(0, 60), tk: String(token.ticker || "").slice(0, 16) });
        if (items.length > max + 500) prune(now, 0);
      },
      prune,
      // Name and ticker of a coin seen lately, by its address.
      find(mint) {
        for (let i = items.length - 1; i >= 0; i--) if (items[i].m === mint) return { name: items[i].nm || "", ticker: items[i].tk || "" };
        return null;
      },
      size: () => items.length,
      dump: (limit = 3000) => items.slice(-limit),
      load(list) {
        if (!Array.isArray(list)) return;
        items = list.filter(i => i && typeof i.at === "number" && typeof i.m === "string").slice(-max);
      }
    };
  }

  // ---------- measuring a coin ----------
  const SUPPLY = 1e9;                 // every pump.fun coin
  const CURVE_TOKENS = 793100000;     // sold through the bonding curve
  const VIRTUAL_ONLY = 279900000;     // virtual tokens that are never sold

  // coin: what the engine has collected. Returns the numbers the range filters look at; null = not known.
  function metrics(coin, now, solUsd) {
    const usd = v => (typeof v === "number" && solUsd > 0 ? v * solUsd : null);
    const balances = coin.balances instanceof Map ? coin.balances : new Map();
    const held = [...balances.values()].filter(v => v > 0).sort((a, b) => b - a);
    const curve = typeof coin.vTokens === "number" && coin.vTokens > 0
      ? Math.min(100, Math.max(0, 100 * (1 - (coin.vTokens - VIRTUAL_ONLY) / CURVE_TOKENS))) : null;
    return {
      ageSec: Math.max(0, (now - coin.createdAt) / 1000),
      marketCapUsd: usd(coin.mcSol),
      liquidityUsd: typeof coin.vSol === "number" ? usd(coin.vSol * 2) : null,
      volumeUsd: usd(coin.volSol),
      txns: coin.txns ?? null,
      buys: coin.buys ?? null,
      sells: coin.sells ?? null,
      holders: held.length,
      bondingCurvePct: curve,
      top10Pct: held.slice(0, 10).reduce((a, b) => a + b, 0) / SUPPLY * 100,
      devHoldingPct: (balances.get(coin.creator) || 0) / SUPPLY * 100,
      devBuySol: typeof coin.devBuySol === "number" ? coin.devBuySol : null
    };
  }

  const fmt = v => (v === null || v === undefined ? "?" : Math.abs(v) >= 1000 ? Math.round(v).toLocaleString("en-US") : String(+Number(v).toFixed(2)));
  const labelOf = key => (RANGES.find(r => r.key === key) || {}).label || key;

  /* Judges a coin.
     pass : every filter is met right now.
     dead : it can never pass any more (wrong name, a copy, too old…): stop watching it.
     why  : the first reasons it does not pass, in plain words.
     Anything that cannot be measured counts as NOT passing: an unknown is never waved through. */
  function evaluate(coin, filters, ctx) {
    const f = filters, why = [], tags = [];
    let dead = false;
    const text = `${coin.name || ""} ${coin.ticker || ""} ${coin.meta && coin.meta.description || ""}`.toLowerCase();

    if (f.excludeKeywords.length) {
      const hit = f.excludeKeywords.find(w => text.includes(w));
      if (hit) { why.push(`has the blocked word "${hit}"`); tags.push("blocked word"); dead = true; }
    }
    if (f.includeKeywords.length && !f.includeKeywords.some(w => text.includes(w))) {
      why.push("none of your keywords"); tags.push("keywords");
      if (coin.meta || coin.metaFailed) dead = true; // until its description is read, a keyword may still turn up there
    }

    if (f.cloneGuard && ctx.clones) {
      const c = ctx.clones;
      const same = Math.max(c.sameName, c.sameTicker);
      if (f.maxSameName !== null && same > f.maxSameName) { why.push(`copy: ${same} earlier coin${same === 1 ? "" : "s"} with this name or ticker`); tags.push("copy"); dead = true; }
      if (f.blockSameImage && c.sameImage > 0) { why.push("copy: same picture and details as an earlier coin"); tags.push("copy"); dead = true; }
      if (f.maxDevCoins !== null && c.devCoins > f.maxDevCoins) { why.push(`the dev made ${c.devCoins} other coins just before`); tags.push("serial dev"); dead = true; }
    }

    const m = metrics(coin, ctx.now, ctx.solUsd);
    for (const key of RANGE_KEYS) {
      const { min, max } = f[key];
      if (min === null && max === null) continue;
      const v = m[key];
      if (v === null || v === undefined || Number.isNaN(v)) { why.push(`${labelOf(key)} not known yet`); tags.push(labelOf(key)); continue; }
      if (min !== null && v < min) { why.push(`${labelOf(key)} ${fmt(v)} is under ${fmt(min)}`); tags.push(labelOf(key)); }
      if (max !== null && v > max) {
        why.push(`${labelOf(key)} ${fmt(v)} is over ${fmt(max)}`); tags.push(labelOf(key));
        if (key === "ageSec" || key === "devBuySol") dead = true; // these never come back down
      }
    }
    if (f.devBuySol.min !== null && m.devBuySol !== null && m.devBuySol < f.devBuySol.min) dead = true;

    if (f.twitter || f.website || f.telegram || f.anySocial) {
      const meta = coin.meta;
      if (!meta) {
        why.push(coin.metaFailed ? "its links could not be read" : "its links are not read yet"); tags.push("links");
        if (coin.metaFailed) dead = true;
      } else {
        const miss = [];
        if (f.twitter && !meta.twitter) miss.push("X/Twitter");
        if (f.website && !meta.website) miss.push("website");
        if (f.telegram && !meta.telegram) miss.push("Telegram");
        if (f.anySocial && !meta.twitter && !meta.website && !meta.telegram) miss.push("any link");
        if (miss.length) { why.push(`no ${miss.join(", ")}`); tags.push("links"); dead = true; }
      }
    }
    return { pass: why.length === 0, dead, why, tags: [...new Set(tags)], metrics: m };
  }

  // The cheap part only (name, copy check, dev's first buy): decides whether a brand-new coin is worth watching at all.
  function worthWatching(coin, filters, ctx) {
    const quick = { ...filters, twitter: false, website: false, telegram: false, anySocial: false };
    for (const key of RANGE_KEYS) if (key !== "devBuySol") quick[key] = { min: null, max: null };
    const r = evaluate(coin, quick, ctx);
    return { ok: !r.dead, why: r.why, tags: r.tags };
  }

  // ---------- importing an Axiom Pulse filter file ----------
  const keyNorm = k => String(k).toLowerCase().replace(/[^a-z0-9]/g, "");
  const ALIASES = {
    ageSec: ["age", "tokenage", "pairage", "agemins", "ageminutes"],
    marketCapUsd: ["marketcap", "mcap", "mc", "marketcapusd"],
    liquidityUsd: ["liquidity", "liq", "liquidityusd"],
    volumeUsd: ["volume", "vol", "volumeusd"],
    txns: ["txns", "transactions", "txs", "numtxns", "txcount", "tx"],
    buys: ["numbuys", "buys", "buycount", "buytxns"],
    sells: ["numsells", "sells", "sellcount", "selltxns"],
    holders: ["holders", "holdercount", "numholders", "holderscount"],
    bondingCurvePct: ["bondingcurve", "bcurve", "bondingcurveprogress", "curve", "curveprogress", "bonding", "progress"],
    top10Pct: ["top10holders", "top10", "top10holding", "top10holdings", "top10holder", "toptenholders"],
    devHoldingPct: ["devholding", "devholdings", "devholds", "dev", "developerholding"],
    includeKeywords: ["searchkeywords", "keywords", "includekeywords", "search", "include", "searchkeyword"],
    excludeKeywords: ["excludekeywords", "exclude", "excludedkeywords", "blacklist", "excludekeyword"],
    twitter: ["twitter", "hastwitter", "x", "twitterexists"],
    website: ["website", "haswebsite", "web"],
    telegram: ["telegram", "hastelegram", "tg"],
    anySocial: ["atleastonesocial", "anysocial", "socials", "hassocials", "atleastone", "onesocial"]
  };
  // Axiom filters Hatchr has no way to measure. They are reported, never silently treated as passed-by-default without telling.
  const AXIOM_ONLY = ["snipers", "sniper", "insiders", "insider", "bundle", "bundled", "bundlers", "protraders", "pro", "botusers", "bots", "bot",
    "devmigrations", "migrations", "devpairscreated", "devpairs", "pairscreated", "dexpaid", "fees", "globalfeespaid", "feespaid", "kols", "kol",
    "protocols", "protocol", "twitterreuses", "reuses", "mustendinpump", "endsinpump", "quotetokens", "quotetoken", "fundedat", "devfunded",
    "tweetage", "numtraders", "traders", "dexboosted", "boosted", "mintauth", "freezeauth", "lpburned", "communities", "livestream", "ispumplive"];
  const lookup = new Map();
  for (const [field, names] of Object.entries(ALIASES)) for (const n of names) lookup.set(n, field);
  const TABS = { newPairs: ["newpairs", "newpair", "new", "newcreations", "newlycreated"], finalStretch: ["finalstretch", "final", "abouttograduate", "graduating"], migrated: ["migrated", "graduated", "migratedtoraydium"] };
  const MIN_WORDS = ["min", "minimum", "from", "gte", "gt", "low", "start"];
  const MAX_WORDS = ["max", "maximum", "to", "lte", "lt", "high", "end"];
  const stripAffix = k => k.replace(/(percent|percentage|pct|usd|filter|value|range)$/g, "").replace(/^(filter|pulse)/, "");

  function parseLoose(text) {
    const raw = String(text || "").trim().replace(/^﻿/, "");
    if (!raw) throw new Error("The file is empty.");
    try { return JSON.parse(raw); } catch { /* maybe it is wrapped */ }
    try { return JSON.parse(atob(raw.replace(/\s+/g, ""))); } catch { /* not base64 either */ }
    try { return JSON.parse(decodeURIComponent(raw)); } catch { /* give up */ }
    throw new Error("That is not a filter file Hatchr can read. Export the filters from Axiom's Pulse filter window and import that file (or paste its text).");
  }

  function findTabs(root) {
    // The object that holds the per-column filters, wherever Axiom nests it.
    const queue = [[root, 0]];
    while (queue.length) {
      const [node, depth] = queue.shift();
      if (!node || typeof node !== "object" || Array.isArray(node)) continue;
      const found = {};
      for (const key of Object.keys(node)) {
        const k = keyNorm(key);
        for (const [tab, names] of Object.entries(TABS)) if (names.includes(k) && node[key] && typeof node[key] === "object") found[tab] = node[key];
      }
      if (Object.keys(found).length) return found;
      if (depth < 4) for (const v of Object.values(node)) queue.push([v, depth + 1]);
    }
    return null;
  }

  const AGE_UNITS = { s: 1, sec: 1, secs: 1, second: 1, seconds: 1, m: 60, min: 60, mins: 60, minute: 60, minutes: 60, h: 3600, hr: 3600, hour: 3600, hours: 3600, d: 86400, day: 86400, days: 86400 };

  function importAxiom(text, wantedTab = "newPairs") {
    const root = parseLoose(text);
    if (!root || typeof root !== "object") throw new Error("That file has no filters in it.");
    const tabs = findTabs(root);
    const tab = tabs ? (tabs[wantedTab] ? wantedTab : Object.keys(tabs)[0]) : null;
    const source = tabs ? tabs[tab] : root;

    const ranges = {}, flags = {}, lists = {}, unsupported = [], unknown = [];
    let ageUnit = null;
    const setRange = (field, side, value) => {
      const n = num(value);
      if (n === null) return;
      (ranges[field] = ranges[field] || { min: null, max: null })[side] = n;
    };
    const describe = v => (typeof v === "object" ? JSON.stringify(v) : String(v)).slice(0, 80);
    const isSet = v => {
      if (v === null || v === undefined || v === "" || v === false) return false;
      if (Array.isArray(v)) return v.some(isSet);
      if (typeof v === "object") return Object.values(v).some(isSet);
      return true;
    };
    const fieldOf = k => lookup.get(k) || lookup.get(stripAffix(k));
    const axiomOnly = k => AXIOM_ONLY.includes(k) || AXIOM_ONLY.includes(stripAffix(k));

    const walk = (node, path) => {
      for (const [rawKey, value] of Object.entries(node)) {
        const k = keyNorm(rawKey);
        const here = path ? `${path}.${rawKey}` : rawKey;
        if (/^(age)?unit$/.test(k) || k === "agetimeunit" || k === "timeunit") { if (typeof value === "string" && AGE_UNITS[value.toLowerCase()]) ageUnit = AGE_UNITS[value.toLowerCase()]; continue; }

        // "minMarketCap" / "marketCapMax" / "age_min"
        let side = null, base = k;
        for (const w of MIN_WORDS.slice(0, 2)) { if (k.startsWith(w) && k.length > w.length) { side = "min"; base = k.slice(w.length); } else if (k.endsWith(w) && k.length > w.length) { side = "min"; base = k.slice(0, -w.length); } }
        for (const w of MAX_WORDS.slice(0, 2)) { if (k.startsWith(w) && k.length > w.length) { side = "max"; base = k.slice(w.length); } else if (k.endsWith(w) && k.length > w.length) { side = "max"; base = k.slice(0, -w.length); } }
        if (side && (fieldOf(base) || axiomOnly(base)) && (value === null || typeof value !== "object")) {
          const field = fieldOf(base);
          if (field && RANGE_KEYS.includes(field)) setRange(field, side, value);
          else if (isSet(value)) unsupported.push({ key: here, value: describe(value) });
          continue;
        }

        const field = fieldOf(k);
        if (field && RANGE_KEYS.includes(field)) {
          if (Array.isArray(value)) { setRange(field, "min", value[0]); setRange(field, "max", value[1]); }
          else if (value && typeof value === "object") {
            for (const [sk, sv] of Object.entries(value)) {
              const s = keyNorm(sk);
              if (MIN_WORDS.includes(s)) setRange(field, "min", sv);
              else if (MAX_WORDS.includes(s)) setRange(field, "max", sv);
              else if (field === "ageSec" && /unit/.test(s) && typeof sv === "string" && AGE_UNITS[sv.toLowerCase()]) ageUnit = AGE_UNITS[sv.toLowerCase()];
            }
          } else if (isSet(value)) unknown.push({ key: here, value: describe(value) }); // a single number: min or max? not guessed
          continue;
        }
        if (field && FLAGS.includes(field)) {
          if (typeof value === "boolean") { if (value) flags[field] = true; }
          else if (value && typeof value === "object" && !Array.isArray(value)) {
            const on = value.enabled ?? value.required ?? value.value ?? value.checked;
            if (on === true) flags[field] = true;
            else if (field === "anySocial") walk(value, here); // { socials: { twitter: true, … } }
            else if (isSet(value)) unknown.push({ key: here, value: describe(value) });
          }
          continue;
        }
        if (field === "includeKeywords" || field === "excludeKeywords") {
          const list = words(value);
          if (list.length) lists[field] = list;
          continue;
        }
        if (axiomOnly(k)) { if (isSet(value)) unsupported.push({ key: here, value: describe(value) }); continue; }
        if (value && typeof value === "object" && !Array.isArray(value)) { walk(value, here); continue; }
        if (isSet(value)) unknown.push({ key: here, value: describe(value) });
      }
    };
    walk(source, "");

    // Axiom's age filter is in minutes unless the file names another unit.
    if (ranges.ageSec) {
      const unit = ageUnit || 60;
      if (ranges.ageSec.min !== null) ranges.ageSec.min *= unit;
      if (ranges.ageSec.max !== null) ranges.ageSec.max *= unit;
    }

    // The import replaces every Axiom-style filter; Hatchr's own copy guard is left as it is.
    const patch = { includeKeywords: lists.includeKeywords || [], excludeKeywords: lists.excludeKeywords || [] };
    for (const key of RANGE_KEYS) patch[key] = key === "devBuySol" ? undefined : range(ranges[key] || {});
    delete patch.devBuySol;
    for (const key of FLAGS) patch[key] = flags[key] === true;

    const applied = [];
    for (const key of RANGE_KEYS) {
      const r = ranges[key];
      if (!r || (r.min === null && r.max === null)) continue;
      const shown = range(r);
      applied.push({ label: labelOf(key), value: [shown.min !== null ? `min ${fmt(shown.min)}` : "", shown.max !== null ? `max ${fmt(shown.max)}` : ""].filter(Boolean).join(", ") });
    }
    if (patch.includeKeywords.length) applied.push({ label: "Keywords", value: patch.includeKeywords.join(", ") });
    if (patch.excludeKeywords.length) applied.push({ label: "Blocked words", value: patch.excludeKeywords.join(", ") });
    const socialNames = { twitter: "X/Twitter", website: "Website", telegram: "Telegram", anySocial: "At least one link" };
    for (const key of FLAGS) if (patch[key]) applied.push({ label: socialNames[key], value: "required" });

    return { tab, tabsFound: tabs ? Object.keys(tabs) : [], patch, applied, unsupported, unknown };
  }

  globalThis.HatchrCalloutFilters = Object.freeze({
    RANGES, FLAGS, DEFAULT_FILTERS, DEFAULT_CONFIG,
    cleanFilters, cleanConfig, fillText, createIndex, metrics, evaluate, worthWatching, importAxiom, norm, uriKey, fmt
  });
})();
