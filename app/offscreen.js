// Hidden page that plays sounds (service workers can't play audio).
// The bell is synthesized with Web Audio, so no sound files are needed.
let ctx = null;

function strike(at, freq, gain, len) {
  // bell = a few inharmonic partials that decay at different speeds
  const partials = [
    [1, 1, 1],
    [2.0, 0.55, 0.8],
    [2.76, 0.45, 0.55],
    [5.4, 0.22, 0.35],
    [8.93, 0.12, 0.2],
  ];
  const out = ctx.createGain();
  out.gain.value = gain;
  out.connect(ctx.destination);
  for (const [ratio, amp, decay] of partials) {
    const o = ctx.createOscillator();
    const g = ctx.createGain();
    o.type = "sine";
    o.frequency.value = freq * ratio;
    g.gain.setValueAtTime(0.0001, at);
    g.gain.exponentialRampToValueAtTime(amp, at + 0.005);
    g.gain.exponentialRampToValueAtTime(0.0001, at + len * decay);
    o.connect(g).connect(out);
    o.start(at);
    o.stop(at + len * decay + 0.05);
  }
}

function playBell(volume, kind) {
  ctx = ctx || new AudioContext();
  if (ctx.state === "suspended") ctx.resume();
  const v = Math.max(0, Math.min(1, (Number(volume) || 0) / 100)) * 0.35;
  if (v <= 0) return;
  const t = ctx.currentTime + 0.02;
  if (kind === "dry") {
    strike(t, 1046.5, v * 0.7, 1.2); // one soft ding
  } else if (kind === "vanity") {
    // sparkly rising chime: your vanity wallet is ready
    [1046.5, 1318.5, 1568, 2093].forEach((f, i) => strike(t + i * 0.09, f, v * (i === 3 ? 0.9 : 0.6), i === 3 ? 2.2 : 0.9));
  } else if (kind === "sell") {
    strike(t, 880, v, 1.4);
    strike(t + 0.16, 659.3, v, 1.8);
  } else {
    strike(t, 1046.5, v, 1.6); // ding-ding: coin is live
    strike(t + 0.18, 1318.5, v, 2.2);
  }
}

// ---------- video frames (for coin images from video posts) ----------
function once(el, ev, ms = 15000) {
  return new Promise((resolve, reject) => {
    const t = setTimeout(() => { el.removeEventListener(ev, ok); reject(new Error(`video ${ev} timed out`)); }, ms);
    const ok = () => { clearTimeout(t); el.removeEventListener(ev, ok); resolve(); };
    el.addEventListener(ev, ok);
    el.addEventListener("error", () => { clearTimeout(t); reject(new Error("video could not be decoded")); }, { once: true });
  });
}

// how usable a frame is: not black/blank, has contrast and detail (sharp, not motion-blurred)
function frameScore(ctx, w, h) {
  const S = 64;
  const c = new OffscreenCanvas(S, S);
  const x = c.getContext("2d");
  x.drawImage(ctx.canvas, 0, 0, w, h, 0, 0, S, S);
  const d = x.getImageData(0, 0, S, S).data;
  const L = new Float32Array(S * S);
  let sum = 0, sat = 0;
  for (let i = 0; i < S * S; i++) {
    const r = d[i * 4], g = d[i * 4 + 1], b = d[i * 4 + 2];
    L[i] = 0.299 * r + 0.587 * g + 0.114 * b;
    sum += L[i];
    sat += Math.max(r, g, b) - Math.min(r, g, b);
  }
  const mean = sum / (S * S);
  let v = 0;
  for (let i = 0; i < S * S; i++) v += (L[i] - mean) ** 2;
  const std = Math.sqrt(v / (S * S));
  let lap = 0;
  for (let y = 1; y < S - 1; y++) for (let xx = 1; xx < S - 1; xx++) {
    const i = y * S + xx;
    lap += Math.abs(4 * L[i] - L[i - 1] - L[i + 1] - L[i - S] - L[i + S]);
  }
  lap /= (S - 2) * (S - 2);
  if (mean < 22 || mean > 240 || std < 12) return 0; // black, white-out or blank
  return +(lap * Math.min(1, std / 45) * (0.8 + Math.min(0.4, sat / (S * S) / 200))).toFixed(2);
}

async function videoFrames(url, count = 6) {
  const res = await fetch(url);
  if (!res.ok) throw new Error(`video download ${res.status}`);
  if (Number(res.headers.get("content-length") || 0) > 60e6) throw new Error("video too large");
  const blob = await res.blob();
  const src = URL.createObjectURL(blob);
  const v = document.createElement("video");
  v.muted = true; v.playsInline = true; v.preload = "auto"; v.src = src;
  try {
    await once(v, "loadeddata");
    const d = Number.isFinite(v.duration) && v.duration > 0 ? v.duration : 1;
    const W = v.videoWidth, H = v.videoHeight;
    const k = Math.min(1, 960 / Math.max(W, H));
    const c = document.createElement("canvas");
    c.width = Math.round(W * k); c.height = Math.round(H * k);
    const ctx = c.getContext("2d", { willReadFrequently: true });
    const frames = [];
    for (let i = 0; i < count; i++) {
      const t = Math.min(d - 0.05, Math.max(0.05, d * (0.1 + (0.8 * i) / Math.max(1, count - 1))));
      v.currentTime = t;
      await once(v, "seeked");
      ctx.drawImage(v, 0, 0, c.width, c.height);
      frames.push({ t: +t.toFixed(2), score: frameScore(ctx, c.width, c.height), dataUrl: c.toDataURL("image/jpeg", 0.88), w: c.width, h: c.height });
    }
    return { frames, duration: d };
  } finally {
    v.removeAttribute("src"); v.load();
    URL.revokeObjectURL(src);
  }
}

// ---------- vanity wallet search (keeps running when the side panel is closed) ----------
let vanity = null;
function vanityStop() {
  if (vanity) vanity.workers.forEach((w) => w.terminate());
  vanity = null;
}
function vanityStart(job) {
  vanityStop();
  const n = Math.max(1, Math.min(8, (navigator.hardwareConcurrency || 4) - 1));
  const v = (vanity = { id: job.id, workers: [], tried: 0, t0: Date.now(), last: 0 });
  const report = (extra) => chrome.runtime.sendMessage({ type: "vanityProgress", id: v.id, tried: v.tried, ms: Date.now() - v.t0, ...extra }).catch(() => {});
  for (let i = 0; i < n; i++) {
    const w = new Worker("vanity-worker.js");
    w.onmessage = (e) => {
      if (vanity !== v) return;
      v.tried += e.data.tried || 0;
      if (e.data.found) {
        vanityStop();
        chrome.runtime.sendMessage({ type: "vanityFound", id: v.id, tried: v.tried, ms: Date.now() - v.t0, pub: e.data.found.pub, secret: e.data.found.secret }).catch(() => {});
        return;
      }
      if (Date.now() - v.last > 1000) { v.last = Date.now(); report(); }
    };
    w.onerror = (err) => { if (vanity === v) { vanityStop(); report({ error: String(err.message || "worker failed") }); } };
    w.postMessage({ prefix: job.prefix, suffix: job.suffix, caseSensitive: job.caseSensitive });
    v.workers.push(w);
  }
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target !== "offscreen") return; // other messages belong to the background
  if (msg.type === "playBell") playBell(msg.volume, msg.kind);
  if (msg.type === "vanityStart") { vanityStart(msg.job); sendResponse({ ok: true }); return; }
  if (msg.type === "vanityStop") { vanityStop(); sendResponse({ ok: true }); return; }
  if (msg.type === "vanityStatus") { sendResponse({ ok: true, running: !!vanity, id: vanity && vanity.id }); return; }
  if (msg.type === "videoFrames") {
    videoFrames(msg.url, msg.count || 6)
      .then((r) => sendResponse({ ok: true, ...r }))
      .catch((e) => sendResponse({ ok: false, error: String(e && e.message || e) }));
    return true;
  }
});
