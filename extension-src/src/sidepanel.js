import { DEFAULTS, DEFAULT_PROMPT, PRESET_HANDLES, AI_PROVIDERS, providerForUrl, lines } from "./lib/settings.js";
import { generateCard, generateTweetImage, bestTwitterImage, autoImageKind } from "./lib/image.js";
import { DEFAULT_IMAGE_STYLE } from "./lib/aiimage.js";
import { GUIDES } from "./lib/guides.js";
import { t, setLang, LANGUAGES } from "./lib/i18n.js";
import { PLATFORMS, platformOf, coinUrl } from "./lib/platforms.js";
import { badChars, vanityTries } from "./lib/vanity.js";
import { computePnl } from "./lib/pnl.js";
import { TOKEN_DEFAULT, PERKS, PREVIEW_BUILD, tierFor, nextTier, hasPerk, fmtAmount } from "./lib/token.js";

const $ = (s, el = document) => el.querySelector(s);
const $$ = (s, el = document) => [...el.querySelectorAll(s)];
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));
const send = (msg) => chrome.runtime.sendMessage(msg).then((r) => { if (!r?.ok) throw new Error(r?.error || "No response"); return r.data; });
const store = {
  get(k) { try { return localStorage.getItem(k); } catch { return null; } },
  set(k, v) { try { localStorage.setItem(k, v); } catch {} },
};

let settings = { ...DEFAULTS };
let feed = [];
let deploys = [];
let heldCoins = [];
let heldInfo = null;
let walletPub = null;
let walletSol = null;
let walletArchive = [];
let axiomStatus = null;
let aiUsage = null;
let rewards = null;
let metaCount = 0;
let pumpStatus = null;
let solPx = null; // { usd, eur, at }
let token = { config: TOKEN_DEFAULT, amount: null, pub: null, error: null }; // $HATCHR: official config + what the wallet holds
let tokenVote = null; // { id, at }
let subTab = store.get("hatchr.sub") || "account";
const edits = {}; // card id -> local edits not yet deployed
const previewCache = new Map();

function ago(time) {
  const s = Math.max(0, Math.round((Date.now() - time) / 1000));
  if (s < 60) return t("{n}s", { n: s });
  if (s < 3600) return t("{n}m", { n: Math.floor(s / 60) });
  if (s < 86400) return t("{n}h", { n: Math.floor(s / 3600) });
  return t("{n}d", { n: Math.floor(s / 86400) });
}
const agoText = (time) => t("{time} ago", { time: ago(time) });

// ---------------- money: SOL, $ or € ----------------
const fmtSol = (n) => (n == null ? "…" : Math.abs(n) >= 1 ? n.toFixed(3) : n.toFixed(4));
const CURRENCIES = ["usd", "eur", "gbp"];
const CUR_SIGN = { usd: "$", eur: "€", gbp: "£" };
const EXCHANGE_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M11.2 1.8 14.4 5l-3.2 3.2-1-1 1.5-1.5H3V4.3h8.7L10.2 2.8z"/><path d="M4.8 14.2 1.6 11l3.2-3.2 1 1-1.5 1.5H13v1.4H4.3l1.5 1.5z"/></svg>`;
function money(sol, { sign = false, solDigits = null } = {}) {
  if (sol == null || !Number.isFinite(Number(sol))) return "…";
  sol = Number(sol);
  const plus = sign && sol > 0 ? "+" : "";
  const cur = settings.currency || "sol";
  const px = cur !== "sol" && solPx ? solPx[cur] : null;
  if (!px) return `${plus}${solDigits != null ? sol.toFixed(solDigits) : fmtSol(sol)} SOL`;
  const v = sol * px;
  const abs = Math.abs(v);
  const digits = abs >= 0.01 || abs === 0 ? 2 : Math.min(6, 1 - Math.floor(Math.log10(abs)));
  const s = new Intl.NumberFormat(navigator.language || "en", { style: "currency", currency: cur.toUpperCase(), minimumFractionDigits: digits, maximumFractionDigits: digits }).format(v);
  return plus + s;
}
async function loadPrice(force = false) {
  if ((settings.currency || "sol") === "sol") return;
  try { solPx = await send({ type: "solPrice", force }); }
  catch (e) { if (!solPx) toast(t("Couldn't get the SOL price right now. Showing SOL."), 3500); }
  renderMoney();
}
function renderMoney() {
  const b = $("#curBtn");
  if (b) b.classList.toggle("on", (settings.currency || "sol") !== "sol");
  if (walletSol != null && !$("#bal").classList.contains("bal-err")) $("#bal").textContent = money(walletSol, { solDigits: walletSol >= 100 ? 2 : 3 });
  const wb = $("#walletBal");
  if (wb && walletSol != null) wb.textContent = money(walletSol, { solDigits: 4 });
  renderDeploys();
  renderRewards();
  renderPnl();
  $$("[data-bal-sol]").forEach((el) => { el.textContent = money(Number(el.dataset.balSol), { solDigits: 4 }); });
  renderFeed();
}
// tiny "SOL ⇄ EUR" switcher under the exchange button
function renderCurPop() {
  const pop = $("#curPop");
  const cur = settings.currency || "sol";
  pop.innerHTML = `<div class="cur-row"><span class="cur-sol">SOL</span><span class="cur-ex">${EXCHANGE_ICON}</span>
      ${CURRENCIES.map((c) => `<button class="cur-opt ${c === cur ? "on" : ""}" data-cur="${c}">${c.toUpperCase()} ${CUR_SIGN[c]}</button>`).join("")}</div>
    ${cur !== "sol" ? `<button class="link cur-off" data-cur="sol">${esc(t("Show in SOL"))}</button>` : ""}`;
}
function closeCurPop() { $("#curPop").hidden = true; }
$("#curBtn").addEventListener("click", (e) => {
  e.stopPropagation();
  const pop = $("#curPop");
  if (!pop.hidden) return closeCurPop();
  renderCurPop();
  pop.hidden = false;
  const r = $("#curBtn").getBoundingClientRect();
  pop.style.top = `${r.bottom + 6}px`;
  pop.style.right = `${Math.max(8, innerWidth - r.right - 4)}px`;
});
$("#curPop").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-cur]");
  if (!b) return;
  const next = b.dataset.cur;
  closeCurPop();
  await setSetting({ currency: next });
  if (next !== "sol") await loadPrice();
  renderMoney();
});
document.addEventListener("click", (e) => { if (!e.target.closest("#curPop, #curBtn")) closeCurPop(); });
setInterval(() => loadPrice(), 180_000);

function toast(text, ms = 2600) {
  const el = document.createElement("div");
  el.className = "toast";
  el.textContent = text;
  document.body.appendChild(el);
  setTimeout(() => el.remove(), ms);
}

function copyText(text, label) {
  navigator.clipboard.writeText(text).then(() => toast(label || t("Copied"))).catch(() => toast(t("Couldn't copy")));
}

function download(name, text) {
  const a = document.createElement("a");
  a.href = URL.createObjectURL(new Blob([text], { type: "application/json" }));
  a.download = name;
  document.body.appendChild(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(a.href), 5000);
}

function applyStatic() {
  $$("[data-i18n]").forEach((el) => { el.textContent = t(el.dataset.i18n); });
  $$("[data-i18n-ph]").forEach((el) => { el.placeholder = t(el.dataset.i18nPh); });
  $$("[data-i18n-title]").forEach((el) => { el.title = t(el.dataset.i18nTitle); });
}

// ---------------- header ----------------
function renderHeader() {
  $$("#modeSeg button").forEach((b) => b.classList.toggle("on", b.dataset.mode === settings.mode));
  const live = !settings.dryRun;
  const chip = $("#dryBtn");
  chip.classList.toggle("live", live);
  chip.classList.toggle("test", !live);
  $(".lbl", chip).textContent = live ? "LIVE" : "TEST";
  chip.title = live
    ? t("LIVE: launches use real SOL. Click to go back to test mode.")
    : t("Test mode: launches are simulated and cost nothing. Click to go LIVE with real SOL.");
  const pb = $("#pauseBtn");
  pb.classList.toggle("on", !!settings.paused);
  $(".lbl", pb).textContent = settings.paused ? t("Start") : t("Pause");
  pb.title = settings.paused ? t("Start: auto mode begins launching") : t("Pause: stop all automatic launches");
  const b = $("#banner");
  b.hidden = false;
  const off = settings.watching === false;
  const wb = $("#watchBtn");
  wb.textContent = off ? t("Turn on") : t("Turn off");
  wb.title = off
    ? t("Turn on: Hatchr watches Axiom, X and Telegram again.")
    : t("Turn off: Hatchr stops watching posts and does nothing in the background, as if it were disabled. Your wallet, the Launched tab and Generate keep working.");
  if (off) {
    b.className = "banner off";
    b.textContent = t("Hatchr is off. It watches no posts and does nothing in the background.") + " ";
    const on = document.createElement("button");
    on.className = "link";
    on.textContent = t("Turn on");
    on.addEventListener("click", () => setSetting({ watching: true }));
    b.appendChild(on);
  }
  else if (settings.paused) { b.className = "banner paused"; b.textContent = t("Paused. Nothing launches automatically. Press Start to begin."); }
  else if (settings.mode === "auto" && live) { b.className = "banner live"; b.textContent = t("AUTO + LIVE: matching posts are launched with real SOL."); }
  else if (settings.mode === "auto") { b.className = "banner dry"; b.textContent = t("Test mode: auto mode runs for real, but launches are only simulated. No money is spent."); }
  else if (!live) { b.className = "banner dry"; b.textContent = t("Test mode: Launch simulates the coin, nothing is spent. Switch to LIVE to launch for real."); }
  else b.hidden = true;
  fitHeader();
}

function scrollTop() { window.scrollTo({ top: 0 }); $("#app").scrollTo({ top: 0 }); }

// Longer languages: drop the wordmark and tighten the tab pills instead of overflowing.
function fitHeader() {
  const top = $(".top"), tabs = $(".tabs");
  top.classList.remove("compact", "snug", "snug2", "no-ai", "no-tier");
  // Nothing in the header may sit under the controls. Make room step by step: tighten the spacing, then shrink
  // the controls a little, and only if that isn't enough drop the holder badge's text (its dot on the logo
  // stays), then the AI badge.
  const crowded = () => {
    const last = [...$(".brand").children].filter((el) => el.offsetParent !== null && !el.classList.contains("tier-dot")).pop();
    return top.scrollWidth > top.clientWidth + 1 || $(".controls").getBoundingClientRect().left < last.getBoundingClientRect().right + 6;
  };
  if (crowded()) top.classList.add("snug");
  if (crowded()) top.classList.add("snug2");
  if (crowded()) top.classList.add("no-tier");
  if (crowded()) top.classList.add("no-ai");
  if (top.scrollWidth > top.clientWidth + 1 || $(".controls").getBoundingClientRect().left < $(".wordmark").getBoundingClientRect().right + 6) top.classList.add("compact");
  // Four tabs and the balance share one row. When they don't fit: tighter pills, then a gear instead of the word
  // "Settings", and as the last step the balance moves to a row of its own.
  tabs.classList.remove("tight", "icons", "wrap");
  const over = () => tabs.scrollWidth > tabs.clientWidth + 1;
  if (over()) tabs.classList.add("tight");
  if (over()) tabs.classList.add("icons");
  if (over()) tabs.classList.add("wrap");
}
addEventListener("resize", () => fitHeader());

async function setSetting(patch) {
  settings = await send({ type: "saveSettings", patch });
  renderHeader();
  renderFeed();
  renderDeploys();
  renderRewards();
  renderPnl();
  renderTier();
}

$$("#modeSeg button").forEach((b) =>
  b.addEventListener("click", async () => {
    const mode = b.dataset.mode;
    if (mode === settings.mode) return;
    if (mode === "auto" && !settings.dryRun &&
      !(await ask(t("Auto mode is LIVE: posts that pass your rules will be launched with real SOL (max {h}/hour, {d}/day, {sol} SOL/day). Continue?", { h: settings.autoMaxPerHour, d: settings.autoMaxPerDay, sol: settings.autoMaxSolPerDay })))) return;
    await setSetting({ mode });
  })
);
$("#dryBtn").addEventListener("click", async () => {
  if (settings.dryRun && !(await ask(settings.mode === "auto"
    ? t("Go LIVE in auto mode? Matching posts will launch real coins and spend real SOL.")
    : t("Go LIVE? Launch will create real coins and spend real SOL."), t("Go LIVE")))) return;
  await setSetting({ dryRun: !settings.dryRun });
});
$("#pauseBtn").addEventListener("click", () => setSetting({ paused: !settings.paused }));
$("#watchBtn").addEventListener("click", () => setSetting({ watching: settings.watching === false }));

async function refreshBalance() {
  try {
    const r = await send({ type: "balance" });
    if (!r) { walletSol = null; $("#bal").textContent = t("no wallet"); $("#bal").style.color = ""; return; }
    walletPub = r.pub;
    walletSol = r.sol;
    $("#bal").classList.remove("bal-err");
    delete $("#bal").dataset.guide;
    delete $("#bal").dataset.err;
    $("#bal").textContent = money(r.sol, { solDigits: r.sol >= 100 ? 2 : 3 });
    $("#bal").title = `${t("Wallet")} ${r.pub}\n${t("Updated {time}", { time: new Date().toLocaleTimeString() })}`;
    const wb = $("#walletBal");
    if (wb) wb.textContent = money(r.sol, { solDigits: 4 });
    renderPnl();
    fitHeader();
  } catch (e) {
    const blocked = /blocked|403|401/.test(e.message);
    $("#bal").textContent = blocked ? t("⚠ RPC blocked") : t("⚠ RPC error");
    $("#bal").title = "";
    $("#bal").classList.add("bal-err");
    $("#bal").dataset.guide = "helius";
    $("#bal").dataset.err = e.message;
    fitHeader();
    $("#bal").style.color = "var(--red)";
    // The header badge already shows "⚠ RPC blocked" with the Helius guide on hover, so no pop-up.
    return;
  }
  $("#bal").style.color = "";
}

// ---------------- tabs ----------------
function showTab(name) {
  $$(".tabs button[data-tab]").forEach((x) => x.classList.toggle("on", x.dataset.tab === name));
  $$(".tab").forEach((el) => el.classList.toggle("on", el.id === `tab-${name}`));
  $("#subtabs").hidden = name !== "settings";
  launchedTabShown(name === "launched");
  calloutsTabShown(name === "callouts");
}
$$(".tabs button[data-tab]").forEach((b) => b.addEventListener("click", () => showTab(b.dataset.tab)));

// ---------------- feed ----------------
function effective(card) {
  return { ...card, ...(edits[card.id] || {}) };
}

const frameRequested = new Set();
function requestFrame(c) {
  if (frameRequested.has(c.id) || c.videoFrameBusy || c.videoFrameError) return;
  if (Date.now() - (c.receivedAt || c.time || 0) > 30 * 60_000) return; // only fresh posts
  frameRequested.add(c.id);
  send({ type: "videoFrame", id: c.id }).catch(() => {});
}
function postPreview(c, fallback) {
  if (c.images?.[0]) return { url: bestTwitterImage(c.images[0]) };
  if (c.videoFrame) return { url: c.videoFrame, badge: t("🎬 frame") };
  if (c.videos?.[0]) {
    requestFrame(c);
    return { ...fallback, badge: c.videoFrameError ? t("🎬 failed") : t("🎬 grabbing…") };
  }
  return fallback;
}

function previewSource(c) {
  const choice = c.imageChoice || "default";
  const fallback = { gen: (settings.imageMode || "post-or-tweet").includes("card") ? "card" : "tweet" };
  if (choice === "custom") return c.imageCustom ? { url: c.imageCustom } : fallback;
  if (choice === "post") return postPreview(c, fallback);
  if (choice === "avatar") return c.avatar ? { url: bestTwitterImage(c.avatar) } : fallback;
  if (choice === "card") return { gen: "card" };
  if (choice === "tweet") return { gen: "tweet" };
  if (choice === "ai") return c.aiImage ? { url: c.aiImage } : { ...fallback, badge: c.aiImageBusy ? t("Generating…") : "AI" };
  if (c.aiImage && choice === "default") return { url: c.aiImage };
  const kind = autoImageKind(c, settings);
  if (kind === "ai") return { gen: "tweet", badge: t("AI at launch") };
  if (kind === "post") return postPreview(c, { gen: "tweet" });
  if (kind === "avatar") return { url: bestTwitterImage(c.avatar) };
  return { gen: kind === "card" ? "card" : "tweet" };
}

async function setPreview(el, c) {
  const img = $(".thumb img", el);
  const src = previewSource(c);
  const badge = $(".thumb-badge", el);
  if (badge) { badge.hidden = !src.badge; badge.textContent = src.badge || ""; }
  if (src.url) { if (img.src !== src.url) img.src = src.url; return; }
  const key = src.gen === "tweet"
    ? ["tweet", c.id, c.author, c.handle, c.avatar].join("|")
    : ["card", c.name, c.ticker, c.handle, (c.text || "").slice(0, 140), settings.cardColor1, settings.cardColor2].join("|");
  if (img.dataset.key === key) return;
  img.dataset.key = key;
  let url = previewCache.get(key);
  if (!url) {
    const blob = src.gen === "tweet"
      ? await generateTweetImage({ author: c.author, handle: c.handle, text: c.text, avatar: c.avatar, verified: c.verified, time: c.time, source: c.source })
      : await generateCard({ name: c.name, ticker: c.ticker, text: c.text, handle: c.handle }, { c1: settings.cardColor1, c2: settings.cardColor2 });
    url = URL.createObjectURL(blob);
    previewCache.set(key, url);
  }
  if (img.dataset.key === key) img.src = url;
}

function cardSkeleton(card) {
  const el = document.createElement("div");
  el.className = "card";
  el.dataset.id = card.id;
  const ttype = { RETWEET: t("repost"), REPLY: t("reply"), QUOTE: t("quote") };
  el.innerHTML = `
    <div class="card-top">
      <span class="src ${esc(card.source)}">${({ x: "X", tg: "TG", axiom: "AX" })[card.source] || t("YOU")}</span>
      ${card.url ? `<a class="who" target="_blank" href="${esc(card.url)}">@${esc(card.handle)}</a>` : `<span class="who">@${esc(card.handle)}</span>`}
      ${card.namedAnimal ? `<span class="paw" title="${esc(t("Named animal: {name}", { name: card.namedAnimal.fullName || card.namedAnimal.name }))}">🐾</span>` : ""}
      ${card.tweetType && card.tweetType !== "TWEET" ? `<span class="ttype">${esc(ttype[card.tweetType] || card.tweetType.toLowerCase())}</span>` : ""}
      <span class="age"></span>
      <span class="ai-tag" hidden>✨ AI</span>
      <span class="score" hidden></span>
      <button class="dismiss" title="${esc(t("Dismiss"))}">×</button>
    </div>
    <div class="text" title="${esc(t("Click to expand"))}"></div>
    <div class="row">
      <div class="thumb"><img alt="" /><span class="thumb-badge" hidden></span><button class="gen" title="${esc(t("Generate AI image"))}">🎨</button><button class="pick" title="${esc(t("Upload image"))}">📁</button></div>
      <div class="fields">
        <input class="f-name" maxlength="32" placeholder="${esc(t("Name"))}" />
        <input class="f-ticker" maxlength="10" placeholder="TICKER" />
        <select class="f-img">
          <option value="default">${esc(t("Image: auto"))}</option>
          <option value="post">${esc(t("Post image / video frame"))}</option>
          <option value="tweet">${esc(t("Tweet screenshot"))}</option>
          <option value="ai">${esc(t("AI image"))}</option>
          <option value="card">${esc(t("Gradient card"))}</option>
          <option value="avatar">${esc(t("Profile picture"))}</option>
          <option value="custom">${esc(t("Custom URL / upload"))}</option>
        </select>
        <input class="f-custom" placeholder="https://… image URL" hidden />
      </div>
    </div>
    <details><summary>${esc(t("Description"))}</summary><textarea class="f-desc" maxlength="500"></textarea></details>
    <div class="actions">
      <button class="deploy"></button>
      <button class="regen ghost" title="${esc(t("Generate a new name"))}">↻</button>
    </div>
    <div class="status"></div>`;
  $(".text", el).textContent = card.text || t("(image only)");
  if (card.context) {
    const ctx = document.createElement("div");
    ctx.className = "ctx";
    ctx.textContent = card.context;
    $(".text", el).after(ctx);
  }
  $(".text", el).addEventListener("click", (e) => e.currentTarget.classList.toggle("open"));

  const edit = (patch) => {
    edits[card.id] = { ...(edits[card.id] || {}), ...patch };
    const c = effective(feed.find((x) => x.id === card.id) || card);
    $(".f-custom", el).hidden = c.imageChoice !== "custom";
    setPreview(el, c);
  };
  $(".f-name", el).addEventListener("input", (e) => edit({ name: e.target.value }));
  $(".f-ticker", el).addEventListener("input", (e) => {
    const v = e.target.value.replace(/[^A-Za-z0-9]/g, "").slice(0, settings.tickerMaxLen || 10);
    if (v !== e.target.value) e.target.value = v;
    edit({ ticker: v });
  });
  $(".f-desc", el).addEventListener("input", (e) => edit({ description: e.target.value }));
  const genAi = async () => {
    if (!settings.imageAiProvider || settings.imageAiProvider === "off") return toast(t("Turn on AI images first (Settings → Images)"));
    const ov = {};
    for (const k of ["name", "ticker"]) if (edits[card.id]?.[k] != null) ov[k] = edits[card.id][k];
    edit({ imageChoice: "ai" });
    $(".f-img", el).value = "ai";
    try { await send({ type: "aiImage", id: card.id, overrides: ov }); delete edits[card.id]?.imageChoice; }
    catch (err) { toast(err.message, 5000); }
  };
  $(".gen", el).addEventListener("click", genAi);
  $(".f-img", el).addEventListener("change", (e) => {
    edit({ imageChoice: e.target.value });
    const c = feed.find((x) => x.id === card.id);
    if (e.target.value === "ai" && c && !c.aiImage && !c.aiImageBusy) genAi();
  });
  $(".f-custom", el).addEventListener("change", (e) => edit({ imageCustom: e.target.value.trim() }));
  $(".pick", el).addEventListener("click", () => {
    const fp = $("#filePick");
    fp.onchange = () => {
      const f = fp.files[0];
      fp.value = "";
      if (!f) return;
      if (f.size > 4 * 1024 * 1024) return toast(t("Image too big (max 4 MB)"));
      const r = new FileReader();
      r.onload = () => {
        edit({ imageChoice: "custom", imageCustom: r.result });
        $(".f-img", el).value = "custom";
        $(".f-custom", el).value = t("(uploaded file)");
      };
      r.readAsDataURL(f);
    };
    fp.click();
  });
  $(".dismiss", el).addEventListener("click", () => { delete edits[card.id]; send({ type: "dismiss", id: card.id }); });
  $(".regen", el).addEventListener("click", async (e) => {
    e.target.disabled = true;
    try {
      delete edits[card.id]?.name;
      delete edits[card.id]?.ticker;
      delete edits[card.id]?.description;
      await send({ type: "regen", id: card.id });
    } catch (err) { toast(err.message); }
    e.target.disabled = false;
  });
  $(".deploy", el).addEventListener("click", () => deploy(card.id));
  return el;
}

async function deploy(id) {
  const card = feed.find((c) => c.id === id);
  if (!card) return;
  const c = effective(card);
  // Ask for access to a custom image host (must happen right in the click)
  if (c.imageChoice === "custom" && /^https:\/\//.test(c.imageCustom || "")) {
    try {
      const origin = new URL(c.imageCustom).origin + "/*";
      const granted = await chrome.permissions.request({ origins: [origin] });
      if (!granted) return toast(t("Image host not allowed"));
    } catch { return toast(t("Bad image URL")); }
  }
  if (!settings.dryRun && settings.confirmManual && !(await ask(t("Launch ${ticker} \"{name}\" with a {sol} SOL dev buy?", { ticker: c.ticker, name: c.name, sol: settings.devBuySol }), t("Launch")))) return;
  const overrides = {};
  for (const k of ["name", "ticker", "description", "imageChoice", "imageCustom"]) if (edits[id]?.[k] != null) overrides[k] = edits[id][k];
  try {
    await send({ type: "deploy", id, overrides });
    delete edits[id];
  } catch (e) {
    // card status shows the error
  }
}

function statusFor(c) {
  const r = c.result || {};
  switch (c.status) {
    case "deploying":
      return { cls: "warn", html: `<span class="spin"></span>${esc(c.step || t("Working…"))}` };
    case "launched":
      return { cls: "ok", html: `${esc(t("Live!"))} ${settings.openIn !== "pumpfun" ? `<a target="_blank" href="${esc(coinUrl(settings.openIn, r.mint))}">${esc(platformOf(settings.openIn).label)}</a> · ` : ""}<a target="_blank" href="https://pump.fun/coin/${esc(r.mint)}">pump.fun</a> · <a target="_blank" href="https://solscan.io/tx/${esc(r.signature)}">tx</a>${r.spentSol != null ? ` · ${esc(t("cost {amount}", { amount: money(r.spentSol) }))}` : ""}` };
    case "dry-ok":
      return { cls: "ok", html: `${esc(t("Test launch done. See your test coin in the Launched tab. Nothing was spent."))}${r.needsFunds ? `<br><span class="warn-t">${esc(t("Your wallet needs SOL to launch this for real."))}</span>` : r.checkError ? `<br><span class="warn-t">${esc(t("Couldn't check the real transaction:"))} ${esc(r.checkError)}</span>` : ""}` };
    case "dry-fail":
      return { cls: "err", html: `${esc(t("Test failed: the real transaction would not go through."))} ${esc(r.simError)}<code>${esc((r.simLogs || []).join("\n"))}</code>` };
    case "failed":
      return { cls: "err", html: `${esc(t("Failed:"))} ${esc(c.error)}` };
    default:
      if (c.aiImageBusy) return { cls: "warn", html: `<span class="spin"></span>${esc(t("Generating AI image…"))}` };
      if (c.aiImageError) return { cls: "err", html: `${esc(t("AI image failed:"))} ${esc(c.aiImageError)}` };
      if (c.autoSkip) return { cls: "info", html: `${esc(t("Auto skipped:"))} ${esc(c.autoSkip)}` };
      if (c.nameFixed) return { cls: "info", html: esc(t("🐾 Named after the animal ({name})", { name: c.nameFixed })) };
      if (c.aiError) return { cls: "warn", html: `${esc(t("AI naming failed, used built-in:"))} ${esc(c.aiError)}` };
      if (c.aiSkipped) return { cls: "info", html: esc(t("AI skipped to save tokens ({why}). Press ↻ for an AI name.", { why: c.aiSkipped })) };
      if (c.reason) return { cls: "info", html: `AI: ${esc(c.reason)}` };
      return { cls: "", html: "" };
  }
}

function updateCardEl(el, card) {
  const c = effective(card);
  el.className = `card ${card.status}`;
  $(".age", el).textContent = agoText(card.time);
  const sc = $(".score", el);
  if (card.score != null) {
    sc.hidden = false;
    sc.textContent = `${card.score}/10`;
    sc.className = `score ${card.score >= 7 ? "hi" : card.score >= 4 ? "mid" : "lo"}`;
  } else sc.hidden = true;

  const aiTag = $(".ai-tag", el);
  aiTag.hidden = c.namingBy !== "ai";
  if (!aiTag.hidden) aiTag.title = c.aiModel ? t("Named by AI ({model})", { model: c.aiModel }) : t("Named by AI");

  const setVal = (sel, v) => { const i = $(sel, el); if (document.activeElement !== i && i.value !== (v ?? "")) i.value = v ?? ""; };
  setVal(".f-name", c.name);
  setVal(".f-ticker", c.ticker);
  setVal(".f-desc", c.description);
  $(".f-img", el).value = c.imageChoice || "default";
  $(".f-custom", el).hidden = c.imageChoice !== "custom";
  if (c.imageCustom && !String(c.imageCustom).startsWith("data:")) setVal(".f-custom", c.imageCustom);

  const btn = $(".deploy", el);
  const busy = card.status === "deploying";
  const done = card.status === "launched";
  btn.disabled = busy || done;
  btn.classList.toggle("dry", !!settings.dryRun);
  btn.textContent = done ? t("Launched") : busy ? t("Launching…") : settings.dryRun ? t("Test launch 🧪") : t("Launch 🚀");
  $(".regen", el).disabled = busy || done;

  const st = statusFor(card);
  const sEl = $(".status", el);
  sEl.className = `status ${st.cls}`;
  if (sEl.innerHTML !== st.html) sEl.innerHTML = st.html;
  setPreview(el, c);
}

function axiomLabel() {
  const st = axiomStatus;
  if (!st || Date.now() - st.at > 150000) return settings.keepAxiomOpen ? t("Axiom (opening…)") : t("Axiom (tab not open)");
  if (st.live) return t("Axiom ● live");
  if (st.hooked) return t("Axiom (reconnecting)");
  return t("Axiom (reload the Axiom tab)");
}

let onboardSeen = true;
function renderOnboard() {
  let el = $("#onboard");
  if (onboardSeen) { el?.remove(); return; }
  el?.remove();
  el = document.createElement("div");
  el.id = "onboard";
  el.className = "onboard";
  el.innerHTML = `<b>${esc(t("Keep Axiom running"))}</b>
    <p>${esc(t("Hatchr keeps your Axiom tab awake by itself, and reopens it as a pinned background tab if you close it. Nothing to do."))}</p>
    <p class="muted">${esc(t("For extra safety you can also add axiom.trade under \"Always keep these sites active\" in Chrome's performance settings."))}</p>
    <div class="onboard-row"><button id="obOpen" class="ghost">${esc(t("Open Chrome setting"))}</button><button id="obOk">${esc(t("Got it"))}</button></div>`;
  $("#tab-feed").prepend(el);
  $("#obOpen").addEventListener("click", () => send({ type: "openPerfSettings" }).catch((e) => toast(e.message)));
  $("#obOk").addEventListener("click", () => { onboardSeen = true; chrome.storage.local.set({ onboardSeen: true }); renderOnboard(); });
}

function renderFeed() {
  const root = $("#feed");
  $("#feedCount").textContent = feed.length ? `(${feed.length})` : "";
  const watching = [];
  if (settings.axiomEnabled) watching.push(axiomLabel());
  if (settings.xEnabled) watching.push(lines(settings.xHandles).length ? t("{n} X accounts", { n: lines(settings.xHandles).length }) : t("any X post"));
  if (settings.tgEnabled && lines(settings.tgChannels).length) watching.push(t("{n} TG channels", { n: lines(settings.tgChannels).length }));
  const off = settings.watching === false;
  let hint = off ? t("Off: not watching any posts") : watching.length ? t("Watching {what}", { what: watching.join(" + ") }) : t("No sources on (Settings → Sources)");
  const today = new Date().toISOString().slice(0, 10);
  if (settings.aiEnabled && aiUsage && aiUsage.day === today) hint += ` · ${t("AI today {k}k tokens", { k: Math.round(aiUsage.tokens / 1000) })}`;
  if (settings.aiEnabled && settings.aiMeta && metaCount) hint += ` · ${t("meta: {n} coins", { n: metaCount })}`;
  if (!off && settings.aiEnabled && settings.aiMeta && settings.pumpMeta !== false && pumpStatus && Date.now() - pumpStatus.at < 90_000) hint += " · pump.fun ● live";
  $("#feedHint").textContent = hint;

  if (!feed.length && off) {
    root.innerHTML = `<div class="empty"><b>${esc(t("Hatchr is off."))}</b><br>${esc(t("Turn it on to see new posts here. You can still paste a post above and press Generate."))}</div>`;
    return;
  }
  if (!feed.length) {
    root.innerHTML = `<div class="empty"><b>${esc(t("No posts yet."))}</b><br>${esc(t("Open axiom.trade and show the X tracker (Alerts) panel, or an X List with your accounts, and keep it in its own window."))}<br>${esc(t("New posts show up here within seconds."))}</div>`;
    return;
  }
  root.querySelector(".empty")?.remove();
  const existing = new Map([...root.children].map((el) => [el.dataset.id, el]));
  let prev = null;
  for (const card of feed) {
    let el = existing.get(card.id);
    if (!el) el = cardSkeleton(card);
    existing.delete(card.id);
    updateCardEl(el, card);
    const want = prev ? prev.nextSibling : root.firstChild;
    if (want !== el) root.insertBefore(el, want);
    prev = el;
  }
  existing.forEach((el, id) => { el.remove(); delete edits[id]; });
}

$("#manualGo").addEventListener("click", async () => {
  const text = $("#manualText").value.trim();
  const image = $("#manualImg").value.trim();
  if (!text) return toast(t("Paste some text first"));
  if (image) {
    try {
      const ok = await chrome.permissions.request({ origins: [new URL(image).origin + "/*"] });
      if (!ok) return toast(t("Image host not allowed"));
    } catch { return toast(t("Bad image URL")); }
  }
  $("#manualGo").disabled = true;
  try {
    await send({ type: "manualPost", text, image });
    $("#manualText").value = "";
    $("#manualImg").value = "";
  } catch (e) { toast(e.message); }
  $("#manualGo").disabled = false;
});
$("#clearFeed").addEventListener("click", () => send({ type: "clearFeed" }));

// ---------------- launched ----------------

function fmtTokens(n) {
  if (n == null) return "?";
  if (n >= 1e9) return `${(n / 1e9).toFixed(2)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(2)}M`;
  if (n >= 1e3) return `${(n / 1e3).toFixed(1)}K`;
  return n.toFixed(n < 1 ? 4 : 0);
}

function renderRewards() {
  const box = $("#rewardsBox");
  if (!box) return;
  if (!walletPub) { box.innerHTML = ""; return; }
  const r = rewards || {};
  const unclaimed = r.wallet === walletPub && r.unclaimed != null ? r.unclaimed : null;
  const busy = !!r.claimStep;
  const claimedTotal = r.wallet === walletPub || !r.wallet ? r.claimedTotal || 0 : 0;
  const auto = settings.autoClaimRewards ? t("Auto-claim on (≥ {sol} SOL)", { sol: settings.autoClaimMinSol }) : t("Auto-claim off");
  const last = (r.history || [])[0];
  box.innerHTML = `
    <div class="rw-top">
      <div><div class="rw-label">${esc(t("Creator rewards to claim"))}</div>
        <div class="rw-amount">${(settings.currency || "sol") === "sol" || !solPx ? `${fmtSol(unclaimed)} <span>SOL</span>` : esc(money(unclaimed))}</div></div>
      <button id="claimBtn" class="rw-claim" ${busy || !unclaimed ? "disabled" : ""}>${busy ? `<span class="spin"></span>${esc(r.claimStep)}` : settings.dryRun ? esc(t("Claim (test)")) : esc(t("Claim"))}</button>
    </div>
    <div class="rw-meta">${esc(t("Claimed so far: {amount}", { amount: money(claimedTotal) }))} · ${esc(auto)}${last ? ` · ${esc(t("last {time}", { time: agoText(last.time) }))}` : ""}</div>
    ${r.claimError ? `<div class="rw-meta err">${esc(r.claimError)}</div>` : r.dryClaimOk && settings.dryRun ? `<div class="rw-meta ok">${esc(t("Claim test passed. Nothing was sent."))}</div>` : ""}
    <div class="rw-meta">${esc(t("You earn a cut of every trade on coins you created, until you claim it. One claim collects all your coins."))}</div>`;
  $("#claimBtn")?.addEventListener("click", async () => {
    try { await send({ type: "claimRewards" }); refreshBalance(); } catch (e) { toast(e.message, 5000); }
  });
}

async function refreshRewards() {
  if (!walletPub) return;
  try { rewards = await send({ type: "rewards" }); } catch (e) { /* RPC hiccup: keep the last value */ }
  renderRewards();
}

function renderDeploys() {
  const root = $("#deploys");
  const test = !!settings.dryRun;
  const coins = deploys.filter((d) => d.ok && !d.pending && (test ? d.simulated : !d.dryRun));
  $("#depCount").textContent = coins.length ? `(${coins.length})` : "";
  const day = deploys.filter((d) => d.ok && !d.pending && Date.now() - d.time < 86400000);
  if (test) {
    const tday = day.filter((d) => d.simulated);
    const would = tday.reduce((a, d) => a + (d.spentSol || 0), 0);
    $("#depSummary").textContent = t("Test mode · last 24h: {n} test coins, ≈{amount} would have been spent", { n: tday.length, amount: money(would) });
  } else {
    const live = day.filter((d) => !d.dryRun);
    const spent = live.reduce((a, d) => a + (d.spentSol || 0), 0);
    $("#depSummary").textContent = t("Last 24h: {n} live launches, {amount} measured cost", { n: live.length, amount: money(spent) });
  }
  if (!deploys.length) {
    root.innerHTML = `<div class="empty">${esc(test ? t("Nothing launched yet. Test launches show up here as simulated coins, so you can see exactly what would happen.") : t("Nothing launched yet."))}</div>`;
    return;
  }
  root.innerHTML = deploys.map((d) => {
    const sim = !!d.simulated && d.ok;
    const live = !d.dryRun && d.ok && d.mint && d.signature;
    const coin = live || sim;
    const empty = coin && (d.sold || d.holding === 0);
    const dot = d.pending ? "pend" : !d.ok ? "bad" : d.dryRun ? "dry" : empty ? "done" : "";
    const links = d.signature
      ? `<a target="_blank" href="https://pump.fun/coin/${esc(d.mint)}">pump.fun</a> · <a target="_blank" href="https://solscan.io/tx/${esc(d.signature)}">tx</a>${d.sellSignature ? ` · <a target="_blank" href="https://solscan.io/tx/${esc(d.sellSignature)}">${esc(t("sell tx"))}</a>` : ""}`
      : "";
    let detail;
    if (d.pending) detail = esc(t("launching…"));
    else if (d.error) detail = esc(d.error);
    else if (d.simError) detail = `${esc(t("Test failed:"))} ${esc(d.simError)}`;
    else if (sim) detail = esc(d.chainCheck === "passed" ? t("Real transaction checked: it would go through.")
      : d.chainCheck === "needs-funds" ? t("Transaction is fine, but your wallet needs SOL to launch this for real.")
      : d.chainCheck === "unavailable" ? `${t("Couldn't check the real transaction:")} ${d.checkError || ""}`
      : t("Simulated without a wallet (no on-chain check)."));
    else if (d.dryRun) detail = esc(d.note || t("simulated OK"));
    else detail = links;
    let hold = "";
    if (sim) {
      if (d.sold) hold = t("Sold (test) · you'd get back ≈{amount}", { amount: money(d.receivedSol) });
      else hold = t("Holding ≈{n} tokens (test)", { n: fmtTokens(d.holding) });
    } else if (live) {
      if (d.sold) hold = `${t("Sold")}${d.receivedSol != null ? ` · ${t("received {amount}", { amount: money(d.receivedSol) })}` : ""} · ${t("holding nothing")}`;
      else if (d.holding === 0) hold = t("Holding nothing");
      else if (d.holding != null) hold = t("Holding {n} tokens", { n: fmtTokens(d.holding) });
      else hold = t("Holding: checking…");
    }
    const sellLabel = sim || settings.dryRun ? t("Sell all (test)") : t("Sell all");
    const sellBtn = !coin ? "" : d.sellStep
      ? `<button class="mini sell" disabled><span class="spin"></span>${esc(d.sellStep)}</button>`
      : empty ? `<button class="mini sell" disabled>${esc(d.sold ? t("Sold") : t("Nothing to sell"))}</button>`
      : `<button class="mini sell" data-act="sell" data-id="${esc(d.id)}">${esc(sellLabel)}</button>`;
    const first = sim
      ? `<button class="mini axiom" data-act="preview" data-id="${esc(d.id)}">${esc(t("Preview coin"))}</button>`
      : `<a class="mini axiom" target="_blank" href="${esc(coinUrl(settings.openIn, d.mint))}">${esc(t("Open in {site}", { site: platformOf(settings.openIn).label }))}</a>`;
    // a callout tells your pump.fun followers why you hold a coin: only for live coins you still hold
    const callBtn = live && !empty && d.holding !== 0 ? `<button class="mini call" data-act="callout" data-id="${esc(d.id)}" title="${esc(t("Tell your pump.fun followers why you hold this coin"))}">${esc(t("Callout"))}</button>` : "";
    const actions = coin ? `<div class="dep-actions">${first}${callBtn}${sellBtn}</div>` : "";
    const sellNote = d.sellError ? `<div class="dep-meta err">${esc(d.sellError)}</div>` : d.sellDryOk ? `<div class="dep-meta ok">${esc(t("Sell test passed. Nothing was sold."))}</div>` : "";
    const cost = d.spentSol != null ? ` · ${esc(sim ? t("≈{amount} cost (simulated)", { amount: money(d.spentSol) }) : t("cost {amount}", { amount: money(d.spentSol) }))}` : "";
    const thumb = d.image ? `<img class="dep-img" src="${esc(d.image)}" alt=""/>` : `<span class="dot ${dot}"></span>`;
    return `<div class="dep ${empty ? "done" : ""} ${sim ? "sim" : ""}">${thumb}<div class="dep-main">
      <div class="dep-title">$${esc(d.ticker || "?")} <span class="muted">${esc(d.name || "")}</span>
        <span class="badge ${d.mode === "auto" ? "auto" : ""}">${d.mode === "auto" ? "AUTO" : t("MANUAL")}</span>${d.dryRun ? '<span class="badge dry">TEST</span>' : ""}</div>
      <div class="dep-meta">${esc(agoText(d.time))}${d.handle ? ` · @${esc(d.handle)}` : ""}${cost}</div>
      ${hold ? `<div class="dep-meta hold">${esc(hold)}</div>` : ""}
      ${d.calledAt ? `<div class="dep-meta">${esc(t("Called out {ago}", { ago: agoText(d.calledAt) }))}${d.calloutUrl ? ` · <a target="_blank" href="${esc(d.calloutUrl)}">${esc(t("view"))}</a>` : ""}</div>` : ""}
      <div class="dep-meta">${detail}</div>${sellNote}${actions}</div></div>`;
  }).join("");
}

// Questions are asked inside the panel, never with a Chrome dialog. ask() resolves to true (go ahead) or false.
// It is used only where something can be lost or real money starts moving; harmless actions just happen.
function ask(text, okLabel) {
  return new Promise((resolve) => {
    document.getElementById("askBox")?.remove();
    const box = document.createElement("div");
    box.id = "askBox";
    box.className = "ask";
    box.innerHTML = `<div class="ask-box" role="alertdialog" aria-modal="true"><p></p><div class="ask-row"><button class="ghost" data-a="no"></button><button data-a="yes"></button></div></div>`;
    box.querySelector("p").textContent = text;
    box.querySelector('[data-a="no"]').textContent = t("Cancel");
    box.querySelector('[data-a="yes"]').textContent = okLabel || t("Continue");
    const done = (v) => { document.removeEventListener("keydown", onKey, true); box.remove(); resolve(v); };
    const onKey = (e) => {
      if (e.key === "Escape") { e.stopPropagation(); done(false); }
      else if (e.key === "Enter") { e.preventDefault(); e.stopPropagation(); done(true); }
    };
    box.addEventListener("click", (e) => {
      const a = e.target.closest("[data-a]");
      if (a) done(a.dataset.a === "yes");
      else if (e.target === box) done(false);
    });
    document.addEventListener("keydown", onKey, true);
    document.body.appendChild(box);
    box.querySelector('[data-a="yes"]').focus();
  });
}

function openModal(html) {
  $("#modalBox").innerHTML = `<button class="modal-x" title="${esc(t("Close"))}">×</button>${html}`;
  $("#modal").hidden = false;
  $(".modal-x").addEventListener("click", closeModal);
}
function closeModal() { vanityModalOpen = false; $("#modal").hidden = true; $("#modalBox").innerHTML = ""; }
$("#modal").addEventListener("click", (e) => { if (e.target.id === "modal") closeModal(); });
document.addEventListener("keydown", (e) => { if (e.key === "Escape") { closeModal(); hideGuide(true); } });

function previewCoin(d) {
  const ec = d.estCost || {};
  const card = feed.find((c) => c.id === d.cardId);
  openModal(`
    <div class="pv">
      ${d.image ? `<img class="pv-img" src="${esc(d.image)}" alt=""/>` : ""}
      <div class="pv-name">${esc(d.name)} <span class="muted">$${esc(d.ticker)}</span></div>
      <span class="badge dry">${esc(t("TEST COIN: not on-chain"))}</span>
      ${d.description ? `<p class="pv-desc">${esc(d.description)}</p>` : ""}
      ${d.source || card?.url ? `<div class="pv-row"><b>${esc(t("X link on the coin"))}</b><a target="_blank" href="${esc(d.source || card.url)}">${esc(t("source post"))}</a></div>` : ""}
      <div class="pv-row"><b>${esc(t("Mint address"))}</b><code>${esc(d.mint || "—")}</code></div>
      <div class="pv-row"><b>${esc(t("Dev buy"))}</b><span>${esc(money(ec.devBuy))}</span></div>
      <div class="pv-row"><b>${esc(t("Network fees"))}</b><span>≈${esc(money(ec.fees))}</span></div>
      <div class="pv-row"><b>${esc(t("Account rent"))}</b><span>≈${esc(money(ec.rent))}</span></div>
      <div class="pv-row total"><b>${esc(t("Total for real"))}</b><span>≈${esc(money(d.spentSol))}</span></div>
      <div class="pv-row"><b>${esc(t("Tokens you'd hold"))}</b><span>≈${fmtTokens(d.holding)}</span></div>
      <p class="help">${esc(t("In LIVE mode this coin would be created on pump.fun with this picture, name and description. These numbers assume nobody else buys first; sniper bots usually do."))}</p>
    </div>`);
}

// ---------------- callout (pump.fun) ----------------
// The composer lives in callout-dialog.js (loaded before this file, shared with the desktop app).
function calloutModal(d) {
  globalThis.HatchrCalloutDialog.open(d, { send, translate: t, escape: esc, modal: openModal, toast, copy: copyText });
}

$("#deploys").addEventListener("click", async (e) => {
  const b = e.target.closest("[data-act]");
  if (!b) return;
  const d = deploys.find((x) => x.id === b.dataset.id);
  if (!d) return;
  if (b.dataset.act === "preview") return previewCoin(d);
  if (b.dataset.act === "callout") return calloutModal(d);
  if (!d.simulated && !settings.dryRun && settings.confirmSell && !(await ask(t("Sell ALL your ${ticker} tokens now?", { ticker: d.ticker }), t("Sell all")))) return;
  b.disabled = true;
  try { await send({ type: "sell", id: d.id }); } catch (err) { toast(err.message, 4000); }
});

// ---------------- Callouts tab: every pump.fun coin you hold ----------------
const shortAddr = (a) => (a ? `${a.slice(0, 4)}…${a.slice(-4)}` : "");
const validAddr = (a) => /^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(a);
// Coins launched here that are live and still held. Their callout texts know the post the coin came from.
const ownHeld = () => deploys.filter((d) => !d.dryRun && d.ok && d.mint && d.signature && !d.sold && d.holding !== 0);
function calloutRow(c, own) {
  const thumb = c.image ? `<img class="dep-img" src="${esc(c.image)}" alt="" referrerpolicy="no-referrer"/>` : `<span class="dot"></span>`;
  const title = c.ticker || c.name ? `$${esc(c.ticker || "?")} <span class="muted">${esc(c.name || "")}</span>` : `<span class="muted">${esc(shortAddr(c.mint))}</span>`;
  const amount = own ? c.holding : c.amount;
  const hold = amount != null ? t("Holding {n} tokens", { n: fmtTokens(amount) }) : t("Holding: checking…");
  const where = own ? t("launched here") : c.wallet && c.wallet !== walletPub ? t("in {wallet}", { wallet: shortAddr(c.wallet) }) : "";
  return `<div class="dep">${thumb}<div class="dep-main">
    <div class="dep-title">${title}</div>
    <div class="dep-meta hold">${esc(hold)}${where ? ` · <span class="muted">${esc(where)}</span>` : ""}</div>
    ${c.calledAt ? `<div class="dep-meta">${esc(t("Called out {ago}", { ago: agoText(c.calledAt) }))}${c.calloutUrl ? ` · <a target="_blank" href="${esc(c.calloutUrl)}">${esc(t("view"))}</a>` : ""}</div>` : ""}
    <div class="dep-actions"><a class="mini axiom" target="_blank" href="${esc(coinUrl(settings.openIn, c.mint))}">${esc(t("Open in {site}", { site: platformOf(settings.openIn).label }))}</a><button class="mini call" data-call="${esc(c.id)}">${esc(c.calledAt ? t("Call out again") : t("Callout"))}</button></div>
  </div></div>`;
}
function renderHeld() {
  const root = $("#held");
  if (!root) return;
  const own = ownHeld();
  const total = own.length + heldCoins.length;
  const count = total ? `(${total})` : "";
  if ($("#callCount").textContent !== count) { $("#callCount").textContent = count; fitHeader(); }
  const scanning = root.dataset.busy === "1";
  const when = heldInfo?.at ? ` · ${t("checked {ago}", { ago: agoText(heldInfo.at) })}` : "";
  const head = `<div class="feed-head held-head"><span class="muted">${esc(t("Coins you hold"))}${total ? ` (${total})` : ""}${esc(when)}</span><button class="link" id="heldScan" ${scanning ? "disabled" : ""}>${scanning ? `<span class="spin"></span>` : ""}${esc(t("Refresh"))}</button></div>`;
  let body = own.map((d) => calloutRow(d, true)).join("") + heldCoins.map((c) => calloutRow(c, false)).join("");
  if (!total) {
    const why = scanning ? t("Looking for pump.fun coins in your wallet…")
      : heldInfo?.error === "no-wallet" ? t("No wallet to read yet. Create your Hatchr wallet under Settings → Account, or fill in the wallet you use on pump.fun above.")
      : heldInfo?.error ? `${t("Couldn't read the wallet:")} ${heldInfo.error}`
      : heldInfo ? t("No pump.fun coins found. If you hold coins in another wallet, fill in its address above.")
      : t("Press Refresh to look for pump.fun coins in your wallet.");
    body = `<div class="held-empty muted">${esc(why)}</div>`;
  } else if (heldInfo?.error && heldInfo.error !== "no-wallet") {
    body = `<div class="held-empty err">${esc(t("Couldn't read the wallet:"))} ${esc(heldInfo.error)}</div>` + body;
  }
  root.innerHTML = head + body;
  // the wallet box above the list is fixed markup, so typing in it is never interrupted by a refresh
  const inp = $("#callWallet");
  if (document.activeElement !== inp && inp.dataset.dirty !== "1") inp.value = settings.calloutWallet || "";
  $("#callWalletNote").textContent = walletPub
    ? t("Your Hatchr wallet {wallet} is always read. Add the address of another wallet here and its coins are listed too. An address can only be looked at, never spent from.", { wallet: shortAddr(walletPub) })
    : t("Paste the public address of the wallet that holds your coins. An address can only be looked at, never spent from.");
}
async function scanHeld() {
  const root = $("#held");
  if (!root || root.dataset.busy === "1") return;
  root.dataset.busy = "1"; renderHeld();
  try { await send({ type: "scanHeld" }); } catch (err) { toast(err.message, 4000); }
  root.dataset.busy = ""; renderHeld();
}
$("#held").addEventListener("click", (e) => {
  if (e.target.closest("#heldScan")) return scanHeld();
  const b = e.target.closest("[data-call]");
  const c = b && (heldCoins.find((x) => x.id === b.dataset.call) || ownHeld().find((x) => x.id === b.dataset.call));
  if (c) calloutModal(c);
});
$("#callWallet").addEventListener("input", (e) => { e.target.dataset.dirty = "1"; });
async function saveCallWallet() {
  const inp = $("#callWallet");
  const v = inp.value.trim();
  if (v && !validAddr(v)) return toast(t("That is not a Solana wallet address. Copy the address from your wallet or your pump.fun profile."), 5000);
  try {
    settings = await send({ type: "saveSettings", patch: { calloutWallet: v } });
    inp.dataset.dirty = ""; inp.value = v;
    const field = document.getElementById("s-calloutWallet");
    if (field) field.value = v;
    toast(v ? t("Saved. Reading that wallet…") : t("Saved."), 2500);
    await scanHeld();
  } catch (err) { toast(err.message, 4000); }
}
$("#callWalletSave").addEventListener("click", saveCallWallet);
$("#callWallet").addEventListener("keydown", (e) => { if (e.key === "Enter") { e.preventDefault(); saveCallWallet(); } });
function calloutsTabShown(on) {
  if (on && (!heldInfo || Date.now() - (heldInfo.at || 0) > 120000)) scanHeld();
  if (on) refreshHoldings();
}

let holdingsTimer = null;
function refreshHoldings() {
  refreshHoldingsNow().catch(() => {});
}
async function refreshHoldingsNow() {
  const ids = deploys.filter((d) => !d.dryRun && d.ok && d.mint && d.signature && !d.sold).slice(0, 12).map((d) => d.id);
  if (ids.length) await send({ type: "holdings", ids });
}
function launchedTabShown(on) {
  clearInterval(holdingsTimer);
  if (on) {
    refreshHoldings(); refreshRewards();
    holdingsTimer = setInterval(() => { refreshHoldings(); refreshRewards(); }, 30000);
  }
}
$("#clearDeps").addEventListener("click", async () => {
  if (await ask(t("Clear the launch log? (Rate limits and daily caps are counted from this log.)"), t("Clear"))) send({ type: "clearDeploys" });
});

// ---------------- settings ----------------
// A drawn coin, not the coin emoji: that emoji is missing on Windows 10 and shows up as an empty box.
const COIN_ICON = `<svg class="coin-ic" viewBox="0 0 16 16" aria-hidden="true"><circle cx="8" cy="8" r="7" fill="#f6c453"/><circle cx="8" cy="8" r="4.6" fill="none" stroke="#a8781f" stroke-width="1.3"/><circle cx="5.6" cy="5.4" r="1.5" fill="#fff" opacity=".55"/></svg>`;
const SUBS = [
  ["account", "👤", "Account"],
  ["token", COIN_ICON, "$HATCHR"],
  ["launch", "🚀", "Launch"],
  ["sources", "📡", "Sources"],
  ["ai", "🤖", "AI"],
  ["images", "🖼️", "Images"],
  ["auto", "⚡", "Auto"],
  ["alerts", "🔔", "Alerts"],
  ["language", "🌐", "Language"],
];

const providerOptions = () => Object.entries(AI_PROVIDERS).map(([id, p]) => [id, p.label]);

const SCHEMA = [
  { sub: "account", title: "Wallet", custom: "wallet", guide: "wallet" },
  { sub: "account", title: "Backup", custom: "backup" },

  { sub: "token", title: "$HATCHR holder perks", custom: "token" },
  { sub: "token", title: "Feature votes", custom: "votes" },

  { sub: "launch", title: "Connections", fields: [
    { k: "rpcUrl", label: "Solana RPC URL", guide: "helius", help: "The free public RPC blocks browser extensions. Get your own free Helius URL (click ⓘ for how)." },
    { k: "pinataJwt", label: "Pinata JWT", type: "password", guide: "pinata", help: "Needed for real launches: stores the coin's picture and details on IPFS. Free." },
  ] },
  { sub: "launch", title: "Launching", fields: [
    { row: [
      { k: "devBuySol", label: "Dev buy (SOL)", type: "number", step: "0.0001" },
      { k: "slippage", label: "Slippage %", type: "number", step: "1" },
    ] },
    { row: [
      { k: "priorityFee", label: "Priority fee (SOL)", type: "number", step: "0.00001" },
      { k: "tickerMaxLen", label: "Max ticker length", type: "number", step: "1" },
    ] },
    { k: "skipPreflight", label: "Skip preflight check", type: "checkbox", help: "Slightly faster, but failed txs still cost fees." },
    { k: "confirmManual", label: "Ask before each manual live launch", type: "checkbox" },
    { k: "openIn", label: "Open coins in", type: "select", options: () => Object.entries(PLATFORMS).map(([id, p]) => [id, p.label]), help: "Where \"Open in …\" takes you, on the Launched tab and after a launch." },
    { k: "openAxiomAfterLaunch", label: "Open the coin right after a live launch", type: "checkbox" },
  ] },
  { sub: "launch", title: "Selling (cheapest)", fields: [
    { row: [
      { k: "sellSlippage", label: "Sell slippage %", type: "number", step: "1" },
      { k: "sellPriorityFee", label: "Sell priority fee (SOL)", type: "number", step: "0.000001" },
    ] },
    { k: "sellCloseAccount", label: "Close the empty token account after selling", type: "checkbox", help: "Gets back about 0.002 SOL of account rent per coin, more than the sell itself costs." },
    { k: "confirmSell", label: "Ask before Sell all", type: "checkbox" },
    { note: "Sell all uses the lowest fee that usually lands. If it isn't confirmed within ~20 seconds it's sent once more with a slightly higher fee, so it never gets stuck. Slippage around 10-15% keeps sandwich bots from skimming your sell." },
  ] },
  { sub: "launch", title: "Creator rewards", fields: [
    { k: "autoClaimRewards", label: "Auto-claim creator rewards", type: "checkbox", help: "Checks your unclaimed rewards and claims them once they're worth it (each claim costs a tiny network fee). LIVE only." },
    { row: [
      { k: "autoClaimMinSol", label: "Claim when ≥ (SOL)", type: "number", step: "0.005" },
      { k: "autoClaimEveryMin", label: "Check every (min)", type: "number", step: "10" },
    ] },
  ] },
  { sub: "launch", title: "Callouts", fields: [
    { k: "calloutWallet", label: "Your pump.fun wallet address (optional)", help: "Only if you sign in on pump.fun with a different wallet than the Hatchr wallet. Hatchr then also lists the coins that wallet holds, so you can call them out. It is a public address: Hatchr can only look at it." },
  ] },
  { sub: "launch", title: "Coin details", fields: [
    { k: "descriptionTemplate", label: "Description template", type: "textarea", help: "Placeholders: {text} {ai} {url} {handle} {author} {name} {ticker}" },
    { k: "linkSourceAsTwitter", label: "Put the source post link in the coin's X field", type: "checkbox" },
    { k: "website", label: "Website (optional)" },
    { k: "telegram", label: "Telegram (optional)" },
  ] },

  { sub: "sources", title: "Main switch", fields: [
    { k: "watching", label: "Watch for new posts", type: "checkbox", help: "Off = as if Hatchr were disabled: it reads nothing on Axiom, X or Telegram, shows Axiom's tracker panel again, lets Chrome put those tabs to sleep and closes the pump.fun stream. Your wallet, the Launched tab, selling and making a coin from pasted text keep working." },
  ] },
  { sub: "sources", title: "Axiom", fields: [
    { k: "axiomEnabled", label: "Watch Axiom X tracker", type: "checkbox", help: "Listens to Axiom's live tweet stream while an axiom.trade tab is open. Reacts to the accounts in your Axiom list." },
    { k: "axiomKeepTracker", label: "Keep Axiom's X tracker connected", type: "checkbox", help: "Axiom only streams tweets while its tracker panel is open, so the extension keeps it open for you." },
    { k: "axiomHideTracker", label: "…and hide the tracker panel", type: "checkbox", help: "The panel keeps running invisibly. Turn this off to see and use Axiom's tracker yourself." },
    { k: "keepAxiomOpen", label: "Keep Axiom running automatically", type: "checkbox", help: "Stops Chrome from putting the Axiom tab to sleep, reopens it as a pinned background tab if you close it, and wakes it if it stops sending." },
    { row: [
      { k: "axiomOriginal", label: "Posts", type: "checkbox" },
      { k: "axiomQuotes", label: "Quotes", type: "checkbox" },
    ] },
    { row: [
      { k: "axiomReplies", label: "Replies", type: "checkbox" },
      { k: "axiomReposts", label: "Reposts", type: "checkbox" },
    ] },
    { k: "axiomFilterHandles", label: "Only Axiom alerts from the X accounts below", type: "checkbox", help: "Off = react to everything in your Axiom tracker." },
  ] },
  { sub: "sources", title: "pump.fun", fields: [
    { k: "pumpMeta", label: "Follow every pump.fun launch live (for the meta)", type: "checkbox", help: "Free, no account or Axiom needed. Hatchr reads each new coin and each coin that graduates as it happens, so the AI knows what's being launched and what's running. Works together with Axiom Pulse if you have it open. Needs AI naming and \"Follow the current meta\" on." },
  ] },
  { sub: "sources", title: "X (Twitter)", fields: [
    { k: "xEnabled", label: "Watch X tabs", type: "checkbox" },
    { k: "xHandles", label: "X accounts to react to", type: "textarea", rows: 6, reset: PRESET_HANDLES, resetLabel: "load preset", help: "One per line, without @. Empty = every post that appears in your X tab." },
    { k: "xAutoLoadNew", label: "Auto-click \"Show new posts\"", type: "checkbox" },
    { k: "maxPostAgeSec", label: "Ignore posts older than (sec)", type: "number", step: "10" },
  ] },
  { sub: "sources", title: "Telegram", fields: [
    { k: "tgEnabled", label: "Watch Telegram channels", type: "checkbox" },
    { k: "tgChannels", label: "Public channel usernames", type: "textarea", help: "One per line, e.g. a news channel's @name. Polled every ~30s (Chrome minimum)." },
    { k: "tgPollSec", label: "Telegram poll interval (sec, min 30)", type: "number", step: "5" },
  ] },

  { sub: "ai", title: "AI provider", custom: "aiprovider", fields: [
    { k: "aiEnabled", label: "Use AI for names + scoring", type: "checkbox", help: "Off = built-in rules (cashtags, hashtags, key words)." },
    { k: "aiProvider", label: "AI provider", type: "select", options: providerOptions, help: "Groq and Gemini are free. \"My own AI\" links any other AI that has an API." },
    { k: "aiUrl", label: "AI endpoint URL", cls: "ai-custom", guide: "customai", help: "OpenAI format ends in /chat/completions, Anthropic format in /v1/messages." },
    { k: "aiFormat", label: "API format", type: "select", cls: "ai-custom", options: [["openai", "OpenAI-compatible (chat/completions)"], ["anthropic", "Anthropic (messages)"]] },
    { k: "aiKey", label: "AI API key", type: "password", guide: "@provider" },
    { k: "aiModel", label: "Model", help: "Use a model name your provider lists." },
    { k: "aiHeaders", label: "Extra headers (optional)", type: "textarea", rows: 2, cls: "ai-custom", help: "Only if your API needs them. One per line, like api-key: 123" },
  ] },
  { sub: "ai", title: "How the AI names coins", custom: "naming", fields: [
    { k: "aiFor", label: "Use AI on", type: "select", options: [["candidates", "Only posts that could launch (saves tokens)"], ["all", "Every post"], ["manual", "Only when I press ↻ on a card"]], help: "\"Could launch\" skips posts blocked by your keywords, cooldown or launch limits. Press ↻ on any card to get an AI name anyway." },
    { k: "aiFallback", label: "If the AI is unavailable (daily limits), auto mode should", type: "select", options: [["skip", "Skip the post (safe)"], ["rules", "Launch on my rules with built-in naming"]] },
    { k: "aiMeta", label: "Follow the current meta", type: "checkbox", help: "The AI sees what's running on pump.fun right now (from the live pump.fun stream, plus your Axiom Pulse page if it's open) and names coins in the meta's style, e.g. Pussycoin when ___coin is running." },
    { k: "metaWindowMin", label: "Meta window (minutes)", type: "number", step: "30", help: "How far back the meta looks. 120-240 works well." },
    { k: "aiShortNames", label: "Keep names memecoin-style", type: "checkbox", help: "Strips \"Token\"/\"Coin\" the AI tacks on (unless the post says it) and completes cut-off tickers (NUCLEA → NUCLEAR)." },
    { k: "aiPrompt", label: "AI prompt", type: "textarea", rows: 8, reset: DEFAULT_PROMPT },
  ] },

  { sub: "images", title: "Coin picture", fields: [
    { k: "imageMode", label: "Default image", type: "select", options: [["post-or-tweet", "Post image, else tweet screenshot"], ["tweet", "Always tweet screenshot"], ["post-or-card", "Post image, else gradient card"], ["avatar-or-card", "Post image, else author avatar"], ["card", "Always gradient card"]] },
    { k: "imageLetAiChoose", label: "Let the AI pick the image type per post", type: "checkbox", help: "News, headlines and quotes get the dark tweet screenshot; posts with a good photo keep it; only mascot-worthy things (animals, characters, objects) get an AI image." },
    { row: [
      { k: "cardColor1", label: "Card color 1", type: "color" },
      { k: "cardColor2", label: "Card color 2", type: "color" },
    ] },
  ] },
  { sub: "images", title: "AI images", custom: "aiimages", fields: [
    { k: "imageAiProvider", label: "AI image generator", type: "select", options: [["off", "Off"], ["cloudflare", "Cloudflare Workers AI (free, ~230/day)"], ["openai", "OpenAI GPT Image (paid per image)"]] },
    { k: "imageAiWhen", label: "Use AI images", type: "select", options: [["no-good-image", "When there's no good picture (no post image, and no famous face to use)"], ["no-post-image", "When the post has no image of its own"], ["always", "Always, even if the post has an image"], ["manual", "Only when I press 🎨 on a card"]], help: "\"No good picture\": post photo first, then the author's profile pic if they're a famous person, otherwise an AI image." },
    { k: "cfAccountId", label: "Cloudflare account ID", guide: "cloudflare" },
    { k: "cfToken", label: "Cloudflare API token", type: "password", guide: "cloudflare", help: "Create it with the \"Workers AI\" template." },
    { k: "openaiKey", label: "OpenAI API key", type: "password", guide: "openai" },
    { row: [
      { k: "openaiImageModel", label: "OpenAI model", help: "auto = newest GPT Image model your key can use" },
      { k: "openaiImageQuality", label: "OpenAI quality", type: "select", options: [["low", "low (cheapest)"], ["medium", "medium"], ["high", "high"]] },
    ] },
    { k: "imageAiStyle", label: "Image style", type: "textarea", rows: 4, reset: DEFAULT_IMAGE_STYLE, help: "Empty = default memecoin-logo style. The AI naming adds the subject for each coin." },
  ] },
  { sub: "images", title: "Video posts", fields: [
    { k: "aiPickFrame", label: "🎬 Let the AI pick the best video frame", type: "checkbox", help: "For video posts the extension grabs 6 frames. A vision AI picks the one that shows the subject best (e.g. the dog); without it, the sharpest clear frame is used." },
    { k: "aiVisionModel", label: "Vision model (for picking frames)", help: "A model on your AI provider that can see images. Empty = use the sharpest frame." },
  ] },

  { sub: "auto", title: "Auto mode rules", fields: [
    { k: "includeKeywords", label: "Only if post contains (optional)", type: "textarea", help: "One per line. Empty = no requirement." },
    { k: "excludeKeywords", label: "Never if post contains", type: "textarea" },
    { k: "namedAnimals", label: "🐾 Always launch named animals", type: "checkbox", help: "Posts with an animal that has a name (\"K9 Neo\", \"Moo Deng the hippo\", \"our dog Floki\") launch without needing an AI score, include keyword or cooldown, named after the animal: K9 Neo / $NEO. Your \"never\" keywords and hourly, daily and SOL limits still apply." },
    { row: [
      { k: "autoMinScore", label: "Min AI score (0-10)", type: "number", step: "1" },
      { k: "autoCooldownSec", label: "Cooldown (sec)", type: "number", step: "10" },
    ] },
    { row: [
      { k: "autoMaxPerHour", label: "Max launches / hour", type: "number", step: "1" },
      { k: "autoMaxPerDay", label: "Max launches / day", type: "number", step: "1" },
    ] },
    { row: [
      { k: "autoMaxSolPerDay", label: "Max SOL spent / day", type: "number", step: "0.01" },
      { k: "minBalanceSol", label: "Stop below balance (SOL)", type: "number", step: "0.01" },
    ] },
    { k: "dedupeHours", label: "Don't relaunch same name/ticker within (hours)", type: "number", step: "1" },
  ] },

  { sub: "alerts", title: "Notifications & sound", custom: "notify", fields: [
    { k: "notifyNewPosts", label: "Notify on every new post", type: "checkbox" },
    { k: "notifyDeploys", label: "Notify on launches / failures", type: "checkbox" },
    { k: "soundEnabled", label: "🔔 Play a bell when a coin launches", type: "checkbox" },
    { k: "soundOnDryRun", label: "…also for test launches (softer ding)", type: "checkbox" },
    { k: "soundOnSell", label: "…also when a Sell all goes through", type: "checkbox" },
    { k: "soundVolume", label: "Bell volume (0-100)", type: "number", step: "5" },
  ] },

  { sub: "language", title: "Language", custom: "language" },
];

const allFields = () => SCHEMA.flatMap((s) => (s.fields || []).flatMap((x) => x.row || [x])).filter((f) => f.k);
const currentProvider = () => $("#s-aiProvider")?.value || settings.aiProvider || providerForUrl(settings.aiUrl);
const guideId = (g) => (g === "@provider" ? AI_PROVIDERS[currentProvider()]?.guide || "customai" : g);
const infoBtn = (g) => (g ? ` <button type="button" class="ginfo" data-guide="${esc(g)}" aria-label="${esc(t("How to get this"))}">i</button>` : "");

function fieldHtml(f) {
  if (f.note) return `<div class="help note">${esc(t(f.note))}</div>`;
  const v = settings[f.k];
  const id = `s-${f.k}`;
  const help = f.help ? `<div class="help">${esc(t(f.help))}</div>` : "";
  const cls = f.cls ? ` ${f.cls}` : "";
  if (f.type === "checkbox") {
    return `<div class="fld check${cls}"><input type="checkbox" id="${id}" data-k="${f.k}" ${v ? "checked" : ""}/><div><label for="${id}">${esc(t(f.label))}</label>${infoBtn(f.guide)}${help}</div></div>`;
  }
  let input;
  if (f.type === "textarea") input = `<textarea id="${id}" data-k="${f.k}" rows="${f.rows || 3}">${esc(v)}</textarea>`;
  else if (f.type === "select") {
    const opts = typeof f.options === "function" ? f.options() : f.options;
    const val = f.k === "aiProvider" ? currentProviderFromSettings() : v;
    input = `<select id="${id}" data-k="${f.k}">${opts.map(([o, l]) => `<option value="${esc(o)}" ${o === val ? "selected" : ""}>${esc(t(l))}</option>`).join("")}</select>`;
  } else input = `<input id="${id}" data-k="${f.k}" type="${f.type || "text"}" ${f.step ? `step="${f.step}"` : ""} value="${esc(v)}" ${f.type === "password" ? 'autocomplete="off"' : ""}/>`;
  const reset = f.reset ? ` <button class="link" data-reset="${f.k}">${esc(t(f.resetLabel || "reset"))}</button>` : "";
  return `<div class="fld${cls}" data-fld="${f.k}"><label for="${id}">${esc(t(f.label))}${infoBtn(f.guide)}${reset}</label>${input}${help}</div>`;
}
const currentProviderFromSettings = () => settings.aiProvider || providerForUrl(settings.aiUrl);

function walletHtml() {
  const archive = walletArchive.length
    ? `<details class="prev-wallets"><summary>${esc(t("Previous wallets ({n})", { n: walletArchive.length }))}</summary>
        <p class="help">${esc(t("Every wallet you replace or remove is kept here, so money left in it is never lost."))}</p>
        ${walletArchive.map((w) => `<div class="pw-row"><div><code>${esc(w.pub.slice(0, 6))}…${esc(w.pub.slice(-6))}</code><div class="help">${esc(new Date(w.time).toLocaleDateString())} · <span data-bal="${esc(w.pub)}">…</span></div></div>
          <button class="mini" data-wact="reveal" data-pub="${esc(w.pub)}">${esc(t("Show key"))}</button><button class="mini" data-wact="use" data-pub="${esc(w.pub)}">${esc(t("Use"))}</button></div>`).join("")}
      </details>`
    : "";
  if (!walletPub) {
    return `<div class="wallet-empty">
        <p>${esc(t("You need a Solana wallet to launch for real. Test mode works without one."))}</p>
        <button id="walletCreate" class="primary wide">✨ ${esc(t("Create new wallet"))}</button>
        <button id="walletVanity" class="ghost wide vanity-btn">🎯 ${esc(t("Vanity address…"))}</button>
        <div class="or">${esc(t("or import a wallet you already have"))}</div>
        <div class="wallet-row"><input id="walletInput" type="password" autocomplete="off" placeholder="${esc(t("Paste private key (base58 or JSON array)"))}"/><button id="walletSave">${esc(t("Import"))}</button></div>
        <div class="warnbox">${esc(t("Only use a burner wallet with small amounts. The key is stored unencrypted in this browser."))}</div>
      </div>${archive}`;
  }
  return `<div class="wallet-card">
      <div class="wc-top"><span class="wc-label">${esc(t("Your wallet"))}</span><span class="wc-bal" id="walletBal">${walletSol != null ? esc(money(walletSol, { solDigits: 4 })) : "…"}</span></div>
      <div class="wc-addr"><code>${esc(walletPub)}</code></div>
      <div class="btn-row"><button id="walletCopy" class="ghost">${esc(t("Copy address"))}</button><a class="btn ghost" target="_blank" href="https://solscan.io/account/${esc(walletPub)}">Solscan ↗</a></div>
      <p class="help">${esc(t("To fund it, send SOL to this address from Phantom, Solflare or an exchange. 0.1 SOL is enough for a few launches."))}</p>
      <div class="btn-row"><button id="walletReveal" class="ghost">🔑 ${esc(t("Show private key"))}</button><button id="walletDownload" class="ghost">⬇ ${esc(t("Download key file"))}</button></div>
      <div id="walletSecretBox" hidden></div>
      <details class="wc-change"><summary>${esc(t("Change wallet"))}</summary>
        <button id="walletCreate" class="ghost wide">✨ ${esc(t("Create a new wallet instead"))}</button>
        <button id="walletVanity" class="ghost wide">🎯 ${esc(t("Vanity address…"))}</button>
        <div class="wallet-row"><input id="walletInput" type="password" autocomplete="off" placeholder="${esc(t("Paste private key to import"))}"/><button id="walletSave">${esc(t("Import"))}</button></div>
        <button id="walletRemove" class="link danger">${esc(t("Remove wallet from this browser"))}</button>
        <p class="help">${esc(t("The current wallet is kept under \"Previous wallets\" so you can always get back to it."))}</p>
      </details>
    </div>${archive}`;
}

function sectionHtml(sec) {
  const title = `<h3>${esc(t(sec.title))}${infoBtn(sec.guide)}</h3>`;
  const wrap = (body) => `<div class="sec" data-sub="${sec.sub}">${title}${body}</div>`;
  if (sec.custom === "wallet") return wrap(`<div id="pnlBox"></div><div id="vanityStatus" class="vstatus" hidden></div><div id="walletBox">${walletHtml()}</div>`);
  if (sec.custom === "backup") {
    return wrap(`<p class="help" style="margin-top:0">${esc(t("Saves everything to one file: all settings, API keys, your wallet keys (current and previous) and your launch history. Import it after reinstalling and you're set up again."))}</p>
      <div class="warnbox">${esc(t("The file contains your wallet private key. Anyone who gets it can empty that wallet. Set a password, and don't upload or share the file."))}</div>
      <div class="fld"><label for="backupPw">${esc(t("Backup password (recommended)"))}</label><input id="backupPw" type="password" autocomplete="new-password" placeholder="${esc(t("Locks the file. Needed again when importing."))}"/></div>
      <div class="fld check"><input type="checkbox" id="backupHistory" checked/><div><label for="backupHistory">${esc(t("Include launch history"))}</label></div></div>
      <div class="onboard-row"><button id="exportBtn">${esc(t("Export backup"))}</button><button id="importBtn" class="ghost">${esc(t("Import backup"))}</button></div>
      <input type="file" id="importFile" accept=".json,application/json" hidden />
      <div id="backupOut" class="help"></div>`);
  }
  if (sec.custom === "token") return wrap(`<div id="tokenBox"></div>`);
  if (sec.custom === "votes") return wrap(`<div id="votesBox"></div>`);
  if (sec.custom === "language") {
    return wrap(`<div class="fld"><label for="s-language">${esc(t("Language"))}</label>
      <select id="s-language" data-k="language">${LANGUAGES.map(([c, l]) => `<option value="${c}" ${c === (settings.language || "auto") ? "selected" : ""}>${esc(c === "auto" ? t(l) : l)}</option>`).join("")}</select>
      <div class="help">${esc(t("Changes right away. Messages that come from websites and APIs (errors, skip reasons) may stay in English."))}</div></div>`);
  }
  const body = sec.fields.map((f) => (f.row ? `<div class="grid2">${f.row.map(fieldHtml).join("")}</div>` : fieldHtml(f))).join("");
  const extra = sec.custom === "aiimages"
    ? `<div class="fld"><button id="aiTestBtn" class="ghost wide">${esc(t("Test AI image (save first)"))}</button><div id="aiTestOut"></div></div>`
    : sec.custom === "aiprovider"
    ? `<div class="fld"><button id="aiTextTest" class="ghost wide">${esc(t("Test AI"))}</button><div id="aiTextOut"></div></div>`
    : sec.custom === "naming"
    ? `<div class="fld"><label>${esc(t("Meta right now (what the AI sees)"))}</label><pre id="metaPreview" class="meta-pre">…</pre><button id="metaRefresh" class="ghost wide">${esc(t("Refresh meta"))}</button></div>`
    : sec.custom === "notify"
    ? `<div class="fld"><button id="soundTestBtn" class="ghost wide">🔔 ${esc(t("Test sound (save volume first)"))}</button></div>` : "";
  return wrap(body + extra);
}

function renderSubnav() {
  $("#subtabs").innerHTML = SUBS.map(([id, icon, label]) => `<button data-sub="${id}" class="${id === subTab ? "on" : ""}"><span>${icon}</span> ${esc(t(label))}</button>`).join("");
}
function showSub(id) {
  subTab = SUBS.some(([s]) => s === id) ? id : "account";
  store.set("hatchr.sub", subTab);
  $$("#subtabs button").forEach((b) => b.classList.toggle("on", b.dataset.sub === subTab));
  $$("#settingsForm .sec").forEach((s) => { s.hidden = s.dataset.sub !== subTab; });
  // wide layout: one section gets a centered column, two or more sit side by side
  $("#settingsForm").dataset.n = String($$("#settingsForm .sec").filter((s) => !s.hidden).length);
  $("#saveBtn").hidden = subTab === "account" || subTab === "language" || subTab === "token";
  $("#testBtn").hidden = subTab === "token";
  if (subTab === "token") refreshToken();
  $("#testOut").innerHTML = "";
  hideGuide(true);
  if (subTab === "account") loadArchiveBalances();
}
$("#subtabs").addEventListener("click", (e) => {
  const b = e.target.closest("button[data-sub]");
  if (b) { showSub(b.dataset.sub); scrollTop(); }
});

function syncProviderFields() {
  const custom = currentProvider() === "custom";
  $$(".ai-custom").forEach((el) => { el.hidden = !custom; });
  const key = $("#s-aiKey");
  if (key) key.placeholder = AI_PROVIDERS[currentProvider()]?.noKey ? t("(not needed for this provider)") : "";
}

async function loadArchiveBalances() {
  for (const el of $$("[data-bal]")) {
    try {
      const sol = await send({ type: "balanceOf", pub: el.dataset.bal });
      el.dataset.balSol = String(sol);
      el.textContent = money(sol, { solDigits: 4 });
      if (sol > 0) el.classList.add("has-sol");
    } catch { el.textContent = "?"; }
  }
}

async function showSecret(pub) {
  if (!(await ask(t("Anyone who sees this key can take everything in the wallet. Show it?"), t("Show private key")))) return;
  try {
    const w = await send({ type: "revealWallet", pub });
    const box = pub ? null : $("#walletSecretBox");
    const html = `<div class="secret"><div class="help">${esc(t("Private key (base58). Phantom: Add / Connect Wallet → Import Private Key."))}</div>
      <code class="secret-key">${esc(w.secret)}</code>
      <div class="btn-row"><button class="ghost" data-copy>${esc(t("Copy key"))}</button><button class="ghost" data-hide>${esc(t("Hide"))}</button></div></div>`;
    if (box) {
      box.innerHTML = html;
      box.hidden = false;
      $("[data-copy]", box).addEventListener("click", () => copyText(w.secret, t("Private key copied")));
      $("[data-hide]", box).addEventListener("click", () => { box.hidden = true; box.innerHTML = ""; });
      clearTimeout(showSecret.timer);
      showSecret.timer = setTimeout(() => { box.hidden = true; box.innerHTML = ""; }, 60000);
    } else {
      openModal(`<h3 class="modal-title">${esc(t("Previous wallet"))}</h3><code class="pv-code">${esc(w.pub)}</code>${html}`);
      $("#modalBox [data-copy]").addEventListener("click", () => copyText(w.secret, t("Private key copied")));
      $("#modalBox [data-hide]").addEventListener("click", closeModal);
    }
  } catch (e) { toast(e.message); }
}

function bindWallet() {
  const after = async (pub, msg) => {
    walletPub = pub;
    walletArchive = await send({ type: "walletArchive" }).catch(() => walletArchive);
    $("#walletBox").innerHTML = walletHtml();
    bindWallet();
    renderPnl();
    loadArchiveBalances();
    refreshBalance();
    if (msg) toast(msg);
  };
  $("#walletCreate")?.addEventListener("click", async () => {
    try { await after(await send({ type: "createWallet" }), t("New wallet created. Send it some SOL to launch for real.")); } catch (e) { toast(e.message, 4000); }
  });
  $("#walletSave")?.addEventListener("click", async () => {
    const v = $("#walletInput").value.trim();
    if (!v) return toast(t("Paste a key first"));
    try { await after(await send({ type: "setWallet", secret: v }), t("Wallet imported")); } catch (e) { toast(e.message, 4000); }
  });
  $("#walletRemove")?.addEventListener("click", async () => {
    try { await after(await send({ type: "setWallet", secret: "" }), t("Wallet removed")); } catch (e) { toast(e.message); }
  });
  $("#walletVanity")?.addEventListener("click", () => openVanity(after));
  $("#walletCopy")?.addEventListener("click", () => copyText(walletPub, t("Address copied")));
  $("#walletReveal")?.addEventListener("click", () => showSecret(null));
  $("#walletDownload")?.addEventListener("click", async () => {
    try {
      const w = await send({ type: "revealWallet" });
      download(`hatchr-wallet-${w.pub.slice(0, 6)}.json`, JSON.stringify({
        app: "Hatchr",
        address: w.pub,
        privateKey: w.secret,
        secretKey: JSON.parse(w.array),
        howToImport: "Phantom / Solflare: Add or Connect Wallet -> Import Private Key -> paste privateKey. Solana CLI: save the secretKey array alone as a .json keypair file.",
        createdAt: new Date().toISOString(),
      }, null, 2));
    } catch (e) { toast(e.message); }
  });
  $$("[data-wact]").forEach((b) => b.addEventListener("click", async () => {
    const pub = b.dataset.pub;
    if (b.dataset.wact === "reveal") return showSecret(pub);
    try { await after(await send({ type: "useArchivedWallet", pub }), t("Switched wallet")); } catch (e) { toast(e.message); }
  }));
}

// ---------------- PnL card ----------------
const PNL_RANGES = [["day", "24h"], ["week", "7 days"], ["month", "30 days"], ["all", "All time"]];
const SHARE_ICON = `<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M8 1.5 4.6 4.9l1 1L7.3 4.2V10h1.4V4.2l1.7 1.7 1-1z"/><path d="M3 8.5v5h10v-5h-1.4v3.6H4.4V8.5z"/></svg>`;
const pct = (n) => `${n > 0 ? "+" : ""}${Math.abs(n) >= 100 ? Math.round(n) : n.toFixed(1)}%`;

function currentPnl() {
  return computePnl({ deploys, rewards, wallet: walletPub, scope: settings.pnlScope, range: settings.pnlRange, test: !!settings.dryRun });
}

function renderPnl() {
  const box = $("#pnlBox");
  if (!box) return;
  const p = currentPnl();
  const test = !!settings.dryRun;
  const tone = !p.launches && !p.rewards ? "" : p.pnl >= 0 ? "up" : "down";
  const meta = p.launches || p.rewards
    ? [t("spent {amount}", { amount: money(p.spent) }), t("back {amount}", { amount: money(p.back) }), !test ? t("rewards {amount}", { amount: money(p.rewards) }) : "", t("{n} launches", { n: p.launches })].filter(Boolean).join(" · ")
    : t("No launches in this period yet.");
  box.innerHTML = `<div class="pnl ${tone}">
    <div class="pnl-l">
      <div class="pnl-head"><span class="pnl-label">PnL</span>${test ? '<span class="badge dry">TEST</span>' : ""}
        <select id="pnlRange" class="pnl-sel" aria-label="${esc(t("Period"))}">${PNL_RANGES.map(([v, l]) => `<option value="${v}" ${v === (settings.pnlRange || "all") ? "selected" : ""}>${esc(t(l))}</option>`).join("")}</select>
        <select id="pnlScope" class="pnl-sel" aria-label="${esc(t("Counts"))}"><option value="wallet" ${settings.pnlScope !== "all" ? "selected" : ""}>${esc(t("This wallet"))}</option><option value="all" ${settings.pnlScope === "all" ? "selected" : ""}>${esc(t("All wallets"))}</option></select></div>
      <div class="pnl-num">${esc(money(p.pnl, { sign: true }))}${p.roi != null ? `<span class="pnl-roi">${esc(pct(p.roi))}</span>` : ""}</div>
      <div class="pnl-meta">${esc(meta)}</div>
    </div>
    <button id="pnlShare" class="pnl-share" title="${esc(t("Share PnL card"))}">${SHARE_ICON}</button>
  </div>`;
  $("#pnlRange").addEventListener("change", (e) => setSetting({ pnlRange: e.target.value }).then(renderPnl));
  $("#pnlScope").addEventListener("change", (e) => setSetting({ pnlScope: e.target.value }).then(renderPnl));
  $("#pnlShare").addEventListener("click", () => sharePnl(p));
}

function loadImg(src) {
  return new Promise((res) => { const i = new Image(); i.onload = () => res(i); i.onerror = () => res(null); i.src = src; });
}

// 1200x630 picture of the PnL card, for X / Telegram
async function pnlImage(p, withLogo = true) {
  const W = 1200, H = 630;
  const c = document.createElement("canvas");
  c.width = W; c.height = H;
  const x = c.getContext("2d");
  const up = p.pnl >= 0;
  const accent = up ? "#86efac" : "#f87171";
  x.fillStyle = "#0e0f12";
  x.fillRect(0, 0, W, H);
  const g = x.createRadialGradient(330, 330, 20, 330, 330, 620);
  g.addColorStop(0, up ? "rgba(134,239,172,0.20)" : "rgba(248,113,113,0.18)");
  g.addColorStop(1, "rgba(14,15,18,0)");
  x.fillStyle = g;
  x.fillRect(0, 0, W, H);
  const tier = currentTier();
  const goldCard = tier?.id === "gold" && settings.goldCard !== false;
  if (goldCard) {
    // Gold tier: a warm glow from the top right, and one thin gold line set in from the edge with round
    // corners, so it stays whole wherever the picture's own corners get rounded (X, chat apps)
    const gg = x.createRadialGradient(W - 120, 40, 10, W - 120, 40, 620);
    gg.addColorStop(0, "rgba(246,196,83,0.20)");
    gg.addColorStop(1, "rgba(14,15,18,0)");
    x.fillStyle = gg;
    x.fillRect(0, 0, W, H);
    const g2 = x.createRadialGradient(80, H - 30, 10, 80, H - 30, 420);
    g2.addColorStop(0, "rgba(246,196,83,0.07)");
    g2.addColorStop(1, "rgba(14,15,18,0)");
    x.fillStyle = g2;
    x.fillRect(0, 0, W, H);
    const frame = x.createLinearGradient(0, 0, W, H);
    frame.addColorStop(0, "rgba(249,220,140,0.95)"); frame.addColorStop(0.5, "rgba(184,134,43,0.55)"); frame.addColorStop(1, "rgba(246,196,83,0.9)");
    x.save();
    x.shadowColor = "rgba(246,196,83,0.35)";
    x.shadowBlur = 22;
    x.strokeStyle = frame;
    x.lineWidth = 2.5;
    x.beginPath(); x.roundRect(20, 20, W - 40, H - 40, 34); x.stroke();
    x.restore();
  } else {
    x.strokeStyle = "rgba(255,255,255,0.06)";
    x.lineWidth = 2;
    x.strokeRect(1, 1, W - 2, H - 2);
  }
  const font = (w, s) => `${w} ${s}px Inter, "Segoe UI", system-ui, sans-serif`;
  const logo = withLogo ? await loadImg("icons/icon128.png") : null;
  if (logo) x.drawImage(logo, 70, 58, 64, 64);
  x.fillStyle = "#f4f4f5";
  x.font = font(800, 40);
  x.textBaseline = "middle";
  x.fillText("Hatchr", 150, 92);
  x.textAlign = "right";
  x.fillStyle = "#8e909b";
  x.font = font(600, 26);
  const range = t((PNL_RANGES.find(([v]) => v === (settings.pnlRange || "all")) || PNL_RANGES[3])[1]);
  x.fillText(`${range}${settings.dryRun ? ` · ${t("TEST (simulated)")}` : ""}`, W - 70, 92);
  x.textAlign = "left";
  if (tier) {
    // holder badge, right-aligned under the period
    const label = `$${token.config.ticker} ${tier.label.toUpperCase()}`;
    x.font = font(800, 20);
    const tw = x.measureText(label).width, ph = 38, pw = tw + 58, px = W - 70 - pw, py = 124;
    const gold = tier.id === "gold";
    x.fillStyle = gold ? "rgba(246,196,83,0.14)" : "rgba(134,239,172,0.12)";
    x.strokeStyle = gold ? "rgba(246,196,83,0.65)" : "rgba(134,239,172,0.5)";
    x.lineWidth = 2;
    x.beginPath(); x.roundRect(px, py, pw, ph, ph / 2); x.fill(); x.stroke();
    x.fillStyle = gold ? "#f6c453" : "#86efac";
    x.beginPath(); x.arc(px + 22, py + ph / 2, 8, 0, Math.PI * 2); x.fill();
    x.fillStyle = "#0e0f12";
    x.beginPath(); x.ellipse(px + 22, py + ph / 2, 3.2, 4.2, 0, 0, Math.PI * 2); x.fill();
    x.fillStyle = gold ? "#f6c453" : "#86efac";
    x.fillText(label, px + 40, py + ph / 2 + 1);
  }
  x.fillStyle = "#8e909b";
  x.font = font(700, 30);
  x.fillText("PnL", 70, 225);
  x.fillStyle = accent;
  let size = 120;
  const big = money(p.pnl, { sign: true });
  do { x.font = font(800, size); size -= 6; } while (x.measureText(big).width > 640 && size > 60);
  x.fillText(big, 66, 320);
  const sub = [];
  if (p.roi != null) sub.push(pct(p.roi));
  if ((settings.currency || "sol") !== "sol" && solPx) sub.push(`${p.pnl > 0 ? "+" : ""}${fmtSol(p.pnl)} SOL`);
  x.fillStyle = "#f4f4f5";
  x.font = font(700, 38);
  x.fillText(sub.join("   "), 70, 420);
  // stat boxes on the right
  const stats = [
    [t("Launches"), String(p.launches)],
    [t("Spent"), money(p.spent)],
    [settings.dryRun ? t("Back from sells") : t("Sells + rewards"), money(p.back + p.rewards)],
  ];
  stats.forEach(([label, val], i) => {
    const y = 180 + i * 118;
    x.fillStyle = "rgba(255,255,255,0.04)";
    x.strokeStyle = "rgba(255,255,255,0.08)";
    x.beginPath();
    x.roundRect(790, y, 340, 98, 18);
    x.fill();
    x.stroke();
    x.fillStyle = "#8e909b";
    x.font = font(600, 22);
    x.fillText(label, 816, y + 32);
    x.fillStyle = "#f4f4f5";
    x.font = font(800, 34);
    x.fillText(val, 816, y + 68);
  });
  x.fillStyle = "#5c5e68";
  x.font = font(600, 22);
  x.fillText(t("Memecoins from breaking posts"), 70, 560);
  try {
    return await new Promise((res) => c.toBlob(res, "image/png"));
  } catch {
    return withLogo ? pnlImage(p, false) : null; // logo couldn't be drawn: make it without
  }
}

async function sharePnl(p) {
  const blob = await pnlImage(p);
  const url = URL.createObjectURL(blob);
  const range = t((PNL_RANGES.find(([v]) => v === (settings.pnlRange || "all")) || PNL_RANGES[3])[1]);
  const pnl = `${money(p.pnl, { sign: true })}${p.roi != null ? ` (${pct(p.roi)})` : ""}`;
  let text = !p.launches ? t("Hatching memecoins from breaking posts with Hatchr")
    : p.launches === 1 ? t("My Hatchr PnL ({range}): {pnl} from 1 memecoin launch", { range, pnl })
    : t("My Hatchr PnL ({range}): {pnl} from {n} memecoin launches", { range, pnl, n: p.launches });
  if (settings.dryRun && p.launches) text += ` ${t("(test mode, nothing spent)")}`;
  text += " 🐣\n\nhatchr.pro";
  openModal(`<h3 class="modal-title">${esc(t("Share PnL card"))}</h3>
    <img class="pnl-img" src="${url}" alt="PnL"/>
    <div class="btn-row"><button id="pnlCopy" class="primary">${esc(t("Copy image"))}</button><button id="pnlDl" class="ghost">${esc(t("Download"))}</button></div>
    <div class="btn-row"><button id="pnlX" class="ghost">${esc(t("Post on X"))}</button></div>
    <p class="help" id="pnlXHelp">${esc(t("Post on X opens X with this picture already in your post. You just press Post."))}</p>`);
  const copy = async () => {
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); toast(t("Image copied")); return true; }
    catch { toast(t("Couldn't copy")); return false; }
  };
  $("#pnlCopy").addEventListener("click", copy);
  $("#pnlDl").addEventListener("click", () => {
    const a = document.createElement("a");
    a.href = url;
    a.download = `hatchr-pnl-${new Date().toISOString().slice(0, 10)}.png`;
    a.click();
  });
  // X's share link can only carry text, so the picture is handed to Hatchr's script on x.com, which adds it
  // to the post. It's also put on the clipboard, in case X changed and it has to be pasted by hand.
  $("#pnlX").addEventListener("click", async () => {
    try { await navigator.clipboard.write([new ClipboardItem({ "image/png": blob })]); } catch {}
    const image = await new Promise((res) => { const r = new FileReader(); r.onload = () => res(r.result); r.readAsDataURL(blob); });
    await chrome.storage.local.set({ xShare: { image, at: Date.now() } });
    window.open(`https://x.com/intent/post?text=${encodeURIComponent(text)}`, "_blank", "noopener");
    $("#pnlXHelp").textContent = t("If the picture isn't in your post, press Ctrl+V (Cmd+V on Mac): it's on your clipboard.");
  });
}

// ---------------- $HATCHR holder perks ----------------
// What the panel treats as "held": the wallet's real balance once the coin is live, or the tier picked
// in the preview switch (preview build only).
const PREVIEW_AMOUNT = { holder: 250_000, gold: 2_400_000 };
const tokenPreviewOn = () => PREVIEW_BUILD && !!PREVIEW_AMOUNT[settings.tokenPreview];
function heldAmount() {
  if (tokenPreviewOn()) return PREVIEW_AMOUNT[settings.tokenPreview];
  return token.config.mint && token.amount != null ? token.amount : null;
}
function currentTier() {
  const a = heldAmount();
  return a == null ? null : tierFor(a, token.config.tiers);
}

async function refreshToken(force = false) {
  try { const r = await send({ type: "token", force }); if (r && r.config) token = r; } catch (e) { token = { ...token, error: e.message }; }
  renderTier();
  renderTokenBox();
  renderVotes();
}

// header badge + gold theme
function renderTier() {
  const tier = currentTier();
  const b = $("#tierBadge"), dot = $("#tierDot");
  b.hidden = dot.hidden = !tier;
  if (tier) {
    dot.className = `tier-dot ${tier.id}`;
    b.textContent = tier.label.toUpperCase();
    b.className = `tier-badge ${tier.id}`;
    b.title = t("You hold {n} ${ticker}. Click for your perks.", { n: fmtAmount(heldAmount()), ticker: token.config.ticker });
  }
  const themePerk = PERKS.find((p) => p.id === "theme");
  document.body.classList.toggle("gold", !!settings.goldTheme && hasPerk(themePerk, tier, token.config.tiers));
  fitHeader();
}
for (const id of ["#tierBadge", "#tierDot"]) $(id).addEventListener("click", () => { showTab("settings"); showSub("token"); scrollTop(); });

function renderTokenBox() {
  const box = $("#tokenBox");
  if (!box) return;
  const cfg = token.config, tier = currentTier(), amt = heldAmount();
  const live = !!cfg.mint, preview = tokenPreviewOn();
  const nt = nextTier(amt ?? 0, cfg.tiers);
  const tk = `$${cfg.ticker}`;
  let status = "";
  if (preview) status = t("Preview: this is how the panel looks for a {tier} holder. Nothing here is a real balance.", { tier: tier?.label || "" });
  else if (!live) status = t("{tk} isn't launched yet. Once it is, keep it in your Hatchr wallet and the perks switch on by themselves.", { tk });
  else if (!walletPub) status = t("Create or import a wallet under Account first. Hatchr reads how much {tk} that wallet holds.", { tk });
  else if (token.error) status = t("Couldn't read your {tk} balance: {err}", { tk, err: token.error });
  const bar = nt ? Math.round(nt.progress * 100) : 100;
  const nextLine = amt == null ? t("Holder from {a} · Gold from {b}", { a: fmtAmount(cfg.tiers[0].min), b: fmtAmount(cfg.tiers[1].min) })
    : nt ? t("{n} more for {tier}", { n: fmtAmount(nt.missing), tier: nt.tier.label })
    : t("Top tier reached");
  const perks = PERKS.map((p) => {
    const on = hasPerk(p, tier, cfg.tiers);
    const need = cfg.tiers.find((x) => x.id === p.tier);
    const sw = p.setting
      ? `<label class="tk-sw" title="${esc(on ? "" : t("Unlocks at {tier}", { tier: need.label }))}"><input type="checkbox" data-tk-set="${p.setting}" ${settings[p.setting] && on ? "checked" : ""} ${on ? "" : "disabled"}/><span></span></label>`
      : "";
    return `<div class="tk-perk ${on ? "on" : ""}"><span class="tk-ic">${on ? "✓" : "🔒"}</span>
      <div class="tk-ptxt"><b>${esc(t(p.title))}</b><span class="tk-pill ${p.tier}">${esc(need.label)}</span><div class="help">${esc(t(p.text))}</div></div>${sw}</div>`;
  }).join("");
  box.innerHTML = `
    <div class="tk-card ${tier ? tier.id : ""}">
      <div class="tk-top"><span class="tk-coin"><img src="icons/logo.svg" alt=""/></span>
        <div class="tk-name"><b>${esc(cfg.name)}</b><span>${esc(tk)}</span></div>
        <span class="tk-tier">${esc(tier ? tier.label : t("No tier yet"))}</span></div>
      <div class="tk-amt"><b>${amt == null ? "–" : esc(fmtAmount(amt))}</b><span>${esc(t("{tk} in your Hatchr wallet", { tk }))}</span></div>
      <div class="tk-bar"><i style="width:${bar}%"></i></div>
      <div class="tk-next">${esc(nextLine)}</div>
    </div>
    ${status ? `<div class="tk-status ${preview ? "preview" : ""}">${esc(status)}</div>` : ""}
    <div class="tk-perks">${perks}</div>
    <div class="tk-addr"><div class="tk-addr-l"><span class="wc-label">${esc(t("Official address"))}</span>
      ${live ? `<code>${esc(cfg.mint)}</code>` : `<span class="muted">${esc(t("Not launched yet"))}</span>`}</div>
      ${live ? `<button id="tkCopy" class="mini">${esc(t("Copy"))}</button>` : ""}</div>
    <p class="help">${esc(t("Only the address shown here and on hatchr.pro is the real {tk}. Any other coin with this name is a copy.", { tk }))}</p>
    <div class="btn-row">${live ? `<a class="btn ghost" target="_blank" rel="noopener" href="https://pump.fun/coin/${esc(cfg.mint)}">pump.fun ↗</a>` : ""}<a class="btn ghost" target="_blank" rel="noopener" href="https://hatchr.pro/#token">${esc(t("How it works"))} ↗</a><button id="tkRefresh" class="ghost">⟳ ${esc(t("Refresh"))}</button></div>
    <div class="tk-note">${esc(t("{tk} unlocks perks in Hatchr. It is not an investment and gives no share in the project or its income. Its price can fall to zero.", { tk }))}</div>
    ${!PREVIEW_BUILD ? "" : `<div class="fld tk-preview"><label for="tkPreview">${esc(t("Preview a tier (this build only)"))}</label>
      <select id="tkPreview"><option value="off">${esc(t("Off: show my real balance"))}</option>${cfg.tiers.map((x) => `<option value="${x.id}" ${settings.tokenPreview === x.id ? "selected" : ""}>${esc(x.label)} · ${esc(fmtAmount(PREVIEW_AMOUNT[x.id]))} ${esc(tk)}</option>`).join("")}</select></div>`}`;
  $("#tkCopy")?.addEventListener("click", () => copyText(cfg.mint, t("Address copied")));
  $("#tkRefresh").addEventListener("click", () => refreshToken(true).then(() => toast(t("Updated"))));
  $("#tkPreview")?.addEventListener("change", async (e) => { await setSetting({ tokenPreview: e.target.value }); renderTokenBox(); renderVotes(); });
  $$("[data-tk-set]", box).forEach((el) => el.addEventListener("change", async () => { await setSetting({ [el.dataset.tkSet]: el.checked }); renderTokenBox(); }));
}

// Feature votes: holders pick what gets built next. In this preview the vote is only saved on this computer.
function renderVotes() {
  const box = $("#votesBox");
  if (!box) return;
  const cfg = token.config, tier = currentTier();
  const open = PREVIEW_BUILD; // real counting isn't live yet: until it is, the options are shown but can't be picked
  const can = open && hasPerk(PERKS.find((p) => p.id === "votes"), tier, cfg.tiers);
  const double = hasPerk(PERKS.find((p) => p.id === "weight"), tier, cfg.tiers);
  box.innerHTML = `<p class="help" style="margin-top:0">${esc(!open
      ? t("Holders will pick what gets built next from ideas like these. The first vote opens after {tk} launches.", { tk: `$${cfg.ticker}` })
      : can
      ? (double ? t("Pick what gets built next. As a Gold holder your vote counts twice.") : t("Pick what gets built next. One vote per wallet; you can change it."))
      : t("Holders pick what gets built next. Hold {n} ${ticker} to vote.", { n: fmtAmount(cfg.tiers[0].min), ticker: cfg.ticker }))}</p>
    ${cfg.votes.map((v) => `<button class="tk-vote ${tokenVote?.id === v.id ? "mine" : ""}" data-vote="${esc(v.id)}" ${can ? "" : "disabled"}>
      <span class="tk-vdot"></span><span class="tk-vtxt"><b>${esc(t(v.title))}</b><span>${esc(t(v.text))}</span></span>
      ${tokenVote?.id === v.id ? `<span class="tk-vmine">${esc(double ? t("Your vote ×2") : t("Your vote"))}</span>` : ""}</button>`).join("")}
    ${open ? `<p class="help">${esc(t("Preview: your vote is saved on this computer only. Counting starts when the coin is live."))}</p>` : ""}`;
  $$("[data-vote]", box).forEach((b) => b.addEventListener("click", async () => {
    tokenVote = tokenVote?.id === b.dataset.vote ? null : { id: b.dataset.vote, at: Date.now() };
    await chrome.storage.local.set({ tokenVote });
    renderVotes();
  }));
}

// ---------------- vanity wallet ----------------
function fmtCount(n) {
  if (n >= 1e9) return `${(n / 1e9).toFixed(1)}B`;
  if (n >= 1e6) return `${(n / 1e6).toFixed(1)}M`;
  if (n >= 1e3) return `${Math.round(n / 1e3)}K`;
  return String(Math.round(n));
}
function fmtDuration(sec) {
  if (sec < 1) return t("under a second");
  if (sec < 90) return t("{n} sec", { n: Math.round(sec) });
  if (sec < 5400) return t("{n} min", { n: Math.round(sec / 60) });
  if (sec < 172800) return t("{n} hours", { n: Math.round(sec / 3600) });
  return t("{n} days", { n: Math.round(sec / 86400) });
}

// The search itself runs in the background (offscreen page), so you can close this and keep going.
let vanityJob = null;
let vanityModalOpen = false;
let vanityAfter = null; // refresh the wallet section after a vanity wallet is used

const vanityPattern = (j) => `${j.prefix ? `${j.prefix}…` : "…"}${j.suffix || ""}`;

function vanityProgressText(j) {
  const secs = (j.ms || 0) / 1000;
  const speed = secs > 1 ? j.tried / secs : 0;
  return t("Searching… {n} checked ({speed}/s).", { n: fmtCount(j.tried || 0), speed: fmtCount(speed) });
}

function vanityFoundHtml(j) {
  const p = (j.prefix || "").length, s = (j.suffix || "").length, a = j.pub || "";
  return `<div class="vfound"><div class="help">${esc(t("Found after {n} tries ({time}).", { n: fmtCount(j.tried || 0), time: fmtDuration((j.ms || 0) / 1000) }))}</div>
    <code class="vaddr"><b>${esc(a.slice(0, p))}</b>${esc(a.slice(p, a.length - s))}<b>${esc(s ? a.slice(-s) : "")}</b></code>
    <div class="btn-row"><button id="vUse" class="primary">${esc(t("Use this wallet"))}</button><button id="vDiscard" class="ghost">${esc(t("Discard"))}</button></div></div>`;
}

async function useVanity() {
  try {
    const pub = await send({ type: "vanityUse" });
    closeModal();
    hideVanityNotice();
    if (vanityAfter) await vanityAfter(pub, t("Vanity wallet saved. Send it some SOL to launch for real."));
    else { walletPub = pub; refreshBalance(); }
  } catch (e) { toast(e.message, 4000); }
}

function openVanity(onUse) {
  if (onUse) vanityAfter = onUse;
  const j = vanityJob;
  if (j && j.status === "found" && !j.seen) send({ type: "vanitySeen" }).catch(() => {});
  hideVanityNotice();
  openModal(`
    <h3 class="modal-title">🎯 ${esc(t("Vanity wallet"))}</h3>
    <div id="vBody"></div>`);
  vanityModalOpen = true;
  renderVanityModal();
}

function renderVanityModal() {
  const body = $("#vBody");
  if (!body || !vanityModalOpen) return;
  const j = vanityJob;
  if (j && j.status === "running") {
    if (body.dataset.view !== "running") {
      body.dataset.view = "running";
      body.innerHTML = `<div class="vjob"><code class="vpat">${esc(vanityPattern(j))}</code>
        <div id="vProg" class="help"></div></div>
        <div class="btn-row"><button id="vHide" class="primary">${esc(t("Keep searching in the background"))}</button><button id="vStop" class="ghost">${esc(t("Stop"))}</button></div>
        <p class="help">${esc(t("You can close this and keep using Hatchr, even close the panel. You'll hear a chime and get a notification when it's found."))}</p>`;
      $("#vHide").addEventListener("click", closeModal);
      $("#vStop").addEventListener("click", () => send({ type: "vanityStop" }).catch((e) => toast(e.message)));
    }
    $("#vProg").innerHTML = `<span class="spin"></span>${esc(vanityProgressText(j))}`;
    return;
  }
  if (body.dataset.view === "form-forced") return;
  if (j && j.status === "found" && j.pub) {
    if (body.dataset.view === `found:${j.pub}`) return;
    body.dataset.view = `found:${j.pub}`;
    body.innerHTML = vanityFoundHtml(j) + `<button id="vAgain" class="link">${esc(t("Search again"))}</button>`;
    $("#vUse").addEventListener("click", useVanity);
    $("#vDiscard").addEventListener("click", () => {
      send({ type: "vanityDiscard" }).catch(() => {});
    });
    $("#vAgain").addEventListener("click", () => { body.dataset.view = "form-forced"; renderVanityForm(body); });
    return;
  }
  if (body.dataset.view === "form") return;
  renderVanityForm(body);
}

function renderVanityForm(body) {
  const last = vanityJob && (vanityJob.status === "stopped" || vanityJob.status === "error" || vanityJob.status === "found") ? vanityJob : null;
  if (body.dataset.view !== "form-forced") body.dataset.view = "form";
  const speed = Number(store.get("hatchr.vanitySpeed")) || 0;
  body.innerHTML = `
    <p class="help">${esc(t("Make a wallet whose address starts or ends with letters you choose, like PEPE… or …moon. Every extra letter makes it about 30-58 times slower."))}</p>
    <div class="grid2">
      <div class="fld"><label for="vPre">${esc(t("Starts with"))}</label><input id="vPre" maxlength="6" autocomplete="off" spellcheck="false" placeholder="PEPE" value="${esc(last?.prefix || "")}"/></div>
      <div class="fld"><label for="vSuf">${esc(t("Ends with"))}</label><input id="vSuf" maxlength="6" autocomplete="off" spellcheck="false" placeholder="moon" value="${esc(last?.suffix || "")}"/></div>
    </div>
    <div class="fld check"><input type="checkbox" id="vCase" ${last?.caseSensitive ? "checked" : ""}/><div><label for="vCase">${esc(t("Match upper/lower case exactly"))}</label><div class="help">${esc(t("Off is much faster: pepe also matches PePe."))}</div></div></div>
    <div id="vOdds" class="help note"></div>
    ${last?.error === "interrupted" ? `<p class="help err-t">${esc(t("The last search stopped because Chrome was closed or restarted."))}</p>` : ""}
    <div class="btn-row"><button id="vGo" class="primary">${esc(t("Start search"))}</button></div>
    <p class="help">${esc(t("It runs in the background: you can close this and keep going. A chime and a notification tell you when it's found."))}</p>`;
  const pre = $("#vPre"), suf = $("#vSuf"), cs = $("#vCase");
  const odds = () => {
    const p = pre.value.trim(), s = suf.value.trim();
    const bad = badChars(p + s);
    const box = $("#vOdds");
    $("#vGo").disabled = !!bad.length || !(p || s);
    if (bad.length) { box.innerHTML = `<span class="err-t">${esc(t("Not possible in an address: {chars}. Addresses use 1-9 and letters, but never 0, O, I or l.", { chars: bad.join(" ") }))}</span>`; return; }
    if (!(p || s)) { box.textContent = t("Type the letters you want at the start, the end, or both."); return; }
    const tries = vanityTries(p, s, cs.checked);
    const eta = speed ? ` ${t("At {speed} per second on this computer that's about {time}, but it's luck: it can be faster or slower.", { speed: fmtCount(speed), time: fmtDuration(tries / speed) })}` : "";
    box.textContent = `${t("About 1 in {n} addresses match.", { n: fmtCount(tries) })}${eta}${tries > 5e8 ? ` ${t("That's a lot: try fewer letters.")}` : ""}`;
  };
  [pre, suf].forEach((i) => i.addEventListener("input", odds));
  cs.addEventListener("change", odds);
  odds();
  $("#vGo").addEventListener("click", async () => {
    if (vanityJob?.status === "found" && !(await ask(t("Start a new search? The vanity wallet you found and didn't use will be thrown away.")))) return;
    $("#vGo").disabled = true;
    body.dataset.view = "";
    try {
      await send({ type: "vanityStart", prefix: pre.value.trim(), suffix: suf.value.trim(), caseSensitive: cs.checked });
    } catch (e) { toast(e.message, 4000); $("#vGo").disabled = false; body.dataset.view = "form"; }
  });
}

// small status line in the wallet section + an in-app notice when a search finishes
function renderVanityStatus() {
  const el = $("#vanityStatus");
  if (!el) return;
  const j = vanityJob;
  if (j && j.status === "running") {
    el.hidden = false;
    el.innerHTML = `<span class="spin"></span><span class="vs-t">${esc(t("Vanity search {pattern}", { pattern: vanityPattern(j) }))} · ${esc(fmtCount(j.tried || 0))}</span><button class="link" data-vact="open">${esc(t("View"))}</button>`;
  } else if (j && j.status === "found") {
    el.hidden = false;
    el.innerHTML = `<span class="vs-t">🎯 ${esc(t("Vanity wallet found: {addr}", { addr: `${(j.pub || "").slice(0, 8)}…` }))}</span><button class="link" data-vact="open">${esc(t("View"))}</button>`;
  } else el.hidden = true;
}
document.addEventListener("click", (e) => {
  if (e.target.closest("[data-vact=open]")) { showTab("settings"); showSub("account"); openVanity(); }
});

function showVanityNotice(j) {
  let n = $("#vNotice");
  if (!n) {
    n = document.createElement("div");
    n.id = "vNotice";
    n.className = "notice";
    document.body.appendChild(n);
  }
  n.innerHTML = `<span class="notice-ic">🎯</span><div class="notice-t"><b>${esc(t("Vanity wallet found!"))}</b><code>${esc((j.pub || "").slice(0, 12))}…${esc((j.pub || "").slice(-6))}</code></div>
    <button class="notice-go" data-vact="open">${esc(t("View"))}</button><button class="notice-x" title="${esc(t("Close"))}">×</button>`;
  $(".notice-x", n).addEventListener("click", () => { hideVanityNotice(); send({ type: "vanitySeen" }).catch(() => {}); });
}
function hideVanityNotice() { $("#vNotice")?.remove(); }

function onVanityJob(next, prev) {
  vanityJob = next;
  renderVanityStatus();
  renderVanityModal();
  if (next && next.status === "running" && next.tried > 0 && next.ms > 3000) store.set("hatchr.vanitySpeed", String(Math.round(next.tried / (next.ms / 1000))));
  if (next && next.status === "found" && !next.seen && !vanityModalOpen && (!prev || prev.status !== "found" || prev.pub !== next.pub)) showVanityNotice(next);
  else if (!next || next.status !== "found" || next.seen) hideVanityNotice();
}

function renderSettings() {
  $("#settingsForm").innerHTML = SCHEMA.map(sectionHtml).join("");
  renderSubnav();
  showSub(subTab);
  syncProviderFields();
  bindWallet();
  renderTokenBox();
  renderVotes();

  $("#s-aiProvider")?.addEventListener("change", (e) => {
    const p = AI_PROVIDERS[e.target.value];
    if (!p) return;
    if (p.url) $("#s-aiUrl").value = p.url;
    if (p.model) $("#s-aiModel").value = p.model;
    $("#s-aiFormat").value = p.format || "openai";
    const vision = $("#s-aiVisionModel");
    if (vision) vision.value = p.vision || "";
    syncProviderFields();
    if (e.target.value === "custom") {
      $("#s-aiUrl").value = ""; $("#s-aiModel").value = "";
      toast(t("Fill in your AI's URL, key and model (ⓘ shows how), then Save settings"), 4000);
    } else toast(t("Paste your key for {p}, then Save settings", { p: t(p.label) }), 3500);
  });
  $("#s-language")?.addEventListener("change", async (e) => {
    await setSetting({ language: e.target.value });
    applyLanguage();
  });

  const showMeta = async () => {
    const pre = $("#metaPreview");
    if (!pre) return;
    try {
      const m = await send({ type: "metaPreview" });
      pre.textContent = m.text || t("Nothing yet. Open axiom.trade on the Pulse page and give it a minute; the extension reads New Pairs, Final Stretch and Migrated every 15 seconds.");
    } catch (e) { pre.textContent = e.message; }
  };
  showMeta();
  $("#metaRefresh")?.addEventListener("click", showMeta);
  $("#soundTestBtn")?.addEventListener("click", async () => {
    try {
      const ok = await send({ type: "testSound", kind: "live" });
      if (!ok) toast(t("Couldn't play sound in this Chrome version"));
    } catch (e) { toast(e.message); }
  });
  $("#aiTextTest")?.addEventListener("click", async () => {
    const out = $("#aiTextOut");
    const patch = collectSettings();
    if (!(await allowHosts([patch.aiUrl]))) return;
    out.innerHTML = `<div class="muted" style="padding:6px 0"><span class="spin"></span>${esc(t("Asking the AI…"))}</div>`;
    try {
      const r = await send({ type: "testAi", patch });
      out.innerHTML = `<div class="test-row"><b class="ok">✓</b><span>${esc(t("Works! It named a test post ${ticker} \"{name}\" in {s}s (model {model}).", { ticker: r.ticker, name: r.name, s: (r.ms / 1000).toFixed(1), model: r.model }))}</span></div>`;
    } catch (e) {
      out.innerHTML = `<div class="test-row"><b class="bad">✗</b><span>${esc(e.message)}</span></div>`;
    }
  });
  $("#aiTestBtn")?.addEventListener("click", async () => {
    const out = $("#aiTestOut");
    out.innerHTML = `<div class="muted" style="padding:6px 0"><span class="spin"></span>${esc(t("Generating…"))}</div>`;
    try {
      const r = await send({ type: "testAiImage" });
      out.innerHTML = `<img class="ai-test" src="${esc(r.image)}" alt="AI test image"/><div class="help">${esc(r.provider)} · ${esc(r.model || "")}</div>`;
    } catch (e) {
      out.innerHTML = `<div class="test-row"><b class="bad">✗</b><span>${esc(e.message)}</span></div>`;
    }
  });
  $("#exportBtn").addEventListener("click", async () => {
    const password = $("#backupPw").value;
    if (!password && !(await ask(t("Export WITHOUT a password? Your wallet private key and API keys will be readable by anyone who opens the file.")))) return;
    try {
      const file = await send({ type: "exportBackup", password, includeHistory: $("#backupHistory").checked });
      download(`hatchr-backup-${new Date().toISOString().slice(0, 10)}${file.encrypted ? "-locked" : ""}.json`, JSON.stringify(file, null, 2));
      $("#backupOut").textContent = file.encrypted ? t("Exported (password-protected). Keep the password; it can't be recovered.") : t("Exported (no password). Keep the file private.");
    } catch (e) { toast(e.message, 5000); }
  });
  $("#importBtn").addEventListener("click", () => $("#importFile").click());
  $("#importFile").addEventListener("change", async (e) => {
    const f = e.target.files[0];
    e.target.value = "";
    if (!f) return;
    const text = await f.text();
    if (!(await ask(t("Replace your current settings, API keys and wallet with this backup?")))) return;
    try {
      const r = await send({ type: "importBackup", file: text, password: $("#backupPw").value });
      settings = { ...DEFAULTS, ...((await chrome.storage.local.get("settings")).settings || {}) };
      walletPub = r.wallet || walletPub;
      walletArchive = await send({ type: "walletArchive" }).catch(() => walletArchive);
      applyLanguage();
      refreshBalance();
      const needs = [settings.rpcUrl, settings.aiEnabled ? settings.aiUrl : null].filter(Boolean)
        .map((u) => { try { return new URL(u).origin; } catch { return null; } })
        .filter((o) => o && !BUILTIN_ORIGINS.has(o));
      const parts = [t("Backup imported")];
      if (r.wallet) parts.push(t("wallet {w}", { w: `${r.wallet.slice(0, 4)}…${r.wallet.slice(-4)}` }));
      if (r.historyAdded) parts.push(t("{n} launches restored", { n: r.historyAdded }));
      $("#backupOut").textContent = parts.join(" · ") + (needs.length ? `. ${t("Click \"Save settings\" once so Chrome allows {hosts}.", { hosts: needs.join(", ") })}` : ".");
      toast(t("Backup imported"));
    } catch (err) {
      $("#backupOut").textContent = err.message;
      toast(err.message, 5000);
    }
  });
  $$("[data-reset]").forEach((b) =>
    b.addEventListener("click", (e) => {
      e.preventDefault();
      const f = allFields().find((x) => x.k === b.dataset.reset);
      $(`#s-${f.k}`).value = f.reset;
    })
  );
}

// ---------------- ⓘ guides ----------------
let guidePinned = false;
let guideHideTimer = null;
function guideHtml(id, err) {
  const g = GUIDES[id];
  if (!g) return "";
  return `<div class="gp-head"><b>${esc(t(g.title))}</b><button class="gp-x" title="${esc(t("Close"))}">×</button></div>
    ${err ? `<p class="gp-err">⚠ ${esc(err)}</p>` : ""}
    ${g.intro ? `<p class="gp-intro">${esc(t(g.intro))}</p>` : ""}
    <ol class="gp-steps">${g.steps.map((s) => `<li>${esc(t(s))}</li>`).join("")}</ol>
    ${g.tips?.length ? `<div class="gp-tips">${g.tips.map((s) => `<p>💡 ${esc(t(s))}</p>`).join("")}</div>` : ""}
    ${g.url ? `<a class="gp-open" target="_blank" href="${esc(g.url)}">${esc(t("Open {site}", { site: g.site }))} ↗</a>` : ""}`;
}
function showGuide(btn, pin) {
  const id = guideId(btn.dataset.guide);
  const pop = $("#guidePop");
  clearTimeout(guideHideTimer);
  if (pop.dataset.guide !== id || pop.hidden) {
    pop.innerHTML = guideHtml(id, btn.dataset.err);
    pop.dataset.guide = id;
    $(".gp-x", pop).addEventListener("click", () => hideGuide(true));
  }
  pop.hidden = false;
  const r = btn.getBoundingClientRect();
  const h = pop.offsetHeight;
  const below = r.bottom + 6;
  pop.style.top = `${below + h > innerHeight - 8 ? Math.max(8, r.top - h - 6) : below}px`;
  // narrow panel: CSS spans it edge to edge; wide window: keep it next to the ⓘ
  pop.style.left = innerWidth >= 760 ? `${Math.max(8, Math.min(r.left - 16, innerWidth - pop.offsetWidth - 8))}px` : "";
  if (pin) guidePinned = true;
  pop.classList.toggle("pinned", guidePinned);
}
function hideGuide(force) {
  if (guidePinned && !force) return;
  guidePinned = false;
  const pop = $("#guidePop");
  pop.hidden = true;
  pop.dataset.guide = "";
}
document.addEventListener("click", (e) => {
  const b = e.target.closest(".ginfo, .bal-err");
  if (b) { e.preventDefault(); return showGuide(b, true); }
  if (!e.target.closest("#guidePop")) hideGuide(true);
});
document.addEventListener("mouseover", (e) => {
  const b = e.target.closest(".ginfo, .bal-err");
  if (b) showGuide(b, false);
  else if (e.target.closest("#guidePop")) clearTimeout(guideHideTimer);
});
document.addEventListener("mouseout", (e) => {
  if (!e.target.closest(".ginfo, .bal-err, #guidePop")) return;
  clearTimeout(guideHideTimer);
  guideHideTimer = setTimeout(() => hideGuide(false), 350);
});
addEventListener("scroll", () => hideGuide(true), { passive: true });
// the desktop app scrolls #app instead of the page (its title bar stays put)
$("#app").addEventListener("scroll", () => hideGuide(true), { passive: true });

function collectSettings() {
  const patch = {};
  $$("#settingsForm [data-k]").forEach((el) => {
    const k = el.dataset.k;
    if (el.type === "checkbox") patch[k] = el.checked;
    else if (el.type === "number") patch[k] = el.value === "" ? DEFAULTS[k] : Number(el.value);
    else patch[k] = el.value;
  });
  patch.tgPollSec = Math.max(30, patch.tgPollSec || 30);
  patch.tickerMaxLen = Math.min(10, Math.max(3, patch.tickerMaxLen || 10));
  patch.devBuySol = Math.max(0, patch.devBuySol);
  patch.sellPriorityFee = Math.max(0, patch.sellPriorityFee ?? DEFAULTS.sellPriorityFee);
  if (patch.aiProvider && patch.aiProvider !== "custom") patch.aiFormat = AI_PROVIDERS[patch.aiProvider]?.format || "openai";
  return patch;
}

const BUILTIN_ORIGINS = new Set(["https://api.mainnet-beta.solana.com", "https://mainnet.helius-rpc.com", "https://api.groq.com", "https://generativelanguage.googleapis.com", "https://api.openai.com", "https://api.cloudflare.com"]);

// Chrome must allow custom RPC / AI hosts; this has to run inside a click.
async function allowHosts(urls) {
  const origins = [];
  for (const u of urls) {
    if (!u) continue;
    try {
      const url = new URL(u);
      if (!/^https?:$/.test(url.protocol)) throw new Error();
      if (!BUILTIN_ORIGINS.has(url.origin)) origins.push(`${url.protocol}//${url.hostname}/*`);
    } catch { toast(t("Not a valid URL: {url}", { url: u })); return false; }
  }
  if (!origins.length) return true;
  const ok = await chrome.permissions.request({ origins }).catch(() => false);
  if (!ok) toast(t("Chrome didn't allow {hosts}", { hosts: origins.join(", ") }), 4000);
  return ok;
}

$("#saveBtn").addEventListener("click", async () => {
  const patch = collectSettings();
  if (!(await allowHosts([patch.rpcUrl, patch.aiEnabled ? patch.aiUrl : null]))) return;
  settings = await send({ type: "saveSettings", patch });
  renderHeader();
  renderFeed();
  refreshBalance();
  toast(t("Saved"));
});

$("#testBtn").addEventListener("click", async () => {
  const out = $("#testOut");
  out.innerHTML = `<div class="muted" style="padding:8px 0"><span class="spin"></span>${esc(t("Testing… (save first if you changed anything)"))}</div>`;
  try {
    const rows = await send({ type: "test" });
    out.innerHTML = rows.map((r) => `<div class="test-row"><b class="${r.ok ? "ok" : "bad"}">${r.ok ? "✓" : "✗"} ${esc(t(r.label))}</b><span>${esc(r.detail)}</span></div>`).join("");
  } catch (e) {
    out.innerHTML = `<div class="test-row"><b class="bad">✗ ${esc(t("Error"))}</b><span>${esc(e.message)}</span></div>`;
  }
});

// ---------------- boot ----------------
function applyLanguage() {
  setLang(settings.language);
  applyStatic();
  $("#feed").innerHTML = ""; // cards are rebuilt in the new language
  renderHeader();
  renderOnboard();
  renderFeed();
  renderDeploys();
  renderHeld();
  renderRewards();
  renderSettings();
  renderVanityStatus();
  renderMoney();
  if (!walletPub) $("#bal").textContent = t("no wallet");
}

async function load() {
  const st = await chrome.storage.local.get(["settings", "feed", "deploys", "axiomStatus", "onboardSeen", "aiUsage", "rewards", "metaTokens", "pumpStatus", "heldCoins", "heldInfo"]);
  heldCoins = st.heldCoins || [];
  heldInfo = st.heldInfo || null;
  pumpStatus = st.pumpStatus || null;
  vanityJob = (await chrome.storage.local.get("vanityJob")).vanityJob || null;
  rewards = st.rewards || null;
  metaCount = Object.keys(st.metaTokens || {}).length;
  aiUsage = st.aiUsage || null;
  axiomStatus = st.axiomStatus || null;
  onboardSeen = !!st.onboardSeen;
  settings = { ...DEFAULTS, ...(st.settings || {}) };
  feed = st.feed || [];
  deploys = st.deploys || [];
  try { walletPub = await send({ type: "walletPub" }); } catch {}
  renderHeld();
  try { walletArchive = await send({ type: "walletArchive" }); } catch {}
  tokenVote = (await chrome.storage.local.get("tokenVote")).tokenVote || null;
  applyLanguage();
  refreshBalance();
  refreshToken();
  loadPrice();
  if (vanityJob && vanityJob.status === "found" && !vanityJob.seen) showVanityNotice(vanityJob);
  // tells the first-run splash (splash.js) that the panel is ready underneath
  dispatchEvent(new Event("hatchr-ready"));
}

chrome.storage.onChanged.addListener((ch, area) => {
  if (area !== "local") return;
  if (ch.settings) {
    const before = settings.language;
    settings = { ...DEFAULTS, ...(ch.settings.newValue || {}) };
    if (settings.language !== before) applyLanguage();
    else { renderHeader(); renderFeed(); renderDeploys(); renderHeld(); }
    renderTier();
    const m = document.getElementById("s-aiModel");
    if (m && document.activeElement !== m && m.value !== settings.aiModel) m.value = settings.aiModel;
  }
  if (ch.feed) { feed = ch.feed.newValue || []; renderFeed(); }
  if (ch.heldCoins || ch.heldInfo) {
    if (ch.heldCoins) heldCoins = ch.heldCoins.newValue || [];
    if (ch.heldInfo) heldInfo = ch.heldInfo.newValue || null;
    renderHeld();
  }
  if (ch.metaTokens) {
    const n = Object.keys(ch.metaTokens.newValue || {}).length;
    if (n !== metaCount) { metaCount = n; if (!ch.feed) renderFeed(); }
  }
  if (ch.rewards) { rewards = ch.rewards.newValue || null; renderRewards(); renderPnl(); }
  if (ch.aiUsage) { aiUsage = ch.aiUsage.newValue || null; if (!ch.feed) renderFeed(); }
  if (ch.axiomStatus) { axiomStatus = ch.axiomStatus.newValue || null; if (!ch.feed) renderFeed(); }
  if (ch.pumpStatus) pumpStatus = ch.pumpStatus.newValue || null;
  if (ch.vanityJob) onVanityJob(ch.vanityJob.newValue || null, ch.vanityJob.oldValue || null);
  if (ch.deploys) {
    const before = deploys.filter((d) => d.ok && !d.dryRun).length;
    deploys = ch.deploys.newValue || [];
    renderDeploys();
    renderHeld();
    renderPnl();
    const soldBefore = (ch.deploys.oldValue || []).filter((d) => d.sold && !d.simulated).length;
    if (deploys.filter((d) => d.ok && !d.dryRun).length !== before || deploys.filter((d) => d.sold && !d.simulated).length !== soldBefore) refreshBalance();
  }
});

setInterval(() => {
  $$(".card").forEach((el) => {
    const c = feed.find((x) => x.id === el.dataset.id);
    if (c) $(".age", el).textContent = agoText(c.time);
  });
  renderFeed();
}, 5000);
setInterval(refreshBalance, 60000);
setInterval(refreshToken, 5 * 60000);

$("#balRefresh").addEventListener("click", async () => {
  const b = $("#balRefresh");
  if (b.classList.contains("spinning")) return;
  b.classList.add("spinning");
  $("#bal").textContent = t("refreshing…");
  $("#bal").style.color = "";
  const started = Date.now();
  try {
    await refreshBalance();
    if ($("#tab-launched").classList.contains("on")) await Promise.all([refreshHoldingsNow(), refreshRewards()]);
  } finally {
    setTimeout(() => b.classList.remove("spinning"), Math.max(0, 500 - (Date.now() - started)));
  }
});

load();
