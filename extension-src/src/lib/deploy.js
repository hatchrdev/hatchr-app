// Pinata IPFS upload -> PumpPortal trade-local "create" -> sign locally -> send via your RPC.
// Your private key never leaves the extension; PumpPortal only sees your public key.
import { Keypair, VersionedTransaction, PublicKey, Transaction, TransactionInstruction } from "@solana/web3.js";
import { Buffer } from "buffer";
import bs58 from "bs58";

const LAMPORTS = 1_000_000_000;

export function parseSecret(input) {
  const s = String(input || "").trim();
  if (!s) throw new Error("No wallet key set");
  let bytes;
  if (s.startsWith("[")) bytes = Uint8Array.from(JSON.parse(s));
  else bytes = bs58.decode(s);
  if (bytes.length === 64) return Keypair.fromSecretKey(bytes);
  if (bytes.length === 32) return Keypair.fromSeed(bytes);
  throw new Error(`Key has ${bytes.length} bytes, expected 64 (base58 private key or JSON array)`);
}

/** A brand-new burner wallet. The secret is base58 (what Phantom and Solflare import). */
export function newWallet() {
  const kp = Keypair.generate();
  return { secret: bs58.encode(kp.secretKey), pub: kp.publicKey.toBase58() };
}

/** The same key as a JSON byte array (Solana CLI keypair file format). */
export function secretAsArray(secret) {
  return JSON.stringify(Array.from(parseSecret(secret).secretKey));
}

// ---------- test-mode numbers (pump.fun bonding curve at launch) ----------
const CURVE_SOL = 30; // virtual SOL reserves of a fresh curve
const CURVE_TOKENS = 1_073_000_000; // virtual token reserves of a fresh curve
const TRADE_FEE = 0.0125; // pump.fun protocol + creator fee, roughly
const PORTAL_FEE = 0.005; // PumpPortal's fee on trades it builds
const BASE_FEE = 0.000005; // network fee per signature
export const TOKEN_ACCOUNT_RENT = 0.00203928; // given back when an empty token account is closed

/** What a launch would cost and give you, if nothing else trades in between. */
export function simulateLaunch(devBuySol, priorityFee, overheadSol) {
  const buy = Math.max(0, Number(devBuySol) || 0);
  const net = buy * (1 - TRADE_FEE - PORTAL_FEE);
  const tokens = net > 0 ? (CURVE_TOKENS * net) / (CURVE_SOL + net) : 0;
  const fees = Number(priorityFee || 0) + 2 * BASE_FEE;
  const cost = buy + fees + Number(overheadSol || 0);
  return { tokens, costSol: +cost.toFixed(6), devBuySol: buy, feesSol: +fees.toFixed(6), rentSol: Number(overheadSol || 0) };
}

/** SOL back from selling `tokens` right after launch (test mode). */
export function simulateSell(tokens, devBuySol, { priorityFee = 0.000001, closeAccount = true } = {}) {
  const buy = Math.max(0, Number(devBuySol) || 0);
  const net = buy * (1 - TRADE_FEE - PORTAL_FEE);
  const k = CURVE_SOL * CURVE_TOKENS;
  const solOut = Math.max(0, CURVE_SOL + net - k / (CURVE_TOKENS - (CURVE_TOKENS * net) / (CURVE_SOL + net) + tokens));
  const got = solOut * (1 - TRADE_FEE - PORTAL_FEE) - (Number(priorityFee) + BASE_FEE) + (closeAccount ? TOKEN_ACCOUNT_RENT - BASE_FEE : 0);
  return +got.toFixed(6);
}

export async function rpc(url, method, params = []) {
  const res = await fetch(url, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: Date.now(), method, params }),
  });
  if (res.status === 401 || res.status === 403) {
    throw new Error(`RPC blocked the request (${res.status}). The free public Solana RPC refuses browser extensions: get a free Helius RPC URL (helius.dev) and paste it in Settings → Launch → Solana RPC URL.`);
  }
  if (res.status === 429) throw new Error(`RPC rate limit hit (429). Wait a bit, or use your own free Helius RPC URL.`);
  if (!res.ok) throw new Error(`RPC ${method} HTTP ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  if (j.error) throw new Error(`RPC ${method}: ${j.error.message || JSON.stringify(j.error)}`);
  return j.result;
}

export async function getBalanceSol(rpcUrl, pubkey) {
  const r = await rpc(rpcUrl, "getBalance", [pubkey, { commitment: "confirmed" }]);
  return r.value / LAMPORTS;
}

async function pinataUpload(jwt, blob, filename) {
  const fd = new FormData();
  fd.append("network", "public");
  fd.append("file", blob, filename);
  const res = await fetch("https://uploads.pinata.cloud/v3/files", {
    method: "POST",
    headers: { Authorization: `Bearer ${jwt}` },
    body: fd,
  });
  if (!res.ok) throw new Error(`Pinata ${res.status}: ${(await res.text()).slice(0, 200)}`);
  const j = await res.json();
  const cid = j?.data?.cid;
  if (!cid) throw new Error("Pinata returned no CID");
  return `https://ipfs.io/ipfs/${cid}`;
}

export async function testPinata(jwt) {
  const res = await fetch("https://api.pinata.cloud/data/testAuthentication", {
    headers: { Authorization: `Bearer ${jwt}` },
  });
  if (!res.ok) throw new Error(`Pinata ${res.status}: ${(await res.text()).slice(0, 150)}`);
  return true;
}

async function buildCreateTx({ publicKey, name, symbol, uri, mint, devBuySol, slippage, priorityFee }) {
  const res = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey,
      action: "create",
      tokenMetadata: { name, symbol, uri },
      mint,
      denominatedInSol: "true",
      amount: Number(devBuySol),
      slippage: Number(slippage),
      priorityFee: Number(priorityFee),
      pool: "pump",
    }),
  });
  if (res.status !== 200) {
    throw new Error(`PumpPortal ${res.status}: ${(await res.text()).slice(0, 200) || res.statusText}`);
  }
  return new Uint8Array(await res.arrayBuffer());
}

function toBase64(bytes) {
  let bin = "";
  for (let i = 0; i < bytes.length; i += 0x8000) bin += String.fromCharCode(...bytes.subarray(i, i + 0x8000));
  return btoa(bin);
}

async function sendTx(rpcUrl, tx, skipPreflight) {
  return rpc(rpcUrl, "sendTransaction", [
    toBase64(tx.serialize()),
    { encoding: "base64", skipPreflight: !!skipPreflight, preflightCommitment: "confirmed", maxRetries: 5 },
  ]);
}

async function simulateTx(rpcUrl, tx) {
  const r = await rpc(rpcUrl, "simulateTransaction", [
    toBase64(tx.serialize()),
    { encoding: "base64", sigVerify: false, replaceRecentBlockhash: true, commitment: "confirmed" },
  ]);
  return r.value;
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

async function waitConfirm(rpcUrl, sig, timeoutMs = 75000) {
  const start = Date.now();
  while (Date.now() - start < timeoutMs) {
    const r = await rpc(rpcUrl, "getSignatureStatuses", [[sig], { searchTransactionHistory: false }]);
    const st = r?.value?.[0];
    if (st) {
      if (st.err) throw new Error(`Transaction failed on-chain: ${JSON.stringify(st.err)}`);
      if (st.confirmationStatus === "confirmed" || st.confirmationStatus === "finalized") return st;
    }
    await sleep(1500);
  }
  throw new Error("Not confirmed within 75s (it may still land, check Solscan)");
}

/**
 * Launch a coin.
 * card: { name, ticker, description, url }
 * opts: { dryRun, imageBlob, imageKind, onStep }
 * Returns a result record.
 */
export async function launch(card, settings, secret, opts) {
  const step = opts.onStep || (() => {});
  const result = { dryRun: !!opts.dryRun };

  const mintKp = Keypair.generate();
  result.mint = mintKp.publicKey.toBase58();
  if (opts.dryRun && !secret) {
    step("Test mode: no wallet yet, simulating only");
    result.note = "Simulated without a wallet (no on-chain check). Create a wallet in Settings → Account to also check the real transaction.";
    return result;
  }

  const signer = parseSecret(secret);
  result.wallet = signer.publicKey.toBase58();

  let balanceBefore = null;
  try {
    balanceBefore = await getBalanceSol(settings.rpcUrl, result.wallet);
  } catch (e) {
    console.warn("balance check failed", e);
  }
  result.balanceBefore = balanceBefore;

  let uri;
  if (opts.dryRun) {
    uri = "https://ipfs.io/ipfs/bafkreidryrun000000000000000000000000000000000000000000000";
  } else {
    if (!settings.pinataJwt) throw new Error("Pinata JWT not set (Settings → Launch)");
    step("Uploading image to IPFS…");
    const ext = (opts.imageBlob?.type || "image/png").split("/")[1] || "png";
    const image = await pinataUpload(settings.pinataJwt, opts.imageBlob, `${card.ticker}.${ext}`);
    result.image = image;
    step("Uploading metadata…");
    const meta = {
      name: card.name,
      symbol: card.ticker,
      description: card.description || "",
      image,
      showName: true,
      createdOn: "https://pump.fun",
    };
    // link the post the coin is about in the coin's socials
    if (settings.linkSourceAsTwitter && card.url) {
      if (/^https:\/\/t\.me\//.test(card.url)) meta.telegram = card.url;
      else meta.twitter = card.url;
    }
    if (settings.website) meta.website = settings.website;
    if (settings.telegram) meta.telegram = settings.telegram;
    const metaBlob = new Blob([JSON.stringify(meta)], { type: "application/json" });
    uri = await pinataUpload(settings.pinataJwt, metaBlob, `${card.ticker}.json`);
    result.uri = uri;
  }

  step("Building create transaction…");
  const raw = await buildCreateTx({
    publicKey: result.wallet,
    name: card.name,
    symbol: card.ticker,
    uri,
    mint: result.mint,
    devBuySol: settings.devBuySol,
    slippage: settings.slippage,
    priorityFee: settings.priorityFee,
  });
  const tx = VersionedTransaction.deserialize(raw);
  tx.sign([mintKp, signer]);

  if (opts.dryRun) {
    step("Simulating (no SOL spent)…");
    const sim = await simulateTx(settings.rpcUrl, tx);
    result.simulated = true;
    result.simError = sim.err ? JSON.stringify(sim.err) : null;
    result.simLogs = (sim.logs || []).slice(-6);
    result.unitsConsumed = sim.unitsConsumed;
    // an empty or under-funded wallet is not a problem with the coin: report it, don't fail the test
    const all = `${result.simError || ""} ${(sim.logs || []).join(" ")}`;
    if (result.simError && /AccountNotFound|insufficient lamports|insufficient funds|InsufficientFunds/i.test(all)) {
      result.needsFunds = true;
      result.simError = null;
      result.note = "Transaction is fine, but your wallet needs SOL to launch this for real.";
    }
    return result;
  }

  step("Sending transaction…");
  const sig = await sendTx(settings.rpcUrl, tx, settings.skipPreflight);
  result.signature = sig;
  step("Waiting for confirmation…");
  try { await waitConfirm(settings.rpcUrl, sig); }
  catch (e) { e.signature = sig; e.mint = result.mint || null; throw e; } // sent but not confirmed in time: the caller records that it may have landed
  result.confirmed = true;

  try {
    const after = await getBalanceSol(settings.rpcUrl, result.wallet);
    result.balanceAfter = after;
    if (balanceBefore != null) result.spentSol = +(balanceBefore - after).toFixed(6);
  } catch {}
  return result;
}

// ---------- holdings + sell ----------

// Token balance of `owner` for `mint` (works for SPL and Token-2022 mints).
export async function getTokenBalance(rpcUrl, owner, mint) {
  const r = await rpc(rpcUrl, "getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  let ui = 0, raw = 0n;
  for (const acc of r?.value || []) {
    const ta = acc.account?.data?.parsed?.info?.tokenAmount;
    if (!ta) continue;
    ui += Number(ta.uiAmount || 0);
    raw += BigInt(ta.amount || "0");
  }
  return { ui, raw: raw.toString() };
}

/**
 * Sell 100% of the wallet's tokens of `mint` via PumpPortal (pool "auto" also covers
 * coins that already left the bonding curve). Test mode simulates only.
 */
async function buildSellTx(owner, mint, settings, priorityFee) {
  const res = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({
      publicKey: owner,
      action: "sell",
      mint,
      denominatedInSol: "false",
      amount: "100%",
      slippage: Number(settings.sellSlippage ?? settings.slippage),
      priorityFee,
      pool: "auto",
    }),
  });
  if (res.status !== 200) throw new Error(`PumpPortal ${res.status}: ${(await res.text()).slice(0, 200) || res.statusText}`);
  return VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
}

/** Closes the wallet's empty token accounts for `mint`, giving back their rent (~0.002 SOL each). */
export async function closeEmptyTokenAccounts(rpcUrl, signer, mint) {
  const owner = signer.publicKey.toBase58();
  const r = await rpc(rpcUrl, "getTokenAccountsByOwner", [owner, { mint }, { encoding: "jsonParsed", commitment: "confirmed" }]);
  const empty = (r?.value || []).filter((a) => a.account?.data?.parsed?.info?.tokenAmount?.amount === "0");
  if (!empty.length) return { closed: 0 };
  const { value } = await rpc(rpcUrl, "getLatestBlockhash", [{ commitment: "confirmed" }]);
  const tx = new Transaction({ feePayer: signer.publicKey, recentBlockhash: value.blockhash });
  for (const a of empty) {
    tx.add(new TransactionInstruction({
      programId: new PublicKey(a.account.owner), // SPL Token or Token-2022
      keys: [
        { pubkey: new PublicKey(a.pubkey), isSigner: false, isWritable: true },
        { pubkey: signer.publicKey, isSigner: false, isWritable: true },
        { pubkey: signer.publicKey, isSigner: true, isWritable: false },
      ],
      data: Buffer.from([9]), // CloseAccount
    }));
  }
  tx.sign(signer);
  const sig = await rpc(rpcUrl, "sendTransaction", [toBase64(tx.serialize()), { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 5 }]);
  await waitConfirm(rpcUrl, sig, 45000);
  return { closed: empty.length, signature: sig };
}

/**
 * Sell 100% of the wallet's tokens of `mint` via PumpPortal (pool "auto" also covers
 * coins that already left the bonding curve), as cheaply as possible:
 * tiny priority fee first, resent once at 10x if it isn't confirmed within ~20s,
 * then the empty token account is closed to get its rent back. Test mode simulates only.
 */
export async function sellAll(mint, settings, secret, { dryRun, onStep } = {}) {
  const step = onStep || (() => {});
  const signer = parseSecret(secret);
  const owner = signer.publicKey.toBase58();
  step("Checking balance…");
  const bal = await getTokenBalance(settings.rpcUrl, owner, mint);
  if (bal.raw === "0") {
    if (!dryRun && settings.sellCloseAccount !== false) await closeEmptyTokenAccounts(settings.rpcUrl, signer, mint).catch(() => {});
    return { nothing: true, tokensBefore: 0 };
  }

  let solBefore = null;
  try { solBefore = await getBalanceSol(settings.rpcUrl, owner); } catch {}

  const fee1 = Math.max(0, Number(settings.sellPriorityFee ?? 0.000001));
  step("Building sell transaction…");
  let tx = await buildSellTx(owner, mint, settings, fee1);
  tx.sign([signer]);

  if (dryRun) {
    step("Simulating sell…");
    const sim = await simulateTx(settings.rpcUrl, tx);
    return { dryRun: true, tokensBefore: bal.ui, simError: sim.err ? JSON.stringify(sim.err) : null, simLogs: (sim.logs || []).slice(-6) };
  }

  step("Sending sell (low fee)…");
  let signature = await sendTx(settings.rpcUrl, tx, settings.skipPreflight);
  step("Waiting for confirmation…");
  let retried = false;
  try {
    await waitConfirm(settings.rpcUrl, signature, Number(settings.sellConfirmMs) || 20000);
  } catch (e) {
    if (/failed on-chain/.test(e.message)) throw e;
    // not confirmed yet: maybe it landed late, otherwise resend once with a higher fee
    const now = await getTokenBalance(settings.rpcUrl, owner, mint).catch(() => null);
    if (!now || now.raw !== "0") {
      retried = true;
      const fee2 = Math.max(fee1 * 10, 0.00001);
      step("Network busy, resending with a slightly higher fee…");
      tx = await buildSellTx(owner, mint, settings, fee2);
      tx.sign([signer]);
      signature = await sendTx(settings.rpcUrl, tx, settings.skipPreflight);
      await waitConfirm(settings.rpcUrl, signature);
    }
  }
  const out = { signature, tokensBefore: bal.ui, confirmed: true, retried };
  try {
    out.tokensAfter = (await getTokenBalance(settings.rpcUrl, owner, mint)).ui;
    if (settings.sellCloseAccount !== false && out.tokensAfter === 0) {
      step("Getting the account rent back…");
      const c = await closeEmptyTokenAccounts(settings.rpcUrl, signer, mint).catch((e) => ({ error: e.message }));
      out.closedAccounts = c.closed || 0;
      if (c.error) out.closeError = c.error;
    }
    const after = await getBalanceSol(settings.rpcUrl, owner);
    if (solBefore != null) out.receivedSol = +(after - solBefore).toFixed(6);
  } catch {}
  return out;
}

export const axiomUrl = (mint) => `https://axiom.trade/token/${mint}?chain=sol`;

// ---------- creator rewards ----------
// Every trade on a coin you created pays you a creator fee. It collects in "creator vaults"
// (one per creator, shared by all your coins) until you claim it.

export const PUMP_PROGRAM = "6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P";
export const PUMP_AMM_PROGRAM = "pAMMBay6oceH9fJKBRHGP5D4bD4sWpmSwMn52FMfXEA";
const WSOL = "So11111111111111111111111111111111111111112";
const RENT_EXEMPT_EMPTY = 890880; // lamports kept in a 0-byte account

export function creatorVaults(creator) {
  const c = new PublicKey(creator).toBuffer();
  const enc = new TextEncoder();
  const [curve] = PublicKey.findProgramAddressSync([enc.encode("creator-vault"), c], new PublicKey(PUMP_PROGRAM));
  const [amm] = PublicKey.findProgramAddressSync([enc.encode("creator_vault"), c], new PublicKey(PUMP_AMM_PROGRAM));
  return { curve: curve.toBase58(), ammAuthority: amm.toBase58() };
}

/** Unclaimed creator rewards in SOL: bonding-curve vault + PumpSwap (migrated coins) vault. */
export async function getCreatorRewards(rpcUrl, creator) {
  const v = creatorVaults(creator);
  let curve = 0, amm = 0;
  const bal = await rpc(rpcUrl, "getBalance", [v.curve, { commitment: "confirmed" }]);
  curve = Math.max(0, (bal.value || 0) - RENT_EXEMPT_EMPTY) / LAMPORTS;
  try {
    const r = await rpc(rpcUrl, "getTokenAccountsByOwner", [v.ammAuthority, { mint: WSOL }, { encoding: "jsonParsed", commitment: "confirmed" }]);
    for (const a of r?.value || []) amm += Number(a.account?.data?.parsed?.info?.tokenAmount?.uiAmount || 0);
  } catch {}
  return { total: +(curve + amm).toFixed(9), curve, amm };
}

/** Claims all creator rewards in one transaction via PumpPortal. Test mode simulates only. */
export async function claimCreatorRewards(settings, secret, { dryRun, onStep } = {}) {
  const step = onStep || (() => {});
  const signer = parseSecret(secret);
  const owner = signer.publicKey.toBase58();
  const before = await getCreatorRewards(settings.rpcUrl, owner).catch(() => null);
  step("Building claim…");
  const res = await fetch("https://pumpportal.fun/api/trade-local", {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ publicKey: owner, action: "collectCreatorFee", priorityFee: Number(settings.priorityFee) || 0.000001 }),
  });
  if (res.status !== 200) {
    const t = (await res.text()).slice(0, 200);
    throw new Error(`PumpPortal ${res.status}: ${t || res.statusText}`);
  }
  const tx = VersionedTransaction.deserialize(new Uint8Array(await res.arrayBuffer()));
  tx.sign([signer]);
  if (dryRun) {
    step("Simulating claim…");
    const sim = await simulateTx(settings.rpcUrl, tx);
    return { dryRun: true, expected: before?.total ?? null, simError: sim.err ? JSON.stringify(sim.err) : null };
  }
  let solBefore = null;
  try { solBefore = await getBalanceSol(settings.rpcUrl, owner); } catch {}
  step("Sending claim…");
  const signature = await sendTx(settings.rpcUrl, tx, settings.skipPreflight);
  step("Waiting for confirmation…");
  await waitConfirm(settings.rpcUrl, signature);
  const out = { signature, expected: before?.total ?? null };
  try {
    const after = await getBalanceSol(settings.rpcUrl, owner);
    if (solBefore != null) out.receivedSol = +(after - solBefore).toFixed(6);
  } catch {}
  return out;
}
