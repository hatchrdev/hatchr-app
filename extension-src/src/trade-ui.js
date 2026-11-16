/* The Trade tab: the features that buy, sell and watch by themselves, each on its own page.
     CA buy (ca-buy.js)  ·  Copy trade (copytrade.js)  ·  Positions (positions.js)  ·  Pump alerts (pump-alerts.js)
   (Auto callouts has its page here too; callout-auto-ui.js draws it.)
   Every page is split into short sections, and a field only shows when it applies (data-if, the same rule language
   as in Settings: "a", "!a", "a=x", "a!=x"). The on/off switches sit at the top of the tab (switches-ui.js), not in
   the forms. Light: nothing is asked of the background unless the Trade tab is open, and then only for the page you
   look at. */
(() => {
  "use strict";
  const esc = s => String(s ?? "").replace(/[&<>"']/g, c => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
  const send = message => chrome.runtime.sendMessage(message).then(r => { if (!r || !r.ok) throw new Error(r && r.error || "No answer from Hatchr"); return r.data; });
  const $ = (sel, root = document) => root.querySelector(sel);
  const val = v => (v === null || v === undefined ? "" : String(v));
  const clock = at => new Date(at).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit", second: "2-digit" });
  const isDesktop = chrome.runtime.id === "hatchr-desktop";
  const ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
  const when = (rule, vals) => (globalThis.HatchrWhen ? globalThis.HatchrWhen(rule, vals) : true);
  const iff = rule => (rule ? ` data-if="${esc(rule)}"` : "");
  const field = (id, key, label, value, help = "", placeholder = "", type = "number", rule = "") =>
    `<div class="fld"${iff(rule)}><label for="${id}">${esc(label)}</label><input id="${id}" data-k="${key}" type="${type}" ${type === "number" ? 'min="0" step="any"' : 'autocomplete="off" spellcheck="false"'} placeholder="${esc(placeholder)}" value="${esc(val(value))}"/>${help ? `<div class="help">${esc(help)}</div>` : ""}</div>`;
  const check = (id, key, label, on, help = "", rule = "") =>
    `<div class="fld check"${iff(rule)}><input type="checkbox" id="${id}" data-k="${key}" ${on ? "checked" : ""}/><div><label for="${id}">${esc(label)}</label>${help ? `<div class="help">${esc(help)}</div>` : ""}</div></div>`;
  const select = (id, key, label, value, options, help = "", rule = "") =>
    `<div class="fld"${iff(rule)}><label for="${id}">${esc(label)}</label><select id="${id}" data-k="${key}">${options.map(([v, l]) => `<option value="${esc(v)}" ${v === value ? "selected" : ""}>${esc(l)}</option>`).join("")}</select>${help ? `<div class="help">${esc(help)}</div>` : ""}</div>`;
  const grid = (a, b, rule = "") => `<div class="grid2"${iff(rule)}>${a}${b || "<div></div>"}</div>`;
  const sec = (title, body, rule = "", hint = "") => `<section class="tr-sec"${iff(rule)}><h4 class="tr-h">${esc(title)}</h4>${hint ? `<p class="help tr-hint">${hint}</p>` : ""}${body}</section>`;
  const logHtml = rows => rows && rows.length ? '<div class="ca-log">' + rows.map(r => {
    const links = [r.url ? `<a href="${esc(r.url)}" target="_blank" rel="noopener noreferrer">post</a>` : "", r.mint ? `<a href="https://pump.fun/coin/${esc(r.mint)}" target="_blank" rel="noopener noreferrer">coin</a>` : "",
      r.signature ? `<a href="https://solscan.io/tx/${esc(r.signature)}" target="_blank" rel="noopener noreferrer">tx</a>` : ""].filter(Boolean).join(" · ");
    return `<div class="ca-row ${esc(r.kind || "call")}"><span class="ca-time">${esc(clock(r.at).slice(0, 5))}</span><span>${esc(r.text)}${links ? ` <span class="ca-links">${links}</span>` : ""}</span></div>`;
  }).join("") + "</div>" : '<p class="help">Nothing yet.</p>';
  const ago = at => { const s = Math.max(0, Math.round((Date.now() - at) / 1000)); return s < 90 ? `${s} s ago` : s < 5400 ? `${Math.round(s / 60)} min ago` : `${Math.round(s / 3600)} h ago`; };
  const short4 = a => `${String(a).slice(0, 4)}…${String(a).slice(-4)}`;
  const read = box => { const out = {}; box.querySelectorAll("[data-k]").forEach(el => { out[el.dataset.k] = el.type === "checkbox" ? el.checked : el.value; }); return out; };
  const usd = n => (n >= 1e6 ? `$${(n / 1e6).toFixed(2)}M` : n >= 1e3 ? `$${(n / 1e3).toFixed(1)}K` : `$${Math.round(n)}`);
  // a field with a rule shows only when the rule holds for what the form says (and the switches: extra)
  function applyIf(box, extra = {}) {
    if (!box) return;
    const vals = { ...extra, ...read(box) };
    box.querySelectorAll("[data-if]").forEach(el => { el.hidden = !when(el.dataset.if, vals); });
  }
  const pill = (on, test) => (on ? (test ? '<span class="ca-pill test">TEST</span>' : '<span class="ca-pill live">LIVE</span>') : "");

  // ---------- ⚡ Boost: the network's fee of the moment instead of a fixed one ----------
  const BOOST_SLIP = { buy: 35, copy: 35, sell: 30 }; // trade-routes.js BOOST_SLIPPAGE
  function boostBlock(idp, kp, x, fee, kind) {
    const on = !!x[`boost`];
    const now = fee && fee.fee ? `${fee.fee} SOL now (${esc(fee.how)}${fee.capped ? ", held at the cap" : ""})` : "read from your RPC when it is needed";
    return `<div class="boost-row"><label class="boost-pill ${on ? "on" : ""}" title="Fast without overpaying"><input type="checkbox" id="${idp}-boost" data-k="${kp}boost" ${on ? "checked" : ""}/><span>⚡ Boost</span></label>
        <span class="help" data-if="${kp}boost">Priority fee: what the network asks right now, never above 0.003 SOL: ${now}. Slippage ${BOOST_SLIP[kind]}%.</span>
        <span class="help" data-if="!${kp}boost">One click for the fastest fill without paying over the odds: the fee follows the network, capped.</span></div>
      ${grid(field(`${idp}-slippage`, `${kp}slippage`, "Slippage (%)", x.slippage, kind === "sell" ? "" : "A fresh coin moves fast; too low and it fails."), field(`${idp}-priorityFee`, `${kp}priorityFee`, "Priority fee (SOL)", x.priorityFee, "Paid on every trade."), `!${kp}boost`)}`;
  }

  // ---------- automatic exits (positions.js runs them) ----------
  function exitsBlock(idp, kp, xIn, fee) {
    const x = xIn || { on: false, tp: [], mcSell: 100, slippage: 25, priorityFee: 0.0005 };
    const tp = i => (x.tp || [])[i] || {};
    return `${check(`${idp}-on`, `${kp}on`, "Sell automatically", x.on)}
      <div data-if="${kp}on">
        <p class="help tr-hint">Checked every 2 seconds. Coins on the pump.fun curve are priced straight from the chain; others from DexScreener (a rule then has to hold on two readings).</p>
        ${[0, 1, 2].map(i => grid(field(`${idp}-tp${i}u`, `${kp}tp${i + 1}Up`, i ? `…then at +(%)` : "Take profit at +(%)", tp(i).up, "", i ? "" : "100"), field(`${idp}-tp${i}s`, `${kp}tp${i + 1}Sell`, "sell (% of what is left)", tp(i).sell || "", "", "100"), i ? `${kp}tp${i}Up` : "")).join("")}
        ${grid(field(`${idp}-sl`, `${kp}sl`, "Stop loss at -(%)", x.sl, "Sells everything.", "off"), field(`${idp}-trail`, `${kp}trail`, "Trailing stop (% under the top)", x.trail, "Arms once the coin is in profit.", "off"))}
        ${grid(field(`${idp}-mc`, `${kp}mcUsd`, "Sell at market cap ($)", x.mcUsd, "", "off"), field(`${idp}-mcs`, `${kp}mcSell`, "…sell (%)", x.mcSell, "", "100", "number", `${kp}mcUsd`))}
        ${field(`${idp}-after`, `${kp}afterMin`, "Sell everything after (minutes)", x.afterMin, "", "off")}
        <div class="tr-sub">Selling</div>
        ${boostBlock(`${idp}-s`, kp, x, fee, "sell")}
      </div>`;
  }
  function readExits(raw, kp) {
    const out = { on: raw[`${kp}on`] === true, tp: [1, 2, 3].map(i => ({ up: raw[`${kp}tp${i}Up`], sell: raw[`${kp}tp${i}Sell`] || 100 })).filter(s => s.up !== "" && s.up !== undefined),
      sl: raw[`${kp}sl`], trail: raw[`${kp}trail`], mcUsd: raw[`${kp}mcUsd`], mcSell: raw[`${kp}mcSell`], afterMin: raw[`${kp}afterMin`],
      slippage: raw[`${kp}slippage`], priorityFee: raw[`${kp}priorityFee`], boost: raw[`${kp}boost`] === true };
    for (const k of Object.keys(raw)) if (k.startsWith(kp)) delete raw[k];
    return out;
  }
  // the switches at the top of the tab own these; a Save keeps what they say
  async function stored(key) { try { return (await chrome.storage.local.get(key))[key] || {}; } catch { return {}; } }

  // =====================================================================================================
  // CA buy (with the launch watch)
  // =====================================================================================================
  const ca = { cfg: null, data: null, dirty: false, note: "" };
  function caStatus() {
    const d = ca.data;
    if (!d) return "…";
    const c = d.config;
    let text = "Off. Switch it on at the top.", tone = "";
    if (c.enabled && !c.handles.length) { text = "No accounts entered yet."; tone = "warn"; }
    else if (c.enabled && !d.wallet) { text = "No Hatchr wallet to buy with yet (Settings → Account)."; tone = "bad"; }
    else if (c.enabled) { text = `Ready. A contract address posted by ${c.handles.slice(0, 4).map(h => "@" + h).join(", ")}${c.handles.length > 4 ? ` and ${c.handles.length - 4} more` : ""} is bought for ${c.buySol} SOL${c.smart ? "; launch watch on" : ""}.`; tone = "ok"; }
    const more = c.enabled ? `<div class="help">Wallet ${d.wallet ? esc(short4(d.wallet)) : "-"}${d.balance !== null && d.balance !== undefined ? `, ${Number(d.balance).toFixed(3)} SOL` : ""} · bought today: ${d.state.buysToday || 0}${c.maxPerDay ? ` of ${c.maxPerDay}` : ""}</div>` : "";
    return `<div class="ca-status ${tone}"><div><b>CA buy</b> ${pill(c.enabled, d.test)}</div><div class="ca-now">${esc(text)}</div>${more}${c.enabled ? caSources(d) : ""}</div>`;
  }
  // Where the posts come from, and whether each chosen account's posts reach Hatchr at all.
  function caSources(d) {
    const c = d.config, src = d.sources || {}, st = d.state || {}, a = src.axiom, rows = [];
    const fresh = a && Date.now() - a.at < 35000;
    let axiom, tone, fix = "";
    if (src.axiomTabs === 0) { axiom = "no axiom.trade tab is open. Hatchr opens one by itself within half a minute (Settings → Sources → Keep Axiom running), or press the button."; tone = "bad"; fix = "Open Axiom"; }
    else if (fresh && a.live) { axiom = `connected, tweet stream live${a.lastTweetAt ? `, last tracker post ${ago(a.lastTweetAt)}` : ""}.`; tone = "ok"; }
    else if (fresh) { axiom = "the tab is connected, but Axiom's tweet stream is not open. Sign in on axiom.trade; Hatchr keeps the X tracker open for you."; tone = "warn"; fix = "Reconnect"; }
    else if (src.desktop) { axiom = a ? `not heard from for ${ago(a.at).replace(" ago", "")}. Open Axiom in the app and sign in.` : "not connected yet. Open Axiom in the app and sign in."; tone = "warn"; }
    else { axiom = "an axiom.trade tab is open but is not talking to Hatchr (this happens after Hatchr is updated). Press Reconnect."; tone = "bad"; fix = "Reconnect"; }
    rows.push(`<div><span class="${tone}">●</span> Axiom: ${esc(axiom)}</div>`);
    if (src.xTabs) rows.push(`<div><span class="acc">●</span> ${src.xTabs} X tab${src.xTabs === 1 ? "" : "s"} open: read too when “X tabs” is on (Settings → Sources). Slower than Axiom.</div>`);
    for (const handle of c.handles.slice(0, 8)) {
      const seen = st.seen && st.seen[handle];
      rows.push(seen
        ? `<div><span class="ok">●</span> @${esc(handle)}: last post reached Hatchr ${esc(ago(seen.at))}${seen.why ? ` (${esc(seen.why)})` : ""}.</div>`
        : `<div><span class="warn">●</span> @${esc(handle)}: no post seen yet. Posts only arrive for accounts on your <b>Axiom X tracker</b> list: on axiom.trade open the X tracker and add @${esc(handle)}.</div>`);
    }
    for (const w of (st.watches || []).filter(x => x.state === "watching").slice(0, 3)) rows.push(`<div><span class="ok">●</span> Watching for @${esc(w.handle)}'s ${esc(w.label)}: ${Math.max(0, Math.round((w.until - Date.now()) / 1000))} s left.</div>`);
    const devs = Object.entries(st.devs || {}).filter(([h]) => c.handles.includes(h));
    if (c.smart && devs.length) rows.push(`<div class="acc">Known dev wallets: ${devs.map(([h, list]) => `@${esc(h)} → ${list.map(short4).map(esc).join(", ")}`).join("; ")} <button class="link" data-x="cbForget">Forget</button></div>`);
    if (st.lastPost) rows.push(`<div class="acc">Last post from any account: ${esc(ago(st.lastPost.at))}${st.lastPost.handle ? ` (@${esc(st.lastPost.handle)}${st.lastPost.source ? `, via ${esc(st.lastPost.source === "axiom" ? "Axiom" : st.lastPost.source === "x" ? "an X tab" : st.lastPost.source)}` : ""})` : ""}.</div>`);
    else rows.push(`<div class="acc">No post from any account has reached CA buy since it was switched on.</div>`);
    if (fix && !src.desktop) rows.push(`<button class="ghost" data-x="cbReconnect">${esc(fix)}</button>`);
    return `<div class="ca-src">${rows.join("")}</div>`;
  }
  function caForm() {
    const c = ca.cfg, d = ca.data || {};
    return `<div id="cbStatus">${caStatus()}</div>
      <p class="help tr-intro">When one of these X accounts posts a contract address, Hatchr buys it at once. Posts come from Axiom's X tracker (the account has to be on your tracker list there, and the Axiom tab has to stay open). Follows TEST / LIVE at the top.</p>
      ${sec("Accounts", `<div class="fld"><label for="cb-handles">X accounts (one per line)</label><textarea id="cb-handles" data-k="handles" rows="3" spellcheck="false" placeholder="@account">${esc(c.handles.map(h => "@" + h).join("\n"))}</textarea></div>
        ${grid(check("cb-t1", "t_TWEET", "Their own posts", c.types.TWEET), check("cb-t2", "t_REPLY", "Their replies", c.types.REPLY))}
        ${grid(check("cb-t3", "t_QUOTE", "Their quote posts", c.types.QUOTE), check("cb-t4", "t_RETWEET", "Their reposts", c.types.RETWEET))}
        ${check("cb-quoted", "quoted", "Also take an address from the post they quote or reply to", c.quoted)}`)}
      ${sec("Buy", `${grid(field("cb-buySol", "buySol", "Buy size (SOL)", c.buySol), field("cb-reserveSol", "reserveSol", "Always keep in wallet (SOL)", c.reserveSol))}
        ${grid(field("cb-maxPerDay", "maxPerDay", "Buys per day", c.maxPerDay, "0 = no limit."), field("cb-cooldownSec", "cooldownSec", "Pause per account after a buy (s)", c.cooldownSec, "0 = no pause."))}
        ${field("cb-maxAgeSec", "maxAgeSec", "Ignore posts older than (seconds)", c.maxAgeSec, "A post that reaches Hatchr late is not chased. 0 = any age.")}
        ${check("cb-onlyPump", "onlyPump", "Only pump.fun coins (address ends in “pump”)", c.onlyPump, "Off: any Solana coin address is bought, wherever it trades.")}`)}
      ${sec("Speed", boostBlock("cb", "", c, d.boostFee, "buy"))}
      ${sec("Launch watch", `<p class="help tr-hint">A post with a $TICKER and/or a picture but no address (like “$COIN · Just a social experiment”): Hatchr watches every new pump.fun coin and buys the first one that matches. Same size, speed and limits as above.</p>
        ${select("cb-smartMatch", "smartMatch", "A coin matches when it has", c.smartMatch, [["all", "Everything the post shows (ticker and picture)"], ["either", "The ticker or the picture (fastest, more fakes)"], ["ticker", "The ticker"], ["picture", "The picture"]], "Pictures are compared by how they look, so a resized or re-saved copy still matches.")}
        ${grid(field("cb-smartWindowSec", "smartWindowSec", "Watch for (seconds)", c.smartWindowSec, "After the post."), field("cb-smartBeforeSec", "smartBeforeSec", "Also coins made before it (s)", c.smartBeforeSec, "Some devs launch first, then post."))}
        ${check("cb-smartName", "smartName", "A coin whose name is the ticker counts too", c.smartName, "", "smartMatch!=picture")}
        ${field("cb-smartWords", "smartWords", "Only posts with one of these words (optional)", c.smartWords, "Comma separated. Empty: any post with a $ticker or picture.", "launch, live, soon", "text")}
        <div class="tr-sub">Against fakes</div>
        ${check("cb-smartLearn", "smartLearn", "Once Hatchr knows an account's dev wallet, only coins made by it", c.smartLearn, "Learned when the account posts the address of a coin made in the 10 minutes before.")}
        <div class="fld"><label for="cb-smartDevs">Dev wallets to accept (optional, one per line)</label><textarea id="cb-smartDevs" data-k="smartDevs" rows="2" spellcheck="false" placeholder="wallet address">${esc((c.smartDevs || []).join("\n"))}</textarea></div>
        ${check("cb-smartLink", "smartLink", "The coin must link to the account (X link or website)", c.smartLink, "Slower: the coin's details are read first.")}
        <div class="warnbox">Bots launch coins with the same ticker, often the same picture, seconds after a post like this, usually before the real dev. A known dev wallet is the only strong guard.</div>`, "smart",
        "")}
      <p class="help tr-hint" data-if="!smart">Turn on <b>Launch watch</b> at the top to also buy coins that are announced without an address.</p>
      ${sec("Sell", `${exitsBlock("cb-x", "x_", c.exits, d.boostFee)}
        <p class="help" data-if="callout,x_on"><span class="ca-warn">Coins you call out are not sold automatically</span> (that would be call-and-dump); you can still sell them on the Positions page.</p>`)}
      ${sec("Callout", check("cb-callout", "callout", "Call the coin out on pump.fun after the buy", c.callout, "Uses your callout texts and timing from Trade → Auto callouts."))}
      <div class="warnbox">Hatchr buys whatever address the account posts, without looking at the coin. If the account is hacked or posts a scam, you bought it. Each address is bought once.</div>
      <div class="onboard-row"><button data-x="cbSave">Save</button></div>
      <div id="cbNote" class="help">${ca.note}</div>
      <details class="ca-details" open><summary>Activity</summary><div id="cbLog">${logHtml(d.state && d.state.log)}</div><button class="link" data-x="cbClear">Clear</button></details>`;
  }
  function caRead(box) {
    const raw = read(box), types = {};
    for (const t of ["TWEET", "REPLY", "QUOTE", "RETWEET"]) { types[t] = raw["t_" + t] === true; delete raw["t_" + t]; }
    const exits = readExits(raw, "x_");
    return { ...raw, types, exits };
  }

  // =====================================================================================================
  // Copy trade
  // =====================================================================================================
  const ct = { cfg: null, data: null, dirty: false, note: "", open: -1 };
  function ctStatus() {
    const d = ct.data;
    if (!d) return "…";
    const c = d.config, st = d.state || {}, on = c.wallets.filter(w => w.on);
    let text = "Off. Switch it on at the top.", tone = "";
    if (c.enabled && !on.length) { text = c.wallets.length ? "Every wallet is switched off." : "No wallets added yet."; tone = "warn"; }
    else if (c.enabled && !d.wallet) { text = "No Hatchr wallet to copy with yet (Settings → Account)."; tone = "bad"; }
    else if (c.enabled && !d.rpc) { text = "No Solana RPC set (Settings → Launch). Copy trade listens to your RPC."; tone = "bad"; }
    else if (c.enabled && !d.live) { text = "Connecting to your RPC…"; tone = "warn"; }
    else if (c.enabled) { text = `Live: following ${on.length} wallet${on.length === 1 ? "" : "s"}.`; tone = "ok"; }
    const rows = c.enabled ? on.slice(0, 8).map(w => {
      const last = st.last && st.last[w.address];
      return `<div><span class="${last ? "ok" : "acc"}">●</span> ${esc(w.label || short4(w.address))}: ${last ? `last ${last.side === "create" ? "launch" : last.side} ${esc(ago(last.at))} (${esc(String(last.mint).slice(0, 6))}…, ${esc(last.venue)})` : "no trade seen yet"}</div>`;
    }).join("") : "";
    const more = c.enabled ? `<div class="help">Wallet ${d.wallet ? esc(short4(d.wallet)) : "-"}${d.balance !== null && d.balance !== undefined ? `, ${Number(d.balance).toFixed(3)} SOL` : ""} · copies today: ${st.buysToday || 0}${c.maxPerDay ? ` of ${c.maxPerDay}` : ""}</div>` : "";
    return `<div class="ca-status ${tone}"><div><b>Copy trade</b> ${pill(c.enabled, d.test)}</div><div class="ca-now">${esc(text)}</div>${more}${rows ? `<div class="ca-src">${rows}</div>` : ""}</div>`;
  }
  function walletSummary(w, c) {
    const what = { buys: "their buys", launches: "only coins they create", both: "buys + their launches" }[w.what];
    const size = w.size === "fixed" ? `${w.sol || c.buySol} SOL` : w.size === "ratio" ? `${w.ratioPct ?? c.ratioPct}% of theirs` : c.sizeMode === "ratio" ? `${c.ratioPct}% of theirs` : `${c.buySol} SOL`;
    const sells = (w.sells === "default" ? c.copySells : w.sells === "copy") ? "sells copied" : "sells not copied";
    return `${what} · ${size} · ${sells}${w.exits === "own" ? " · own exits" : w.exits === "none" ? " · no exits" : ""}`;
  }
  function walletCard(w, i, c, fee) {
    const k = `w${i}.`;
    return `<details class="wcard" data-w="${i}" ${ct.open === i ? "open" : ""}>
      <summary><span class="wdot ${w.on ? "on" : ""}"></span><b>${esc(w.label || short4(w.address))}</b><span class="wsum">${esc(walletSummary(w, c))}</span></summary>
      <div class="wbody">
        <input type="hidden" data-k="${k}address" value="${esc(w.address)}"/>
        <div class="help"><code>${esc(w.address)}</code></div>
        ${grid(field(`ct-w${i}-label`, `${k}label`, "Name", w.label, "", "whale", "text"), check(`ct-w${i}-on`, `${k}on`, "Follow this wallet", w.on))}
        ${select(`ct-w${i}-what`, `${k}what`, "Copy", w.what, [["buys", "Everything they buy"], ["launches", "Only coins they create (their launches)"], ["both", "Their buys and their launches"]],
          w.what === "buys" ? "" : "A launch is bought in the same moment they create the coin, with the fixed amount.")}
        ${select(`ct-w${i}-size`, `${k}size`, "Size", w.size, [["default", `Like below (${c.sizeMode === "ratio" ? `${c.ratioPct}% of theirs` : `${c.buySol} SOL`})`], ["fixed", "A fixed amount for this wallet"], ["ratio", "A share of what this wallet spends"]])}
        ${field(`ct-w${i}-sol`, `${k}sol`, "Amount per copy (SOL)", w.sol, "", String(c.buySol), "number", `${k}size=fixed`)}
        ${grid(field(`ct-w${i}-ratio`, `${k}ratioPct`, "Share of theirs (%)", w.ratioPct, "", String(c.ratioPct)), field(`ct-w${i}-max`, `${k}maxSol`, "At most (SOL)", w.maxSol, "", String(c.maxSol)), `${k}size=ratio`)}
        ${select(`ct-w${i}-sells`, `${k}sells`, "When they sell", w.sells, [["default", `Like below (${c.copySells ? "sell the same share" : "do nothing"})`], ["copy", "Sell the same share of mine"], ["no", "Do nothing"]])}
        ${select(`ct-w${i}-exits`, `${k}exits`, "Automatic exits", w.exits, [["default", "Like below"], ["own", "Own rules for this wallet"], ["none", "None for this wallet"]])}
        <div data-if="${k}exits=own" class="tr-inset">${exitsBlock(`ct-w${i}-x`, `${k}x_`, w.ownExits, fee)}</div>
        <div class="tr-sub">Duplicate for another wallet</div>
        <div class="wadd"><input class="ctDupAddr" placeholder="other wallet address" spellcheck="false" autocomplete="off"/><input class="ctDupName" placeholder="name (optional)" spellcheck="false" autocomplete="off"/><button class="ghost" data-x="ctDup" data-i="${i}">Duplicate</button></div>
        <p class="help ctDupNote">Adds another wallet with exactly these settings: what to copy, size, sells and exits.</p>
        <button class="link danger" data-x="ctDel" data-i="${i}">Remove this wallet</button>
      </div></details>`;
  }
  function ctForm() {
    const c = ct.cfg, d = ct.data || {};
    return `<div id="ctStatus">${ctStatus()}</div>
      <p class="help tr-intro">When a wallet you follow buys, Hatchr buys too, straight away; when it sells, Hatchr can sell the same share. It listens to your own RPC and reads pump.fun and PumpSwap trades from the transaction log the moment they land (other exchanges about a second later). Follows TEST / LIVE at the top.</p>
      ${sec("Wallets", `${c.wallets.map((w, i) => walletCard(w, i, c, d.boostFee)).join("") || '<p class="help">No wallets yet.</p>'}
        <div class="wadd"><input id="ctNewAddr" placeholder="wallet address" spellcheck="false" autocomplete="off"/><input id="ctNewName" placeholder="name (optional)" spellcheck="false" autocomplete="off"/><button class="ghost" data-x="ctAdd">Add</button></div>
        <p class="help">Open a wallet to give it its own size, its own sell rule, its own exits, or to copy only the coins it creates.</p>`)}
      ${sec("Buy", `${select("ct-sizeMode", "sizeMode", "Size per copy", c.sizeMode, [["fixed", "A fixed amount"], ["ratio", "A share of what they spend"]], "For every wallet that has no size of its own.")}
        ${field("ct-buySol", "buySol", "Amount per copy (SOL)", c.buySol, "Also used for launches.", "", "number")}
        ${grid(field("ct-ratioPct", "ratioPct", "Share of theirs (%)", c.ratioPct, "100 = the same SOL as they spend."), field("ct-maxSol", "maxSol", "At most per copy (SOL)", c.maxSol, "0 = no cap."), "sizeMode=ratio")}
        ${field("ct-minTheirSol", "minTheirSol", "Ignore their buys under (SOL)", c.minTheirSol, "Skips dust and test buys.")}
        ${grid(field("ct-maxPerDay", "maxPerDay", "Copies per day", c.maxPerDay, "0 = no limit."), field("ct-reserveSol", "reserveSol", "Always keep in wallet (SOL)", c.reserveSol))}
        ${check("ct-oncePerCoin", "oncePerCoin", "Copy only their first buy of a coin", c.oncePerCoin, "Off: every top-up of theirs is copied too.")}
        ${check("ct-onlyPump", "onlyPump", "Only pump.fun coins (address ends in “pump”)", c.onlyPump)}
        ${field("ct-maxAgeSec", "maxAgeSec", "Skip a trade seen later than (seconds)", c.maxAgeSec, "Only trades on other exchanges are read the slow way. 0 = any.")}`)}
      ${sec("Speed", boostBlock("ct", "", c, d.boostFee, "copy"))}
      ${sec("Sell", `${check("ct-copySells", "copySells", "When they sell, sell the same share of mine", c.copySells, "They sell half: Hatchr sells half of yours.")}
        ${check("ct-onlyCopied", "onlyCopied", "…only coins Hatchr bought by copying", c.onlyCopied, "Off: also coins you bought yourself, when they sell them.", "copySells")}
        <div class="tr-sub">Automatic exits</div>${exitsBlock("ct-x", "x_", c.exits, d.boostFee)}`)}
      <div class="warnbox">Your copy lands one or two blocks after theirs, at a higher price. Some wallets buy to be copied and sell into their followers. Copy trading is only as good as the wallet you copy.</div>
      <div class="onboard-row"><button data-x="ctSave">Save</button></div>
      <div id="ctNote" class="help">${ct.note}</div>
      <details class="ca-details" open><summary>Activity</summary><div id="ctLog">${logHtml(d.state && d.state.log)}</div><button class="link" data-x="ctClear">Clear</button></details>`;
  }
  function ctRead(box) {
    const raw = read(box);
    const wallets = [...box.querySelectorAll(".wcard")].map(card => {
      const k = `w${card.dataset.w}.`;
      const ownExits = readExits(raw, `${k}x_`);
      const w = { address: raw[`${k}address`], label: raw[`${k}label`], on: raw[`${k}on`] === true, what: raw[`${k}what`], size: raw[`${k}size`], sol: raw[`${k}sol`], ratioPct: raw[`${k}ratioPct`], maxSol: raw[`${k}maxSol`], sells: raw[`${k}sells`], exits: raw[`${k}exits`], ownExits };
      for (const key of Object.keys(raw)) if (key.startsWith(k)) delete raw[key];
      return w;
    });
    const exits = readExits(raw, "x_");
    return { ...raw, wallets, exits };
  }

  // =====================================================================================================
  // Positions
  // =====================================================================================================
  const ps = { data: null, edit: "", note: "" };
  function posCard(p, i, fee) {
    // the gain is the price against the price paid (what the rules measure); value is what is still held
    const value = p.price && p.tokens ? p.price * p.tokens : null, gain = p.price && p.entry ? (p.price / p.entry - 1) * 100 : null;
    const age = Math.max(0, Math.round((Date.now() - p.openedAt) / 60000));
    const name = p.ticker ? "$" + p.ticker : short4(p.mint);
    const desc = globalThis.HatchrPositionsText ? globalThis.HatchrPositionsText(p.exits) : "";
    const k = `p${i}.`;
    return `<div class="pos ${gain === null ? "" : gain >= 0 ? "up" : "down"}" data-mint="${esc(p.mint)}" data-paper="${p.paper ? 1 : 0}">
      <div class="pos-top"><a href="https://pump.fun/coin/${esc(p.mint)}" target="_blank" rel="noopener noreferrer"><b>${esc(name)}</b></a>${p.paper ? ' <span class="ca-pill test">TEST</span>' : ""}<span class="pos-pnl">${gain === null ? "…" : `${gain >= 0 ? "+" : ""}${gain.toFixed(1)}%`}</span></div>
      <div class="help">${esc(p.source)}${p.by ? ` · ${esc(p.by)}` : ""} · cost ${Number(p.costSol).toFixed(3)} SOL${value !== null ? ` · now ${value.toFixed(4)} SOL` : ""}${p.mcUsd ? ` · MC ${usd(p.mcUsd)}` : ""} · ${age} min</div>
      <div class="help">${p.calledOut ? "Called out: no automatic exits." : esc(desc || "No automatic exits.")}${p.done && p.done.length ? ` Done: ${esc(p.done.join(", "))}.` : ""}${p.paused ? ' <span class="ca-bad">Paused after failed sells.</span>' : ""}</div>
      <div class="pos-btns">${[25, 50, 100].map(n => `<button class="mini" data-x="posSell" data-pct="${n}">Sell ${n}%</button>`).join("")}<button class="link" data-x="posEdit">Exits…</button><button class="link" data-x="posForget">Forget</button></div>
      ${ps.edit === p.mint ? `<div class="pos-edit tr-inset" data-k-root="${k}">${exitsBlock(`pos${i}`, `${k}x_`, p.exits, fee)}<div class="onboard-row"><button data-x="posExitsSave">Save these exits</button></div></div>` : ""}
    </div>`;
  }
  function psForm() {
    const d = ps.data;
    if (!d) return '<p class="help">…</p>';
    const open = d.list.filter(p => p.status === "open"), closed = d.list.filter(p => p.status !== "open" && !p.forgotten).slice(0, 8);
    const real = open.filter(p => !p.paper), paper = open.filter(p => p.paper);
    const total = real.reduce((a, p) => a + (p.price && p.tokens ? p.price * p.tokens : 0), 0), cost = real.reduce((a, p) => a + p.costSol, 0);
    return `<div class="ca-status ${open.length ? "ok" : ""}"><div><b>Positions</b> ${pill(true, d.test)}</div>
        <div class="ca-now">${open.length ? `${real.length} open${paper.length ? ` and ${paper.length} TEST` : ""}${real.length ? ` · worth ${total.toFixed(3)} SOL for ${cost.toFixed(3)} SOL` : ""}.` : "Nothing open."}</div>
        <div class="help">Coins Hatchr bought by itself (CA buy, launch watch, copy trade). Their exit rules are set on those pages; change them per coin here.</div></div>
      <div id="psList">${open.map((p, i) => posCard(p, i, d.fee)).join("")}</div>
      <div id="psNote" class="help">${ps.note}</div>
      ${closed.length ? `<details class="ca-details"><summary>Closed</summary>${closed.map(p => `<div class="help">${esc(p.ticker ? "$" + p.ticker : short4(p.mint))}${p.paper ? " (TEST)" : ""} · ${esc(p.source)} · cost ${Number(p.costSol).toFixed(3)} SOL${p.soldSol ? ` · sold for about ${Number(p.soldSol).toFixed(3)} SOL` : ""}</div>`).join("")}</details>` : ""}
      <details class="ca-details" open><summary>Activity</summary><div id="psLog">${logHtml(d.log)}</div><button class="link" data-x="psClear">Clear</button></details>`;
  }

  // =====================================================================================================
  // Pump alerts
  // =====================================================================================================
  const pa = { cfg: null, data: null, dirty: false, note: "", tgNote: "" };
  function paStatus() {
    const d = pa.data;
    if (!d) return "…";
    const c = d.config, s = d.state;
    let text = "Off. Switch it on at the top.", tone = "";
    if (c.enabled && s.error) { text = `Prices could not be read: ${s.error}`; tone = "bad"; }
    else if (c.enabled && !s.at) { text = "Reading prices…"; tone = "warn"; }
    else if (c.enabled) { text = `Watching ${s.watched || 0} coin${s.watched === 1 ? "" : "s"} you hold. Last read ${clock(s.at)}.`; tone = "ok"; }
    const phone = c.enabled ? `<div class="help">Phone: ${c.tgOn && c.tgToken && c.tgChat ? (s.pushError ? `<span class="ca-bad">${esc(s.pushError)}</span>` : "connected") : "not set up"}</div>` : "";
    return `<div class="ca-status ${tone}"><div><b>Pump alerts</b></div><div class="ca-now">${esc(text)}</div>${phone}</div>`;
  }
  function paCoins() {
    const coins = ((pa.data && pa.data.state.coins) || []).filter(c => c.last > 0).sort((a, b) => b.up - a.up).slice(0, 40);
    if (!coins.length) return "";
    return `<div class="ca-coins">${coins.map(c => `<div class="ca-coin"><span>${esc(c.ticker ? "$" + c.ticker : c.name || c.mint.slice(0, 6) + "…")}</span><span class="${c.up >= 0 ? "up" : "down"}">${c.up >= 0 ? "+" : ""}${c.up.toFixed(0)}%</span><span class="muted">${c.value !== null && c.value !== undefined ? "$" + Number(c.value).toFixed(2) : ""}</span></div>`).join("")}</div>`;
  }
  function paForm() {
    const c = pa.cfg;
    return `<div id="paStatus">${paStatus()}</div>
      <p class="help tr-intro">Hatchr reads the price of every coin in your wallet every 20 seconds and tells you when one jumps. A jump only counts when it shows on two readings in a row, in the same pool, with real trades, so a coin that sits still never alerts. Nothing is sold for you.</p>
      ${sec("When", `${field("pa-risePct", "risePct", "Alert when a coin is up (%)", c.risePct, "From the price when Hatchr started watching it; after an alert the mark moves up. Empty = off.", "off")}
        ${grid(field("pa-fastPct", "fastPct", "Sudden move: up (%)", c.fastPct, "", "off"), field("pa-fastMin", "fastMin", "…within (minutes)", c.fastMin, "", "5", "number", "fastPct"))}
        ${field("pa-minValueUsd", "minValueUsd", "Ignore holdings worth less than ($)", c.minValueUsd || "", "Empty = every coin.", "any")}
        ${check("pa-skipHidden", "skipHidden", "Leave out coins I hid on the Callouts tab", c.skipHidden)}`)}
      ${sec("How", `${grid(check("pa-desktop", "desktop", "Notification on this computer", c.desktop), check("pa-sound", "sound", "Play a sound", c.sound))}
        ${check("pa-tgOn", "tgOn", "Also on my phone (Telegram, iPhone and Android)", c.tgOn)}
        <div data-if="tgOn" class="tr-inset">
          <ol class="ca-steps"><li>In Telegram, open <b>@BotFather</b>, send <b>/newbot</b>, copy the token.</li><li>Paste it below.</li><li>Open your bot and press <b>Start</b>.</li><li>Press <b>Connect</b>, then <b>Send a test</b>.</li></ol>
          ${field("pa-tgToken", "tgToken", "Bot token", c.tgToken, "", "123456789:AA…", "password")}
          ${grid(field("pa-tgChat", "tgChat", "Chat", c.tgChat, "Filled in by Connect.", "", "text"), `<div class="fld"><label>&nbsp;</label><div class="onboard-row"><button class="ghost" data-x="paConnect">Connect</button><button class="ghost" data-x="paTest">Send a test</button></div></div>`)}
          <div id="paTg" class="help">${pa.tgNote}</div>
          ${check("pa-tgEvents", "tgEvents", "Also send buys, sells and callouts to my phone", c.tgEvents)}
        </div>`)}
      <div class="onboard-row"><button data-x="paSave">Save</button><button class="ghost" data-x="paReset" title="Forget the marks and measure every coin from its price right now">Measure from now</button></div>
      <div id="paNote" class="help">${pa.note}</div>
      <details class="ca-details" open><summary>Since Hatchr started watching</summary><div id="paCoins">${paCoins() || '<p class="help">No prices yet.</p>'}</div></details>
      <details class="ca-details"><summary>Alerts</summary><div id="paLog">${logHtml(pa.data && pa.data.state.log)}</div><button class="link" data-x="paClear">Clear</button></details>`;
  }


  // =====================================================================================================
  // Watchlist: coins you keep an eye on, with a market-cap alert (coin-watch.js does the watching)
  // =====================================================================================================
  const wa = { cfg: null, data: null, dirty: false, note: "", edit: "" };
  const mcText = v => (v > 0 ? usd(v) : "…");
  function waStatus() {
    const d = wa.data;
    if (!d) return "…";
    const c = d.config, s = d.state, n = c.items.length;
    let text = "Off. Switch it on at the top.", tone = "";
    if (c.enabled && !n) { text = "Add a coin below."; tone = "warn"; }
    else if (c.enabled && s.error) { text = `Prices could not be read: ${s.error}`; tone = "bad"; }
    else if (c.enabled && !s.at) { text = "Reading prices…"; tone = "warn"; }
    else if (c.enabled) { text = `Watching ${n} coin${n === 1 ? "" : "s"}, every ${c.everySec} s. Last read ${clock(s.at)}.`; tone = "ok"; }
    const phone = c.enabled && c.phone ? `<div class="help">Phone: ${d.phone.ready ? (d.phone.error ? `<span class="ca-bad">${esc(d.phone.error)}</span>` : "connected") : 'not set up (Trade → Pump alerts → "Also on my phone")'}</div>` : "";
    return `<div class="ca-status ${tone}"><div><b>Watchlist</b></div><div class="ca-now">${esc(text)}</div>${phone}</div>`;
  }
  function waLevel(side, s, mc) {
    if (!s.level) return "";
    const arrow = side === "below" ? "↓" : "↑", word = side === "below" ? "at or below" : "at or above";
    const state = s.armed ? `<span class="muted">waiting</span>` : `<span class="ca-ok">hit ${clock(s.firedAt)} at ${usd(s.firedMc)}</span>`;
    return `<div class="help">${arrow} Alert ${word} <b>${usd(s.level)}</b> · ${state}${!s.armed ? ` <span class="muted">(again after it moves 25% back${mc > 0 ? `; now ${usd(mc)}` : ""})</span>` : ""}</div>`;
  }
  function waCard(c) {
    const name = c.label || (c.ticker ? "$" + c.ticker : c.name || short4(c.mint));
    const change = c.mc > 0 && c.startMc > 0 ? (c.mc / c.startMc - 1) * 100 : null;
    const editing = wa.edit === c.mint;
    return `<div class="pos ${change === null ? "" : change >= 0 ? "up" : "down"}" data-wmint="${esc(c.mint)}">
      <div class="pos-top"><a href="https://pump.fun/coin/${esc(c.mint)}" target="_blank" rel="noopener noreferrer"><b>${esc(name)}</b></a>${c.label && c.ticker ? ` <span class="muted">$${esc(c.ticker)}</span>` : ""}<span class="pos-pnl">MC ${mcText(c.mc)}</span></div>
      <div class="help">${c.startMc ? `${usd(c.startMc)} when added` : "No price yet"}${change !== null ? ` · ${change >= 0 ? "+" : ""}${change.toFixed(1)}%` : ""}${c.low ? ` · low ${usd(c.low)} · high ${usd(c.high)}` : ""}${c.src === "curve" ? " · on the bonding curve" : ""}${c.missing > 3 ? ' · <span class="ca-warn">no price found for it</span>' : ""}</div>
      ${waLevel("below", c.below, c.mc)}${waLevel("above", c.above, c.mc)}
      ${!c.below.level && !c.above.level ? '<div class="help muted">No alert set: only watched.</div>' : ""}
      <div class="pos-btns"><a class="mini" href="https://axiom.trade/t/${esc(c.mint)}" target="_blank" rel="noopener noreferrer">Axiom</a><button class="link" data-x="waEdit">Change…</button>${!c.below.armed || !c.above.armed ? '<button class="link" data-x="waRearm">Alert again now</button>' : ""}<button class="link danger" data-x="waRemove">Remove</button></div>
      ${editing ? `<div class="tr-inset"><div class="wadd"><input class="waEdBelow" placeholder="alert at or below ($), e.g. 4k" value="${c.below.level || ""}" autocomplete="off"/><input class="waEdAbove" placeholder="at or above ($)" value="${c.above.level || ""}" autocomplete="off"/></div>
        <div class="wadd"><input class="waEdName" placeholder="name (optional)" value="${esc(c.label)}" autocomplete="off"/><button class="ghost" data-x="waEditSave">Save</button><button class="link" data-x="waEditCancel">Cancel</button></div></div>` : ""}
    </div>`;
  }
  function waList() {
    const coins = (wa.data && wa.data.state.coins) || [];
    return coins.length ? coins.map(waCard).join("") : '<p class="help">Nothing on the watchlist yet.</p>';
  }
  function waForm() {
    const c = wa.cfg;
    return `<div id="waStatus">${waStatus()}</div>
      <p class="help tr-intro">Coins you keep an eye on. Set a market cap and Hatchr tells you when the coin gets there, for example when it dumps to $4k, so you can look at it and buy yourself. Nothing is bought or sold here. Coins still on the bonding curve are read straight from it; the rest from DexScreener, where a level has to show twice in a row.</p>
      ${sec("Add a coin", `<div class="wadd"><input id="waAddr" placeholder="coin address, or a pump.fun / Axiom / DexScreener link" spellcheck="false" autocomplete="off"/></div>
        <div class="wadd"><input id="waBelow" placeholder="alert at or below ($ MC), e.g. 4k" autocomplete="off"/><input id="waAbove" placeholder="or at or above, e.g. 50k" autocomplete="off"/></div>
        <div class="wadd"><input id="waName" placeholder="name (optional)" spellcheck="false" autocomplete="off"/><button class="ghost" data-x="waAdd">Watch</button></div>
        <p class="help">Write amounts like 4000, 4k or 1.2m. After an alert, the same level alerts again once the market cap has moved 25% back.</p>`)}
      <div id="waList">${waList()}</div>
      <div id="waNote" class="help">${wa.note}</div>
      ${sec("How", `${grid(check("wa-desktop", "desktop", "Notification on this computer", c.desktop, "Click it to open the coin on Axiom."), check("wa-sound", "sound", "Play a sound", c.sound))}
        ${check("wa-phone", "phone", "Also on my phone (Telegram)", c.phone, "Uses the Telegram bot set up under Pump alerts.")}
        ${field("wa-everySec", "everySec", "Check every (seconds)", c.everySec, "10 to 120.")}
        <div class="onboard-row"><button class="ghost" data-x="waSave">Save</button></div>`)}
      <details class="ca-details" open><summary>Alerts</summary><div id="waLog">${logHtml(wa.data && wa.data.state.log)}</div><button class="link" data-x="waClear">Clear</button></details>`;
  }

  // =====================================================================================================
  // drawing, data, polling (only the page you look at, only while the Trade tab is open)
  // =====================================================================================================
  const P = () => globalThis.HatchrPanel;
  const page = () => (P() ? P().tradeSub() : "cabuy");
  const visible = () => document.visibilityState !== "hidden" && !!$("#tab-trade.on");
  const PAGES = {
    cabuy: { box: "#caBuyBox", get: "caBuyGet", obj: ca, form: caForm, extra: () => ({ smart: !!(ca.data && ca.data.config.smart), enabled: !!(ca.data && ca.data.config.enabled) }) },
    copy: { box: "#copyBox", get: "copyGet", obj: ct, form: ctForm, extra: () => ({}) },
    positions: { box: "#posBox", get: "posGet", obj: ps, form: psForm, extra: () => ({}) },
    pumps: { box: "#pumpBox", get: "pumpGet", obj: pa, form: paForm, extra: () => ({}) },
    watch: { box: "#watchBox", get: "watchGet", obj: wa, form: waForm, extra: () => ({}) },
  };
  function render(id) {
    const pg = PAGES[id], box = pg && $(pg.box);
    if (!box || !pg.obj.data || (pg.obj !== ps && !pg.obj.cfg)) return;
    box.innerHTML = pg.form();
    box.dataset.ready = "1";
    applyIf(box, pg.extra());
  }
  // only the parts that change by themselves: status, lists, activity (a form being typed in is left alone)
  function refresh(id) {
    const pg = PAGES[id], box = pg && $(pg.box);
    if (!box || !box.dataset.ready) return render(id);
    if (id === "cabuy") { const s = $("#cbStatus"), l = $("#cbLog"); if (s) s.innerHTML = caStatus(); if (l) l.innerHTML = logHtml(ca.data.state.log); applyIf(box, pg.extra()); }
    else if (id === "copy") { const s = $("#ctStatus"), l = $("#ctLog"); if (s) s.innerHTML = ctStatus(); if (l) l.innerHTML = logHtml(ct.data.state.log); }
    else if (id === "pumps") { const s = $("#paStatus"), l = $("#paLog"), c = $("#paCoins"); if (s) s.innerHTML = paStatus(); if (l) l.innerHTML = logHtml(pa.data.state.log); if (c) c.innerHTML = paCoins() || '<p class="help">No prices yet.</p>'; }
    else if (id === "positions") { if (!ps.edit) render(id); else { const l = $("#psLog"); if (l) l.innerHTML = logHtml(ps.data.log); } }
    else if (id === "watch") { const s = $("#waStatus"), l = $("#waLog"), w = $("#waList"); if (s) s.innerHTML = waStatus(); if (l) l.innerHTML = logHtml(wa.data.state.log); if (w && !wa.edit) w.innerHTML = waList(); }
  }
  async function load(id) {
    const pg = PAGES[id];
    if (!pg) return;
    try {
      const data = await send({ type: pg.get });
      if (id === "positions") { try { data.fee = (ca.data && ca.data.boostFee) || (ct.data && ct.data.boostFee) || null; } catch { /* only for the text */ } }
      pg.obj.data = data;
      if (pg.obj !== ps && (!pg.obj.cfg || !pg.obj.dirty)) pg.obj.cfg = data.config;
    } catch { /* background not up yet */ }
  }
  let timer = null, current = "";
  async function poll() {
    if (!visible()) return;
    const id = page();
    if (!PAGES[id]) return;
    await load(id);
    if (id !== current) { current = id; render(id); } else refresh(id);
  }
  function schedule() {
    clearInterval(timer); timer = null;
    if (!visible() || !PAGES[page()]) return;
    poll();
    timer = setInterval(poll, page() === "positions" ? 2000 : 4000);
  }
  // sidepanel.js tells this file which page is shown; the tab bar and visibility are watched here
  globalThis.HatchrTrade = Object.freeze({ shown: () => { current = ""; schedule(); } });
  document.addEventListener("visibilitychange", schedule);
  document.addEventListener("click", e => { if (e.target.closest && e.target.closest(".tabs button[data-tab]")) setTimeout(schedule, 0); });

  // ---------- Save buttons and the rest ----------
  const allow = async origins => {
    if (isDesktop || !chrome.permissions) return true;
    try { return await chrome.permissions.request({ origins }); } catch { return false; }
  };
  document.addEventListener("click", async e => {
    const btn = e.target.closest("[data-x]");
    if (!btn) return;
    const act = btn.dataset.x, cbBox = $("#caBuyBox"), paBox = $("#pumpBox"), xBox = $("#copyBox");
    try {
      if (act === "cbSave" && cbBox) {
        const now = await stored("caBuy");
        const next = { ...caRead(cbBox), enabled: now.enabled === true, smart: now.smart === true };
        allow(["https://lite-api.jup.ag/*", "https://api.dexscreener.com/*"]); // Chrome asks only straight from a click; not waited for
        ca.data = await send({ type: "caBuySave", config: next });
        ca.cfg = ca.data.config; ca.dirty = false;
        ca.note = ca.cfg.enabled ? (ca.data.test ? "Saved. Running in TEST: a matching post is reported (and a TEST position opened), nothing is bought." : "Saved. Running LIVE: a matching post is bought at once.") : "Saved. CA buy is off: switch it on at the top.";
        if (!ca.cfg.boost && ca.cfg.priorityFee >= 0.05) ca.note += ` <span class="ca-warn">The priority fee is ${ca.cfg.priorityFee} SOL on every buy.</span>`;
        render("cabuy");
      } else if (act === "cbClear") { ca.data = await send({ type: "caBuyClearLog" }); refresh("cabuy"); }
      else if (act === "cbForget") { ca.data = await send({ type: "caBuyForgetDevs" }); refresh("cabuy"); }
      else if (act === "cbReconnect") {
        btn.disabled = true; btn.textContent = "Reconnecting…";
        const r = await send({ type: "reconnectSources" });
        const parts = [r.axiom ? `${r.axiom} Axiom tab${r.axiom === 1 ? "" : "s"} reconnected` : "", r.reloaded ? `${r.reloaded} Axiom tab${r.reloaded === 1 ? "" : "s"} reloaded` : "", r.opened ? "an Axiom tab was opened (sign in there if asked)" : "", r.x ? `${r.x} X tab${r.x === 1 ? "" : "s"} reconnected` : ""].filter(Boolean);
        ca.note = parts.length ? parts.join(", ") + ". The status turns green within ten seconds once Axiom talks to Hatchr again." : "No tab to reconnect.";
        const el = $("#cbNote"); if (el) el.innerHTML = esc(ca.note);
        setTimeout(() => load("cabuy").then(() => refresh("cabuy")), 3000);
      }
      else if (act === "ctAdd" && xBox) {
        const address = String($("#ctNewAddr").value || "").trim(), label = String($("#ctNewName").value || "").trim();
        if (!ADDRESS.test(address)) throw new Error("That is not a Solana wallet address.");
        const draft = ctRead(xBox);
        if (draft.wallets.some(w => w.address === address)) throw new Error("That wallet is already on the list.");
        draft.wallets.push({ address, label, on: true, what: "both", size: "default", sells: "default", exits: "default", ownExits: null });
        ct.cfg = { ...ct.cfg, ...draft }; ct.dirty = true; ct.open = draft.wallets.length - 1;
        ct.note = "Added. Press Save to start following it.";
        render("copy");
      } else if (act === "ctDup" && xBox) {
        // a second wallet with this wallet's settings, including edits not saved yet
        const i = Number(btn.dataset.i), card = btn.closest(".wcard");
        const address = String(card.querySelector(".ctDupAddr").value || "").trim(), name = String(card.querySelector(".ctDupName").value || "").trim();
        if (!ADDRESS.test(address)) throw new Error("That is not a Solana wallet address.");
        const draft = ctRead(xBox), from = draft.wallets[i];
        if (!from) throw new Error("That wallet is gone from the list; open the page again.");
        if (draft.wallets.some(w => w.address === address)) throw new Error("That wallet is already on the list.");
        const copy = JSON.parse(JSON.stringify({ ...from, address, label: name || (from.label ? `${from.label} 2` : ""), on: true }));
        draft.wallets.splice(i + 1, 0, copy);
        ct.cfg = { ...ct.cfg, ...draft }; ct.dirty = true; ct.open = i + 1;
        ct.note = `Duplicated ${from.label ? `“${from.label}”` : short4(from.address)} for ${copy.label ? `“${copy.label}”` : short4(address)} with the same settings. Press Save to start following it.`;
        render("copy");
        const added = document.querySelector(`#copyBox .wcard[data-w="${i + 1}"]`);
        if (added) added.scrollIntoView({ block: "nearest" });
      } else if (act === "ctDel" && xBox) {
        const draft = ctRead(xBox), i = Number(btn.dataset.i);
        draft.wallets.splice(i, 1);
        ct.cfg = { ...ct.cfg, ...draft }; ct.dirty = true; ct.open = -1;
        ct.note = "Removed. Press Save to stop following it.";
        render("copy");
      } else if (act === "ctSave" && xBox) {
        const now = await stored("copyTrade");
        const next = { ...ctRead(xBox), enabled: now.enabled === true, v: 2 };
        allow(["https://lite-api.jup.ag/*", "https://api.dexscreener.com/*"]);
        ct.data = await send({ type: "copySave", config: next });
        ct.cfg = ct.data.config; ct.dirty = false;
        ct.note = ct.cfg.enabled ? (ct.data.test ? "Saved. Running in TEST: their trades are reported (and TEST positions opened), nothing is bought or sold." : "Saved. Running LIVE: their trades are copied at once.") : "Saved. Copy trade is off: switch it on at the top.";
        render("copy");
      } else if (act === "ctClear") { ct.data = await send({ type: "copyClearLog" }); refresh("copy"); }
      else if (act.startsWith("pos")) {
        const card = btn.closest(".pos"), mint = card && card.dataset.mint, paper = card && card.dataset.paper === "1";
        if (act === "posSell") { btn.disabled = true; ps.data = await send({ type: "posSell", mint, paper, pct: Number(btn.dataset.pct) }); ps.note = ""; render("positions"); }
        else if (act === "posForget") { ps.data = await send({ type: "posForget", mint, paper }); render("positions"); }
        else if (act === "posEdit") { ps.edit = ps.edit === mint ? "" : mint; render("positions"); }
        else if (act === "posExitsSave") {
          const root = card.querySelector(".pos-edit"), raw = read(root), kp = `${root.dataset.kRoot}x_`;
          ps.data = await send({ type: "posExits", mint, paper, exits: readExits(raw, kp) });
          ps.edit = ""; ps.note = "Exits saved for this coin."; render("positions");
        }
      }
      else if (act === "psClear") { ps.data = await send({ type: "posClearLog" }); render("positions"); }
      else if (act === "paSave" && paBox) {
        const now = await stored("pumpAlerts");
        const next = { ...read(paBox), enabled: now.enabled === true };
        allow(["https://api.dexscreener.com/*", "https://api.telegram.org/*"]);
        pa.data = await send({ type: "pumpSave", config: next });
        pa.cfg = pa.data.config; pa.dirty = false;
        pa.note = pa.cfg.enabled ? "Saved. Pump alerts are on." : "Saved. Pump alerts are off: switch them on at the top.";
        if (pa.cfg.tgOn && !(pa.cfg.tgToken && pa.cfg.tgChat)) pa.note += ' <span class="ca-warn">The phone is not connected yet: paste the token, press Connect, then Save.</span>';
        render("pumps");
      } else if (act === "paClear") { pa.data = await send({ type: "pumpClearLog" }); refresh("pumps"); }
      else if (act === "waAdd") {
        const address = String($("#waAddr").value || "").trim();
        if (!address) throw new Error("Paste a coin address or link first.");
        allow(["https://api.dexscreener.com/*"]);
        btn.disabled = true; btn.textContent = "Looking it up…";
        wa.data = await send({ type: "watchAdd", address, below: $("#waBelow").value, above: $("#waAbove").value, label: $("#waName").value });
        wa.cfg = wa.data.config; wa.note = wa.data.note || "Added."; render("watch");
      } else if (act === "waSave") {
        const box = $("#watchBox"), now = await stored("coinWatch");
        wa.data = await send({ type: "watchSave", config: { ...read(box), enabled: now.enabled === true } });
        wa.cfg = wa.data.config; wa.dirty = false; wa.note = "Saved."; render("watch");
      } else if (act === "waClear") { wa.data = await send({ type: "watchClearLog" }); refresh("watch"); }
      else if (act.startsWith("wa")) {
        const card = btn.closest("[data-wmint]"), mint = card && card.dataset.wmint;
        if (!mint) return;
        if (act === "waEdit") { wa.edit = mint; render("watch"); }
        else if (act === "waEditCancel") { wa.edit = ""; render("watch"); }
        else if (act === "waEditSave") {
          wa.data = await send({ type: "watchEdit", mint, below: card.querySelector(".waEdBelow").value, above: card.querySelector(".waEdAbove").value, label: card.querySelector(".waEdName").value });
          wa.edit = ""; wa.cfg = wa.data.config; wa.note = "Alert changed."; render("watch");
        } else if (act === "waRemove") { wa.data = await send({ type: "watchRemove", mint }); wa.cfg = wa.data.config; wa.note = "Removed from the watchlist."; render("watch"); }
        else if (act === "waRearm") { wa.data = await send({ type: "watchRearm", mint }); wa.note = "It will alert again when the level is reached."; render("watch"); }
      }
      else if (act === "paReset") { pa.data = await send({ type: "pumpReset" }); pa.note = "Every coin is now measured from its price right now."; render("pumps"); }
      else if (act === "paConnect" && paBox) {
        await allow(["https://api.telegram.org/*"]);
        const draft = read(paBox);
        const got = await send({ type: "pumpConnect", token: draft.tgToken });
        pa.cfg = { ...pa.cfg, ...draft, tgChat: got.chat, tgOn: true }; pa.dirty = true;
        pa.tgNote = `Connected to @${esc(got.bot)}${got.who ? `, writing to ${esc(got.who)}` : ""}. Press Send a test, then Save.`;
        render("pumps");
      } else if (act === "paTest" && paBox) {
        await allow(["https://api.telegram.org/*"]);
        await send({ type: "pumpTest", config: read(paBox) });
        pa.tgNote = "Sent. Check Telegram on your phone."; const el = $("#paTg"); if (el) el.textContent = pa.tgNote;
      }
    } catch (err) {
      const near = act === "ctDup" && btn.closest(".wcard") && btn.closest(".wcard").querySelector(".ctDupNote");
      if (near) { near.innerHTML = `<span class="ca-bad">${esc(err.message || err)}</span>`; return; }
      if (act === "waAdd") { btn.disabled = false; btn.textContent = "Watch"; }
      const target = act.startsWith("cb") ? "#cbNote" : act.startsWith("ct") ? "#ctNote" : act.startsWith("pos") || act.startsWith("ps") ? "#psNote" : act.startsWith("wa") ? "#waNote" : act === "paConnect" || act === "paTest" ? "#paTg" : "#paNote";
      const el = $(target); if (el) el.innerHTML = `<span class="ca-bad">${esc(err.message || err)}</span>`;
      if (btn.disabled) btn.disabled = false;
    }
  });
  // typing marks a form as being edited (the poll then leaves it alone) and shows/hides the fields that depend on it
  const typed = e => {
    const cb = e.target.closest("#caBuyBox"), pb = e.target.closest("#pumpBox"), xb = e.target.closest("#copyBox"), pos = e.target.closest(".pos-edit");
    if (e.target.id === "ctNewAddr" || e.target.id === "ctNewName" || (e.target.classList && (e.target.classList.contains("ctDupAddr") || e.target.classList.contains("ctDupName")))) return;
    if (cb) { ca.dirty = true; ca.cfg = { ...ca.cfg, ...caRead(cb), handles: String(read(cb).handles || "").split(/[\s,]+/).map(h => h.replace(/^@/, "")).filter(Boolean) }; applyIf(cb, PAGES.cabuy.extra()); }
    if (xb) { ct.dirty = true; const card = e.target.closest(".wcard"); if (card) ct.open = Number(card.dataset.w); applyIf(xb); }
    if (pb) { pa.dirty = true; pa.cfg = { ...pa.cfg, ...read(pb) }; applyIf(pb); }
    const wb = e.target.closest("#watchBox");
    if (wb && e.target.dataset && e.target.dataset.k) { wa.dirty = true; wa.cfg = { ...wa.cfg, ...read(wb) }; }
    if (pos) applyIf(pos);
  };
  document.addEventListener("input", typed);
  document.addEventListener("change", typed);
  document.addEventListener("toggle", e => { const card = e.target.closest && e.target.closest(".wcard"); if (card && card.open) ct.open = Number(card.dataset.w); }, true);

  try {
    chrome.storage.onChanged.addListener((changes, area) => {
      if (area !== "local") return;
      // the switches at the top: the page follows at once (the launch watch section, the status)
      if (changes.caBuy && ca.data) { const n = changes.caBuy.newValue || {}; ca.data.config = { ...ca.data.config, enabled: !!n.enabled, smart: !!n.smart }; if (ca.cfg) ca.cfg = { ...ca.cfg, enabled: !!n.enabled, smart: !!n.smart }; refresh("cabuy"); }
      if (changes.copyTrade && ct.data) { ct.data.config = { ...ct.data.config, enabled: !!(changes.copyTrade.newValue || {}).enabled }; refresh("copy"); }
      if (changes.pumpAlerts && pa.data) { pa.data.config = { ...pa.data.config, enabled: !!(changes.pumpAlerts.newValue || {}).enabled }; refresh("pumps"); }
      if (changes.positions) badge(changes.positions.newValue);
    });
  } catch { /* the poll keeps it fresh */ }
  // the Trade tab shows how many positions are open
  function badge(v) { const el = $("#tradeCount"); if (el) { const n = (v && Array.isArray(v.list) ? v.list : []).filter(p => p.status === "open").length; el.textContent = n ? String(n) : ""; } }
  chrome.storage.local.get("positions").then(r => badge(r.positions)).catch(() => {});
  // text of the exit rules (the same words positions.js uses)
  globalThis.HatchrPositionsText = x => {
    if (!x || !x.on) return "No automatic exits.";
    const parts = [...(x.tp || []).map(s => `+${s.up}%: sell ${s.sell}%`)];
    if (x.sl) parts.push(`stop loss -${x.sl}%`);
    if (x.trail) parts.push(`trailing ${x.trail}%`);
    if (x.mcUsd) parts.push(`at ${usd(x.mcUsd)} market cap: sell ${x.mcSell}%`);
    if (x.afterMin) parts.push(`after ${x.afterMin} min: sell all`);
    return parts.length ? parts.join(" · ") : "No automatic exits.";
  };
  schedule();
})();
