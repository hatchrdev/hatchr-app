// AI image generation for coin logos.
// Providers: Cloudflare Workers AI (FLUX schnell, free daily allowance) or OpenAI GPT Image.

export const DEFAULT_IMAGE_STYLE =
  "Memecoin logo: one bold cartoon mascot or object, centered, thick clean outlines, vibrant flat colors, " +
  "simple solid background, sticker style, high contrast, fun and iconic, no text, no letters, no words";

export function imagePromptFor(card, settings) {
  const snippet = String(card.text || "").replace(/https?:\/\/\S+/g, "").replace(/\s+/g, " ").trim().slice(0, 220);
  const idea = card.aiImagePrompt || `${card.name}${snippet ? `, inspired by this post: "${snippet}"` : ""}`;
  return `${settings.imageAiStyle || DEFAULT_IMAGE_STYLE}. Subject: ${idea}`.slice(0, 1900);
}

function b64ToBlob(b64, type) {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return new Blob([bytes], { type });
}

async function errText(res) {
  const t = await res.text().catch(() => "");
  try {
    const j = JSON.parse(t);
    return j.error?.message || j.errors?.[0]?.message || t.slice(0, 200);
  } catch {
    return t.slice(0, 200);
  }
}

async function cloudflare(prompt, s) {
  if (!s.cfAccountId || !s.cfToken) throw new Error("Cloudflare account ID or API token missing (Settings → Images)");
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(s.cfAccountId.trim())}/ai/run/@cf/black-forest-labs/flux-1-schnell`;
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.cfToken.trim()}` },
    body: JSON.stringify({ prompt, steps: Math.min(8, Math.max(1, Number(s.cfSteps) || 4)) }),
  });
  if (!res.ok) throw new Error(`Cloudflare ${res.status}: ${await errText(res)}`);
  const j = await res.json();
  const b64 = j?.result?.image || j?.image;
  if (!b64) throw new Error(`Cloudflare returned no image${j?.errors?.length ? `: ${j.errors[0].message}` : ""}`);
  return b64ToBlob(b64, "image/jpeg");
}

// Picks the newest GPT Image model this key can use.
async function resolveOpenAiModel(s) {
  if (s.openaiImageModel && s.openaiImageModel !== "auto") return s.openaiImageModel;
  const res = await fetch("https://api.openai.com/v1/models", { headers: { Authorization: `Bearer ${s.openaiKey.trim()}` } });
  if (!res.ok) throw new Error(`OpenAI ${res.status}: ${await errText(res)}`);
  const j = await res.json();
  const models = (j.data || []).filter((m) => /^gpt-image/.test(m.id) && !/\d{4}-\d{2}-\d{2}$/.test(m.id));
  if (!models.length) throw new Error("No GPT Image model available for this OpenAI key");
  // newest first; full models before -mini
  models.sort((a, b) => (/mini/.test(a.id) - /mini/.test(b.id)) || (b.created || 0) - (a.created || 0));
  return models[0].id;
}

async function openai(prompt, s) {
  if (!s.openaiKey) throw new Error("OpenAI API key missing (Settings → Images)");
  const model = await resolveOpenAiModel(s);
  const res = await fetch("https://api.openai.com/v1/images/generations", {
    method: "POST",
    headers: { "Content-Type": "application/json", Authorization: `Bearer ${s.openaiKey.trim()}` },
    body: JSON.stringify({ model, prompt, size: "1024x1024", quality: s.openaiImageQuality || "low", n: 1 }),
  });
  if (!res.ok) {
    const msg = await errText(res);
    if (/verif/i.test(msg)) throw new Error(`OpenAI: your organization must be verified to use image models (platform.openai.com → Settings → Organization → Verify). ${msg}`);
    throw new Error(`OpenAI ${res.status}: ${msg}`);
  }
  const j = await res.json();
  const b64 = j?.data?.[0]?.b64_json;
  if (b64) return { blob: b64ToBlob(b64, "image/png"), model };
  const url = j?.data?.[0]?.url;
  if (url) return { blob: await (await fetch(url)).blob(), model };
  throw new Error("OpenAI returned no image");
}

/** Returns { blob, provider, model }. */
export async function generateAiImage(card, settings) {
  const prompt = imagePromptFor(card, settings);
  if (settings.imageAiProvider === "cloudflare") return { blob: await cloudflare(prompt, settings), provider: "cloudflare", model: "flux-1-schnell", prompt };
  if (settings.imageAiProvider === "openai") {
    const r = await openai(prompt, settings);
    return { ...r, provider: "openai", prompt };
  }
  throw new Error("AI images are off (Settings → Images)");
}

export function blobToDataUrl(blob) {
  return blob.arrayBuffer().then((buf) => {
    const bytes = new Uint8Array(buf);
    let bin = "";
    for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
    return `data:${blob.type || "image/png"};base64,${btoa(bin)}`;
  });
}

// Should this card get an AI image automatically at launch?
export function wantsAutoAiImage(card, settings) {
  if (!settings.imageAiProvider || settings.imageAiProvider === "off") return false;
  if ((card.imageChoice || "default") !== "default") return false;
  if (settings.imageAiWhen === "always") return true;
  if (settings.imageAiWhen === "no-post-image" || settings.imageAiWhen === "no-good-image") return !(card.images && card.images.length) && !(card.videos && card.videos.length);
  return false;
}
