/* Direct Pump.fun callouts. Browser-owned session cookies never enter app storage. */
(() => {
  "use strict";
  const ENDPOINT = "https://frontend-api-v3.pump.fun/callout/create";
  const ORIGINS = ["https://pump.fun/*", "https://frontend-api-v3.pump.fun/*"];
  const PUMP_PAGE = "https://pump.fun/robots.txt"; // the lightest page on pump.fun: only its address matters
  const inFlight = new Map();
  const mintPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
  const unknown = () => ({ sent: false, reason: "unknown" });
  const storageKey = mint => `hatchr.callout.${mint}`;

  // Runs inside a pump.fun page, not in Hatchr. Pump.fun's API answers only requests that come from its own site
  // (anyone else gets "Not allowed by CORS"), so the callout has to leave from a pump.fun tab, exactly as it does when
  // you post one there yourself. Chrome copies this one function into the page, so it can use nothing from this file.
  async function pagePost(endpoint, payload) {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    try {
      const response = await fetch(endpoint, {
        method: "POST",
        credentials: "include",
        redirect: "error",
        headers: {
          accept: "application/json",
          "content-type": "application/json",
          "x-pump-platform": "web",
          "x-pump-source": "WEB"
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
      let body = null;
      try { body = await response.json(); } catch { /* A non-JSON success is unconfirmed. */ }
      return { status: response.status, body };
    } catch {
      return { lost: true }; // timeout, redirect or dropped connection: it may or may not have arrived
    } finally {
      clearTimeout(timer);
    }
  }

  const onPump = url => typeof url === "string" && url.startsWith("https://pump.fun/");
  const pause = ms => new Promise(resolve => setTimeout(resolve, ms));

  // A pump.fun tab to send from: one you already have open, or a small one opened in the background for the moment.
  async function pumpTab() {
    const open = (await chrome.tabs.query({ url: "https://pump.fun/*" })).find(tab => !tab.discarded && onPump(tab.url));
    if (open) return { id: open.id, opened: false };
    const tab = await chrome.tabs.create({ url: PUMP_PAGE, active: false });
    for (let i = 0; i < 60; i++) { // up to 15 s until the tab really is on pump.fun
      const now = await chrome.tabs.get(tab.id).catch(() => null);
      if (!now) break; // closed by the user
      if (onPump(now.url)) return { id: tab.id, opened: true };
      await pause(250);
    }
    chrome.tabs.remove(tab.id).catch(() => {});
    throw new Error("pump.fun did not open");
  }

  // { status, body } from pump.fun, { lost } when the answer never came, { notSent } when nothing could be sent at all.
  async function postFromPumpPage(payload) {
    let tab;
    try { tab = await pumpTab(); } catch { return { notSent: true }; }
    try {
      let frames, timer;
      try {
        const running = chrome.scripting.executeScript({ target: { tabId: tab.id }, world: "MAIN", func: pagePost, args: [ENDPOINT, payload] });
        const tooLong = new Promise(resolve => { timer = setTimeout(() => resolve("timeout"), 45000); });
        frames = await Promise.race([running, tooLong]);
      } catch { return { notSent: true }; } // Chrome refused to run it in that tab: nothing left Hatchr
      finally { clearTimeout(timer); }
      const reply = frames === "timeout" ? null : frames?.[0]?.result;
      if (!reply || reply.lost || typeof reply.status !== "number") return { lost: true };
      return { status: reply.status, body: reply.body ?? null };
    } finally {
      if (tab.opened) chrome.tabs.remove(tab.id).catch(() => {});
    }
  }

  function confirmedCallout(body, mint) {
    // Pump.fun's reply is not documented, so the callout and its id are accepted under the names such replies usually use
    // (callout.calloutId, callout.id, data.id, id). Without any id the post still counts as unconfirmed.
    const callout = body?.callout ?? body?.data?.callout ?? (body?.data && typeof body.data === "object" && !Array.isArray(body.data) ? body.data : body);
    if (!callout || typeof callout !== "object" || body?.success === false || body?.error) return null;
    const id = callout.calloutId ?? callout.id;
    if (typeof id !== "string" || !idPattern.test(id)) return null;
    if (callout.coinMint && callout.coinMint !== mint) return null;
    return { sent: true, url: `https://pump.fun/callouts/${mint}/${id}`, calledAt: Date.now() };
  }

  function rejection(status, body) {
    // Keep raw HTML and arbitrary server objects out of the UI and local storage.
    const code = String(body?.code || body?.error?.code || "").toUpperCase();
    const raw = body?.message ?? body?.error?.message ?? body?.error;
    const detail = (Array.isArray(raw) ? raw.filter(v => typeof v === "string").join("; ") :
      typeof raw === "string" ? raw : "").replace(/[\u0000-\u001f]/g, " ").slice(0, 300);
    let reason = "refused";
    if (status === 401) reason = "not-signed-in";
    else if (code === "DUPLICATE_CALLOUT" || status === 409 || /already.*callout|existing.callout/i.test(detail)) reason = "has-live-callout";
    else if (["INSUFFICIENT_BALANCE", "NO_ELIGIBLE_WALLET", "WALLET_NOT_LINKED"].includes(code)) reason = "cannot-call";
    else if (status === 429 || ["COOLDOWN", "ATTEMPT_LIMIT", "MEDIA_RATE_LIMITED"].includes(code)) reason = "rate-limited";
    else if (status === 403) reason = "forbidden";
    return { sent: false, reason, status, detail };
  }

  async function fingerprint(mint, text) {
    const digest = await crypto.subtle.digest("SHA-256", new TextEncoder().encode(`${mint}\n${text}`));
    return Array.from(new Uint8Array(digest), byte => byte.toString(16).padStart(2, "0")).join("");
  }

  async function submit(input, saveRecord) {
    const { id, mint, text } = input;
    // A coin launched in Hatchr, or one of the coins the wallet holds (the "Other coins you hold" list).
    const { deploys = [], heldCoins = [] } = await chrome.storage.local.get(["deploys", "heldCoins"]);
    const coin = deploys.find(item => item.id === id) || heldCoins.find(item => item.id === id);
    if (!coin || coin.mint !== mint || coin.dryRun || !coin.ok) throw new Error("Choose a successfully launched live coin.");
    if (!await chrome.permissions.contains({ origins: ORIGINS })) return { sent: false, reason: "no-permission" };

    const key = storageKey(mint);
    const hash = await fingerprint(mint, text);
    const prior = (await chrome.storage.session.get(key))[key];
    if (prior?.result?.sent && prior.fingerprint === hash && Date.now() - prior.result.calledAt < 60000) return prior.result;
    // A terminated worker or lost response may still have published the callout.
    // Only an explicit user check permits another attempt in that case.
    if ((prior?.state === "pending" || prior?.state === "unknown") && !input.checkedNotPosted) return unknown();

    await chrome.storage.session.set({ [key]: { state: "pending", fingerprint: hash } });
    let result;
    try {
      const payload = { coinMint: mint, thesis: text, chainId: 1399811149, version: 2 };
      let reply;
      if (chrome.hatchrCallouts?.post) {
        // Electron's main process uses the same cookie session as its Pump.fun
        // login window. Never copy cookies from Chrome or expose them over IPC.
        reply = await chrome.hatchrCallouts.post(payload);
      } else {
        reply = await postFromPumpPage(payload);
      }
      const { status, body = null } = reply || {};
      if (reply?.notSent) result = { sent: false, reason: "no-pump-page" };
      else if (typeof status !== "number") result = unknown();
      else if (status >= 200 && status < 300) result = confirmedCallout(body, mint) || unknown();
      else if (status >= 500 || status === 408) result = unknown();
      else result = rejection(status, body);
    } catch {
      // Do not replay a POST after a timeout, redirect, or dropped connection.
      result = unknown();
    }

    // Retain the pending marker if storage fails; never turn a successful POST
    // into a generic failure that encourages the user to send it again.
    try {
      if (result.sent || result.reason === "unknown") {
        await chrome.storage.session.set({ [key]: {
          state: result.sent ? "sent" : "unknown", fingerprint: hash, result
        } });
      } else await chrome.storage.session.remove(key);
    } catch { /* Pending state still prevents an automatic repeat. */ }
    if (result.sent) {
      try { await saveRecord(id, { calledAt: result.calledAt, calloutUrl: result.url }); }
      catch { result.historyWarning = true; }
    }
    return result;
  }

  function create(input, saveRecord) {
    if (!input || typeof input.id !== "string" || !mintPattern.test(input.mint || "")) {
      return Promise.reject(new Error("Not a coin address"));
    }
    const text = typeof input.text === "string" ? input.text.trim() : "";
    if (!text || text.length > 2000) return Promise.reject(new Error("Write a callout between 1 and 2000 characters."));
    const running = inFlight.get(input.mint);
    if (running) return running.text === text ? running.promise : Promise.resolve({ sent: false, reason: "in-progress" });
    const promise = submit({ ...input, text }, saveRecord).finally(() => inFlight.delete(input.mint));
    inFlight.set(input.mint, { text, promise });
    return promise;
  }

  globalThis.HatchrCallouts = Object.freeze({ create });
})();
