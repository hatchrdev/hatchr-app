// Trading sites a launched coin can be opened in.
export const PLATFORMS = {
  axiom: { label: "Axiom", url: (m) => `https://axiom.trade/token/${m}?chain=sol` },
  pumpfun: { label: "pump.fun", url: (m) => `https://pump.fun/coin/${m}` },
  gmgn: { label: "GMGN", url: (m) => `https://gmgn.ai/sol/token/${m}` },
  bullx: { label: "BullX NEO", url: (m) => `https://neo.bullx.io/terminal?chainId=1399811149&address=${m}` },
  padre: { label: "Padre", url: (m) => `https://trade.padre.gg/trade/solana/${m}` },
  dexscreener: { label: "DEX Screener", url: (m) => `https://dexscreener.com/solana/${m}` },
};

export const platformOf = (id) => PLATFORMS[id] || PLATFORMS.axiom;
export const coinUrl = (id, mint) => platformOf(id).url(mint);
