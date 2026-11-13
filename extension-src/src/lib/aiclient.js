// One place that talks to text/vision AI APIs. Supports the OpenAI chat/completions format
// (Groq, Gemini, OpenRouter, OpenAI, DeepSeek, Mistral, xAI, Together, Ollama, LM Studio, vLLM…)
// and the Anthropic messages format, plus extra headers for custom APIs.

export function parseHeaders(text) {
  const out = {};
  for (const line of String(text || "").split(/\n/)) {
    const i = line.indexOf(":");
    if (i <= 0) continue;
    const k = line.slice(0, i).trim();
    const v = line.slice(i + 1).trim();
    if (/^[A-Za-z0-9-]+$/.test(k) && v) out[k] = v;
  }
  return out;
}

export function aiFormat(settings) {
  if (settings.aiFormat === "anthropic") return "anthropic";
  if (/api\.anthropic\.com/.test(settings.aiUrl || "")) return "anthropic";
  return "openai";
}

export function aiHeaders(settings) {
  const h = { "Content-Type": "application/json" };
  if (aiFormat(settings) === "anthropic") {
    if (settings.aiKey) h["x-api-key"] = settings.aiKey;
    h["anthropic-version"] = "2023-06-01";
    h["anthropic-dangerous-direct-browser-access"] = "true";
  } else if (settings.aiKey) {
    h.Authorization = `Bearer ${settings.aiKey}`;
  }
  return { ...h, ...parseHeaders(settings.aiHeaders) };
}

// OpenAI-style content parts -> Anthropic content blocks
function toAnthropicContent(content) {
  if (typeof content === "string") return content;
  return content.map((p) => {
    if (p.type === "image_url") {
      const url = p.image_url?.url || "";
      const m = url.match(/^data:([^;]+);base64,(.*)$/);
      return m
        ? { type: "image", source: { type: "base64", media_type: m[1], data: m[2] } }
        : { type: "image", source: { type: "url", url } };
    }
    return { type: "text", text: p.text || "" };
  });
}

/**
 * One chat request. Never throws for HTTP errors.
 * Returns { ok, status, text (error body), content, usage, retryAfter }.
 */
export async function chat(settings, { model, system, user, maxTokens = 300, temperature = 0.5, json = false, reasoning = false }) {
  const headers = aiHeaders(settings);
  if (aiFormat(settings) === "anthropic") {
    const body = { model, max_tokens: maxTokens, temperature, messages: [{ role: "user", content: toAnthropicContent(user) }] };
    if (system) body.system = system;
    const res = await fetch(settings.aiUrl, { method: "POST", headers, body: JSON.stringify(body) });
    if (!res.ok) return { ok: false, status: res.status, text: await res.text(), retryAfter: res.headers.get("retry-after") };
    const j = await res.json();
    const content = (j.content || []).filter((b) => b.type === "text").map((b) => b.text).join("");
    const usage = (j.usage?.input_tokens || 0) + (j.usage?.output_tokens || 0);
    return { ok: true, status: 200, content, usage };
  }

  const messages = [];
  if (system) messages.push({ role: "system", content: system });
  messages.push({ role: "user", content: user });
  const body = { model, messages, temperature, max_completion_tokens: maxTokens };
  if (json) body.response_format = { type: "json_object" };
  if (reasoning && /gpt-oss/.test(model)) {
    body.reasoning_effort = "low";
    body.include_reasoning = false;
  }
  const call = (b) => fetch(settings.aiUrl, { method: "POST", headers, body: JSON.stringify(b) });
  let res = await call(body);
  if (res.status === 400 || res.status === 422) {
    // the API doesn't know some option: retry with the plain request
    for (const k of ["response_format", "reasoning_effort", "include_reasoning", "max_completion_tokens"]) delete body[k];
    body.max_tokens = maxTokens;
    res = await call(body);
  }
  if (!res.ok) return { ok: false, status: res.status, text: await res.text(), retryAfter: res.headers.get("retry-after") };
  const j = await res.json();
  let content = j?.choices?.[0]?.message?.content;
  if (Array.isArray(content)) content = content.map((p) => p.text || "").join("");
  return { ok: true, status: 200, content: content || "", usage: j?.usage?.total_tokens || 0 };
}

/** Lists the models a key can use (GET /models on both formats). */
export async function listModelIds(settings) {
  const url = aiFormat(settings) === "anthropic"
    ? settings.aiUrl.replace(/\/messages\/?$/, "/models")
    : settings.aiUrl.replace(/\/chat\/completions\/?$/, "/models");
  const headers = aiHeaders(settings);
  delete headers["Content-Type"];
  const res = await fetch(url, { headers });
  if (!res.ok) throw new Error(`AI models list ${res.status}`);
  const j = await res.json();
  return (j.data || j.models || []).map((m) => String(m.id || m.name || "").replace(/^models\//, "")).filter(Boolean);
}
