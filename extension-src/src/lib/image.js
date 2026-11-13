// Token image: the post's own image, the author's avatar, or a generated card.
// generateCard uses OffscreenCanvas so it runs in the service worker and in the panel.

function wrap(ctx, text, maxWidth, maxLines) {
  const words = String(text || "").split(/\s+/).filter(Boolean);
  const out = [];
  let line = "";
  for (const w of words) {
    const test = line ? `${line} ${w}` : w;
    if (ctx.measureText(test).width > maxWidth && line) {
      out.push(line);
      line = w;
      if (out.length === maxLines) break;
    } else line = test;
  }
  if (out.length < maxLines && line) out.push(line);
  if (out.length === maxLines && words.join(" ").length > out.join(" ").length) {
    out[maxLines - 1] = out[maxLines - 1].replace(/\s*\S*$/, "") + "…";
  }
  return out;
}

function fitFont(ctx, text, weight, maxSize, maxWidth) {
  let size = maxSize;
  do {
    ctx.font = `${weight} ${size}px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
    if (ctx.measureText(text).width <= maxWidth) break;
    size -= 4;
  } while (size > 18);
  return size;
}

export async function generateCard({ name, ticker, text, handle }, colors = {}) {
  const S = 512;
  const c = new OffscreenCanvas(S, S);
  const ctx = c.getContext("2d");
  const g = ctx.createLinearGradient(0, 0, S, S);
  g.addColorStop(0, colors.c1 || "#86EFAC");
  g.addColorStop(1, colors.c2 || "#14532D");
  ctx.fillStyle = g;
  ctx.fillRect(0, 0, S, S);

  // soft vignette + inner panel
  ctx.fillStyle = "rgba(10,10,18,0.55)";
  const r = 36, x = 28, y = 28, w = S - 56, h = S - 56;
  ctx.beginPath();
  ctx.moveTo(x + r, y);
  ctx.arcTo(x + w, y, x + w, y + h, r);
  ctx.arcTo(x + w, y + h, x, y + h, r);
  ctx.arcTo(x, y + h, x, y, r);
  ctx.arcTo(x, y, x + w, y, r);
  ctx.closePath();
  ctx.fill();

  ctx.textAlign = "center";
  ctx.textBaseline = "alphabetic";
  ctx.fillStyle = "#ffffff";
  const t = `$${ticker || "MEME"}`;
  const size = fitFont(ctx, t, 900, 112, S - 110);
  ctx.fillText(t, S / 2, 150 + size / 3);

  ctx.fillStyle = "rgba(255,255,255,0.85)";
  fitFont(ctx, name || "", 700, 40, S - 120);
  ctx.fillText(name || "", S / 2, 250);

  ctx.fillStyle = "rgba(255,255,255,0.75)";
  ctx.font = `500 24px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
  const snippet = wrap(ctx, String(text || "").replace(/https?:\/\/\S+/g, ""), S - 130, 4);
  snippet.forEach((l, i) => ctx.fillText(l, S / 2, 312 + i * 32));

  if (handle) {
    ctx.fillStyle = "rgba(255,255,255,0.6)";
    ctx.font = `600 22px system-ui, -apple-system, "Segoe UI", Roboto, Arial, sans-serif`;
    ctx.fillText(`@${handle}`, S / 2, S - 58);
  }
  return c.convertToBlob({ type: "image/png" });
}

export function bestTwitterImage(url) {
  if (!url) return url;
  try {
    const u = new URL(url);
    if (u.hostname === "pbs.twimg.com") {
      if (u.pathname.includes("/profile_images/")) {
        return url.replace(/_(normal|bigger|mini|200x200)(\.\w+)$/, "_400x400$2");
      }
      u.searchParams.set("name", "medium");
      return u.toString();
    }
  } catch {}
  return url;
}

async function fetchBlob(url) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`image ${res.status}`);
  const blob = await res.blob();
  if (!blob.type.startsWith("image/")) throw new Error(`not an image (${blob.type || "unknown type"})`);
  if (blob.size > 4.5 * 1024 * 1024) throw new Error("image larger than 4.5 MB");
  return blob;
}

import { generateAiImage, wantsAutoAiImage } from "./aiimage.js";

// Individual people whose face is the meme. Used when the AI didn't judge it (AI off or failed).
const FAMOUS_PEOPLE = new Set([
  "elonmusk", "realdonaldtrump", "potus", "flotus", "jdvance", "cz_binance", "vitalikbuterin", "aeyakovenko",
  "a1lon9", "blknoiz06", "saylor", "brian_armstrong", "jack", "sama", "kanyewest", "ye", "kimkardashian",
  "mrbeast", "snoopdogg", "taylorswift13", "cristiano", "kingjames", "ishowspeed", "drake", "rihanna",
  "barackobama", "billgates", "jeffbezos", "zuck", "markcuban", "paulg", "naval", "andrewtate", "joerogan",
  "tuckercarlson", "rfkjr", "nayibbukele", "javiermilei", "ansem", "jamesblunt", "elizabethwarren",
]);
export function isFamousPerson(card) {
  if (typeof card.avatarOk === "boolean") return card.avatarOk;
  return FAMOUS_PEOPLE.has(String(card.handle || "").toLowerCase());
}

// What a card gets when its image menu is on "auto". Shared with the side panel preview.
// Returns "ai" | "post" | "tweet" | "avatar" | "card".
export function autoImageKind(card, settings) {
  const hasPost = !!(card.images?.[0] || card.videos?.[0] || card.videoFrame);
  const aiOn = settings.imageAiProvider && settings.imageAiProvider !== "off" && settings.imageAiWhen !== "manual";
  // named animal: its photo, else an AI mascot of it
  if (card.namedAnimal) {
    if (hasPost) return "post";
    if (aiOn) return "ai";
  }
  // "no good picture" rule: post photo -> famous person's profile pic -> AI image
  if (settings.imageAiWhen === "no-good-image") {
    if (hasPost) return "post";
    if (card.avatar && isFamousPerson(card)) return "avatar";
    if (aiOn) return "ai";
  }
  if (settings.imageLetAiChoose !== false && card.aiImageKind) {
    const k = card.aiImageKind;
    if (k === "tweet") return "tweet";
    if (k === "post" && hasPost) return "post";
    if (k === "avatar" && card.avatar && isFamousPerson(card)) return "avatar";
    if (k === "ai" && aiOn && (settings.imageAiWhen === "always" || !hasPost)) return "ai";
    if (k === "ai" && hasPost) return "post";
  }
  if (wantsAutoAiImage(card, settings)) return "ai";
  const mode = settings.imageMode || "post-or-tweet";
  if (mode !== "card" && mode !== "tweet" && hasPost) return "post";
  if (mode === "avatar-or-card" && card.avatar) return "avatar";
  if (mode === "post-or-card" || mode === "card" || mode === "avatar-or-card") return "card";
  return "tweet";
}

// Decides which image a card uses. Returns { blob, kind }.
export async function imageForCard(card, settings) {
  const colors = { c1: settings.cardColor1, c2: settings.cardColor2 };
  const gen = async () => ({
    blob: await generateCard({ name: card.name, ticker: card.ticker, text: card.text, handle: card.handle }, colors),
    kind: "card",
  });
  const tweet = async () => ({
    blob: await generateTweetImage({ author: card.author, handle: card.handle, text: card.text, avatar: card.avatar, verified: card.verified, time: card.time, source: card.source }),
    kind: "tweet",
  });
  const post = async () => {
    if (card.images?.[0]) return { blob: await fetchBlob(bestTwitterImage(card.images[0])), kind: "post" };
    const frame = card.videoFrame || (card.videos?.[0] && settings.extractVideoFrame ? await settings.extractVideoFrame(card) : null);
    if (frame) return { blob: await fetchBlob(frame), kind: "video" };
    throw new Error("post has no picture");
  };

  const choice = card.imageChoice || "default";
  const ai = async () => {
    if (card.aiImage) return { blob: await fetchBlob(card.aiImage), kind: "ai" };
    const r = await generateAiImage(card, settings);
    return { blob: r.blob, kind: "ai" };
  };
  if (choice === "ai") return ai();
  if (choice === "default") {
    if (card.aiImage) { try { return await ai(); } catch {} } // generated earlier with 🎨
    const kind = autoImageKind(card, settings);
    const fallback = async () => {
      if ((card.images?.[0] || card.videos?.[0]) && kind !== "post") { try { return await post(); } catch {} }
      return tweet();
    };
    try {
      if (kind === "ai") return await ai();
      if (kind === "post") return await post();
      if (kind === "tweet") return await tweet();
      if (kind === "avatar") return { blob: await fetchBlob(bestTwitterImage(card.avatar)), kind: "avatar" };
      if (kind === "card") return await gen();
    } catch (e) {
      console.warn(`${kind} image failed, using fallback`, e);
      return fallback();
    }
  }
  if (choice === "custom" && card.imageCustom) return { blob: await fetchBlob(card.imageCustom), kind: "custom" };
  if (choice === "card") return gen();
  if (choice === "tweet") return tweet();
  if (choice === "post" && (card.images?.[0] || card.videos?.[0] || card.videoFrame)) return post();
  if (choice === "avatar" && card.avatar) return { blob: await fetchBlob(bestTwitterImage(card.avatar)), kind: "avatar" };

  // default: follow settings.imageMode
  const mode = settings.imageMode || "post-or-tweet";
  if (mode !== "card" && mode !== "tweet" && card.images?.[0]) {
    try { return await post(); } catch (e) { console.warn("post image failed", e); }
  }
  if (mode === "avatar-or-card" && card.avatar) {
    try { return { blob: await fetchBlob(bestTwitterImage(card.avatar)), kind: "avatar" }; } catch {}
  }
  if (mode === "post-or-card" || mode === "card" || mode === "avatar-or-card") return gen();
  return tweet();
}

// ---------- tweet screenshot style image ----------
const FONT = `system-ui, -apple-system, "Segoe UI", Roboto, "Helvetica Neue", Arial, "Apple Color Emoji", "Segoe UI Emoji", sans-serif`;

function wrapAll(ctx, text, maxWidth) {
  const out = [];
  for (const para of String(text).split(/\n+/)) {
    const words = para.split(/\s+/).filter(Boolean);
    let line = "";
    for (let w of words) {
      // break words that are wider than the box on their own
      while (ctx.measureText(w).width > maxWidth && w.length > 1) {
        let cut = w.length - 1;
        while (cut > 1 && ctx.measureText(w.slice(0, cut)).width > maxWidth) cut--;
        if (line) { out.push(line); line = ""; }
        out.push(w.slice(0, cut));
        w = w.slice(cut);
      }
      const test = line ? `${line} ${w}` : w;
      if (ctx.measureText(test).width > maxWidth && line) { out.push(line); line = w; }
      else line = test;
    }
    if (line) out.push(line);
  }
  return out;
}

function fitParagraph(ctx, text, maxW, maxH, maxSize, minSize, weight = 400) {
  for (let size = maxSize; size >= minSize; size -= 2) {
    ctx.font = `${weight} ${size}px ${FONT}`;
    const lines = wrapAll(ctx, text, maxW);
    if (lines.length * size * 1.28 <= maxH) return { size, lines };
  }
  ctx.font = `${weight} ${minSize}px ${FONT}`;
  const lines = wrapAll(ctx, text, maxW);
  const max = Math.max(1, Math.floor(maxH / (minSize * 1.28)));
  if (lines.length > max) { lines.length = max; lines[max - 1] = lines[max - 1].replace(/\s*\S*$/, "") + "…"; }
  return { size: minSize, lines };
}

async function loadBitmap(url) {
  if (!url) return null;
  try {
    const res = await fetch(bestTwitterImage(url));
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}

function fmtDate(t) {
  const d = new Date(t || Date.now());
  const time = d.toLocaleTimeString("en-US", { hour: "numeric", minute: "2-digit" });
  const date = d.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return `${time} · ${date}`;
}

/** Square image that looks like the original post (dark mode). */
export async function generateTweetImage({ author, handle, text, avatar, verified, time, source }) {
  const S = 1000, PAD = 72;
  const c = new OffscreenCanvas(S, S);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#000000";
  ctx.fillRect(0, 0, S, S);

  const body = String(text || "")
    .replace(/https?:\/\/t\.co\/\S+/g, "")
    .replace(/https?:\/\/\S+$/g, "")
    .replace(/[ \t]+\n/g, "\n")
    .trim();

  // header
  const AV = 112;
  const bmp = await loadBitmap(avatar);
  ctx.save();
  ctx.beginPath();
  ctx.arc(PAD + AV / 2, PAD + AV / 2, AV / 2, 0, Math.PI * 2);
  ctx.closePath();
  ctx.clip();
  if (bmp) ctx.drawImage(bmp, PAD, PAD, AV, AV);
  else {
    ctx.fillStyle = "#1d9bf0";
    ctx.fillRect(PAD, PAD, AV, AV);
    ctx.fillStyle = "#fff";
    ctx.font = `700 56px ${FONT}`;
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(author || handle || "?").trim().charAt(0).toUpperCase(), PAD + AV / 2, PAD + AV / 2 + 2);
  }
  ctx.restore();

  ctx.textAlign = "left";
  ctx.textBaseline = "alphabetic";
  const nx = PAD + AV + 28;
  const nameMax = S - nx - PAD - (verified ? 56 : 0);
  ctx.fillStyle = "#e7e9ea";
  let ns = 46;
  do { ctx.font = `700 ${ns}px ${FONT}`; ns -= 2; } while (ctx.measureText(author || handle || "").width > nameMax && ns > 26);
  const name = String(author || handle || "");
  ctx.fillText(name, nx, PAD + 50);
  if (verified) {
    const bx = nx + ctx.measureText(name).width + 26, by = PAD + 36;
    ctx.fillStyle = "#1d9bf0";
    ctx.beginPath(); ctx.arc(bx, by, 19, 0, Math.PI * 2); ctx.fill();
    ctx.strokeStyle = "#fff"; ctx.lineWidth = 5; ctx.lineCap = "round"; ctx.lineJoin = "round";
    ctx.beginPath(); ctx.moveTo(bx - 9, by + 1); ctx.lineTo(bx - 2, by + 8); ctx.lineTo(bx + 10, by - 7); ctx.stroke();
  }
  ctx.fillStyle = "#71767b";
  ctx.font = `400 36px ${FONT}`;
  ctx.fillText(source === "tg" ? `t.me/${handle}` : `@${handle || ""}`, nx, PAD + 98);

  // body
  const top = PAD + AV + 52, bottom = S - PAD - 70;
  ctx.fillStyle = "#e7e9ea";
  if (body) {
    const { size, lines } = fitParagraph(ctx, body, S - PAD * 2, bottom - top, 100, 30);
    ctx.font = `400 ${size}px ${FONT}`;
    const lh = size * 1.28;
    const blockH = lines.length * lh;
    // short posts sit a little lower so the card doesn't look top-heavy
    let y = top + Math.max(0, (bottom - top - blockH) * 0.25) + size;
    for (const l of lines) { ctx.fillText(l, PAD, y); y += lh; }
  }

  // footer
  ctx.fillStyle = "#71767b";
  ctx.font = `400 32px ${FONT}`;
  ctx.fillText(fmtDate(time), PAD, S - PAD);
  ctx.strokeStyle = "#2f3336";
  ctx.lineWidth = 2;
  ctx.beginPath(); ctx.moveTo(PAD, S - PAD - 52); ctx.lineTo(S - PAD, S - PAD - 52); ctx.stroke();

  return c.convertToBlob({ type: "image/png" });
}

/** Small square JPEG (data URL) of a coin image, for the Launched list. */
export async function thumbDataUrl(blob, size = 96) {
  try {
    const bmp = await createImageBitmap(blob);
    const c = new OffscreenCanvas(size, size);
    const ctx = c.getContext("2d");
    const s = Math.min(bmp.width, bmp.height);
    ctx.drawImage(bmp, (bmp.width - s) / 2, (bmp.height - s) / 2, s, s, 0, 0, size, size);
    const out = await c.convertToBlob({ type: "image/jpeg", quality: 0.8 });
    const bytes = new Uint8Array(await out.arrayBuffer());
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:image/jpeg;base64,${btoa(bin)}`;
  } catch {
    return null;
  }
}
