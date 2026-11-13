// The "meta": what's being launched and what's running on pump.fun right now, built from the
// coins the extension sees on pump.fun (live launch stream) and Axiom Pulse. Fed to the AI so it can name coins the way the
// current meta does (e.g. after Dickcoin and Asscoin run, "pussy" becomes Pussycoin).

const STOP = new Set(("the and for with you your this that from are was not but all its his her our out new now just "
  + "get got who how why what when one two big lol omg wtf yes official real the of on in to a an is it be my me we").split(" "));
// endings people glue onto words: pussycoin, catwifhat, dogeai …
const AFFIXES = ["coin", "token", "inu", "wif", "hat", "cat", "dog", "ai", "gpt", "fun", "sol", "x", "69", "420", "cto"];

export function parseMc(s) {
  const m = String(s || "").replace(/,/g, "").match(/([\d.]+)\s*([KMB])?/i);
  if (!m) return 0;
  const n = parseFloat(m[1]);
  const mul = { K: 1e3, M: 1e6, B: 1e9 }[String(m[2] || "").toUpperCase()] || 1;
  return Math.round(n * mul);
}

export function fmtMc(n) {
  if (n >= 1e9) return `$${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `$${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `$${Math.round(n / 1e3)}K`;
  return `$${n}`;
}

/** Merge a Pulse snapshot into the rolling store. Returns the new store. */
export function mergePulse(store, rows, now, windowMin = 180, cap = 2500) {
  const next = { ...(store || {}) };
  for (const r of rows || []) {
    if (!r || !r.address || !r.name) continue;
    const prev = next[r.address];
    const mc = parseMc(r.mc);
    next[r.address] = {
      name: String(r.name).slice(0, 40),
      ticker: String(r.ticker || "").slice(0, 16),
      table: r.table || prev?.table || "newPairs",
      // once a coin reaches Final Stretch / Migrated, remember it
      best: rank(r.table) >= rank(prev?.best) ? r.table : prev.best,
      mc,
      maxMc: Math.max(mc, prev?.maxMc || 0),
      firstSeen: prev?.firstSeen || now,
      lastSeen: now,
    };
  }
  const cutoff = now - windowMin * 60_000;
  let entries = Object.entries(next).filter(([, t]) => t.lastSeen >= cutoff);
  if (entries.length > cap) {
    // the live launch stream is a firehose: keep coins that ran first, then the newest
    const ran = (t) => (rank(t.best) >= 1 || t.maxMc >= 15000 ? 1 : 0);
    entries = entries.sort((a, b) => ran(b[1]) - ran(a[1]) || b[1].lastSeen - a[1].lastSeen).slice(0, cap);
  }
  return Object.fromEntries(entries);
}

const rank = (t) => ({ newPairs: 0, finalStretch: 1, migrated: 2 })[t] ?? -1;

export function wordsOf(name) {
  const spaced = String(name || "")
    .replace(/([a-z])([A-Z])/g, "$1 $2")
    .replace(/[^A-Za-z0-9]+/g, " ")
    .toLowerCase()
    .trim();
  const out = [];
  for (const w of spaced.split(/\s+/).filter(Boolean)) {
    const aff = AFFIXES.find((a) => w.length > a.length + 2 && w.endsWith(a));
    if (aff) out.push({ w: w.slice(0, -aff.length), pos: "first" }, { w: aff, pos: "glued" });
    else out.push({ w, pos: null });
  }
  return out;
}

/**
 * Build the meta summary the AI sees.
 * Returns { text, suffixes, hot, patterns, related, coins }.
 */
export function buildMeta(store, now, { windowMin = 180, postText = "" } = {}) {
  const cutoff = now - windowMin * 60_000;
  const coins = Object.values(store || {}).filter((t) => t.lastSeen >= cutoff);
  if (!coins.length) return { text: "", suffixes: [], hot: [], patterns: [], related: [], coins: 0 };

  const hot = coins
    .filter((t) => rank(t.best) >= 1 || t.maxMc >= 15000)
    .sort((a, b) => b.maxMc - a.maxMc)
    .slice(0, 15);

  // naming patterns: words/affixes used by several different coins
  const counts = new Map();
  for (const t of coins) {
    const ws = wordsOf(t.name);
    const seen = new Set();
    ws.forEach((x, i) => {
      if (x.w.length < 2 || STOP.has(x.w) || /^\d+$/.test(x.w) && x.w !== "69" && x.w !== "420") return;
      const key = x.w;
      if (seen.has(key)) return;
      seen.add(key);
      const c = counts.get(key) || { n: 0, first: 0, last: 0, glued: 0, hot: 0 };
      c.n++;
      if (x.pos === "glued") c.glued++;
      else if (ws.length > 1 && i === 0) c.first++;
      else if (ws.length > 1 && i === ws.length - 1) c.last++;
      if (rank(t.best) >= 1 || t.maxMc >= 15000) c.hot++;
      counts.set(key, c);
    });
  }
  const patterns = [...counts.entries()]
    .filter(([, c]) => c.n >= 3)
    .sort((a, b) => b[1].hot * 3 + b[1].n - (a[1].hot * 3 + a[1].n))
    .slice(0, 8)
    .map(([w, c]) => ({
      word: w,
      n: c.n,
      hot: c.hot,
      shape: c.glued >= c.n / 2 ? `___${w}` : c.first > c.last ? `${w} ___` : c.last > 0 ? `___ ${w}` : w,
    }));

  // coins that already use this post's words
  const postWords = new Set(
    (String(postText).toLowerCase().match(/[a-z][a-z0-9]{2,}/g) || []).filter((w) => !STOP.has(w))
  );
  const related = postWords.size
    ? coins
        .filter((t) => {
          const n = `${t.name} ${t.ticker}`.toLowerCase();
          for (const w of postWords) if (w.length >= 4 ? n.includes(w) : wordsOf(t.name).some((x) => x.w === w)) return true;
          return false;
        })
        .sort((a, b) => b.maxMc - a.maxMc)
        .slice(0, 8)
    : [];

  const fmt = (t) => `${t.name} (${[`$${t.ticker || "?"}`, t.maxMc ? fmtMc(t.maxMc) : "", rank(t.best) === 2 ? "migrated" : rank(t.best) === 1 ? "final stretch" : ""].filter(Boolean).join(", ")})`;
  const lines = [`Current pump.fun meta (last ${Math.round(windowMin / 60 * 10) / 10}h, ${coins.length} coins seen):`];
  if (hot.length) lines.push(`Running hot: ${hot.map(fmt).join("; ")}`);
  if (patterns.length) lines.push(`Naming patterns spreading: ${patterns.map((p) => `"${p.shape}" (${p.n} coins${p.hot ? `, ${p.hot} hot` : ""})`).join(", ")}`);
  if (related.length) lines.push(`Already launched with this post's words: ${related.map(fmt).join("; ")}`);
  const text = lines.length > 1 ? lines.join("\n").slice(0, 1400) : "";

  const suffixes = patterns.filter((p) => p.shape.startsWith("___")).map((p) => p.word);
  return { text, suffixes, hot, patterns, related, coins: coins.length };
}
