/* Building a buy or a sell, shared by CA buy (ca-buy.js) and copy trade (copytrade.js). Plain script next to background.js.
   Buy: two routes, asked at the same moment.
     1. PumpPortal ("auto" pool): one request, the transaction comes back ready. It only knows coins priced in SOL.
     2. Jupiter: any route from SOL to the coin, also through another token. pump.fun coins can be paired with USDC or
        with another pump.fun coin, and PumpPortal answers 400 for those. Jupiter needs two requests (price, then the
        transaction); the first is sent together with PumpPortal's, so it is already answered when it is needed.
   Sell: PumpPortal first (a share of what the wallet holds), Jupiter when PumpPortal cannot.
   Nothing here sends anything: the caller signs off and sends. */
(() => {
  "use strict";
  const core = () => globalThis.HatchrCore;
  const wait = ms => new Promise(resolve => setTimeout(resolve, ms));
  const short = (e, n = 200) => String(e && e.message || e || "").slice(0, n);
  const SOL = "So11111111111111111111111111111111111111112";

  const PUMP_ERRORS = { 6002: "the price moved more than your slippage allows", 6005: "the coin already left the bonding curve", 6021: "not enough coins left on the bonding curve",
    6042: "the price moved more than your slippage allows", 6063: "the coin is priced in another token than SOL" };
  function explain(err) {
    const text = typeof err === "string" ? err : JSON.stringify(err);
    const code = (text.match(/"Custom":\s*(\d+)/) || [])[1];
    if (code && PUMP_ERRORS[code]) return `${PUMP_ERRORS[code]} (error ${code})`;
    if (/InsufficientFunds|insufficient lamports|"Custom":\s*1\b/.test(text)) return "not enough SOL in the wallet";
    return text.slice(0, 180);
  }

  // o: { pub, sol (buy) | pct (sell), slippage, priorityFee }
  async function portal(mint, o, action) {
    const body = action === "sell"
      ? { publicKey: o.pub, action: "sell", mint, denominatedInSol: "false", amount: `${o.pct}%`, slippage: o.slippage, priorityFee: o.priorityFee, pool: "auto" }
      : { publicKey: o.pub, action: "buy", mint, denominatedInSol: "true", amount: o.sol, slippage: o.slippage, priorityFee: o.priorityFee, pool: "auto" };
    const response = await fetch("https://pumpportal.fun/api/trade-local", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) });
    if (response.status !== 200) throw new Error(`${response.status} ${(await response.text().catch(() => "")).slice(0, 100) || response.statusText || ""}`.trim());
    return core().Tx.deserialize(new Uint8Array(await response.arrayBuffer()));
  }
  async function jupiterQuote(input, output, amount, slippage) {
    // restrictIntermediateTokens=false: the token a coin is paired with is exactly such an "unusual" token in between
    const url = `https://lite-api.jup.ag/swap/v1/quote?inputMint=${input}&outputMint=${output}&amount=${amount}&slippageBps=${Math.min(10000, Math.round(slippage * 100))}&restrictIntermediateTokens=false`;
    const response = await fetch(url, { headers: { accept: "application/json" } });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || data.error || !(Number(data.outAmount) > 0)) throw new Error(data && (data.error || data.errorCode) ? String(data.error || data.errorCode).slice(0, 100) : `${response.status}`);
    return data;
  }
  async function jupiterTx(quote, o) {
    const response = await fetch("https://lite-api.jup.ag/swap/v1/swap", {
      method: "POST",
      headers: { "Content-Type": "application/json", accept: "application/json" },
      body: JSON.stringify({ quoteResponse: quote, userPublicKey: o.pub, wrapAndUnwrapSol: true, dynamicComputeUnitLimit: true, prioritizationFeeLamports: Math.round(o.priorityFee * 1e9) })
    });
    const data = await response.json().catch(() => null);
    if (!response.ok || !data || !data.swapTransaction) throw new Error(data && data.error ? String(data.error).slice(0, 100) : `${response.status}`);
    return core().Tx.deserialize(Uint8Array.from(atob(data.swapTransaction), c => c.charCodeAt(0)));
  }
  const hops = quote => (Array.isArray(quote.routePlan) ? quote.routePlan : []).map(h => h && h.swapInfo && h.swapInfo.label).filter(Boolean).join(" → ");

  // What a pump.fun coin is priced in, read from its bonding curve (quote mint at byte 83; all zeros = SOL).
  // "" = SOL, or no curve, or it could not be read. PumpPortal answers 200 for a coin on the curve that is priced in
  // another token, and that transaction then fails on-chain (error 6063), so its answer alone is not enough.
  const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P", B58_ABC = "123456789ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz";
  function base58(bytes) { let n = 0n, out = ""; for (const b of bytes) n = (n << 8n) | BigInt(b); while (n > 0n) { out = B58_ABC[Number(n % 58n)] + out; n /= 58n; } for (const b of bytes) { if (b !== 0) break; out = "1" + out; } return out; }
  function curveOf(mint) {
    const PK = core().PublicKey;
    return PK.findProgramAddressSync([new TextEncoder().encode("bonding-curve"), new PK(mint).toBytes()], new PK(PUMP_PROGRAM))[0].toBase58();
  }
  async function curveBytes(mint, rpcUrl, offset, length) {
    const got = await core().rpc(rpcUrl, "getAccountInfo", [curveOf(mint), { encoding: "base64", commitment: "processed", dataSlice: { offset, length } }]);
    const b64 = got && got.value && got.value.data && got.value.data[0];
    return b64 ? Uint8Array.from(atob(b64), c => c.charCodeAt(0)) : null;
  }
  async function pricedIn(mint, rpcUrl) {
    if (!/pump$/.test(mint) || !rpcUrl) return "";
    const bytes = await curveBytes(mint, rpcUrl, 83, 32);
    if (!bytes || bytes.length < 32 || !bytes.some(b => b !== 0)) return "";
    const quote = base58(bytes);
    return quote === SOL ? "" : quote;
  }
  // Who made a pump.fun coin (the curve's creator, byte 49). "" when unknown.
  async function creatorOf(mint, rpcUrl) {
    if (!/pump$/.test(mint) || !rpcUrl) return "";
    const bytes = await curveBytes(mint, rpcUrl, 49, 32);
    return bytes && bytes.length === 32 && bytes.some(b => b !== 0) ? base58(bytes) : "";
  }

  async function viaJupiter(asked, keypair, o, whyNot) {
    const quote = await asked;
    if (!quote.value) throw new Error(`no route to buy it with SOL. PumpPortal: ${whyNot}. Jupiter: ${quote.error}.`);
    // Jupiter's price already includes what this buy itself does to the price. More than your slippage: do not buy.
    const impact = Number(quote.value.priceImpactPct) * 100;
    if (o.slippage > 0 && impact > o.slippage) throw new Error(`the only route (Jupiter, ${hops(quote.value) || "indirect"}) is too thin: a ${o.sol} SOL buy would move the price ${impact.toFixed(1)}%, more than your ${o.slippage}% slippage. PumpPortal: ${whyNot}.`);
    const swap = await jupiterTx(quote.value, o).then(value => ({ value }), e => ({ error: short(e, 120) }));
    if (!swap.value) throw new Error(`no route to buy it with SOL. PumpPortal: ${whyNot}. Jupiter found a price but could not build the buy: ${swap.error}.`);
    swap.value.sign([keypair]);
    return { tx: swap.value, route: `Jupiter (${hops(quote.value) || "swap"}), because PumpPortal cannot buy this coin (${whyNot})` };
  }

  // A coin priced in another pump coin ($Daddy in $Huang in SOL): pump.fun's own multi-hop route, SOL → Huang → Daddy in
  // one transaction (lib/hops.js, pump.fun's SDK). It prices the route with a dry run, so the result counts as simulated.
  async function viaHops(mint, keypair, rpcUrl, o, side) {
    const H = globalThis.HatchrHops;
    if (!H) throw new Error("pump.fun's multi-hop route is not available here");
    const args = { rpcUrl, user: keypair.publicKey.toBase58(), mint, slippage: o.slippage, priorityFee: o.priorityFee };
    const made = side === "sell" ? await H.sell({ ...args, raw: o.amount }) : await H.buy({ ...args, sol: o.sol });
    made.tx.sign([keypair]);
    return { tx: made.tx, route: `pump.fun's multi-hop route (${made.path})`, simulated: true };
  }
  const reason = e => short(e && e.message ? e.message : e, 160);

  // A buy of o.sol SOL. Returns { tx (signed), route, simulated? } or throws with each route's reason.
  // Three requests leave at the same moment: PumpPortal's transaction, Jupiter's price, and what the coin is priced in.
  async function buy(mint, keypair, rpcUrl, o) {
    const C = core(), settle = p => p.then(value => ({ value }), e => ({ error: short(e, 120) }));
    const building = settle(portal(mint, o, "buy")); // first out: this is the one the buy normally waits for
    const asked = settle(jupiterQuote(SOL, mint, Math.round(o.sol * 1e9), o.slippage)), quoteMint = Promise.resolve().then(() => pricedIn(mint, rpcUrl)).catch(() => "");
    const first = await building;
    if (!first.value) {
      // PumpPortal could not build it: Jupiter, and for a coin priced in another pump coin pump.fun's own route
      const [jupiter, hops] = await Promise.all([
        viaJupiter(asked, keypair, o, first.error).then(value => ({ value }), e => ({ error: e })),
        quoteMint.then(q => (q ? viaHops(mint, keypair, rpcUrl, o, "buy") : null)).then(value => ({ value }), e => ({ error: e }))
      ]);
      if (jupiter.value) return jupiter.value;
      if (hops.value) return hops.value;
      throw hops.error ? new Error(`${reason(jupiter.error)} pump.fun's own route: ${reason(hops.error)}.`) : jupiter.error;
    }
    first.value.sign([keypair]);
    // the curve read is usually back before PumpPortal; an RPC that is slower than that is not waited for long
    const other = await Promise.race([quoteMint, wait(250).then(() => "")]);
    if (!other) return { tx: first.value, route: "PumpPortal" };
    // Priced in another token. PumpPortal's transaction gets a dry run while Jupiter and pump.fun's own multi-hop route
    // build theirs; the one that works is sent (PumpPortal first, then pump.fun's route, then Jupiter).
    const [sim, hops, jupiter] = await Promise.all([
      C.simulate(rpcUrl, first.value).catch(e => ({ err: short(e) })),
      viaHops(mint, keypair, rpcUrl, o, "buy").then(value => ({ value }), e => ({ error: e })),
      viaJupiter(asked, keypair, o, `priced in another token, ${other.slice(0, 4)}…`).then(value => ({ value }), e => ({ error: e }))
    ]);
    if (sim && !sim.err) return { tx: first.value, route: "PumpPortal", simulated: true };
    if (hops.value) return hops.value;
    if (jupiter.value) return jupiter.value;
    throw new Error(`${reason(jupiter.error)} pump.fun's own route: ${reason(hops.error)}.`);
  }

  // A sell of o.pct % of what the wallet holds of the coin. o.raw: the raw amount held (string), if known.
  async function sell(mint, keypair, rpcUrl, o) {
    const first = await portal(mint, o, "sell").then(value => ({ value }), e => ({ error: short(e, 120) }));
    if (first.value) { first.value.sign([keypair]); return { tx: first.value, route: "PumpPortal" }; }
    let raw = o.raw;
    if (!raw) raw = (await core().tokenBalance(rpcUrl, o.pub, mint).catch(() => ({ raw: "0" }))).raw;
    const amount = (BigInt(raw || "0") * BigInt(Math.round(Math.min(100, o.pct) * 100))) / 10000n;
    if (amount <= 0n) throw new Error(`nothing of it in the wallet to sell. PumpPortal: ${first.error}.`);
    // priced in another pump coin: pump.fun's own route back to SOL (Jupiter is the fallback)
    const other = await pricedIn(mint, rpcUrl).catch(() => "");
    let hopsError = "";
    if (other) {
      try { return await viaHops(mint, keypair, rpcUrl, { ...o, amount: amount.toString() }, "sell"); }
      catch (e) { hopsError = ` pump.fun's own route: ${reason(e)}.`; }
    }
    const quote = await jupiterQuote(mint, SOL, amount.toString(), o.slippage).catch(e => { throw new Error(`no route to sell it. PumpPortal: ${first.error}. Jupiter: ${short(e, 100)}.${hopsError}`); });
    const tx = await jupiterTx(quote, o);
    tx.sign([keypair]);
    return { tx, route: `Jupiter (${hops(quote) || "swap"}), because PumpPortal cannot sell this coin (${first.error})` };
  }

  // ---------- Boost: the priority fee the network asks for right now ----------
  // Fast without overpaying: the "high" level (about the 75th percentile of what recent pump.fun / PumpSwap trades
  // paid), never under 0.0001 and never over FEE_CAP SOL. Helius RPCs give the levels directly; any other RPC gives
  // the recent fees, from which the same percentile is taken. Kept for 30 seconds.
  const PUMP_AMM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA", FEE_CAP = 0.003, FEE_MIN = 0.0001, CU = 150000;
  const BOOST_SLIPPAGE = Object.freeze({ buy: 30, copy: 25, sell: 25 }); // what Boost sets: a fresh coin moves fast
  let feeCache = null;
  async function feeEstimate(rpcUrl) {
    if (feeCache && feeCache.url === rpcUrl && Date.now() - feeCache.at < 30000) return feeCache.value;
    const C = core();
    let micro = 0, how = "";
    if (/helius/i.test(rpcUrl)) {
      try {
        const r = await C.rpc(rpcUrl, "getPriorityFeeEstimate", [{ accountKeys: [PUMP_PROGRAM, PUMP_AMM], options: { includeAllPriorityFeeLevels: true } }]);
        const levels = r && r.priorityFeeLevels;
        if (levels && Number(levels.high) > 0) { micro = Number(levels.high); how = "Helius estimate, high"; }
      } catch { /* the plain way below */ }
    }
    if (!micro) {
      try {
        const list = await C.rpc(rpcUrl, "getRecentPrioritizationFees", [[PUMP_PROGRAM]]);
        const fees = (Array.isArray(list) ? list : []).map(x => Number(x && x.prioritizationFee) || 0).filter(x => x > 0).sort((a, b) => a - b);
        if (fees.length) { micro = fees[Math.min(fees.length - 1, Math.floor(fees.length * 0.75))]; how = "recent pump.fun fees, 75th percentile"; }
      } catch { /* default below */ }
    }
    const raw = micro ? (micro * CU) / 1e15 : 0.0005;
    const fee = Math.round(Math.min(FEE_CAP, Math.max(FEE_MIN, raw)) * 1e6) / 1e6;
    const value = { fee, how: how || "no fee data, a safe default", capped: raw > FEE_CAP, at: Date.now() };
    feeCache = { url: rpcUrl, at: Date.now(), value };
    return value;
  }

  // Keeps both connections open (a cold connection costs a few hundred ms of handshake at the worst moment).
  function warm() {
    fetch("https://pumpportal.fun/api/trade-local", { method: "OPTIONS" }).catch(() => {});
    fetch("https://lite-api.jup.ag/swap/v1/quote", { method: "OPTIONS" }).catch(() => {});
  }

  globalThis.HatchrRoutes = Object.freeze({ buy, sell, explain, pricedIn, creatorOf, warm, base58, feeEstimate, BOOST_SLIPPAGE, FEE_CAP, SOL, PUMP_PROGRAM });
})();
