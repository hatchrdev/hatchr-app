/* Side panel part of the callout automode: its settings (Trade → Auto callouts) and its status card on the Callouts tab.
   The filters shown here are Hatchr's own, separate from Axiom's; an Axiom Pulse filter export can be imported into them. */
(() => {
  "use strict";
  const F = globalThis.HatchrCalloutFilters;
  if (!F) return;
  const PUMP_ORIGINS = ["https://pump.fun/*", "https://frontend-api-v3.pump.fun/*"];
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const send = message => chrome.runtime.sendMessage(message).then(r => { if (!r || !r.ok) throw new Error(r && r.error || "No answer from Hatchr"); return r.data; });
  const $ = (sel, root = document) => root.querySelector(sel);

  let saved = F.cleanConfig(null);   // what the background runs on
  let draft = F.cleanConfig(null);   // what the form shows (may have unsaved changes)
  let state = null, live = false, wallets = [], walletFeed = false, dryRun = true, mainOn = true, loaded = false, dirty = false;

  // Whether the Activity list is folded open is your choice and stays that way (it used to spring open again on every refresh).
  const OPEN_KEY = "hatchr.caActivityOpen";
  const activityOpen = () => { try { return localStorage.getItem(OPEN_KEY) !== "0"; } catch { return true; } };
  document.addEventListener("toggle", e => {
    if (!e.target.matches || !e.target.matches("details.ca-details")) return;
    try { localStorage.setItem(OPEN_KEY, e.target.open ? "1" : "0"); } catch { /* private mode: it just is not remembered */ }
    document.querySelectorAll("details.ca-details").forEach(d => { if (d !== e.target && d.open !== e.target.open) d.open = e.target.open; });
  }, true);
  const shortKey = w => `${w.slice(0, 4)}…${w.slice(-4)}`;
  let importNote = "", formNote = "";

  // ---------- status ----------
  const span = ms => {
    const m = Math.max(1, Math.round(ms / 60000));
    return m >= 60 ? `${Math.floor(m / 60)}h ${m % 60}m` : `${m}m`;
  };
  const clock = at => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" });

  function statusLine() {
    if (!loaded) return { tone: "", text: "…" };
    if (!saved.enabled && !saved.ownBuys) return { tone: "", text: "Off" };
    const s = state || {};
    if (s.paused) return { tone: "bad", text: (s.log || []).find(l => l.kind === "error")?.text || "Paused.", resume: true };
    const queue = s.pending || [], going = queue.find(p => !isWaiting(p)), held = queue.filter(isWaiting);
    if (going) return { tone: "ok", text: `${going.own ? "You bought" : "Bought"} ${going.ticker ? "$" + going.ticker : "a coin"}, sending its callout…${held.length ? ` ${held.length} more waiting.` : ""}` };
    if (held.length && (!saved.enabled || Date.now() < (s.nextSlotAt || 0))) return { tone: "ok", text: `${waitText(held[0])}.${held.length > 1 ? ` ${held.length - 1} more waiting.` : ""}` };
    if (saved.ownBuys && !wallets.length && !saved.enabled) return { tone: "warn", text: "No wallet to watch yet. Create your Hatchr wallet in Settings → Account, or enter the wallet you use on pump.fun on the Callouts tab." };
    if (!saved.enabled) return live ? { tone: "ok", text: "Waiting for your next buy. Its callout goes out right after." } : { tone: "warn", text: "Connecting to pump.fun's live stream… Your buys are still picked up within a minute." };
    if (saved.maxPerDay !== 0 && ((s.callsToday || 0) >= saved.maxPerDay || (s.buysToday || 0) >= saved.maxPerDay)) return { tone: "", text: `Done for today: ${Math.max(s.callsToday || 0, s.buysToday || 0)} of ${saved.maxPerDay}, your "Callouts per day" setting (0 there = no daily limit). Starts again at midnight UTC.` };
    if (Date.now() < (s.nextSlotAt || 0)) {
      const left = s.nextSlotAt - Date.now();
      // This wait is your own "Minutes between callouts" setting (or a short pause after an error), never a time-out by the app.
      return { tone: "", skip: true, text: saved.minIntervalMin > 0 && left > 600000
        ? `Next automatic buy in ${span(left)}: your "Minutes between callouts" setting is ${saved.minIntervalMin}. Set it to 0 for no waiting.`
        : `Next automatic buy in ${left >= 60000 ? span(left) : Math.ceil(left / 1000) + " s"}.` };
    }
    if (!live) return { tone: "warn", text: "Connecting to pump.fun's live stream…" };
    return { tone: "ok", text: `Watching new coins. ${s.watching || 0} being measured right now.` };
  }

  function statsLine() {
    const s = state || {};
    const top = Object.entries(s.skips || {}).sort((a, b) => b[1] - a[1]).slice(0, 4).map(([k, n]) => `${k} (${n.toLocaleString("en-US")})`);
    return `Today: ${(s.seen || 0).toLocaleString("en-US")} new coins seen · ${(s.watchedToday || 0).toLocaleString("en-US")} measured · ${s.buysToday || 0} bought · ${s.callsToday || 0} called out.` +
      (top.length ? ` Most were skipped for: ${top.join(", ")}.` : "");
  }

  function statusHtml() {
    const st = statusLine();
    const on = saved.enabled || saved.ownBuys;
    const mode = on ? (dryRun ? '<span class="ca-pill test">TEST</span>' : '<span class="ca-pill live">LIVE</span>') : "";
    const watching = saved.ownBuys ? (wallets.length ? ` (watching ${wallets.map(shortKey).join(", ")}${walletFeed ? ", live" : live ? ", via pump.fun's stream and a check every 10 s" : ", checked every 10 s"})` : " (no wallet to watch)") : "";
    const parts = on ? `<div class="help">Auto buy: ${saved.enabled ? "on" : "off"} · Your own buys: ${saved.ownBuys ? "on" : "off"}${esc(watching)}</div>` : "";
    return `<div class="ca-status ${st.tone}"><div><b>Auto callouts</b> ${mode}</div><div class="ca-now">${esc(st.text)}</div>` +
      (st.resume ? '<button class="ghost" data-ca="resume">Resume</button>' : "") + (st.skip ? '<button class="ghost" data-ca="skipWait">Skip the wait</button>' : "") + parts +
      (saved.enabled ? `<div class="help">${esc(statsLine())}</div>` : "") + "</div>";
  }

  function logHtml(limit) {
    const rows = ((state && state.log) || []).slice(0, limit);
    if (!rows.length) return '<p class="help">Nothing yet.</p>';
    return '<div class="ca-log">' + rows.map(r => {
      const links = [r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">callout</a>` : "",
        r.mint ? `<a href="https://pump.fun/coin/${esc(r.mint)}" target="_blank" rel="noopener noreferrer">coin</a>` : ""].filter(Boolean).join(" · ");
      return `<div class="ca-row ${esc(r.kind)}"><span class="ca-time">${esc(clock(r.at))}</span><span>${esc(r.text)}${links ? ` <span class="ca-links">${links}</span>` : ""}</span></div>`;
    }).join("") + "</div>";
  }

  // ---------- the card on the Callouts tab ----------
  let cardHtml = "";
  function renderCard() {
    const box = $("#coAutoCard");
    if (!box) return;
    const html = `<div class="ca-card">${statusHtml()}
      ${saved.enabled || saved.ownBuys || ((state && state.log) || []).length ? `<details class="ca-details"${activityOpen() ? " open" : ""}><summary>Activity</summary>${logHtml(8)}</details>` : ""}
      <button class="link" data-ca="open">${saved.enabled || saved.ownBuys ? "Filters and settings" : "Set up automatic callouts"}</button></div>`;
    if (html === cardHtml && box.firstChild) return; // nothing changed: leave the page alone
    cardHtml = html;
    box.innerHTML = html;
  }

  // ---------- the settings form ----------
  const val = v => (v === null || v === undefined ? "" : String(v));
  const numField = (key, label, help, step = "any", placeholder = "") =>
    `<div class="fld"><label for="ca-${key}">${esc(label)}</label><input id="ca-${key}" data-c="${key}" type="number" min="0" step="${step}" placeholder="${esc(placeholder)}" value="${esc(val(draft[key]))}"/>${help ? `<div class="help">${esc(help)}</div>` : ""}</div>`;
  // When does a bought coin's callout go out? (the same rule the background uses)
  const ruleOf = p => p.own ? { delay: saved.ownDelaySec, minMc: saved.ownMinMcUsd } : { delay: saved.autoDelaySec, minMc: saved.autoMinMcUsd };
  const isWaiting = p => { const r = ruleOf(p); return Date.now() < p.boughtAt + r.delay * 1000 || (r.minMc !== null && !(p.mcUsd >= r.minMc)); };
  const money = v => `$${Math.round(v).toLocaleString("en-US")}`;
  function waitText(p) {
    const r = ruleOf(p), name = p.ticker ? `$${p.ticker}` : "your coin", left = p.boughtAt + r.delay * 1000 - Date.now(), parts = [];
    if (left > 0) parts.push(`in ${left >= 90000 ? Math.round(left / 60000) + " min" : Math.ceil(left / 1000) + " s"}`);
    if (r.minMc !== null && !(p.mcUsd >= r.minMc)) parts.push(`once its market cap reaches ${money(r.minMc)} (${p.mcUsd > 0 ? "now " + money(p.mcUsd) : "reading it…"}${p.offCurve ? ", it left the bonding curve, so that number may be behind" : ""})`);
    return `${name}: callout ${parts.join(" and ")}`;
  }
  const check = (scope, key, label, help) =>
    `<div class="fld check"><input type="checkbox" id="ca-${key}" data-${scope}="${key}" ${(scope === "c" ? draft : draft.filters)[key] ? "checked" : ""}/><div><label for="ca-${key}">${esc(label)}</label>${help ? `<div class="help">${esc(help)}</div>` : ""}</div></div>`;

  function formHtml() {
    const f = draft.filters;
    const ranges = F.RANGES.map(r => `<div class="ca-range"><label title="${esc(r.help || "")}">${esc(r.label)}</label>
        <input type="number" min="0" step="any" placeholder="min" data-min="${r.key}" value="${esc(val(f[r.key].min))}" aria-label="${esc(r.label)} minimum"/>
        <input type="number" min="0" step="any" placeholder="max" data-max="${r.key}" value="${esc(val(f[r.key].max))}" aria-label="${esc(r.label)} maximum"/></div>`).join("");
    return `
      <div id="caStatus">${statusHtml()}</div>
      <p class="help" style="margin-top:0">Two switches that work on their own or together. Both follow the TEST / LIVE switch at the top: in TEST nothing is bought or posted, the activity list shows what would have happened. Hatchr never sells here: selling stays your decision.</p>
      <p class="help tr-hint" data-if="!ownBuys,!enabled">Switch on <b>Call out my own buys</b> and/or <b>Auto buy + call out</b> at the top of this page.</p>
      <section class="tr-sec" data-if="ownBuys"><h4 class="tr-h">Your own buys</h4>
      <div class="fld"><label for="ca-ownTemplate">Text for your own buys</label><textarea id="ca-ownTemplate" data-c="ownTemplate" rows="2" maxlength="2000">${esc(draft.ownTemplate)}</textarea></div>
      <div class="grid2">${numField("ownDelaySec", "Your buys: wait before the callout (seconds)", "0 = straight away.")}${numField("ownMinMcUsd", "Your buys: only once market cap reaches ($)", "Empty = no condition.", "any", "no condition")}</div>
      </section>
      <div data-if="ownBuys|enabled">${check("c", "keepTab", "Keep a pump.fun tab open in the background", "A callout has to leave from a pump.fun tab. With none open, Chrome first opens and loads one for every callout, which costs a few seconds. On: Hatchr keeps one small pinned tab ready (LIVE only). You can also just keep pump.fun open yourself.")}</div>
      <section class="tr-sec" data-if="enabled"><h4 class="tr-h">Automatic buys</h4>
      <p class="help tr-hint">When a new pump.fun coin passes the filters below, Hatchr buys the smallest position pump.fun accepts for a callout, checks that your wallet really holds it, and posts the callout.</p>
      <div class="grid2">${numField("autoDelaySec", "Automatic buys: wait before the callout (seconds)", "0 = straight away.")}${numField("autoMinMcUsd", "Automatic buys: only once market cap reaches ($)", "Empty = no condition. While a coin waits, the next coins are still bought.", "any", "no condition")}</div>
      ${numField("waitMaxMin", "Stop waiting for the market cap after (minutes)", "A coin that has not reached the market cap by then is not called out (it stays in your wallet). Empty = keep waiting for as long as you hold it. If you sell it meanwhile, it is not called.", "any", "never")}
      <div class="warnbox">Every buy costs real SOL plus trading and network fees, and most new coins go to zero. pump.fun pays callout rewards on how your followers do after a call, and pays less the more often you call, so strict filters and few callouts work better than many.</div>
      <div class="grid2">${numField("buyUsd", "Buy size ($)", "Any amount. pump.fun only takes a callout for a coin you hold $1 of, so under about 1.2 the callout is usually refused after fees.")}${numField("slippage", "Slippage (%)", "")}</div>
      ${check("c", "boost", "⚡ Boost: the priority fee follows the network", "Pays what the network asks right now for a fast landing, never more than 0.003 SOL, instead of a fixed fee.")}
      <div class="grid2"><div data-if="!boost">${numField("priorityFee", "Priority fee (SOL)", "Paid in full on every buy.")}</div>${numField("reserveSol", "Always keep in wallet (SOL)", "Buying stops when the balance would go under this. 0 = spend down to nothing.")}</div>
      <div class="grid2">${numField("minIntervalMin", "Minutes between callouts", "The automatic buys wait this long after a callout. 0 = no waiting: the next coin that passes is bought straight away.")}${numField("maxPerDay", "Callouts per day", "0 = no daily limit.")}</div>
      </section>
      <section class="tr-sec" data-if="ownBuys|enabled"><h4 class="tr-h">Callout text</h4>
      <div class="fld"><label for="ca-textMode">Text the two switches send</label>
        <select id="ca-textMode" data-c="textMode"><option value="template" ${draft.textMode === "template" ? "selected" : ""}>The one text set for each switch</option><option value="list" ${draft.textMode === "list" ? "selected" : ""}>A random one of my callout texts (below)</option><option value="auto" ${draft.textMode === "auto" ? "selected" : ""}>Hatchr's AI texts (when the AI is set up)</option></select></div>
      <div class="fld" data-if="textMode=template"><label for="ca-template">Text for automatic buys</label><textarea id="ca-template" data-c="template" rows="2" maxlength="2000">${esc(draft.template)}</textarea>
        <div class="help">{ticker} becomes $TICKER, {name} the coin's name. Your followers read this, so keep it true.</div></div>

      </section>
      <section class="tr-sec"><h4 class="tr-h">My callout texts</h4>
      <div class="fld"><textarea id="ca-texts" data-c="texts" rows="6" spellcheck="false" placeholder="One text per line">${esc(draft.texts.join("\n"))}</textarea>
        <div class="help">One text per line, as many as you like. {ticker} becomes $TICKER, {name} the coin's name. These are the ready texts in the callout window on the Callouts tab (three at a time, "New texts" shuffles), in place of Hatchr's built-in ones. Empty the box to get the built-in ones back.</div></div>
      ${check("c", "textsOnly", "Always offer my texts in the callout window", "Off: the AI's texts are shown when the AI is set up and answers, yours otherwise. On: always yours, and the window opens without waiting for the AI.")}

      </section>
      <section class="tr-sec" data-if="enabled"><h4 class="tr-h">Filters</h4>
      <p class="help" style="margin-top:0">These are Hatchr's own filters, separate from the ones in Axiom. A coin has to pass every one that is filled in; anything Hatchr cannot measure counts as not passed. Leave a box empty for no limit.</p>
      <div class="ca-import">
        <select id="caTab" aria-label="Axiom column"><option value="newPairs">New Pairs</option><option value="finalStretch">Final Stretch</option><option value="migrated">Migrated</option></select>
        <button class="ghost" data-ca="importFile">Import Axiom filter file</button>
        <button class="ghost" data-ca="importPaste">Paste</button>
        <input type="file" id="caFile" accept=".json,.txt,application/json,text/plain" hidden />
      </div>
      <div id="caPasteBox" hidden><textarea id="caPaste" rows="4" placeholder="Paste the text Axiom gave you when you exported your Pulse filters"></textarea>
        <div class="onboard-row"><button data-ca="importPasteGo">Import this</button><button class="ghost" data-ca="importPasteCancel">Cancel</button></div></div>
      <div id="caImportOut">${importNote}</div>
      <div class="ca-ranges"><div class="ca-range ca-range-head"><span></span><span>Min</span><span>Max</span></div>${ranges}</div>
      <div class="fld"><label for="ca-include">Keywords (any of these, in name, ticker or description)</label><input id="ca-include" data-words="includeKeywords" value="${esc(f.includeKeywords.join(", "))}" placeholder="comma separated, empty = any coin"/></div>
      <div class="fld"><label for="ca-exclude">Blocked words</label><input id="ca-exclude" data-words="excludeKeywords" value="${esc(f.excludeKeywords.join(", "))}" placeholder="comma separated"/></div>
      <div class="grid2">${check("f", "anySocial", "Has at least one link")}${check("f", "twitter", "Has X / Twitter")}</div>
      <div class="grid2">${check("f", "website", "Has a website")}${check("f", "telegram", "Has Telegram")}</div>

      <h4 class="tr-sub">Copies and vamps</h4>
      ${check("f", "cloneGuard", "Skip copies", "Compares every new coin with the ones Hatchr saw before it. Not part of Axiom's filters, so an import leaves this as it is.")}
      <div class="grid2">
        <div class="fld"><label for="ca-cloneWindowMin">Look back (minutes)</label><input id="ca-cloneWindowMin" data-fn="cloneWindowMin" type="number" min="0" step="any" value="${esc(val(f.cloneWindowMin))}"/><div class="help">How far back Hatchr remembers earlier coins when it checks for copies. 180 = a coin is a copy if the same name, ticker or picture appeared in the last 3 hours. 0 = remembers nothing, so no coin counts as a copy.</div></div>
        <div class="fld"><label for="ca-maxSameName">Earlier coins with the same name or ticker allowed</label><input id="ca-maxSameName" data-fn="maxSameName" type="number" min="0" step="any" placeholder="no limit" value="${esc(val(f.maxSameName))}"/><div class="help">0 = only the first coin with a name gets through. Empty = no limit.</div></div>
      </div>
      <div class="grid2">
        ${check("f", "blockSameImage", "Skip a coin that reuses an earlier coin's picture and details")}
        <div class="fld"><label for="ca-maxDevCoins">Other coins by the same dev allowed</label><input id="ca-maxDevCoins" data-fn="maxDevCoins" type="number" min="0" step="any" placeholder="no limit" value="${esc(val(f.maxDevCoins))}"/><div class="help">How many other coins the same dev may have launched in the look-back time. Empty = no limit (a dev with 3,000 coins still passes).</div></div>
      </div>

      </section>
      <div class="onboard-row"><button data-ca="save">Save</button><button class="ghost" data-ca="reset" data-if="enabled">Reset filters</button></div>
      <div id="caNote" class="help">${formNote}</div>
      <p class="help">Everything on this page (both switches' settings, filters, your callout texts) and your hidden coins are part of Hatchr's backup: Settings → Account → Export.</p>
      <details class="ca-details"${activityOpen() ? " open" : ""}><summary>Activity</summary><div id="caLog">${logHtml(40)}</div><button class="link" data-ca="clearLog">Clear</button></details>`;
  }

  function readForm(box) {
    const next = JSON.parse(JSON.stringify(draft));
    box.querySelectorAll("[data-c]").forEach(el => { next[el.dataset.c] = el.type === "checkbox" ? el.checked : el.value; });
    box.querySelectorAll("[data-f]").forEach(el => { next.filters[el.dataset.f] = el.checked; });
    box.querySelectorAll("[data-fn]").forEach(el => { next.filters[el.dataset.fn] = el.value; });
    box.querySelectorAll("[data-min]").forEach(el => { next.filters[el.dataset.min] = { ...next.filters[el.dataset.min], min: el.value }; });
    box.querySelectorAll("[data-max]").forEach(el => { next.filters[el.dataset.max] = { ...next.filters[el.dataset.max], max: el.value }; });
    box.querySelectorAll("[data-words]").forEach(el => { next.filters[el.dataset.words] = el.value; });
    return F.cleanConfig(next);
  }

  function renderForm() {
    const box = $("#coAutoBox");
    if (!box) return;
    box.innerHTML = formHtml();
    box.dataset.ready = "1";
    showWhen(box);
  }
  // sections follow the two switches (at the top of the tab) and the text mode (sidepanel.js has the rule language)
  function showWhen(box = $("#coAutoBox")) {
    if (!box || !globalThis.HatchrWhen) return;
    const vals = { enabled: !!draft.enabled, ownBuys: !!draft.ownBuys, textMode: (box.querySelector("#ca-textMode") || {}).value || draft.textMode, boost: (box.querySelector("#ca-boost") || {}).checked };
    box.querySelectorAll("[data-if]").forEach(el => { el.hidden = !globalThis.HatchrWhen(el.dataset.if, vals); });
  }
  function refreshStatus() {
    renderCard();
    const st = $("#caStatus"), lg = $("#caLog");
    if (st) st.innerHTML = statusHtml();
    if (lg) lg.innerHTML = logHtml(40);
  }

  // ---------- importing Axiom filters ----------
  function runImport(text) {
    const box = $("#coAutoBox");
    if (box) draft = readForm(box);
    let result;
    try { result = F.importAxiom(text, $("#caTab")?.value || "newPairs"); }
    catch (e) { importNote = `<div class="warnbox">${esc(e.message || e)}</div>`; return renderForm(); }
    const names = { newPairs: "New Pairs", finalStretch: "Final Stretch", migrated: "Migrated" };
    if (!result.applied.length && !result.unsupported.length && !result.unknown.length) {
      importNote = '<div class="warnbox">No filters were set in that file, so nothing was changed.</div>';
      return renderForm();
    }
    draft = F.cleanConfig({ ...draft, filters: { ...draft.filters, ...result.patch } });
    dirty = true;
    const list = items => `<ul>${items.map(i => `<li>${i}</li>`).join("")}</ul>`;
    importNote = `<div class="ca-imported"><b>Imported${result.tab ? ` from ${esc(names[result.tab] || result.tab)}` : ""}. Check the values, then press Save.</b>` +
      (result.applied.length ? list(result.applied.map(a => `${esc(a.label)}: ${esc(a.value)}`)) : '<p class="help">None of the filters in the file are ones Hatchr can measure.</p>') +
      (result.unsupported.length ? `<p class="help"><b>Not applied</b>, because only Axiom has this data (Hatchr cannot check it, so these coins are NOT filtered on it):</p>${list(result.unsupported.map(u => `${esc(u.key)} = ${esc(u.value)}`))}` : "") +
      (result.unknown.length ? `<p class="help"><b>Not recognised</b> (left out):</p>${list(result.unknown.map(u => `${esc(u.key)} = ${esc(u.value)}`))}` : "") + "</div>";
    renderForm();
  }

  // ---------- hiding coins on the Callouts tab ----------
  // The eye on a coin hides it from the list (it stays in your wallet and nothing else changes). Hidden coins are counted
  // in a line under the list; "Show" brings them back greyed out, where the crossed eye un-hides one, or "Unhide all".
  const EYE = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M2 12s3.6-7 10-7 10 7 10 7-3.6 7-10 7S2 12 2 12z"/><circle cx="12" cy="12" r="3"/></svg>';
  const EYE_OFF = '<svg viewBox="0 0 24 24" width="14" height="14" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="M3 3l18 18"/><path d="M10.6 5.1A10.9 10.9 0 0 1 12 5c6.4 0 10 7 10 7a17.6 17.6 0 0 1-3.2 4.1M6.5 6.6A17.3 17.3 0 0 0 2 12s3.6 7 10 7a10.6 10.6 0 0 0 4.3-.9"/><path d="M9.9 9.9a3 3 0 0 0 4.2 4.2"/></svg>';
  let hiddenSet = new Set(), showHidden = false, heldWatch = null;
  function applyHidden() {
    const box = $("#held");
    if (!box) return;
    if (heldWatch) heldWatch.disconnect();
    box.querySelectorAll(".ca-hidden-bar").forEach(el => el.remove());
    let count = 0;
    box.querySelectorAll(".dep").forEach(row => {
      const btn = row.querySelector("[data-hide]");
      if (!btn) return;
      const hid = hiddenSet.has(btn.dataset.hide);
      if (hid) count++;
      row.classList.toggle("ca-hid", hid);
      row.hidden = hid && !showHidden;
      const want = hid ? "off" : "on";
      if (btn.dataset.eye !== want) { btn.dataset.eye = want; btn.innerHTML = hid ? EYE_OFF : EYE; btn.title = hid ? "Show this coin in the list again" : "Hide this coin"; btn.setAttribute("aria-label", btn.title); }
    });
    if (count) {
      const bar = document.createElement("div");
      bar.className = "ca-hidden-bar";
      bar.innerHTML = `<span class="muted">${count} hidden coin${count === 1 ? "" : "s"}</span> <button class="link" data-ca="hiddenToggle">${showHidden ? "Hide again" : "Show"}</button>${showHidden ? ' <button class="link" data-ca="unhideAll">Unhide all</button>' : ""}`;
      box.appendChild(bar);
    } else showHidden = false;
    if (heldWatch) heldWatch.observe(box, { childList: true });
  }
  async function setHidden(mints, hide) {
    for (const mint of mints) { if (hide) hiddenSet.add(mint); else hiddenSet.delete(mint); }
    applyHidden();
    try { await chrome.storage.local.set({ coHidden: [...hiddenSet].slice(-5000) }); } catch { /* stays hidden for this session at least */ }
  }
  (async () => {
    try { const { coHidden } = await chrome.storage.local.get("coHidden"); if (Array.isArray(coHidden)) hiddenSet = new Set(coHidden); } catch { /* nothing hidden */ }
    const box = $("#held");
    if (box) { heldWatch = new MutationObserver(applyHidden); heldWatch.observe(box, { childList: true }); }
    applyHidden();
  })();

  // What a backup file holds of all this (shown next to "Exported" under Settings → Account).
  let savingAt = 0;
  globalThis.HatchrBackupNote = () => ` Also in the file: your callout settings and filters, ${saved.texts.length} callout text${saved.texts.length === 1 ? "" : "s"}${hiddenSet.size ? `, ${hiddenSet.size} hidden coin${hiddenSet.size === 1 ? "" : "s"}` : ""}.`;

  // ---------- actions ----------
  async function load() {
    try {
      const data = await send({ type: "coAutoGet" });
      saved = F.cleanConfig(data.config); state = data.state; live = !!data.live;
      wallets = Array.isArray(data.wallets) ? data.wallets : []; walletFeed = !!data.walletFeed;
      if (!loaded || !dirty) draft = F.cleanConfig(saved);
      loaded = true;
    } catch { /* background not up yet: the next poll gets it */ }
    try {
      const { settings } = await chrome.storage.local.get("settings");
      dryRun = !settings || settings.dryRun !== false;
    } catch { /* keep what we had */ }
  }

  async function save(box) {
    const next = readForm(box);
    savingAt = Date.now();
    // Chrome only shows its permission question straight from a click, so this comes before anything else.
    if ((next.enabled || next.ownBuys) && chrome.permissions && chrome.runtime.id !== "hatchr-desktop") {
      let allowed = false;
      try { allowed = await chrome.permissions.request({ origins: PUMP_ORIGINS }); } catch { allowed = false; }
      if (!allowed) { formNote = '<span class="ca-bad">Chrome did not allow pump.fun, and a callout cannot be sent without it. Nothing was switched on.</span>'; next.enabled = false; next.ownBuys = false; }
      else formNote = "";
    } else formNote = "";
    try {
      savingAt = Date.now();
      const data = await send({ type: "coAutoSave", config: next });
      saved = F.cleanConfig(data.config); state = data.state; live = !!data.live;
      draft = F.cleanConfig(saved); dirty = false; importNote = "";
      if (!formNote) formNote = saved.enabled || saved.ownBuys ? (dryRun ? "Saved. Running in TEST: nothing is bought or posted." : "Saved. Running LIVE.") : "Saved. Automatic callouts are off.";
      // Nothing is capped any more, so a slip of the finger is pointed out instead.
      const heads = [];
      if (saved.priorityFee >= 0.01) heads.push(`The priority fee is ${saved.priorityFee} SOL on every single buy.`);
      if (saved.buyUsd < 1.2) heads.push("With a buy under about $1.20, pump.fun usually refuses the callout: it needs $1 held after fees.");
      if (saved.enabled && saved.minIntervalMin === 0 && saved.maxPerDay === 0) heads.push("No waiting and no daily limit: every coin that passes your filters is bought, for as long as the wallet has SOL above your reserve.");
      if (heads.length) formNote += ` <span class="ca-warn">${heads.map(esc).join(" ")}</span>`;
    } catch (e) { formNote = `<span class="ca-bad">${esc(e.message || e)}</span>`; }
    renderForm(); renderCard();
  }

  document.addEventListener("click", async e => {
    const eye = e.target.closest("[data-hide]");
    if (eye) { e.preventDefault(); e.stopPropagation(); return setHidden([eye.dataset.hide], !hiddenSet.has(eye.dataset.hide)); }
    const btn = e.target.closest("[data-ca]");
    if (!btn) return;
    if (btn.dataset.ca === "hiddenToggle") { showHidden = !showHidden; return applyHidden(); }
    if (btn.dataset.ca === "unhideAll") { showHidden = false; return setHidden([...document.querySelectorAll("#held .dep.ca-hid [data-hide]")].map(b => b.dataset.hide), false); }
    const box = $("#coAutoBox"), act = btn.dataset.ca;
    if (act === "open") {
      $('.tabs button[data-tab="settings"]')?.click();
      $('#subtabs button[data-sub="callauto"]')?.click();
    } else if (act === "skipWait") {
      try { const data = await send({ type: "coAutoSkipWait" }); state = data.state; live = !!data.live; } catch { /* next poll */ }
      refreshStatus();
    } else if (act === "resume") {
      try { const data = await send({ type: "coAutoResume" }); state = data.state; live = !!data.live; } catch { /* next poll */ }
      refreshStatus();
    } else if (act === "clearLog") {
      try { const data = await send({ type: "coAutoClearLog" }); state = data.state; } catch { /* next poll */ }
      refreshStatus();
    } else if (act === "save" && box) {
      btn.disabled = true;
      await save(box);
    } else if (act === "reset" && box) {
      draft = F.cleanConfig({ ...readForm(box), filters: F.DEFAULT_FILTERS });
      dirty = true; importNote = ""; formNote = "Filters are back to Hatchr's defaults. Press Save to keep them.";
      renderForm();
    } else if (act === "importFile") {
      $("#caFile")?.click();
    } else if (act === "importPaste") {
      const p = $("#caPasteBox"); if (p) { p.hidden = !p.hidden; if (!p.hidden) $("#caPaste")?.focus(); }
    } else if (act === "importPasteCancel") {
      const p = $("#caPasteBox"); if (p) p.hidden = true;
    } else if (act === "importPasteGo") {
      runImport($("#caPaste")?.value || "");
    }
  });
  document.addEventListener("change", e => {
    if (e.target.id === "caFile") {
      const file = e.target.files && e.target.files[0];
      if (!file) return;
      if (file.size > 2e6) { importNote = '<div class="warnbox">That file is too large to be a filter export.</div>'; return renderForm(); }
      file.text().then(runImport, () => { importNote = '<div class="warnbox">The file could not be read.</div>'; renderForm(); });
      return;
    }
    const box = e.target.closest("#coAutoBox");
    if (!box || e.target.id === "caTab") return;
    dirty = true; draft = readForm(box);
    showWhen(box);
  });
  // Keep what is typed, so it survives the form being rebuilt.
  document.addEventListener("input", e => { const box = e.target.closest("#coAutoBox"); if (box && e.target.id !== "caPaste") { dirty = true; draft = readForm(box); } });

  // The settings form is rebuilt by sidepanel.js now and then; put ours back, with unsaved changes kept.
  const mount = () => { const box = $("#coAutoBox"); if (box && !box.dataset.ready && loaded) renderForm(); };
  const host = $("#settingsForm");
  if (host) new MutationObserver(mount).observe(host, { childList: true });

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      if (changes.coAutoState) { state = changes.coAutoState.newValue || state; refreshStatus(); }
      if (changes.coHidden) { hiddenSet = new Set(Array.isArray(changes.coHidden.newValue) ? changes.coHidden.newValue : []); applyHidden(); }
      // The callout settings changed from outside this form: a backup was imported. Show what was loaded, straight away.
      // (Before, the form kept showing the old values, and pressing Save there wrote them back over the import.)
      // Only a switch was flipped (the switches at the top of the tab): the form follows, other unsaved edits stay.
      const same = (a, b) => JSON.stringify({ ...a, enabled: 0, ownBuys: 0 }) === JSON.stringify({ ...b, enabled: 0, ownBuys: 0 });
      if (changes.coAuto && Date.now() - savingAt > 2000 && saved && same(F.cleanConfig(changes.coAuto.newValue), saved)) {
        const next = F.cleanConfig(changes.coAuto.newValue);
        saved = next; draft = { ...draft, enabled: next.enabled, ownBuys: next.ownBuys };
        renderForm(); renderCard();
      } else if (changes.coAuto && Date.now() - savingAt > 2000) {
        saved = F.cleanConfig(changes.coAuto.newValue); draft = F.cleanConfig(saved); dirty = false; importNote = "";
        formNote = changes.coAutoWhy && changes.coAutoWhy.newValue && changes.coAutoWhy.newValue.why === "no-wait"
          ? "Minutes between callouts was moved from the old default of 180 to 0 (no waiting)."
          : "Callout settings, filters and texts were loaded from your backup. Both switches arrive off: switch on what you want and press Save.";
        renderForm(); renderCard();
      }
      if (changes.settings) { const s = changes.settings.newValue; dryRun = !s || s.dryRun !== false; refreshStatus(); }
    });
  } catch { /* no storage events: the poll below keeps it fresh */ }

  // Only while something of it is on screen: its page (Trade → Auto callouts) or its card (Callouts tab).
  const onScreen = () => { const a = $("#coAutoBox"), b = $("#coAutoCard"); return (a && a.offsetParent !== null) || (b && b.offsetParent !== null); };
  async function poll(force) {
    if (document.visibilityState === "hidden" || (!force && loaded && !onScreen())) return;
    await load();
    mount();
    refreshStatus();
  }
  poll(true);
  setInterval(poll, 5000);
  document.addEventListener("click", e => { if (e.target.closest && e.target.closest(".tabs button, #subtabs button")) setTimeout(() => poll(), 0); });
})();
