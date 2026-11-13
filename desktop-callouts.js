// Fixed Pump.fun transport for the app's engine. Uses Electron's cookie session;
// never exports cookies to a renderer, accepts an arbitrary URL, or retries a POST.
const ENDPOINT = "https://frontend-api-v3.pump.fun/callout/create";

async function postCallout(session, input) {
  const mint = input?.coinMint;
  const thesis = typeof input?.thesis === "string" ? input.thesis.trim() : "";
  if (typeof mint !== "string" || !/^[1-9A-HJ-NP-Za-km-z]{32,44}$/.test(mint) || !thesis || thesis.length > 2000) {
    throw new Error("Invalid callout");
  }
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), 20000);
  try {
    const response = await session.fetch(ENDPOINT, {
      method: "POST", credentials: "include", redirect: "error",
      headers: { accept: "application/json", "content-type": "application/json", "x-pump-platform": "web", "x-pump-source": "WEB" },
      body: JSON.stringify({ coinMint: mint, thesis, chainId: 1399811149, version: 2 }),
      signal: controller.signal
    });
    let body = null;
    try { body = await response.json(); } catch { /* The client reports an unconfirmed response. */ }
    return { status: response.status, body };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = { postCallout };
