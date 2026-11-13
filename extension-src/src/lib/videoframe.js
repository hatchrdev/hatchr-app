import { chat } from "./aiclient.js";
// Turns frames grabbed from a video post into a coin image.
// Picks the frame that best shows the subject (vision AI if available, else sharpest/clearest),
// then fits it into a square over a blurred copy so nothing gets cropped off.

async function bitmapFrom(dataUrl) {
  const blob = await (await fetch(dataUrl)).blob();
  return createImageBitmap(blob);
}

async function toDataUrl(canvas, type = "image/jpeg", quality = 0.9) {
  const blob = await canvas.convertToBlob({ type, quality });
  const buf = new Uint8Array(await blob.arrayBuffer());
  let s = "";
  for (let i = 0; i < buf.length; i += 0x8000) s += String.fromCharCode(...buf.subarray(i, i + 0x8000));
  return `data:${type};base64,${btoa(s)}`;
}

/** Square coin image from a frame: full frame centred over a blurred, darkened fill. */
export async function squareFromFrame(dataUrl, size = 1024) {
  const bmp = await bitmapFrom(dataUrl);
  const c = new OffscreenCanvas(size, size);
  const ctx = c.getContext("2d");
  const w = bmp.width, h = bmp.height;
  const cover = Math.max(size / w, size / h);
  const contain = Math.min(size / w, size / h);
  ctx.fillStyle = "#000";
  ctx.fillRect(0, 0, size, size);
  if (Math.abs(w - h) / Math.max(w, h) > 0.04) {
    ctx.filter = "blur(36px) brightness(0.55) saturate(1.2)";
    ctx.drawImage(bmp, (size - w * cover) / 2 - 40, (size - h * cover) / 2 - 40, w * cover + 80, h * cover + 80);
    ctx.filter = "none";
  }
  ctx.drawImage(bmp, (size - w * contain) / 2, (size - h * contain) / 2, w * contain, h * contain);
  return toDataUrl(c);
}

/** Numbered grid of frames for the vision AI. */
export async function collage(frames, cell = 320) {
  const cols = 3, rows = Math.ceil(frames.length / cols);
  const c = new OffscreenCanvas(cols * cell, rows * cell);
  const ctx = c.getContext("2d");
  ctx.fillStyle = "#111";
  ctx.fillRect(0, 0, c.width, c.height);
  for (let i = 0; i < frames.length; i++) {
    const bmp = await bitmapFrom(frames[i].dataUrl);
    const x0 = (i % cols) * cell, y0 = Math.floor(i / cols) * cell;
    const k = Math.min((cell - 8) / bmp.width, (cell - 8) / bmp.height);
    ctx.drawImage(bmp, x0 + (cell - bmp.width * k) / 2, y0 + (cell - bmp.height * k) / 2, bmp.width * k, bmp.height * k);
    ctx.fillStyle = "rgba(0,0,0,.75)";
    ctx.fillRect(x0 + 6, y0 + 6, 52, 52);
    ctx.fillStyle = "#ffeb3b";
    ctx.font = "bold 40px sans-serif";
    ctx.textAlign = "center";
    ctx.textBaseline = "middle";
    ctx.fillText(String(i + 1), x0 + 32, y0 + 33);
  }
  return toDataUrl(c, "image/jpeg", 0.8);
}

export const DEFAULT_VISION_MODEL = "meta-llama/llama-4-scout-17b-16e-instruct";

/** Asks a vision model which numbered frame best shows the subject. Returns a 0-based index or null. */
export async function aiPickFrame(frames, subject, settings) {
  const grid = await collage(frames);
  const model = settings.aiVisionModel || DEFAULT_VISION_MODEL;
  const r = await chat(settings, {
    model,
    temperature: 0,
    maxTokens: 8,
    user: [
      { type: "text", text: `These are ${frames.length} numbered frames from a video. Which ONE frame best shows ${subject} clearly, large, in focus and recognisable, to use as a memecoin logo? Reply with only the number.` },
      { type: "image_url", image_url: { url: grid } },
    ],
  });
  if (!r.ok) throw new Error(`vision ${r.status}: ${String(r.text).slice(0, 160)}`);
  if (settings.onAiUsage && r.usage) settings.onAiUsage(model, r.usage);
  const n = parseInt(String(r.content || "").match(/\d+/)?.[0], 10);
  return n >= 1 && n <= frames.length ? n - 1 : null;
}

export function bestByScore(frames) {
  let best = 0;
  frames.forEach((f, i) => { if ((f.score || 0) > (frames[best].score || 0)) best = i; });
  return best;
}
