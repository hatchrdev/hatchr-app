// Bridge on axiom.trade: receives tweets from content-axiom-main.js and forwards them to the extension.
(() => {
  // After Hatchr is updated, the copy of this script that was already on the page can no longer reach the
  // extension. The background then injects this script again: it takes over unless the old copy still works.
  try { if (window.__t2cAxiomBridgeAlive && window.__t2cAxiomBridgeAlive()) return; } catch { /* the old copy is gone */ }
  let alive = true;
  window.__t2cAxiomBridgeAlive = () => { try { return alive && !!chrome.runtime?.id; } catch { return false; } };

  try { chrome.runtime.sendMessage({ type: "hello" }).catch(() => {}); } catch {}

  // Tell the page script what to do: watch at all, and keep Axiom's tracker panel open (hidden). Posts are read while
  // Hatchr launches from posts (the Feed's switch) or while CA buy is on; with both off this bridge goes quiet too:
  // no timer, it only listens for one of them coming back on.
  let pushTimer = null;
  function pushConfig() {
    if (!alive) return;
    try {
      chrome.storage.local.get(["settings", "caBuy"]).then(({ settings: s, caBuy: cb }) => {
        const launch = !s || s.watching !== false;
        const ca = !!(cb && cb.enabled && Array.isArray(cb.handles) && cb.handles.length);
        const on = launch || ca;
        // Axiom only streams tracker posts while its tracker panel is open
        const keep = (!s || s.axiomKeepTracker !== false) && ((launch && (!s || s.axiomEnabled !== false)) || ca);
        const hide = on && (!!s ? s.axiomHideTracker !== false : true);
        window.postMessage({ __t2c: "axiom-config", on, keep, hide }, location.origin);
        if (on && !pushTimer) pushTimer = setInterval(pushConfig, 5000);
        if (!on && pushTimer) { clearInterval(pushTimer); pushTimer = null; }
      }).catch(() => {});
    } catch { alive = false; }
  }
  pushConfig();
  setTimeout(pushConfig, 1000); // again shortly after, in case the page script was not listening yet
  setTimeout(pushConfig, 4000);
  try { chrome.storage.onChanged.addListener((ch, area) => { if (area === "local" && (ch.settings || ch.caBuy)) pushConfig(); }); } catch {}
  const str = (v, max) => (typeof v === "string" ? v.slice(0, max) : "");

  window.addEventListener("message", (e) => {
    if (!alive || e.source !== window || e.origin !== location.origin) return;
    const d = e.data;
    if (d && d.__t2c === "axiom-status") {
      try {
        chrome.runtime.sendMessage({ type: "axiomStatus", status: { live: !!d.live, hooked: !!d.hooked, lastTweetAt: Number(d.lastTweetAt) || 0 } }).catch(() => {});
      } catch { alive = false; }
      return;
    }
    if (d && d.__t2c === "axiom-pulse" && Array.isArray(d.rows)) {
      const rows = d.rows.slice(0, 200).map((r) => ({
        address: str(r.address, 60), name: str(r.name, 40), ticker: str(r.ticker, 16),
        table: ["newPairs", "finalStretch", "migrated"].includes(r.table) ? r.table : "newPairs", mc: str(r.mc, 12),
      })).filter((r) => r.address && r.name);
      try { chrome.runtime.sendMessage({ type: "pulse", rows }).catch(() => {}); } catch { alive = false; }
      return;
    }
    if (!d || d.__t2c !== "axiom-post" || !d.post || typeof d.post !== "object") return;
    const p = d.post;
    // only pass plain, size-limited fields on
    const post = {
      source: "axiom",
      postId: str(p.postId, 40),
      dedupeKey: str(p.dedupeKey, 50),
      tweetType: str(p.tweetType, 20),
      tracked: str(p.tracked, 40),
      handle: str(p.handle, 40),
      author: str(p.author, 80),
      text: str(p.text, 4000),
      context: str(p.context, 400),
      url: /^https:\/\/x\.com\//.test(p.url || "") ? str(p.url, 200) : "",
      images: Array.isArray(p.images) ? p.images.filter((u) => typeof u === "string" && /^https:\/\//.test(u)).slice(0, 4) : [],
      videos: Array.isArray(p.videos) ? p.videos.filter((u) => typeof u === "string" && /^https:\/\/video\.twimg\.com\//.test(u)).slice(0, 2) : [],
      avatar: typeof p.avatar === "string" && /^https:\/\//.test(p.avatar) ? p.avatar : null,
      verified: !!p.verified,
      time: Number(p.time) || Date.now(),
    };
    if (!/^\d+$/.test(post.postId)) return;
    try {
      chrome.runtime.sendMessage({ type: "post", post }).catch(() => {});
    } catch {
      alive = false; // extension reloaded; refresh the Axiom tab to reconnect
    }
  });
})();
