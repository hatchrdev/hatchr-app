/* The callout composer stays in Hatchr. Only explicit links open Pump.fun. */
(() => {
  "use strict";
  const ORIGINS = ["https://pump.fun/*", "https://frontend-api-v3.pump.fun/*"];
  const LIMIT = 2000;

  function open(coin, { send, translate, escape: esc, modal, toast, copy }) {
    const t = key => globalThis.HatchrCalloutLocales?.[document.documentElement.lang]?.[key] || translate(key);
    const desktop = chrome.runtime.id === "hatchr-desktop";
    modal(`
      <div class="co">
        <div class="co-head">${coin.image ? `<img src="${esc(coin.image)}" alt=""/>` : ""}<div><b>$${esc(coin.ticker || "?")}</b> <span class="muted">${esc(coin.name || "")}</span><div class="muted">${esc(t("Callout on pump.fun"))}</div></div></div>
        <p class="muted">${esc(t("Tell your followers why you hold this coin. Pick a text or write your own."))}</p>
        <div class="co-opts" id="coOpts"></div>
        <textarea id="coText" rows="4" maxlength="${LIMIT}" placeholder="${esc(t("Your callout text"))}"></textarea>
        <div class="co-count"><button class="link" id="coAgain">${esc(t("New texts"))}</button><span id="coCount">0 / ${LIMIT}</span></div>
        <button id="coGo">${esc(t("Send callout"))}</button>
        <div class="co-row"><a class="btn ghost" id="coOpen" href="https://pump.fun/coin/${esc(coin.mint)}" target="_blank" rel="noopener noreferrer">${esc(t("Open on pump.fun"))}</a><button class="ghost" id="coCopy">${esc(t("Copy text"))}</button><button class="ghost" id="coX">${esc(t("Post on X"))}</button></div>
        <p class="muted co-note" id="coNote" role="status" aria-live="polite"></p>
        <label class="co-retry" id="coRetry" hidden><input type="checkbox" id="coChecked"/> <span>${esc(t("I checked pump.fun: this callout was not posted."))}</span></label>
      </div>`);
    const root = document.querySelector("#modalBox .co");
    const find = selector => root.querySelector(selector);
    const text = find("#coText");
    const options = find("#coOpts");
    const note = find("#coNote");
    const go = find("#coGo");
    const again = find("#coAgain");
    const retry = find("#coRetry");
    const checked = find("#coChecked");
    let busy = false, sent = false, uncertain = false, generation = 0;
    note.textContent = t(desktop ? "Posts directly using the account signed in through Hatchr's Pump.fun window. Sign in there once; this is separate from your Chrome login." : "Posts directly from Hatchr using the account signed in on pump.fun in this Chrome profile. Pump.fun's holding requirements still apply.");

    const refresh = () => {
      find("#coCount").textContent = `${text.value.length} / ${LIMIT}`;
      go.disabled = busy || sent || !text.value.trim() || text.value.trim().length > LIMIT || (uncertain && !checked.checked);
      text.disabled = busy || sent;
      again.disabled = busy || sent;
      options.querySelectorAll("button").forEach(button => {
        button.disabled = busy || sent;
        button.classList.toggle("on", button.textContent === text.value);
      });
    };
    text.addEventListener("input", refresh);
    checked.addEventListener("change", refresh);

    async function suggestions() {
      const current = ++generation;
      const initialText = text.value;
      options.innerHTML = `<div class="muted co-wait"><span class="spin"></span>${esc(t("Writing texts…"))}</div>`;
      try {
        const response = await send({ type: "calloutTexts", id: coin.id });
        if (!root.isConnected || current !== generation) return;
        options.replaceChildren();
        for (const suggestion of response.texts || []) {
          const button = document.createElement("button");
          button.className = "co-opt";
          button.textContent = suggestion;
          button.addEventListener("click", () => { text.value = suggestion; refresh(); });
          options.appendChild(button);
        }
        if (response.by === "custom") {
          // Your own texts, saved under Settings → Callouts.
          const info = document.createElement("div");
          info.className = "muted co-wait";
          info.textContent = t(response.error ? "The AI didn't answer, so these are your own texts (Settings → Callouts)." : "Your own texts. Change them under Settings → Callouts.");
          options.appendChild(info);
        } else if (response.by !== "ai") {
          const info = document.createElement("div");
          info.className = "muted co-wait";
          info.textContent = t(response.error ? "The AI didn't answer, so these are built-in texts." : "Built-in texts. Turn on AI naming (Settings → AI) for texts written for each coin.");
          options.appendChild(info);
        }
        if (!busy && !sent && text.value === initialText && !text.value && response.texts?.[0]) text.value = response.texts[0];
        refresh();
      } catch (error) {
        if (root.isConnected && current === generation) options.textContent = error.message;
      }
    }
    again.addEventListener("click", suggestions);
    find("#coCopy").addEventListener("click", () => {
      if (text.value.trim()) copy(text.value.trim(), t("Text copied"));
    });
    find("#coX").addEventListener("click", () => {
      if (text.value.trim()) window.open(`https://x.com/intent/post?text=${encodeURIComponent(`${text.value.trim()}\n\nhttps://pump.fun/coin/${coin.mint}`)}`, "_blank", "noopener");
    });

    function showResult(result) {
      sent = !!result.sent;
      uncertain = !sent && result.reason === "unknown";
      retry.hidden = !uncertain;
      checked.checked = false;
      const messages = {
        "no-permission": "Allow access to pump.fun to send a callout from Hatchr.",
        "not-signed-in": desktop ? "Open pump.fun from Hatchr and sign in, then return here and send again. Your draft is kept." : "Sign in on pump.fun in this Chrome profile, then return here and send again. Your draft is kept.",
        "has-live-callout": "You already have a live callout for this coin. Open pump.fun to view or update it.",
        "cannot-call": "Pump.fun requires an eligible wallet holding this coin on your signed-in account.",
        "rate-limited": "Pump.fun is limiting callouts right now. Wait before trying again.",
        "forbidden": "Pump.fun refused access. Check your login or any verification on pump.fun, then return here.",
        "no-pump-page": "Couldn't reach pump.fun to send the callout. Open pump.fun in a tab, check that you are signed in, and send again. Nothing was posted.",
        "unknown": "Could not confirm whether the callout was posted. Check pump.fun before sending again to avoid a duplicate.",
        "in-progress": "A callout for this coin is already sending. Wait before trying again.",
        "refused": "Pump.fun refused the callout."
      };
      note.textContent = sent ? t("Sent to your pump.fun followers.") : t(messages[result.reason] || messages.refused);
      if (!sent && result.detail) note.appendChild(document.createTextNode(` ${result.detail}`));
      if (sent) {
        go.textContent = t("Callout sent");
        if (result.url && result.url.startsWith(`https://pump.fun/callouts/${coin.mint}/`)) {
          const link = document.createElement("a");
          link.href = result.url;
          link.target = "_blank";
          link.rel = "noopener noreferrer";
          link.textContent = t("View it on pump.fun");
          note.appendChild(document.createTextNode(" "));
          note.appendChild(link);
        }
        if (result.historyWarning) note.appendChild(document.createTextNode(` ${t("Posted successfully, but Hatchr could not update the launch history.")}`));
      }
    }

    go.addEventListener("click", async () => {
      if (busy || sent || (uncertain && !checked.checked)) return;
      const draft = text.value.trim();
      if (!draft || draft.length > LIMIT) return toast(t("Write or pick a text first"));
      busy = true;
      refresh();
      note.textContent = t("Sending…");
      let dispatched = false;
      try {
        // Request immediately in the click handler to retain Chrome's user gesture.
        const allowed = await chrome.permissions.request({ origins: ORIGINS });
        if (!allowed) { showResult({ sent: false, reason: "no-permission" }); return; }
        dispatched = true;
        const result = await send({ type: "calloutCreate", id: coin.id, mint: coin.mint, text: draft, checkedNotPosted: uncertain && checked.checked });
        if (root.isConnected) showResult(result);
      } catch (error) {
        if (root.isConnected) {
          if (dispatched) showResult({ sent: false, reason: "unknown" });
          else note.textContent = t("Allow access to pump.fun to send a callout from Hatchr.");
        }
      } finally {
        busy = false;
        if (root.isConnected) refresh();
      }
    });
    refresh();
    suggestions();
  }
  globalThis.HatchrCalloutDialog = Object.freeze({ open });
})();
