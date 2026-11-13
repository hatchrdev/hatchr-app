/* Direct Pump.fun callouts. Browser-owned session cookies never enter app storage. */
(() => {
  "use strict";
  const ENDPOINT = "https://frontend-api-v3.pump.fun/callout/create";
  const ORIGINS = ["https://pump.fun/*", "https://frontend-api-v3.pump.fun/*"];
  const inFlight = new Map();
  const mintPattern = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const idPattern = /^[a-zA-Z0-9_-]{1,128}$/;
  const unknown = () => ({ sent: false, reason: "unknown" });
  const storageKey = mint => `hatchr.callout.${mint}`;

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
    const { deploys = [] } = await chrome.storage.local.get("deploys");
    const coin = deploys.find(item => item.id === id);
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
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), 20000);
    let result;
    try {
      const payload = { coinMint: mint, thesis: text, chainId: 1399811149, version: 2 };
      let status, body = null;
      if (chrome.hatchrCallouts?.post) {
        // Electron's main process uses the same cookie session as its Pump.fun
        // login window. Never copy cookies from Chrome or expose them over IPC.
        ({ status, body } = await chrome.hatchrCallouts.post(payload));
      } else {
        const response = await fetch(ENDPOINT, {
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
        status = response.status;
        try { body = await response.json(); } catch { /* A non-JSON success is unconfirmed. */ }
      }
      if (status >= 200 && status < 300) result = confirmedCallout(body, mint) || unknown();
      else if (status >= 500 || status === 408) result = unknown();
      else result = rejection(status, body);
    } catch {
      // Do not replay a POST after a timeout, redirect, or dropped connection.
      result = unknown();
    } finally {
      clearTimeout(timer);
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
