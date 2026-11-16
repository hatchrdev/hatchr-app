// Runs inside axiom.trade's own page (MAIN world), injected before Axiom's scripts.
// 1. Listens to Axiom's live tweet stream (the socials WebSocket). That stream stays open
//    whether or not the X tracker panel is showing, so nothing is missed when it's closed.
// 2. Backup: reads rows of the tracker panel when it is open.
// Tweets go to content-axiom.js, which forwards them to the extension.
(() => {
  if (window.__t2cAxiomMain) return;
  window.__t2cAxiomMain = true;

  const seen = new Set();
  const sockets = new Set();
  let lastTweetAt = 0;

  function unproxy(u) {
    if (!u || typeof u !== "string") return null;
    try {
      return new URL(u).searchParams.get("url") || u;
    } catch {
      return u;
    }
  }

  function toPost(trackedHandle, t) {
    const type = String(t.type || "TWEET").toUpperCase();
    const sub = t.subtweet || null;
    // a repost carries its content in the subtweet
    const main = type === "RETWEET" && sub ? sub : t;
    const who = main["author"] || {};
    const profile = who.profile || {};
    const thumbs = (tw) => {
      const vids = ((tw && tw.media && tw.media.videos) || []).map((v) => typeof v === "string" ? (/\.(jpe?g|png|webp)(\?|$)/i.test(v) ? v : null) : (v && (v.thumbnail || v.thumbnailUrl || v.preview || v.poster || v.image)) || null);
      const card = tw && tw.card && (tw.card.image || tw.card.thumbnail || tw.card.imageUrl);
      return [...vids, typeof card === "string" ? card : null].map(unproxy).filter(Boolean);
    };
    let images = ((main.media && main.media.images) || []).map(unproxy).filter(Boolean);
    if (!images.length) images = thumbs(main);
    if (!images.length && sub && sub !== main) images = ((sub.media && sub.media.images) || []).map(unproxy).filter(Boolean);
    // videos come as plain .mp4 links; the extension grabs a frame from them for the coin image
    const mp4s = (tw) => ((tw && tw.media && tw.media.videos) || [])
      .map((v) => (typeof v === "string" ? v : v && (v.url || v.src || (v.variants && v.variants[0] && v.variants[0].url))))
      .map(unproxy)
      .filter((u) => typeof u === "string" && /video\.twimg\.com\/.+\.mp4/i.test(u));
    let videos = mp4s(main);
    if (!videos.length && sub && sub !== main) videos = mp4s(sub);
    const subWho = sub ? sub["author"] || {} : {};
    const handle = who.handle || trackedHandle || "";
    return {
      source: "axiom",
      postId: String(t.id),
      dedupeKey: `tw:${main.id || t.id}`,
      tweetType: type,
      tracked: trackedHandle || "",
      handle,
      author: profile.name || handle,
      text: String((main.body && main.body.text) || "").trim(),
      context: sub && sub !== main ? `${type === "REPLY" ? "Replying to" : "Quoting"} @${subWho.handle || "?"}: ${String((sub.body && sub.body.text) || "").slice(0, 280)}` : "",
      url: `https://x.com/${handle}/status/${main.id || t.id}`,
      images,
      videos: videos.slice(0, 2),
      avatar: unproxy(profile.avatar),
      verified: !!who.verified,
      time: Date.parse(t.created_at) || Date.now(),
    };
  }

  function emit(trackedHandle, tweet, via) {
    if (!tweet || !tweet.id) return;
    const id = String(tweet.id);
    if (seen.has(id)) return;
    seen.add(id);
    if (seen.size > 5000) seen.clear();
    lastTweetAt = Date.now();
    try {
      window.postMessage({ __t2c: "axiom-post", via, post: toPost(trackedHandle, tweet) }, location.origin);
    } catch (e) {
      console.warn("[t2c] could not read Axiom tweet", e);
    }
  }

  // ---------- 1. live stream ----------
  function onSocketMessage(e) {
    if (typeof e.data !== "string" || e.data.indexOf("tweet") < 0) return;
    let msg;
    try { msg = JSON.parse(e.data); } catch { return; }
    for (const m of Array.isArray(msg) ? msg : [msg]) {
      const tweet = m && m.payload && m.payload.tweet;
      if (tweet && (m.kind === "tweet" || m.platform === "twitter" || tweet.body)) {
        emit(m.handle || m.payload.handle || "", tweet, "stream");
      }
    }
  }

  const NativeWS = window.WebSocket;
  if (NativeWS && !NativeWS.__t2c) {
    class HookedWS extends NativeWS {
      constructor(url, protocols) {
        super(url, protocols);
        try {
          if (/socials/i.test(String(url))) {
            sockets.add(this);
            this.addEventListener("message", onSocketMessage);
            this.addEventListener("close", () => sockets.delete(this));
          }
        } catch {}
      }
    }
    HookedWS.__t2c = true;
    window.WebSocket = HookedWS;
  }

  // ---------- 2. panel rows (backup) ----------
  function eventOf(row) {
    const key = Object.keys(row).find((k) => k.startsWith("__reactFiber"));
    if (!key) return null;
    let f = row[key];
    for (let i = 0; i < 6 && f; i++) {
      const ev = f.memoizedProps && f.memoizedProps.event;
      if (ev && ev.event && ev.event.tweet) return ev;
      f = f.return;
    }
    return null;
  }

  function scanPanel() {
    const rows = document.querySelectorAll("#twitter-alerts [data-launch-hotkey-row]");
    for (const row of rows) {
      let ev;
      try { ev = eventOf(row); } catch { ev = null; }
      if (ev) emit(ev.handle, ev.event.tweet, "panel");
    }
  }

  let timer = null;
  const observePanel = () => {
    if (!document.documentElement) return setTimeout(observePanel, 50);
    new MutationObserver(() => {
      if (timer) return;
      timer = setTimeout(() => { timer = null; scanPanel(); markWrappers(config.keep && config.hide); }, 150);
    }).observe(document.documentElement, { childList: true, subtree: true });
  };
  observePanel();
  setInterval(scanPanel, 3000);

  // ---------- keep the tracker panel mounted (Axiom only streams tweets while it is open) ----------
  let config = { keep: false, hide: false };
  let attempts = 0, backoffUntil = 0;
  const STYLE_ID = "t2c-hide-tracker";

  window.addEventListener("message", (e) => {
    if (e.source !== window || !e.data || e.data.__t2c !== "axiom-config") return;
    config = { keep: !!e.data.keep, hide: !!e.data.hide };
    applyHide();
  });

  // The panel sits inside a few wrapper layers that also catch clicks; those are made
  // click-through too. We stop at the tracker's own floating window (first fixed ancestor):
  // above that is a container Axiom shares with ALL its windows (Instant Trade, Wallet Tracker…),
  // which must never be hidden. Re-evaluated on every page change, so stale marks get removed.
  function markWrappers(on) {
    const panel = document.getElementById("twitter-alerts");
    const want = new Set();
    if (on && panel) {
      let el = panel;
      while (el.parentElement && el.parentElement !== document.body && el.parentElement !== document.documentElement && el.parentElement.childElementCount === 1) {
        el = el.parentElement;
        want.add(el);
        if (getComputedStyle(el).position === "fixed") break;
      }
    }
    document.querySelectorAll("[data-t2c-ghost]").forEach((e) => { if (!want.has(e)) e.removeAttribute("data-t2c-ghost"); });
    want.forEach((e) => { if (!e.hasAttribute("data-t2c-ghost")) e.setAttribute("data-t2c-ghost", ""); });
  }

  function applyHide() {
    let st = document.getElementById(STYLE_ID);
    const want = config.keep && config.hide;
    if (want && !st && document.head) {
      st = document.createElement("style");
      st.id = STYLE_ID;
      st.textContent =
        "#twitter-alerts, #twitter-alerts *, [data-t2c-ghost] { opacity: 0 !important; pointer-events: none !important; }" +
        " #twitter-alerts, [data-t2c-ghost] { box-shadow: none !important; }";
      document.head.appendChild(st);
    } else if (!want && st) st.remove();
    markWrappers(want);
  }

  function trackerToggle() {
    for (const i of document.querySelectorAll("button i.ri-twitter-x-line")) {
      const b = i.closest("button");
      if (b && !b.closest("#twitter-alerts")) return b;
    }
    return null;
  }

  setInterval(() => {
    applyHide();
    if (!config.keep || document.readyState !== "complete") return;
    if (document.getElementById("twitter-alerts")) { attempts = 0; return; }
    if (Date.now() < backoffUntil) return;
    const btn = trackerToggle();
    if (!btn) return;
    btn.click();
    if (++attempts >= 3) { attempts = 0; backoffUntil = Date.now() + 60_000; } // e.g. logged out
  }, 3000);

  // ---------- meta: coins on Axiom Pulse (New Pairs / Final Stretch / Migrated) ----------
  function pulseRow(el) {
    const key = Object.keys(el).find((k) => k.startsWith("__reactFiber"));
    if (!key) return null;
    let name = null, ticker = null, table = null;
    const queue = [[el[key], 0]];
    while (queue.length) {
      const [f, d] = queue.shift();
      const p = f && f.memoizedProps;
      if (p && p.tokenName) { name = p.tokenName; ticker = p.tokenTicker; break; }
      if (f && d < 8) for (let c = f.child; c; c = c.sibling) queue.push([c, d + 1]);
    }
    let f = el[key];
    for (let i = 0; i < 12 && f && !table; i++) { const p = f.memoizedProps || {}; table = p.tableType || p.pulseTable || null; f = f.return; }
    if (!name) return null;
    const txt = el.innerText || "";
    return {
      address: el.getAttribute("data-pulse-token-address"),
      name: String(name),
      ticker: String(ticker || ""),
      table: String(table || ""),
      mc: (txt.match(/MC\s*\$([\d.,]+[KMB]?)/) || [])[1] || "",
    };
  }
  function scanPulse() {
    const els = document.querySelectorAll("[data-pulse-token-address]");
    if (!els.length) return;
    const rows = [];
    for (const el of els) { try { const r = pulseRow(el); if (r) rows.push(r); } catch {} }
    if (rows.length) window.postMessage({ __t2c: "axiom-pulse", rows }, location.origin);
  }
  setInterval(scanPulse, 15000);
  setTimeout(scanPulse, 4000);

  // ---------- status heartbeat for the side panel ----------
  setInterval(() => {
    const live = [...sockets].some((s) => s.readyState === 1);
    window.postMessage({ __t2c: "axiom-status", live, hooked: sockets.size > 0, lastTweetAt }, location.origin);
  }, 10000);
})();
