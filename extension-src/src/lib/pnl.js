// Profit and loss from the launch log: what launches cost, what sells brought back,
// plus creator rewards claimed. Live and test coins are counted separately.
const DAY = 86_400_000;
export const RANGES = { day: DAY, week: 7 * DAY, month: 30 * DAY, all: Infinity };

export function computePnl({ deploys = [], rewards = null, wallet = null, scope = "wallet", range = "all", test = false, now = Date.now() }) {
  const since = now - (RANGES[range] ?? Infinity);
  const mine = (w) => scope === "all" || !wallet || !w || w === wallet;
  const coins = deploys.filter((d) =>
    d.ok && !d.pending && (test ? d.simulated : !d.dryRun) && d.time >= since && mine(d.wallet));
  const spent = coins.reduce((a, d) => a + (Number(d.spentSol) || 0), 0);
  const sold = coins.filter((d) => d.sold);
  const back = sold.reduce((a, d) => a + Math.max(0, Number(d.receivedSol) || 0), 0);
  const claimed = test ? 0 : (rewards?.history || [])
    .filter((h) => h.time >= since && h.mode !== "dry" && mine(h.wallet || rewards.wallet))
    .reduce((a, h) => a + (Number(h.sol) || 0), 0);
  const pnl = back + claimed - spent;
  let best = null;
  for (const d of sold) {
    const p = (Number(d.receivedSol) || 0) - (Number(d.spentSol) || 0);
    if (!best || p > best.pnl) best = { ticker: d.ticker, pnl: p };
  }
  const unclaimed = !test && rewards && rewards.unclaimed != null && (scope === "all" || rewards.wallet === wallet) ? rewards.unclaimed : 0;
  return {
    pnl: +pnl.toFixed(9),
    roi: spent > 0 ? (pnl / spent) * 100 : null,
    spent: +spent.toFixed(9),
    back: +back.toFixed(9),
    rewards: +claimed.toFixed(9),
    unclaimed,
    launches: coins.length,
    sold: sold.length,
    holding: coins.filter((d) => !d.sold && d.holding !== 0).length,
    best,
  };
}
