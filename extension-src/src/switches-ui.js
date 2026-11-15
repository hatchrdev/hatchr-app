/* On/off switches at the top of every tab and settings page. A switch changes its feature straight away, no Save:
     Feed: reading posts to launch coins.   Launched: auto-claim creator rewards.   Callouts: auto buy + call out, own buys.
     Trade pages: CA buy (+ launch watch), Copy trade, Pump alerts, Auto callouts.
   Settings pages: the switches that belong to that page (Sources, Auto, Launch, AI, Alerts).
   Light: the switches read the features' settings straight from storage and follow its change events; nothing is
   asked of the background until a switch is flipped.
   Each feature has its own switch and runs on its own: turning off the Feed does not stop CA buy, callouts or pump alerts.
   Runs in the side panel after sidepanel.js and uses what it hands over as globalThis.HatchrPanel. */
(() => {
  "use strict";
  const h = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const call = message => chrome.runtime.sendMessage(message).then(r => { if (!r || !r.ok) throw new Error(r && r.error || "No answer from Hatchr"); return r.data; });
  const isDesktop = chrome.runtime.id === "hatchr-desktop";
  const P = () => globalThis.HatchrPanel || null; // sidepanel.js
  const S = () => (P() && P().settings()) || {};
  const own = { coAuto: null, caBuy: null, pumps: null, copy: null }; // configs of the features that keep their own settings

  async function patch(change) {
    if (P()) await P().setSetting(change); // sidepanel.js: saves and redraws the header and the Feed
    else await call({ type: "saveSettings", patch: change });
    // the Settings form is drawn once; its checkboxes follow, so a later "Save settings" does not undo the switch
    for (const [k, v] of Object.entries(change)) { const el = document.getElementById("s-" + k); if (el && el.type === "checkbox") el.checked = !!v; }
  }
  const MSG = { coAuto: ["coAutoGet", "coAutoSave"], caBuy: ["caBuyGet", "caBuySave"], pumps: ["pumpGet", "pumpSave"], copy: ["copyGet", "copySave"] };
  const KEYS = { coAuto: "coAuto", caBuy: "caBuy", pumps: "pumpAlerts", copy: "copyTrade" };
  async function saveOwn(kind, change) {
    const [get, save] = MSG[kind];
    const current = (await call({ type: get })).config;
    own[kind] = (await call({ type: save, config: { ...current, ...change } })).config;
  }
  const allow = origins => { // Chrome asks only straight from a click; the switch is saved whatever the answer
    if (isDesktop || !chrome.permissions) return;
    try { chrome.permissions.request({ origins }).catch(() => {}); } catch { /* not offered here */ }
  };
  const setting = (k, label, on, off) => ({ label, get: () => !!S()[k], set: v => patch({ [k]: v }), on, off });

  const SWITCHES = {
    watch: { label: "Watch posts", get: () => S().watching !== false, set: v => patch({ watching: v }),
      on: "Reading Axiom, X and Telegram. Posts show in the Feed and launch coins (by hand, or by themselves in auto mode).",
      off: "Nothing is read or launched from posts. CA buy, auto callouts and pump alerts have their own switches and keep running." },
    auto: { label: "Auto mode", get: () => S().mode === "auto" && !S().paused,
      set: async v => {
        if (!v) return patch({ paused: true });
        if (!S().dryRun && P() && !(await P().ask("Auto mode is LIVE: posts that pass your rules will be launched with real SOL. Continue?"))) return;
        return patch({ mode: "auto", paused: false });
      },
      on: "Posts that pass your rules launch coins by themselves.", off: "Nothing launches by itself. You press Launch on a post." },
    claim: setting("autoClaimRewards", "Auto-claim creator rewards", "Your creator rewards are claimed once they are worth it (LIVE only).", "Rewards wait until you claim them."),
    axiom: setting("axiomEnabled", "Axiom X tracker", "Posts from Axiom's X tracker launch coins.", "Axiom's posts are not used for launching (CA buy still reads them)."),
    x: setting("xEnabled", "X tabs", "Posts in your open X tabs are read.", "X tabs are not read."),
    tg: setting("tgEnabled", "Telegram channels", "Your Telegram channels are read.", "Telegram is not read."),
    pumpMeta: setting("pumpMeta", "pump.fun live stream", "Every new pump.fun coin is followed for the meta.", "The pump.fun stream is not used for the meta."),
    ai: setting("aiEnabled", "AI names", "The AI names and scores coins.", "Built-in rules name the coins."),
    notify: setting("notifyDeploys", "Notifications", "A notification for every launch and failure.", "No notifications for launches."),
    sound: setting("soundEnabled", "Sound", "A bell when a coin launches.", "Silent."),
    coAuto: { label: "Auto buy + call out", get: () => !!(own.coAuto && own.coAuto.enabled), set: v => saveOwn("coAuto", { enabled: v }),
      on: "New coins that pass your filters are bought and called out.", off: "No coins are bought for callouts." },
    coOwn: { label: "Call out my own buys", get: () => !!(own.coAuto && own.coAuto.ownBuys), set: v => saveOwn("coAuto", { ownBuys: v }),
      on: "A coin you buy yourself is called out.", off: "Your own buys are not called out." },
    caBuy: { label: "CA buy", get: () => !!(own.caBuy && own.caBuy.enabled),
      set: v => { if (v) allow(["https://lite-api.jup.ag/*"]); return saveOwn("caBuy", { enabled: v }); },
      on: "A contract address posted by your chosen accounts is bought at once.", off: "Nothing is bought from posts." },
    smart: { label: "Launch watch", get: () => !!(own.caBuy && own.caBuy.smart), set: v => saveOwn("caBuy", { smart: v }),
      on: "A post with a $TICKER or picture but no address: the next matching new coin is bought (needs CA buy on).", off: "Only posts with an address are bought." },
    copy: { label: "Copy trade", get: () => !!(own.copy && own.copy.enabled),
      set: v => { if (v) allow(["https://lite-api.jup.ag/*"]); return saveOwn("copy", { enabled: v }); },
      on: "Trades of the wallets you follow are copied at once.", off: "Nothing is copied." },
    pumps: { label: "Pump alerts", get: () => !!(own.pumps && own.pumps.enabled),
      set: v => { if (v) allow(["https://api.dexscreener.com/*", "https://api.telegram.org/*"]); return saveOwn("pumps", { enabled: v }); },
      on: "You are told when a coin you hold jumps.", off: "No pump alerts." },
  };
  const PLACES = {
    feed: ["watch"], launched: ["claim"], callouts: ["coAuto", "coOwn"],
    sources: ["watch", "axiom", "x", "tg", "pumpMeta"], auto: ["auto"], launch: ["claim"], ai: ["ai"], alerts: ["notify", "sound"],
    "trade:cabuy": ["caBuy", "smart"], "trade:copy": ["copy"], "trade:positions": [], "trade:pumps": ["pumps"], "trade:callauto": ["coOwn", "coAuto"],
  };
  const busy = new Set();

  function placeOf(box) {
    const p = box.dataset.place;
    if (p === "trade") return "trade:" + (P() ? P().tradeSub() : "cabuy"); // the Trade page that is showing
    if (p !== "settings") return p;
    return P() ? P().subTab() : ""; // the settings page that is showing
  }
  function render() {
    document.querySelectorAll(".tab-switches[data-place]").forEach(box => {
      const keys = PLACES[placeOf(box)] || [];
      const html = keys.map(k => {
        const sw = SWITCHES[k], on = sw.get();
        const needs = { coAuto: "coAuto", coOwn: "coAuto", caBuy: "caBuy", smart: "caBuy", pumps: "pumps", copy: "copy" }[k], known = !needs || !!own[needs]; // not loaded yet: shown, not usable
        return `<label class="tsw ${on ? "on" : ""}${known ? "" : " unknown"}">
          <span class="tsw-txt"><b>${h(sw.label)}</b><small>${h(on ? sw.on : sw.off)}</small></span>
          <input type="checkbox" role="switch" data-sw="${k}" ${on ? "checked" : ""} ${busy.has(k) || !known ? "disabled" : ""} aria-label="${h(sw.label)}"/><span class="tsw-ui" aria-hidden="true"></span>
        </label>`;
      }).join("");
      if (box.dataset.html !== html) { box.dataset.html = html; box.innerHTML = html; }
      box.hidden = !keys.length;
    });
  }

  // straight from storage (what the background saved); a feature never saved yet is off
  async function loadOwn() {
    try {
      const got = await chrome.storage.local.get(Object.values(KEYS));
      for (const [kind, key] of Object.entries(KEYS)) own[kind] = got[key] && typeof got[key] === "object" ? got[key] : { enabled: false };
    } catch { /* stays as it was */ }
    render();
  }

  document.addEventListener("change", async e => {
    const input = e.target.closest && e.target.closest("input[data-sw]");
    if (!input) return;
    const k = input.dataset.sw, sw = SWITCHES[k];
    if (!sw || busy.has(k)) return;
    busy.add(k); render();
    try { await sw.set(input.checked); }
    catch (err) { if (P()) P().toast(String(err && err.message || err), 4000); }
    finally { busy.delete(k); render(); }
  });
  // tabs and settings pages: draw the switches of the one that is showing (after sidepanel.js has switched it)
  document.addEventListener("click", e => { if (e.target.closest && e.target.closest(".tabs button, #subtabs button")) setTimeout(render, 0); });
  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      let moved = false;
      for (const [kind, key] of Object.entries(KEYS)) if (changes[key]) { own[kind] = changes[key].newValue || { enabled: false }; moved = true; }
      if (moved) render();
      else if (changes.settings) setTimeout(render, 0); // sidepanel.js reads the new settings first
    });
  } catch { /* the poll below keeps it fresh */ }
  loadOwn();
  globalThis.HatchrSwitches = Object.freeze({ render, SWITCHES, PLACES });
})();
