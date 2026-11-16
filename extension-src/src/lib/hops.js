// Coins priced in another pump coin (pump.fun's "pump coin quote"): $Daddy priced in $Huang, $Huang priced in SOL.
// PumpPortal and Jupiter cannot trade those with SOL. pump.fun's own `multi_hop_swap` can: SOL → Huang → Daddy in one
// transaction, with no Huang ever landing in the wallet. Built with pump.fun's official SDK (@pump-fun/pump-sdk).
// trade-routes.js (a plain script) calls globalThis.HatchrHops when a coin's curve is priced in something else than SOL.
import "./buffer-global.js";
import { Connection, PublicKey, TransactionMessage, VersionedTransaction, ComputeBudgetProgram } from "@solana/web3.js";
import { OnlinePumpSdk, PUMP_SDK } from "@pump-fun/pump-sdk";
import BN from "bn.js";

const WSOL = new PublicKey("So11111111111111111111111111111111111111112");
const PUMP = new PublicKey("6EF8rrecthR5Dkzon8Nwu78hRvfCKubJ14M5uBEwF6P");
const MAX_DEPTH = 5; // the program's own cap

const clients = new Map(); // rpcUrl -> { connection, sdk }
function client(rpcUrl) {
  if (!clients.has(rpcUrl)) {
    const connection = new Connection(rpcUrl, { commitment: "processed", disableRetryOnRateLimit: true });
    clients.set(rpcUrl, { connection, sdk: new OnlinePumpSdk(connection) });
  }
  return clients.get(rpcUrl);
}
const within = (p, ms, what) => Promise.race([p, new Promise((_, no) => setTimeout(() => no(new Error(`${what} took longer than ${ms / 1000} s`)), ms))]);
const name = key => key.toBase58().slice(0, 4) + "…";

// The coin's chain of quote coins, read from each bonding curve's quote mint (byte 83): [SOL, …, coin] for a buy.
// A curve stays after its coin moved to PumpSwap, so a migrated quote coin is still found.
async function chain(connection, mint) {
  const up = [new PublicKey(mint)];
  for (let i = 0; i <= MAX_DEPTH; i++) {
    const coin = up[up.length - 1];
    const [curve] = PublicKey.findProgramAddressSync([new TextEncoder().encode("bonding-curve"), coin.toBytes()], PUMP);
    const acc = await connection.getAccountInfo(curve, { commitment: "processed", dataSlice: { offset: 83, length: 32 } });
    if (!acc) {
      if (up.length === 1) throw new Error("not a pump.fun coin");
      throw new Error(`it is priced in ${name(coin)}, which is not a pump.fun coin or SOL`);
    }
    const quote = new PublicKey(acc.data.subarray(0, 32));
    if (quote.equals(PublicKey.default) || quote.equals(WSOL)) return [WSOL, ...up.reverse()];
    up.push(quote);
  }
  throw new Error("its chain of quote coins is deeper than pump.fun allows");
}

async function build({ rpcUrl, user, side, path, amountIn, slippage, priorityFee }) {
  const { connection, sdk } = client(rpcUrl);
  const hops = await within(sdk.resolveMultiHopRoute(path, side), 4000, "finding the pump.fun route");
  const out = await within(sdk.simulateMultiHopSwap({ user, hops, side, amountIn }), 5000, "pricing the pump.fun route");
  if (!out || out.lten(0)) throw new Error("the pump.fun route would return nothing");
  const keep = Math.max(1, Math.round((100 - Math.min(99, Math.max(0, Number(slippage) || 0))) * 100));
  let minAmountOut = out.muln(keep).divn(10000);
  if (minAmountOut.lten(0)) minAmountOut = new BN(1);
  const ixs = await PUMP_SDK.multiHopSwapInstructions({ user, hops, side, amountIn, minAmountOut });
  const units = 150000 + 200000 * hops.length;
  const microLamports = Math.max(1, Math.floor((Number(priorityFee) || 0) * 1e9 * 1e6 / units));
  const { blockhash } = await connection.getLatestBlockhash("processed");
  const message = new TransactionMessage({ payerKey: user, recentBlockhash: blockhash, instructions: [
    ComputeBudgetProgram.setComputeUnitLimit({ units }), ComputeBudgetProgram.setComputeUnitPrice({ microLamports }), ...ixs] }).compileToV0Message();
  return { tx: new VersionedTransaction(message), out: out.toString(), min: minAmountOut.toString(), hops: hops.length };
}

const via = path => path.map(k => (k.equals(WSOL) ? "SOL" : name(k))).join(" → ");

// Buy `sol` SOL of `mint`. Returns { tx (unsigned), path, out (raw tokens expected) }.
async function buy({ rpcUrl, user, mint, sol, slippage, priorityFee }) {
  const { connection } = client(rpcUrl);
  const path = await chain(connection, mint);
  if (path.length < 3) throw new Error("it is priced in SOL: no multi-hop route needed");
  const made = await build({ rpcUrl, user: new PublicKey(user), side: "buy", path, amountIn: new BN(Math.floor(sol * 1e9)), slippage, priorityFee });
  return { ...made, path: via(path) };
}
// Sell `raw` (base units, string) of `mint` back to SOL along the same chain.
async function sell({ rpcUrl, user, mint, raw, slippage, priorityFee }) {
  const { connection } = client(rpcUrl);
  const path = (await chain(connection, mint)).reverse();
  if (path.length < 3) throw new Error("it is priced in SOL: no multi-hop route needed");
  const made = await build({ rpcUrl, user: new PublicKey(user), side: "sell", path, amountIn: new BN(String(raw)), slippage, priorityFee });
  return { ...made, path: via(path) };
}

globalThis.HatchrHops = Object.freeze({ buy, sell });
