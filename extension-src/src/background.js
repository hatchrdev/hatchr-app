// Service worker: receives posts, names them, stores the feed, applies auto-mode rules, launches coins.
import { getSettings as getSettingsRaw, saveSettings, DEFAULTS, lines, EST_LAUNCH_OVERHEAD_SOL, aiReady, providerForUrl, AI_PROVIDERS } from "./lib/settings.js";
import { nameForPost, aiName, renderDescription, sanitizeName, sanitizeTicker, findNamedAnimal, applyAnimalRule } from "./lib/naming.js";
import { imageForCard, thumbDataUrl } from "./lib/image.js";
import { generateAiImage, blobToDataUrl } from "./lib/aiimage.js";
import { makeBackup, openBackup } from "./lib/backup.js";
import { mergePulse, buildMeta } from "./lib/meta.js";
import { squareFromFrame, aiPickFrame, bestByScore } from "./lib/videoframe.js";
import { OLD_PROMPTS, DEFAULT_PROMPT } from "./lib/settings.js";
import { launch, parseSecret, getBalanceSol, testPinata, rpc, sellAll, getTokenBalance, axiomUrl, getCreatorRewards, claimCreatorRewards, newWallet, secretAsArray, simulateLaunch, simulateSell } from "./lib/deploy.js";
import { fetchChannel } from "./lib/telegram.js";
import { coinUrl } from "./lib/platforms.js";
import { badChars } from "./lib/vanity.js";
import { loadTokenConfig } from "./lib/token.js";
import { calloutTexts } from "./lib/callout.js";
import { PublicKey as PublicKeyStr } from "@solana/web3.js";
import bs58 from "bs58";

// settings plus a hook so AI naming can save a working model it switched to
async function getSettings() {
  const s = await getSettingsRaw();
  s.onModelChange = (aiModel) => saveSettings({ aiModel });
  s.getAiCooldowns = async () => (await chrome.storage.local.get("aiCooldowns")).aiCooldowns || {};
  s.setAiCooldown = async (model, until) => {
    const { aiCooldowns = {} } = await chrome.storage.local.get("aiCooldowns");
    const now = Date.now();
    for (const k of Object.keys(aiCooldowns)) if (aiCooldowns[k] < now) delete aiCooldowns[k];
    aiCooldowns[model] = until;
    await chrome.storage.local.set({ aiCooldowns });
  };
  s.onAiUsage = (model, tokens) => recordAiUsage(model, tokens);
  s.extractVideoFrame = (card) => videoFrameFor(card.id, card);
  return s;
}

let usageChain = Promise.resolve();
function recordAiUsage(model, tokens) {
  usageChain = usageChain.then(async () => {
    const day = new Date().toISOString().slice(0, 10);
    let { aiUsage } = await chrome.storage.local.get("aiUsage");
    if (!aiUsage || aiUsage.day !== day) aiUsage = { day, calls: 0, tokens: 0, byModel: {} };
    aiUsage.calls++;
    aiUsage.tokens += Number(tokens) || 0;
    aiUsage.byModel[model] = (aiUsage.byModel[model] || 0) + (Number(tokens) || 0);
    await chrome.storage.local.set({ aiUsage });
  }).catch(() => {});
}

const FEED_MAX = 100;
const DEPLOYS_MAX = 300;
const SEEN_MAX = 3000;
const HOUR = 3600_000;

// ---------- serialized storage access ----------
let chain = Promise.resolve();
function withLock(fn) {
  const run = chain.then(fn);
  chain = run.catch(() => {});
  return run;
}

async function getState(...keys) {
  return chrome.storage.local.get(keys);
}

async function getSecret() {
  const { walletSecret } = await chrome.storage.local.get("walletSecret");
  return walletSecret || "";
}

function updateCard(id, patch) {
  return withLock(async () => {
    const { feed = [] } = await getState("feed");
    const i = feed.findIndex((c) => c.id === id);
    if (i < 0) return null;
    feed[i] = { ...feed[i], ...patch };
    await chrome.storage.local.set({ feed });
    return feed[i];
  });
}

function notify(title, message, id) {
  try {
    chrome.notifications.create(id || "", {
      type: "basic",
      iconUrl: "icons/icon128.png",
      title: String(title).slice(0, 100),
      message: String(message).slice(0, 250),
      priority: 1,
    });
  } catch (e) {
    console.warn("notification failed", e);
  }
}

// ---------- setup ----------
async function setup() {
  const { settings } = await chrome.storage.local.get("settings");
  if (!settings) await chrome.storage.local.set({ settings: { ...DEFAULTS } });
  if (settings && OLD_PROMPTS.includes(settings.aiPrompt)) {
    settings.aiPrompt = DEFAULT_PROMPT; // adds image_prompt to the AI reply
    await chrome.storage.local.set({ settings });
  }
  if (settings && settings.cardColor1 === "#14F195" && settings.cardColor2 === "#9945FF") {
    settings.cardColor1 = "#86EFAC"; settings.cardColor2 = "#14532D"; // v2.6 green theme
    await chrome.storage.local.set({ settings });
  }
  if (settings && !settings.aiProvider) {
    // v3.1: AI provider presets; work out which one an existing setup uses
    settings.aiProvider = providerForUrl(settings.aiUrl || DEFAULTS.aiUrl);
    settings.aiFormat = AI_PROVIDERS[settings.aiProvider]?.format || "openai";
    await chrome.storage.local.set({ settings });
  }
  if (settings && !settings.migratedTweetImage) {
    // v1.7: the tweet-screenshot image replaces the old gradient card as the default
    const patch = { migratedTweetImage: true };
    if (!settings.imageMode || settings.imageMode === "post-or-card") patch.imageMode = "post-or-tweet";
    await chrome.storage.local.set({ settings: { ...settings, ...patch } });
  }
  // v3.2: launches remember their wallet (for the PnL card); older ones get the current wallet
  const { pnlMigrated, deploys: oldDeps, walletSecret: ws } = await chrome.storage.local.get(["pnlMigrated", "deploys", "walletSecret"]);
  if (!pnlMigrated) {
    let pub = null;
    try { pub = ws ? parseSecret(ws).publicKey.toBase58() : null; } catch {}
    if (pub && oldDeps?.length) await chrome.storage.local.set({ deploys: oldDeps.map((d) => (d.wallet || d.dryRun ? d : { ...d, wallet: pub })) });
    await chrome.storage.local.set({ pnlMigrated: true });
  }
  // Hatchr always starts paused: nothing launches by itself until you press Start
  const { settings: now } = await chrome.storage.local.get("settings");
  if (now && !now.paused) await chrome.storage.local.set({ settings: { ...now, paused: true } });
  try {
    await chrome.sidePanel.setPanelBehavior({ openPanelOnActionClick: true });
  } catch {}
  await scheduleTelegram();
  await updateBadge();
  await scheduleWatchdog();
}

// ---------- sounds (played by a hidden offscreen page) ----------
let offscreenCreating = null;
async function ensureOffscreen() {
  if (!chrome.offscreen) return false;
  try {
    const existing = chrome.runtime.getContexts ? await chrome.runtime.getContexts({ contextTypes: ["OFFSCREEN_DOCUMENT"] }) : [];
    if (existing.length) return true;
    offscreenCreating = offscreenCreating || chrome.offscreen.createDocument({
      url: "offscreen.html",
      reasons: ["AUDIO_PLAYBACK", "BLOBS", "WORKERS"],
      justification: "Plays a bell on launches, grabs a frame from video posts for the coin picture, and searches for vanity wallet addresses in the background",
    });
    await offscreenCreating;
  } catch (e) {
    if (!/single offscreen|already/i.test(String(e && e.message))) { console.warn("offscreen", e); return false; }
  } finally {
    offscreenCreating = null;
  }
  return true;
}

async function playSound(kind, force = false) {
  const s = await getSettingsRaw();
  if (!force) {
    if (!s.soundEnabled) return false;
    if (kind === "dry" && !s.soundOnDryRun) return false;
    if (kind === "sell" && !s.soundOnSell) return false;
  }
  if (!(await ensureOffscreen())) return false;
  const msg = { target: "offscreen", type: "playBell", kind, volume: Number(s.soundVolume ?? 70) };
  for (let i = 0; i < 3; i++) {
    try { await chrome.runtime.sendMessage(msg); return true; }
    catch (e) {
      if (!/Receiving end does not exist/i.test(String(e && e.message))) return true; // delivered, no reply expected
      await new Promise((r) => setTimeout(r, 150)); // page still loading
    }
  }
  return false;
}

// ---------- video posts: grab the best frame as the coin picture ----------
async function sendToOffscreen(msg, tries = 3) {
  for (let i = 0; i < tries; i++) {
    try {
      const r = await chrome.runtime.sendMessage({ target: "offscreen", ...msg });
      if (r !== undefined) return r;
    } catch (e) {
      if (!/Receiving end does not exist/i.test(String(e && e.message))) throw e;
    }
    await new Promise((r) => setTimeout(r, 200));
  }
  throw new Error("Hatchr's background helper didn't answer. Try again.");
}

const frameJobs = new Map();
function videoFrameFor(cardId, cardIn) {
  if (frameJobs.has(cardId)) return frameJobs.get(cardId);
  const job = (async () => {
    const { feed = [] } = await getState("feed");
    const card = feed.find((c) => c.id === cardId) || cardIn;
    if (!card) throw new Error("Card not found");
    if (card.videoFrame) return card.videoFrame;
    const url = card.videos && card.videos[0];
    if (!url) throw new Error("No video on this post");
    const s = await getSettings();
    if (!(await ensureOffscreen())) throw new Error("This Chrome can't decode video in the background");
    await updateCard(cardId, { videoFrameBusy: true, videoFrameError: null });
    try {
      const r = await sendToOffscreen({ type: "videoFrames", url, count: 6 });
      if (!r || !r.ok) throw new Error((r && r.error) || "Couldn't read the video");
      const frames = r.frames.filter((f) => f.score > 0).length ? r.frames.filter((f) => f.score > 0) : r.frames;
      let idx = bestByScore(frames), pickedBy = "sharpest frame";
      if (aiReady(s) && s.aiVisionModel && s.aiPickFrame !== false && frames.length > 1) {
        const subject = card.namedAnimal
          ? `${card.namedAnimal.fullName || card.namedAnimal.name} (the ${/^(k9|k-9|canine)$/.test(card.namedAnimal.animal) ? "police dog" : card.namedAnimal.animal})`
          : card.aiImagePrompt || `the main subject of this post: "${String(card.text || "").slice(0, 120)}"`;
        try {
          const i = await aiPickFrame(frames, subject, s);
          if (i != null) { idx = i; pickedBy = "AI pick"; }
        } catch (e) { console.warn("vision pick failed", e); }
      }
      const square = await squareFromFrame(frames[idx].dataUrl);
      await updateCard(cardId, { videoFrame: square, videoFrameAt: frames[idx].t, videoFramePick: pickedBy, videoFrameBusy: false });
      return square;
    } catch (e) {
      await updateCard(cardId, { videoFrameBusy: false, videoFrameError: String(e.message || e) });
      throw e;
    }
  })();
  frameJobs.set(cardId, job);
  job.finally(() => setTimeout(() => frameJobs.delete(cardId), 1000)).catch(() => {});
  return job;
}

// ---------- keep Axiom (and X) tabs alive ----------
const AXIOM_URL = "https://axiom.trade/pulse";
const STALE_MS = 150_000; // background tabs may only report once a minute

// The main switch (Settings → Sources). Off = Hatchr reads no posts and keeps nothing running in the background.
const watchingOn = (s) => !s || s.watching !== false;

function protectTab(tabId) {
  if (tabId == null || tabId < 0) return;
  getSettingsRaw().then((s) => { if (watchingOn(s)) chrome.tabs.update(tabId, { autoDiscardable: false }).catch(() => {}); }).catch(() => {});
}

// Switched off: Chrome may put the Axiom and X tabs to sleep again, like any other tab.
async function releaseTabs() {
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ["https://axiom.trade/*", "https://x.com/*", "https://twitter.com/*"] }); } catch { return; }
  for (const t of tabs) chrome.tabs.update(t.id, { autoDiscardable: true }).catch(() => {});
}

// The half-minute alarm wakes the background for four jobs: keeping Axiom alive, the pump.fun stream, a running vanity
// search and auto-claiming rewards. With Hatchr switched off and none of the others in use, the alarm is removed,
// so the background is not woken at all.
async function scheduleWatchdog() {
  const s = await getSettingsRaw();
  let job = null;
  try { job = await vanityState(); } catch {}
  const need = watchingOn(s) || (job && job.status === "running") || (s.autoClaimRewards && !s.dryRun && !s.paused);
  const has = await chrome.alarms.get("axiom-watchdog");
  if (need && !has) chrome.alarms.create("axiom-watchdog", { periodInMinutes: 0.5, delayInMinutes: 0.1 });
  if (!need && has) await chrome.alarms.clear("axiom-watchdog");
}

async function onWatchingChange(on) {
  await scheduleWatchdog();
  await scheduleTelegram();
  await ensurePumpSocket().catch(() => {});
  await updateBadge();
  if (on) axiomWatchdog().catch(() => {});
  else {
    await releaseTabs();
    await chrome.storage.local.remove(["axiomStatus", "pumpStatus"]); // so the panel stops saying "live"
  }
}

async function axiomWatchdog() {
  const s = await getSettings();
  if (!watchingOn(s) || !s.axiomEnabled || !s.keepAxiomOpen) return;
  const now = Date.now();
  const { axiomStatus, axiomKeeper = {} } = await chrome.storage.local.get(["axiomStatus", "axiomKeeper"]);
  let tabs = [];
  try { tabs = await chrome.tabs.query({ url: ["https://axiom.trade/*"] }); } catch { return; }

  if (!tabs.length) {
    if (now - (axiomKeeper.openedAt || 0) < 5 * 60_000) return; // don't spam tabs
    await chrome.tabs.create({ url: AXIOM_URL, pinned: true, active: false });
    await chrome.storage.local.set({ axiomKeeper: { ...axiomKeeper, openedAt: now } });
    return;
  }
  tabs.forEach((t) => protectTab(t.id));

  const asleep = tabs.find((t) => t.discarded || t.frozen);
  const stale = !axiomStatus || now - axiomStatus.at > STALE_MS;
  if ((asleep || stale) && now - (axiomKeeper.reloadedAt || 0) > 3 * 60_000) {
    // never reload the tab you're looking at
    const target = asleep || tabs.find((t) => !t.active);
    if (target) {
      await chrome.tabs.reload(target.id).catch(() => {});
      await chrome.storage.local.set({ axiomKeeper: { ...axiomKeeper, reloadedAt: now } });
    }
  }
}

// after install/update, background Axiom tabs need a reload to pick up the new scripts
chrome.runtime.onInstalled.addListener(async () => {
  try {
    const tabs = await chrome.tabs.query({ url: ["https://axiom.trade/*"] });
    for (const t of tabs) if (!t.active) chrome.tabs.reload(t.id).catch(() => {});
  } catch {}
});

async function scheduleTelegram() {
  const s = await getSettings();
  await chrome.alarms.clear("tg-poll");
  if (watchingOn(s) && s.tgEnabled && lines(s.tgChannels).length) {
    chrome.alarms.create("tg-poll", { periodInMinutes: Math.max(0.5, Number(s.tgPollSec || 30) / 60), delayInMinutes: 0.05 });
  }
}

// Toolbar icon. Chrome's badge covered half of the 16px egg (and Hatchr always starts paused, so it was
// always there). Instead the egg fills the whole slot and auto mode shows as a small dot drawn into the
// icon: amber = auto in test mode, red = auto LIVE. Hovering the icon says the state in words.
const STATUS_DOT = { test: "#fbbf24", live: "#ef4444", off: "#6b7280" };
const STATUS_TITLE = { off: "Hatchr · off (not watching posts)", paused: "Hatchr · paused", manual: "Hatchr · manual mode", test: "Hatchr · auto, test mode", live: "Hatchr · auto, LIVE" };
const iconCache = {};
async function iconWithDot(size, color) {
  const key = `${size}${color}`;
  if (iconCache[key]) return iconCache[key];
  const bmp = await createImageBitmap(await (await fetch(chrome.runtime.getURL(`icons/icon${size}.png`))).blob());
  const c = new OffscreenCanvas(size, size);
  const x = c.getContext("2d");
  x.drawImage(bmp, 0, 0, size, size);
  const r = size * 0.2, cx = size - r - size * 0.03, cy = size - r - size * 0.03;
  x.globalCompositeOperation = "destination-out"; // a clear ring around the dot so it reads on any toolbar
  x.beginPath(); x.arc(cx, cy, r + size * 0.08, 0, Math.PI * 2); x.fill();
  x.globalCompositeOperation = "source-over";
  x.fillStyle = color;
  x.beginPath(); x.arc(cx, cy, r, 0, Math.PI * 2); x.fill();
  return (iconCache[key] = x.getImageData(0, 0, size, size));
}
async function updateBadge() {
  const s = await getSettings();
  const state = !watchingOn(s) ? "off" : s.paused ? "paused" : s.mode === "auto" ? (s.dryRun ? "test" : "live") : "manual";
  await chrome.action.setBadgeText({ text: "" });
  await chrome.action.setTitle?.({ title: STATUS_TITLE[state] });
  if (!chrome.action.setIcon) return;
  try {
    const color = STATUS_DOT[state];
    if (!color || typeof OffscreenCanvas === "undefined") await chrome.action.setIcon({ path: { 16: "icons/icon16.png", 32: "icons/icon32.png" } });
    else await chrome.action.setIcon({ imageData: { 16: await iconWithDot(16, color), 32: await iconWithDot(32, color) } });
  } catch {}
}

scheduleWatchdog().catch(() => {});
chrome.runtime.onInstalled.addListener(setup);
chrome.runtime.onStartup.addListener(setup);
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const o = changes.settings.oldValue || {}, n = changes.settings.newValue || {};
  if (o.tgEnabled !== n.tgEnabled || o.tgChannels !== n.tgChannels || o.tgPollSec !== n.tgPollSec) scheduleTelegram();
  if (o.mode !== n.mode || o.paused !== n.paused || o.dryRun !== n.dryRun) updateBadge();
  if ((o.watching !== false) !== (n.watching !== false)) onWatchingChange(n.watching !== false).catch((e) => console.warn("watching", e));
  else if (o.autoClaimRewards !== n.autoClaimRewards || o.paused !== n.paused || o.dryRun !== n.dryRun) scheduleWatchdog().catch(() => {});
});

// ---------- telegram polling ----------
chrome.alarms.onAlarm.addListener((alarm) => {
  if (alarm.name === "axiom-watchdog") {
    axiomWatchdog().catch((e) => console.warn("watchdog", e));
    ensurePumpSocket().catch(() => {});
    vanityWatchdog().catch(() => {}).then(() => scheduleWatchdog()).catch(() => {});
    autoClaimCheck().catch((e) => console.warn("auto-claim", e));
  }
});

chrome.alarms.onAlarm.addListener(async (alarm) => {
  if (alarm.name !== "tg-poll") return;
  const s = await getSettings();
  if (!watchingOn(s) || !s.tgEnabled) return;
  const { tgBaseline = {} } = await getState("tgBaseline");
  for (const ch of lines(s.tgChannels)) {
    try {
      const posts = await fetchChannel(ch);
      const key = ch.toLowerCase();
      if (!tgBaseline[key]) {
        // first time we see this channel: remember existing posts, don't fire on them
        await withLock(async () => {
          const { seen = [] } = await getState("seen");
          const ids = posts.map((p) => `tg:${p.postId}`);
          await chrome.storage.local.set({ seen: [...seen, ...ids].slice(-SEEN_MAX) });
        });
        tgBaseline[key] = Date.now();
        await chrome.storage.local.set({ tgBaseline });
        continue;
      }
      for (const p of posts) handlePost(p).catch((e) => console.error("tg post", e));
    } catch (e) {
      console.warn("telegram poll failed", ch, e);
    }
  }
});

// ---------- post pipeline ----------
async function handlePost(post, { force = false } = {}) {
  const s = await getSettings();
  const id = post.dedupeKey || `${post.source}:${post.postId}`;

  if (!force) {
    if (!watchingOn(s)) return null; // switched off: posts from pages are ignored (a pasted post is forced, so it still works)
    if (post.source === "x" && !s.xEnabled) return null;
    if (post.source === "tg" && !s.tgEnabled) return null;
    if (post.source === "axiom" && !s.axiomEnabled) return null;
    if (post.time && Date.now() - post.time > s.maxPostAgeSec * 1000) return null;
    const handles = lines(s.xHandles).map((h) => h.replace(/^@/, "").toLowerCase());
    if (post.source === "x" && handles.length && !handles.includes(String(post.handle || "").toLowerCase())) return null;
    if (post.source === "axiom") {
      const typeOk = { TWEET: s.axiomOriginal, QUOTE: s.axiomQuotes, REPLY: s.axiomReplies, RETWEET: s.axiomReposts };
      const tt = String(post.tweetType || "TWEET").toUpperCase();
      if ((tt in typeOk ? typeOk[tt] : s.axiomOriginal) === false) return null;
      if (s.axiomFilterHandles && handles.length) {
        const who = [post.tracked, post.handle].map((h) => String(h || "").toLowerCase());
        if (!who.some((h) => handles.includes(h))) return null;
      }
    }
  }

  const isNew = await withLock(async () => {
    const { seen = [] } = await getState("seen");
    if (seen.includes(id)) return false;
    seen.push(id);
    await chrome.storage.local.set({ seen: seen.slice(-SEEN_MAX) });
    return true;
  });
  if (!isNew && !force) return null;

  // AI only for posts that could actually launch (saves the free daily token budget)
  const animal = s.namedAnimals !== false ? findNamedAnimal(post.text) : null;
  let aiSkipped = null;
  if (aiReady(s) && !force) {
    if (s.aiFor === "manual") aiSkipped = "AI only when you press ↻";
    else if (s.aiFor !== "all") {
      const pre = { text: post.text || "", name: "", ticker: "" };
      aiSkipped = keywordBlock(pre, s, { skipInclude: !!animal });
      if (!aiSkipped && s.mode === "auto" && !s.paused) aiSkipped = await withLock(() => limitBlock(pre, s, { dedupe: false, skipCooldown: !!animal }));
    }
  }
  const meta = aiSkipped ? null : await metaFor(`${post.text || ""} ${post.context || ""}`, s);
  let naming = aiSkipped ? await nameForPost(post, { ...s, aiEnabled: false }) : await nameForPost({ ...post, meta }, s);
  if (animal) {
    naming = applyAnimalRule(naming, animal, s.tickerMaxLen);
    naming.imageKind = (post.images && post.images.length) || (post.videos && post.videos.length) ? "post" : "ai";
  }
  const card = {
    id: force && !isNew ? `${id}:${Date.now()}` : id,
    source: post.source,
    author: post.author || "",
    handle: post.handle || "",
    text: post.text || "",
    context: post.context || "",
    tweetType: post.tweetType || null,
    tracked: post.tracked || "",
    url: post.url || "",
    images: post.images || [],
    videos: post.videos || [],
    avatar: post.avatar || null,
    verified: !!post.verified,
    time: post.time || Date.now(),
    receivedAt: Date.now(),
    name: naming.name,
    ticker: naming.ticker,
    aiDescription: naming.description || "",
    aiImagePrompt: naming.imagePrompt || "",
    aiImageKind: naming.imageKind || null,
    avatarOk: typeof naming.avatarOk === "boolean" ? naming.avatarOk : null,
    namedAnimal: animal || null,
    nameFixed: naming.nameFixed || null,
    description: renderDescription(s.descriptionTemplate, post, naming),
    score: naming.score,
    reason: naming.reason,
    namingBy: naming.by,
    aiError: naming.aiError || null,
    aiSkipped,
    aiModel: naming.model || null,
    imageChoice: "default",
    status: "new",
  };

  await withLock(async () => {
    const { feed = [] } = await getState("feed");
    feed.unshift(card);
    await chrome.storage.local.set({ feed: feed.slice(0, FEED_MAX) });
  });

  if (s.notifyNewPosts) notify(`New post: @${card.handle}`, `$${card.ticker} — ${card.text.slice(0, 120)}`, `post-${card.id}`);

  if (s.mode === "auto" && !s.paused && !force) {
    const decision = await withLock(() => evaluateAuto(card, s));
    if (decision.ok) {
      deployCard(card.id, "auto").catch((e) => console.error("auto deploy", e));
    } else {
      await updateCard(card.id, { autoSkip: decision.reason });
    }
  }
  return card;
}

// Runs inside withLock so two posts can't both pass the rate limits.
// Cheap rules that need no AI. Return a skip reason or null.
function keywordBlock(card, s, { skipInclude = false } = {}) {
  const text = `${card.text} ${card.name} ${card.ticker}`.toLowerCase();
  const inc = skipInclude ? [] : lines(s.includeKeywords).map((k) => k.toLowerCase());
  const exc = lines(s.excludeKeywords).map((k) => k.toLowerCase());
  const has = (k) => new RegExp(`(^|[^a-z0-9])${k.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}([^a-z0-9]|$)`).test(text);
  if (inc.length && !inc.some(has)) return "No include keyword";
  const hit = exc.find(has);
  if (hit) return `Excluded keyword "${hit}"`;
  return null;
}

async function limitBlock(card, s, { dedupe, skipCooldown = false }) {
  const dry = !!s.dryRun;
  const { deploys = [] } = await getState("deploys");
  const now = Date.now();
  const same = deploys.filter((d) => !!d.dryRun === dry);
  const auto = same.filter((d) => d.mode === "auto");
  if (dedupe) {
    const dupe = same.find(
      (d) => (d.ok !== false || d.signature) && now - d.time < s.dedupeHours * HOUR && // a launch that was sent counts, confirmed or not
        (d.ticker === card.ticker || String(d.name).toLowerCase() === card.name.toLowerCase())
    );
    if (dupe) return `Already launched $${dupe.ticker} in last ${s.dedupeHours}h`;
  }
  const last = auto[0];
  if (!skipCooldown && last && now - last.time < s.autoCooldownSec * 1000) {
    return `Cooldown (${Math.ceil((s.autoCooldownSec * 1000 - (now - last.time)) / 1000)}s left)`;
  }
  if (auto.filter((d) => now - d.time < HOUR).length >= s.autoMaxPerHour) return `Hourly limit (${s.autoMaxPerHour}) reached`;
  if (auto.filter((d) => now - d.time < 24 * HOUR).length >= s.autoMaxPerDay) return `Daily limit (${s.autoMaxPerDay}) reached`;
  return null;
}

async function evaluateAuto(card, s) {
  // named animals are always the meta: no AI score, cooldown or include-keyword needed
  const animal = !!card.namedAnimal && s.namedAnimals !== false;
  const kw = keywordBlock(card, s, { skipInclude: animal });
  if (kw) return { ok: false, reason: kw };
  const lim = await limitBlock(card, s, { dedupe: true, skipCooldown: animal });
  if (lim) return { ok: false, reason: lim };

  if (aiReady(s) && !animal) {
    if (card.namingBy !== "ai") {
      const why = card.aiSkipped ? `AI skipped (${card.aiSkipped})` : `AI unavailable: ${card.aiError || "unknown"}`;
      if (s.aiFallback !== "rules") return { ok: false, reason: `${why}. No score, not launching.` };
    } else if (card.score != null && card.score < s.autoMinScore) {
      return { ok: false, reason: `AI score ${card.score} < ${s.autoMinScore}` };
    }
  }

  const dry = !!s.dryRun;
  const { deploys = [] } = await getState("deploys");
  const now = Date.now();

  if (!dry) {
    const secret = await getSecret();
    if (!secret) return { ok: false, reason: "No wallet set" };
    if (!s.pinataJwt) return { ok: false, reason: "No Pinata JWT set" };
    const spent = deploys
      .filter((d) => !d.dryRun && now - d.time < 24 * HOUR)
      .reduce((a, d) => a + (d.spentSol ?? (d.ok ? Number(s.devBuySol) + EST_LAUNCH_OVERHEAD_SOL : 0)), 0);
    const next = Number(s.devBuySol) + Number(s.priorityFee) + EST_LAUNCH_OVERHEAD_SOL;
    if (spent + next > s.autoMaxSolPerDay) {
      return { ok: false, reason: `Daily SOL cap: ~${spent.toFixed(3)} spent, next ~${next.toFixed(3)}, cap ${s.autoMaxSolPerDay}` };
    }
    try {
      const pub = parseSecret(secret).publicKey.toBase58();
      const bal = await getBalanceSol(s.rpcUrl, pub);
      if (bal < s.minBalanceSol) return { ok: false, reason: `Balance ${bal.toFixed(4)} SOL below minimum ${s.minBalanceSol}` };
    } catch (e) {
      return { ok: false, reason: `Balance check failed: ${e.message}` };
    }
  }

  // reserve a slot so the next post sees it immediately
  deploys.unshift({ id: `pending:${card.id}`, cardId: card.id, time: now, mode: "auto", dryRun: dry, ticker: card.ticker, name: card.name, pending: true });
  await chrome.storage.local.set({ deploys: deploys.slice(0, DEPLOYS_MAX) });
  return { ok: true };
}

function updateDeploy(id, patch) {
  return withLock(async () => {
    const { deploys = [] } = await getState("deploys");
    const i = deploys.findIndex((d) => d.id === id);
    if (i < 0) return null;
    deploys[i] = { ...deploys[i], ...patch };
    await chrome.storage.local.set({ deploys });
    return deploys[i];
  });
}

// ---------- creator rewards ----------
async function readRewards() {
  const s = await getSettingsRaw();
  const secret = await getSecret();
  if (!secret) return null;
  const owner = parseSecret(secret).publicKey.toBase58();
  const r = await getCreatorRewards(s.rpcUrl, owner);
  const { rewards = {} } = await chrome.storage.local.get("rewards");
  const next = { ...rewards, unclaimed: r.total, curve: r.curve, amm: r.amm, checkedAt: Date.now(), wallet: owner };
  await chrome.storage.local.set({ rewards: next });
  return next;
}

let claiming = false;
async function claimRewards(mode) {
  if (claiming) throw new Error("Already claiming");
  const s = await getSettingsRaw();
  const secret = await getSecret();
  if (!secret) throw new Error("No wallet key set");
  claiming = true;
  const setStep = async (claimStep) => {
    const { rewards = {} } = await chrome.storage.local.get("rewards");
    await chrome.storage.local.set({ rewards: { ...rewards, claimStep, claimError: null } });
  };
  try {
    const r = await claimCreatorRewards(s, secret, { dryRun: !!s.dryRun, onStep: setStep });
    const { rewards = {} } = await chrome.storage.local.get("rewards");
    if (r.dryRun) {
      await chrome.storage.local.set({ rewards: { ...rewards, claimStep: null, claimError: r.simError ? `Claim simulation failed: ${r.simError}` : null, dryClaimOk: !r.simError } });
      return r;
    }
    const got = r.receivedSol != null ? Math.max(0, r.receivedSol) : (r.expected || 0);
    const history = [{ time: Date.now(), sol: got, signature: r.signature, mode, wallet: parseSecret(secret).publicKey.toBase58() }, ...(rewards.history || [])].slice(0, 100);
    await chrome.storage.local.set({ rewards: { ...rewards, claimStep: null, claimError: null, history, claimedTotal: +((rewards.claimedTotal || 0) + got).toFixed(9), lastClaimAt: Date.now() } });
    playSound("sell").catch(() => {});
    if (s.notifyDeploys) notify("Creator rewards claimed", `+${got.toFixed(4)} SOL`, `claim-${Date.now()}`);
    readRewards().catch(() => {});
    return r;
  } catch (e) {
    const { rewards = {} } = await chrome.storage.local.get("rewards");
    await chrome.storage.local.set({ rewards: { ...rewards, claimStep: null, claimError: String(e.message || e) } });
    throw e;
  } finally {
    claiming = false;
  }
}

async function autoClaimCheck() {
  const s = await getSettingsRaw();
  if (!s.autoClaimRewards || s.dryRun || s.paused) return;
  const { rewards = {} } = await chrome.storage.local.get("rewards");
  if (Date.now() - (rewards.lastAutoCheck || 0) < Math.max(10, Number(s.autoClaimEveryMin) || 60) * 60_000) return;
  await chrome.storage.local.set({ rewards: { ...rewards, lastAutoCheck: Date.now() } });
  const r = await readRewards();
  if (r && r.unclaimed >= Math.max(0.005, Number(s.autoClaimMinSol) || 0.02)) await claimRewards("auto");
}

// ---------- pump.fun live launches (PumpPortal data stream: free, no account) ----------
// Every coin created on pump.fun and every coin that graduates, so the AI knows the meta
// even without an Axiom Pulse tab. One connection only (PumpPortal's rule).
let pumpWs = null;
let pumpRetry = 0;
let pumpNextTry = 0;
let pumpBuf = [];
let pumpTimer = null;
let pumpSeen = 0;
const pumpNames = new Map(); // mint -> { name, ticker }, to name coins when they graduate

const wantPump = (s) => watchingOn(s) && s.pumpMeta !== false && !!s.aiEnabled && s.aiMeta !== false;

async function ensurePumpSocket() {
  if (typeof WebSocket === "undefined") return;
  const s = await getSettingsRaw();
  if (!wantPump(s)) {
    if (pumpWs) { const ws = pumpWs; pumpWs = null; try { ws.close(); } catch {} }
    return;
  }
  if (pumpWs || Date.now() < pumpNextTry) return;
  const ws = new WebSocket("wss://pumpportal.fun/api/data");
  pumpWs = ws;
  ws.onopen = () => {
    pumpRetry = 0;
    ws.send(JSON.stringify({ method: "subscribeNewToken" }));
    ws.send(JSON.stringify({ method: "subscribeMigration" }));
  };
  ws.onmessage = (e) => {
    let m;
    try { m = JSON.parse(e.data); } catch { return; }
    onPumpMessage(m);
  };
  const gone = () => {
    if (pumpWs !== ws) return;
    pumpWs = null;
    pumpRetry++;
    const wait = Math.min(60_000, 2000 * 2 ** Math.min(pumpRetry, 5));
    pumpNextTry = Date.now() + wait;
    setTimeout(() => ensurePumpSocket().catch(() => {}), wait + 50);
  };
  ws.onclose = gone;
  ws.onerror = gone;
}

function onPumpMessage(m) {
  if (!m || typeof m !== "object" || !m.mint) return; // e.g. "Successfully subscribed"
  const tx = String(m.txType || "").toLowerCase();
  if (m.name && (tx === "create" || !tx)) {
    pumpSeen++;
    pumpNames.set(m.mint, { name: String(m.name), ticker: String(m.symbol || "") });
    if (pumpNames.size > 6000) pumpNames.delete(pumpNames.keys().next().value);
    pumpBuf.push({ address: m.mint, name: m.name, ticker: m.symbol || "", mc: "0", table: "newPairs" });
  } else if (/migrat/.test(tx) || m.pool === "pump-amm") {
    const known = pumpNames.get(m.mint);
    pumpBuf.push({ address: m.mint, name: m.name || known?.name || "", ticker: m.symbol || known?.ticker || "", mc: "0", table: "migrated" });
  } else return;
  if (!pumpTimer) {
    getSettingsRaw().then((s) => {
      if (!pumpTimer) pumpTimer = setTimeout(flushPump, Number(s.pumpFlushMs) || 15000);
    });
  }
}

async function flushPump() {
  pumpTimer = null;
  const rows = pumpBuf;
  pumpBuf = [];
  if (!rows.length) return;
  const s = await getSettingsRaw();
  await withLock(async () => {
    const { metaTokens } = await chrome.storage.local.get("metaTokens");
    let lookups = 0;
    for (const r of rows) {
      if (r.name) continue;
      // graduated coin we didn't see launch: use what we know, or ask Helius for its name
      const k = metaTokens?.[r.address];
      if (k) { r.name = k.name; r.ticker = k.ticker; continue; }
      if (lookups < 3 && /helius/.test(s.rpcUrl || "")) {
        lookups++;
        try {
          const a = await rpc(s.rpcUrl, "getAsset", { id: r.address });
          r.name = a?.content?.metadata?.name || "";
          r.ticker = a?.content?.metadata?.symbol || "";
        } catch {}
      }
    }
    await chrome.storage.local.set({
      metaTokens: mergePulse(metaTokens, rows.filter((r) => r.name), Date.now(), Number(s.metaWindowMin) || 180),
      pumpStatus: { live: !!pumpWs, at: Date.now(), seen: pumpSeen },
    });
  });
}

ensurePumpSocket().catch(() => {});
chrome.storage.onChanged.addListener((changes, area) => {
  if (area !== "local" || !changes.settings) return;
  const o = changes.settings.oldValue || {}, n = changes.settings.newValue || {};
  if (wantPump(o) !== wantPump(n)) ensurePumpSocket().catch(() => {});
});

// ---------- meta (from Axiom Pulse) ----------
async function metaFor(postText, s) {
  if (!s.aiMeta) return null;
  const { metaTokens } = await chrome.storage.local.get("metaTokens");
  const m = buildMeta(metaTokens, Date.now(), { windowMin: Number(s.metaWindowMin) || 180, postText });
  return m.text ? { text: m.text, suffixes: m.suffixes } : null;
}

const selling = new Set();
async function sellDeploy(id) {
  if (selling.has(id)) throw new Error("Already selling");
  const s = await getSettings();
  const { deploys = [] } = await getState("deploys");
  const d = deploys.find((x) => x.id === id);
  if (!d || !d.mint) throw new Error("Launch not found");
  if (d.simulated) {
    // test coin: simulate selling everything straight back to the curve
    if (d.sold) throw new Error("Already sold");
    const receivedSol = simulateSell(d.holding || 0, d.devBuySol ?? s.devBuySol, { priorityFee: s.sellPriorityFee, closeAccount: s.sellCloseAccount !== false });
    playSound("sell").catch(() => {});
    return updateDeploy(id, { sold: true, soldAt: Date.now(), receivedSol, holding: 0, holdingAt: Date.now(), sellStep: null, sellError: null });
  }
  if (d.dryRun) throw new Error("This was a test launch; there is nothing to sell");
  const secret = await getSecret();
  if (!secret) throw new Error("No wallet key set");
  selling.add(id);
  try {
    await updateDeploy(id, { sellStep: "Starting…", sellError: null });
    const r = await sellAll(d.mint, s, secret, { dryRun: !!s.dryRun, onStep: (sellStep) => updateDeploy(id, { sellStep }) });
    if (r.nothing) return updateDeploy(id, { sellStep: null, holding: 0, holdingAt: Date.now(), sold: true, soldAt: Date.now() });
    if (r.dryRun) return updateDeploy(id, { sellStep: null, sellError: r.simError ? `Sell simulation failed: ${r.simError}` : null, sellDryOk: !r.simError });
    playSound("sell").catch(() => {});
    const patch = { sellStep: null, sold: true, soldAt: Date.now(), sellSignature: r.signature, receivedSol: r.receivedSol ?? null, holding: r.tokensAfter ?? 0, holdingAt: Date.now(), sellRetried: !!r.retried, rentBack: r.closedAccounts > 0 };
    if (s.notifyDeploys) notify(`Sold $${d.ticker}`, r.receivedSol != null ? `Received ${r.receivedSol} SOL` : "Sell confirmed", `sell-${id}`);
    return updateDeploy(id, patch);
  } catch (e) {
    await updateDeploy(id, { sellStep: null, sellError: String(e.message || e) });
    throw e;
  } finally {
    selling.delete(id);
  }
}

async function refreshHoldings(ids) {
  const s = await getSettings();
  const secret = await getSecret();
  if (!secret) return {};
  const owner = parseSecret(secret).publicKey.toBase58();
  const { deploys = [] } = await getState("deploys");
  const out = {};
  for (const d of deploys.filter((x) => ids.includes(x.id) && x.mint && !x.dryRun && x.ok)) {
    try {
      const b = await getTokenBalance(s.rpcUrl, owner, d.mint);
      out[d.id] = b.ui;
    } catch (e) {
      out[d.id] = null;
    }
  }
  await withLock(async () => {
    const { deploys: list = [] } = await getState("deploys");
    for (const d of list) if (d.id in out && out[d.id] != null) { d.holding = out[d.id]; d.holdingAt = Date.now(); }
    await chrome.storage.local.set({ deploys: list });
  });
  return out;
}

async function recordDeploy(entry) {
  await withLock(async () => {
    const { deploys = [] } = await getState("deploys");
    const i = deploys.findIndex((d) => d.id === `pending:${entry.cardId}`);
    if (i >= 0) deploys.splice(i, 1);
    deploys.unshift(entry);
    await chrome.storage.local.set({ deploys: deploys.slice(0, DEPLOYS_MAX) });
  });
}

const inFlight = new Set();

// Only web and inline pictures: a file:// or other local address typed into the picture field is ignored.
const safeImageUrl = (u) => /^(https?:\/\/|data:image\/)/i.test(String(u || "").trim());

/** Settings taken from a backup file: only settings Hatchr knows, numbers must be real numbers of zero or more,
 *  on/off values must be on/off, and auto mode always comes back paused. Anything else in the file is ignored. */
function settingsFromBackup(raw) {
  const keep = { ...DEFAULTS };
  for (const [k, v] of Object.entries(raw || {})) {
    if (!(k in DEFAULTS)) continue;
    const d = DEFAULTS[k];
    if (typeof d === "number") { const n = Number(v); if (v !== "" && v != null && Number.isFinite(n) && n >= 0) keep[k] = v; }
    else if (typeof d === "boolean") { if (typeof v === "boolean") keep[k] = v; }
    else if (typeof d === "string") { if (typeof v === "string" || typeof v === "number") keep[k] = v; }
    else if (v == null || typeof v === "object" || typeof v === "string" || typeof v === "number" || typeof v === "boolean") keep[k] = v;
  }
  keep.paused = true;
  return keep;
}

async function deployCard(cardId, mode, overrides = {}) {
  if (inFlight.has(cardId)) throw new Error("Already deploying this one");
  inFlight.add(cardId);
  const s = await getSettings();
  const dryRun = !!s.dryRun;
  let cardSnap = null;
  // a post that already became a real coin is never launched a second time (that would spend the buy again)
  const { feed: feedNow = [] } = await getState("feed");
  if (feedNow.find((c) => c.id === cardId)?.status === "launched") {
    inFlight.delete(cardId);
    throw new Error("This post is already launched");
  }
  try {
    const clean = {};
    if (overrides.name != null) clean.name = sanitizeName(overrides.name);
    if (overrides.ticker != null) clean.ticker = sanitizeTicker(overrides.ticker, s.tickerMaxLen, true);
    if (overrides.description != null) clean.description = String(overrides.description).slice(0, 500);
    if (overrides.imageChoice) clean.imageChoice = overrides.imageChoice;
    if (overrides.imageCustom != null) clean.imageCustom = overrides.imageCustom;
    const card = await updateCard(cardId, { ...clean, status: "deploying", step: "Preparing image…", error: null, result: null });
    if (!card) throw new Error("Card not found");
    cardSnap = card;
    if (!card.name || !card.ticker) throw new Error("Name and ticker are required");

    const secret = await getSecret();
    if (!dryRun && !secret) throw new Error("No wallet key set (Settings → Account)");

    const { blob, kind } = await imageForCard(card, s);
    const thumb = await thumbDataUrl(blob);
    let result;
    try {
      result = await launch(card, s, secret, {
        dryRun,
        imageBlob: blob,
        imageKind: kind,
        onStep: (step) => updateCard(cardId, { step }),
      });
    } catch (e) {
      if (!dryRun) throw e;
      // test mode: the on-chain check couldn't run (RPC not set up yet, network, PumpPortal down).
      // That says nothing about the coin, so the simulated launch still goes through.
      result = { dryRun: true, mint: newWallet().pub, checkError: String(e.message || e), note: "Couldn't check the real transaction" };
    }
    const ok = !result.simError;
    await updateCard(cardId, { status: dryRun ? (ok ? "dry-ok" : "dry-fail") : "launched", step: null, result, imageKind: kind });
    if (ok) playSound(dryRun ? "dry" : "live").catch(() => {});
    await recordDeploy({
      id: `${cardId}:${Date.now()}`,
      cardId,
      time: Date.now(),
      mode,
      dryRun,
      ok,
      name: card.name,
      ticker: card.ticker,
      source: card.url,
      handle: card.handle,
      mint: result.mint || null,
      signature: result.signature || null,
      spentSol: result.spentSol ?? null,
      simError: result.simError || null,
      note: result.note || null,
      image: thumb,
      wallet: result.wallet || null,
      description: card.description || "",
      ...(dryRun && ok ? testCoin(result, s) : {}),
    });
    if (s.notifyDeploys) {
      if (dryRun) notify(`Test launch ${ok ? "done" : "failed"}: $${card.ticker}`, ok ? "Simulated: see it in the Launched tab. Nothing was spent." : result.simError, `dep-${cardId}`);
      else notify(`Launched $${card.ticker}`, `${card.name} is live on pump.fun`, `dep-${cardId}`);
    }
    if (!dryRun && result.mint && s.openAxiomAfterLaunch) {
      chrome.tabs.create({ url: coinUrl(s.openIn, result.mint), active: true }).catch(() => {});
    }
    return result;
  } catch (e) {
    const msg = String(e.message || e);
    await updateCard(cardId, { status: "failed", step: null, error: msg });
    await recordDeploy({
      id: `${cardId}:${Date.now()}`, cardId, time: Date.now(), mode, dryRun, ok: false, error: msg,
      mint: e.mint || null, signature: e.signature || null, // set when the transaction was sent but not confirmed in time: it may still have landed
      name: cardSnap?.name || overrides.name || "", ticker: cardSnap?.ticker || overrides.ticker || "", handle: cardSnap?.handle || "", source: cardSnap?.url || "",
    });
    if (s.notifyDeploys) notify(`Launch failed`, msg, `dep-${cardId}`);
    throw e;
  } finally {
    inFlight.delete(cardId);
  }
}

// The simulated coin a test launch would have made: same numbers a real launch would show.
function testCoin(result, s) {
  const sim = simulateLaunch(s.devBuySol, s.priorityFee, EST_LAUNCH_OVERHEAD_SOL);
  return {
    simulated: true,
    mint: result.mint || null,
    holding: Math.round(sim.tokens),
    spentSol: sim.costSol,
    estCost: { devBuy: sim.devBuySol, fees: sim.feesSol, rent: sim.rentSol },
    devBuySol: sim.devBuySol,
    chainCheck: result.checkError ? "unavailable" : result.simulated ? (result.needsFunds ? "needs-funds" : "passed") : "skipped",
    checkError: result.checkError || null,
  };
}

// Keeps every wallet key that gets replaced or removed, so funds left in it are never lost.
async function archiveWallet(reason, nextPub = null) {
  const current = await getSecret();
  if (!current) return;
  let pub;
  try { pub = parseSecret(current).publicKey.toBase58(); } catch { return; }
  if (pub === nextPub) return;
  const { walletArchive = [] } = await chrome.storage.local.get("walletArchive");
  if (walletArchive.some((w) => w.pub === pub)) return;
  walletArchive.unshift({ pub, secret: current.trim(), time: Date.now(), reason });
  await chrome.storage.local.set({ walletArchive: walletArchive.slice(0, 50) });
}

const bs58Of = (arrayJson) => bs58.encode(Uint8Array.from(JSON.parse(arrayJson)));

// ---------- vanity wallet search (runs in the offscreen page, so the panel can close) ----------
async function vanityState() {
  const { vanityJob = null } = await chrome.storage.local.get("vanityJob");
  return vanityJob;
}
async function setVanity(patch) {
  const cur = (await vanityState()) || {};
  const next = patch === null ? null : { ...cur, ...patch, updatedAt: Date.now() };
  await chrome.storage.local.set({ vanityJob: next });
  return next;
}
async function startVanity({ prefix = "", suffix = "", caseSensitive = false }) {
  prefix = String(prefix).trim().slice(0, 8);
  suffix = String(suffix).trim().slice(0, 8);
  if (!prefix && !suffix) throw new Error("Type the letters you want first");
  const bad = badChars(prefix + suffix);
  if (bad.length) throw new Error(`Not possible in an address: ${bad.join(" ")}`);
  if (!(await ensureOffscreen())) throw new Error("This Chrome can't run the search in the background");
  const job = { id: Date.now(), prefix, suffix, caseSensitive: !!caseSensitive };
  await chrome.storage.local.set({ vanityJob: { ...job, status: "running", tried: 0, ms: 0, startedAt: Date.now(), updatedAt: Date.now() }, vanityResult: null });
  await sendToOffscreen({ type: "vanityStart", job });
  await scheduleWatchdog(); // the search needs the half-minute check even while Hatchr is switched off
  return job;
}
async function onVanityMessage(msg) {
  const job = await vanityState();
  if (!job || job.id !== msg.id || job.status !== "running") return;
  if (msg.type === "vanityProgress") {
    if (msg.error) return setVanity({ status: "error", error: msg.error });
    return setVanity({ tried: msg.tried, ms: msg.ms });
  }
  // found: keep the key safe until you choose to use it, then ring + notify
  await chrome.storage.local.set({ vanityResult: { id: msg.id, pub: msg.pub, secret: msg.secret } });
  await setVanity({ status: "found", pub: msg.pub, tried: msg.tried, ms: msg.ms, foundAt: Date.now(), seen: false });
  playSound("vanity").catch(() => {});
  notify("🎯 Vanity wallet found", `${msg.pub.slice(0, 10)}…${msg.pub.slice(-6)} · open Hatchr → Account to use it`, `vanity-${msg.id}`);
}
async function vanityWatchdog() {
  const job = await vanityState();
  if (!job || job.status !== "running" || Date.now() - (job.updatedAt || 0) < 45_000) return;
  let alive = false;
  try { alive = !!(await sendToOffscreen({ type: "vanityStatus" }, 1))?.running; } catch {}
  if (!alive) await setVanity({ status: "stopped", error: "interrupted" });
}

// ---------- SOL price (for showing amounts in $ or €) ----------
let priceJob = null;
async function solPrice(force = false) {
  const { solPrice: cached } = await chrome.storage.local.get("solPrice");
  if (!force && cached && cached.gbp && Date.now() - cached.at < 180_000) return cached;
  if (priceJob) return priceJob;
  priceJob = (async () => {
    try {
      const res = await fetch("https://api.coingecko.com/api/v3/simple/price?ids=solana&vs_currencies=usd,eur,gbp");
      if (!res.ok) throw new Error(`price ${res.status}`);
      const j = await res.json();
      const p = { usd: Number(j?.solana?.usd) || null, eur: Number(j?.solana?.eur) || null, gbp: Number(j?.solana?.gbp) || null, at: Date.now() };
      if (!p.usd) throw new Error("no price");
      await chrome.storage.local.set({ solPrice: p });
      return p;
    } catch (e) {
      if (cached) return cached; // keep showing the last known price
      throw new Error("Couldn't get the SOL price right now");
    } finally {
      priceJob = null;
    }
  })();
  return priceJob;
}

// ---------- test setup ----------
async function testSetup() {
  const s = await getSettings();
  const out = [];
  const secret = await getSecret();
  let pub = null;
  if (secret) {
    try {
      pub = parseSecret(secret).publicKey.toBase58();
      out.push({ ok: true, label: "Wallet", detail: pub });
    } catch (e) {
      out.push({ ok: false, label: "Wallet", detail: e.message });
    }
  } else out.push({ ok: false, label: "Wallet", detail: "Not set" });

  try {
    const slot = await rpc(s.rpcUrl, "getSlot", []);
    out.push({ ok: true, label: "RPC", detail: `reachable (slot ${slot})` });
    if (pub) {
      const bal = await getBalanceSol(s.rpcUrl, pub);
      out.push({ ok: bal > 0, label: "Balance", detail: `${bal.toFixed(4)} SOL` });
    }
  } catch (e) {
    out.push({ ok: false, label: "RPC", detail: e.message });
  }

  if (s.pinataJwt) {
    try {
      await testPinata(s.pinataJwt);
      out.push({ ok: true, label: "Pinata", detail: "JWT works" });
    } catch (e) {
      out.push({ ok: false, label: "Pinata", detail: e.message });
    }
  } else out.push({ ok: false, label: "Pinata", detail: "No JWT (needed for real launches)" });

  if (s.aiEnabled) {
    try {
      const r = await aiName({ source: "x", handle: "elonmusk", author: "Elon Musk", text: "Doge to the moon 🚀", images: [] }, s);
      const { aiUsage } = await chrome.storage.local.get("aiUsage");
      const used = aiUsage && aiUsage.day === new Date().toISOString().slice(0, 10) ? ` · today ${aiUsage.calls} calls, ${Math.round(aiUsage.tokens / 1000)}k tokens` : "";
      out.push({ ok: true, label: "AI", detail: `$${r.ticker} "${r.name}" score ${r.score} (model ${r.model})${used}` });
    } catch (e) {
      out.push({ ok: false, label: "AI", detail: e.message });
    }
  } else out.push({ ok: true, label: "AI", detail: "Off (using built-in naming)" });

  if (pub) {
    try {
      const r = await launch({ name: "Setup Test", ticker: "TEST", description: "", url: "" }, s, secret, { dryRun: true });
      out.push({
        ok: !r.simError,
        label: "Create tx (test)",
        detail: r.simError ? `${r.simError} ${(r.simLogs || []).join(" | ").slice(0, 300)}` : `would succeed (${r.unitsConsumed || "?"} CU)`,
      });
    } catch (e) {
      out.push({ ok: false, label: "Create tx (simulated)", detail: e.message });
    }
  }
  return out;
}

// ---------- callouts (pump.fun) ----------
// Texts for a coin you hold, written by your AI from the coin's own facts (built-in texts without an AI).
async function calloutFor(id) {
  const { deploys = [], feed = [] } = await chrome.storage.local.get(["deploys", "feed"]);
  const d = deploys.find((x) => x.id === id);
  if (!d || !d.mint) throw new Error("Coin not found");
  const card = feed.find((c) => c.id === d.cardId);
  const s = await getSettings();
  const coin = { name: d.name, ticker: d.ticker, description: d.description || "", handle: d.handle || card?.handle || "", postText: card?.text || "", ageMin: (Date.now() - d.time) / 60000 };
  return calloutTexts(s, coin, { useAi: aiReady(s) });
}

// Sends a callout straight from Hatchr. The request itself lives in callout-client.js (loaded next to this file, shared
// with the desktop app): it posts with the login the browser already has, never reads or stores that login, and never
// repeats a post whose answer was lost. Here it only gets the function that marks the coin as called.
function createCallout(msg) {
  return globalThis.HatchrCallouts.create(msg, updateDeploy);
}

// ---------- messages ----------
chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  const reply = (p) => p.then((data) => sendResponse({ ok: true, data })).catch((e) => sendResponse({ ok: false, error: String(e.message || e) }));
  switch (msg?.type) {
    case "hello":
      protectTab(sender.tab?.id);
      sendResponse({ ok: true });
      return false;
    case "openPerfSettings":
      chrome.tabs.create({ url: "chrome://settings/performance" }).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    case "post":
      protectTab(sender.tab?.id);
      handlePost(msg.post).catch((e) => console.error(e));
      sendResponse({ ok: true });
      return false;
    case "manualPost": {
      const t = String(msg.text || "").trim();
      const url = (t.match(/https?:\/\/\S+/) || [null])[0];
      const handle = url && /(?:x|twitter)\.com\/(\w+)\/status/.test(url) ? url.match(/(?:x|twitter)\.com\/(\w+)\/status/)[1] : "manual";
      return reply(handlePost({ source: "manual", postId: `m${Date.now()}`, handle, author: "Manual", text: t, url: url || "", images: safeImageUrl(msg.image) ? [String(msg.image).trim()] : [], time: Date.now() }, { force: true })), true;
    }
    case "calloutTexts":
    case "calloutCreate":
      // only Hatchr's own panel may write or send a callout, never a page script
      if (sender?.id !== chrome.runtime.id || sender?.url !== chrome.runtime.getURL("sidepanel.html")) { sendResponse({ ok: false, error: "Not allowed from here" }); return false; }
      return reply(msg.type === "calloutTexts" ? calloutFor(msg.id) : createCallout(msg)), true;
    case "rewards":
      return reply(readRewards()), true;
    case "claimRewards":
      return reply(claimRewards("manual")), true;
    case "pulse":
      withLock(async () => {
        const s = await getSettingsRaw();
        if (!watchingOn(s)) return;
        const { metaTokens } = await chrome.storage.local.get("metaTokens");
        await chrome.storage.local.set({ metaTokens: mergePulse(metaTokens, msg.rows, Date.now(), Number(s.metaWindowMin) || 180) });
      }).catch(() => {});
      sendResponse({ ok: true });
      return false;
    case "metaPreview":
      return reply((async () => {
        const s = await getSettingsRaw();
        const { metaTokens } = await chrome.storage.local.get("metaTokens");
        return buildMeta(metaTokens, Date.now(), { windowMin: Number(s.metaWindowMin) || 180, postText: msg.text || "" });
      })()), true;
    case "videoFrame":
      return reply(videoFrameFor(msg.id)), true;
    case "testSound":
      return reply(playSound(msg.kind || "live", true)), true;
    case "exportBackup":
      return reply((async () => {
        const { settings, walletSecret, deploys = [], onboardSeen, walletArchive = [] } = await chrome.storage.local.get(["settings", "walletSecret", "deploys", "onboardSeen", "walletArchive"]);
        const data = { settings: settings || {}, walletSecret: walletSecret || "", walletArchive, onboardSeen: !!onboardSeen };
        if (msg.includeHistory !== false) data.deploys = deploys.filter((d) => !d.pending);
        return makeBackup(data, { password: msg.password || "", extVersion: chrome.runtime.getManifest().version });
      })()), true;
    case "importBackup":
      return reply((async () => {
        const data = await openBackup(msg.file, msg.password || "");
        const patch = {};
        if (data.settings && typeof data.settings === "object") {
          patch.settings = settingsFromBackup(data.settings);
        }
        let wallet = null;
        if (data.walletSecret) {
          wallet = parseSecret(data.walletSecret).publicKey.toBase58(); // validates before saving
          await archiveWallet("replaced", wallet);
          patch.walletSecret = String(data.walletSecret).trim();
        }
        if (Array.isArray(data.walletArchive) && data.walletArchive.length) {
          const { walletArchive = [] } = await chrome.storage.local.get("walletArchive");
          const have = new Set([...walletArchive.map((w) => w.pub), wallet]);
          const add = data.walletArchive.filter((w) => w && w.secret && w.pub && !have.has(w.pub));
          patch.walletArchive = [...walletArchive, ...add].slice(-50);
        }
        if (data.onboardSeen) patch.onboardSeen = true;
        let added = 0;
        if (Array.isArray(data.deploys) && data.deploys.length) {
          await withLock(async () => {
            const { deploys = [] } = await getState("deploys");
            const ids = new Set(deploys.map((d) => d.id));
            const fresh = data.deploys.filter((d) => d && d.id && !ids.has(d.id));
            added = fresh.length;
            const merged = [...deploys, ...fresh].sort((a, b) => (b.time || 0) - (a.time || 0)).slice(0, DEPLOYS_MAX);
            await chrome.storage.local.set({ deploys: merged });
          });
        }
        await chrome.storage.local.set(patch);
        await updateBadge();
        await scheduleTelegram();
        return { wallet, settings: !!patch.settings, historyAdded: added };
      })()), true;
    case "aiImage":
      return reply((async () => {
        const s = await getSettings();
        const { feed = [] } = await getState("feed");
        const c = feed.find((x) => x.id === msg.id);
        if (!c) throw new Error("Card not found");
        await updateCard(msg.id, { aiImageBusy: true, aiImageError: null });
        try {
          const r = await generateAiImage({ ...c, ...(msg.overrides || {}) }, s);
          const aiImage = await blobToDataUrl(r.blob);
          return updateCard(msg.id, { aiImage, aiImageBusy: false, imageChoice: "ai", aiImageModel: r.model });
        } catch (e) {
          await updateCard(msg.id, { aiImageBusy: false, aiImageError: String(e.message || e) });
          throw e;
        }
      })()), true;
    case "testAiImage":
      return reply((async () => {
        const s = { ...(await getSettings()), ...(msg.patch || {}) };
        const r = await generateAiImage({ name: "Moon Frog", text: "Frogs are going to the moon", aiImagePrompt: "a cheerful green frog astronaut riding a rocket" }, s);
        return { image: await blobToDataUrl(r.blob), model: r.model, provider: r.provider };
      })()), true;
    case "sell":
      return reply(sellDeploy(msg.id)), true;
    case "holdings":
      return reply(refreshHoldings(msg.ids || [])), true;
    case "openAxiom":
      chrome.tabs.create({ url: msg.platform ? coinUrl(msg.platform, msg.mint) : axiomUrl(msg.mint), active: true }).then(() => sendResponse({ ok: true })).catch((e) => sendResponse({ ok: false, error: e.message }));
      return true;
    case "deploy":
      return reply(deployCard(msg.id, "manual", msg.overrides || {})), true;
    case "regen":
      return reply((async () => {
        const s = await getSettings();
        const { feed = [] } = await getState("feed");
        const c = feed.find((x) => x.id === msg.id);
        if (!c) throw new Error("Card not found");
        let n = await nameForPost({ ...c, meta: await metaFor(`${c.text || ""} ${c.context || ""}`, s) }, s);
        if (c.namedAnimal && s.namedAnimals !== false) { n = applyAnimalRule(n, c.namedAnimal, s.tickerMaxLen); n.imageKind = c.images?.length || c.videos?.length ? "post" : "ai"; }
        return updateCard(msg.id, { avatarOk: typeof n.avatarOk === "boolean" ? n.avatarOk : c.avatarOk ?? null, aiImageKind: n.imageKind || null, aiSkipped: null, aiModel: n.model || null, aiImagePrompt: n.imagePrompt || c.aiImagePrompt || "", name: n.name, ticker: n.ticker, score: n.score, reason: n.reason, namingBy: n.by, aiError: n.aiError || null, aiDescription: n.description || "", description: renderDescription(s.descriptionTemplate, c, n) });
      })()), true;
    case "dismiss":
      return reply(withLock(async () => {
        const { feed = [] } = await getState("feed");
        await chrome.storage.local.set({ feed: feed.filter((c) => c.id !== msg.id) });
      })), true;
    case "clearFeed":
      return reply(withLock(() => chrome.storage.local.set({ feed: [] }))), true;
    case "clearDeploys":
      return reply(withLock(() => chrome.storage.local.set({ deploys: [] }))), true;
    case "balance":
      return reply((async () => {
        const s = await getSettings();
        const secret = await getSecret();
        if (!secret) return null;
        const pub = parseSecret(secret).publicKey.toBase58();
        return { pub, sol: await getBalanceSol(s.rpcUrl, pub) };
      })()), true;
    case "token":
      // $HATCHR: the official address and tiers (from hatchr.pro) plus how much the Hatchr wallet holds
      return reply((async () => {
        const config = await loadTokenConfig({ force: !!msg.force });
        const secret = await getSecret();
        const pub = secret ? parseSecret(secret).publicKey.toBase58() : null;
        let amount = null, error = null;
        if (config.mint && pub) {
          try { amount = (await getTokenBalance((await getSettings()).rpcUrl, pub, config.mint)).ui; }
          catch (e) { error = e.message; }
        }
        return { config, pub, amount, error };
      })()), true;
    case "setWallet":
      return reply((async () => {
        if (!msg.secret) {
          await archiveWallet("removed");
          await chrome.storage.local.remove("walletSecret");
          return null;
        }
        const pub = parseSecret(msg.secret).publicKey.toBase58();
        await archiveWallet("replaced", pub);
        await chrome.storage.local.set({ walletSecret: String(msg.secret).trim() });
        return pub;
      })()), true;
    case "createWallet":
      return reply((async () => {
        const w = newWallet();
        await archiveWallet("replaced", w.pub);
        await chrome.storage.local.set({ walletSecret: w.secret, walletCreatedAt: Date.now() });
        return w.pub;
      })()), true;
    case "revealWallet":
      return reply((async () => {
        // the current key, or one from the list of previous wallets
        let secret = await getSecret();
        if (msg.pub) {
          const { walletArchive = [] } = await chrome.storage.local.get("walletArchive");
          secret = walletArchive.find((w) => w.pub === msg.pub)?.secret || (secret && parseSecret(secret).publicKey.toBase58() === msg.pub ? secret : "");
        }
        if (!secret) throw new Error("No wallet key");
        const kp = parseSecret(secret);
        return { pub: kp.publicKey.toBase58(), secret: secret.startsWith("[") ? bs58Of(secret) : secret.trim(), array: secretAsArray(secret) };
      })()), true;
    case "walletArchive":
      return reply((async () => {
        const { walletArchive = [] } = await chrome.storage.local.get("walletArchive");
        return walletArchive.map(({ pub, time, reason }) => ({ pub, time, reason }));
      })()), true;
    case "useArchivedWallet":
      return reply((async () => {
        const { walletArchive = [] } = await chrome.storage.local.get("walletArchive");
        const w = walletArchive.find((x) => x.pub === msg.pub);
        if (!w) throw new Error("Wallet not found");
        await archiveWallet("replaced", w.pub);
        const { walletArchive: rest = [] } = await chrome.storage.local.get("walletArchive");
        await chrome.storage.local.set({ walletSecret: w.secret, walletArchive: rest.filter((x) => x.pub !== w.pub) });
        return w.pub;
      })()), true;
    case "balanceOf":
      return reply((async () => getBalanceSol((await getSettings()).rpcUrl, new PublicKeyStr(msg.pub).toString()))()), true;
    case "vanityStart":
      return reply(startVanity(msg)), true;
    case "vanityStop":
      return reply((async () => {
        await sendToOffscreen({ type: "vanityStop" }).catch(() => {});
        return setVanity({ status: "stopped" });
      })()), true;
    case "vanityProgress":
    case "vanityFound":
      onVanityMessage(msg).catch((e) => console.warn("vanity", e));
      return false;
    case "vanityUse":
      return reply((async () => {
        const { vanityResult } = await chrome.storage.local.get("vanityResult");
        if (!vanityResult?.secret) throw new Error("No vanity wallet waiting");
        const pub = parseSecret(vanityResult.secret).publicKey.toBase58();
        await archiveWallet("replaced", pub);
        await chrome.storage.local.set({ walletSecret: vanityResult.secret, vanityResult: null });
        await setVanity({ status: "used", seen: true });
        return pub;
      })()), true;
    case "vanityDiscard":
      return reply(chrome.storage.local.set({ vanityResult: null, vanityJob: null })), true;
    case "vanitySeen":
      return reply(setVanity({ seen: true })), true;
    case "solPrice":
      return reply(solPrice(!!msg.force)), true;
    case "testAi":
      return reply((async () => {
        const s = { ...(await getSettings()), ...(msg.patch || {}), aiEnabled: true };
        const t0 = Date.now();
        const r = await aiName({ source: "x", handle: "elonmusk", author: "Elon Musk", text: "Doge to the moon 🚀", images: [] }, s);
        return { name: r.name, ticker: r.ticker, score: r.score, model: r.model, ms: Date.now() - t0 };
      })()), true;
    case "walletPub":
      return reply((async () => {
        const secret = await getSecret();
        return secret ? parseSecret(secret).publicKey.toBase58() : null;
      })()), true;
    case "test":
      return reply(testSetup()), true;
    case "axiomStatus":
      protectTab(sender.tab?.id);
      getSettingsRaw().then((s) => { if (watchingOn(s)) chrome.storage.local.set({ axiomStatus: { ...msg.status, at: Date.now() } }); }).catch(() => {});
      sendResponse({ ok: true });
      return false;
    case "saveSettings":
      return reply(saveSettings(msg.patch)), true;
    default:
      return false;
  }
});
