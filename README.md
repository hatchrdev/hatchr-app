# Hatchr desktop

Hatchr turns breaking posts from Axiom's X tracker, X and public Telegram channels into pump.fun coins, by hand or automatically.

Website: **[hatchr.pro](https://hatchr.pro)** · [Privacy](https://hatchr.pro/#privacy)

**The main way to use Hatchr is the Chrome extension.** This repo is the desktop app: the same extension, unchanged, running in its own window, for people who would rather not use Chrome.

## Download

| System | File |
|---|---|
| Windows 10/11 (64-bit) | [Hatchr-Setup.exe](https://github.com/hatchrdev/hatchr-app/releases/latest/download/Hatchr-Setup.exe) · [portable zip](https://github.com/hatchrdev/hatchr-app/releases/latest/download/Hatchr-win.zip) |
| macOS 13 Ventura or newer (Apple Silicon and Intel) | [Hatchr-mac.dmg](https://github.com/hatchrdev/hatchr-app/releases/latest/download/Hatchr-mac.dmg) |
| Linux (64-bit) | [Hatchr-linux.AppImage](https://github.com/hatchrdev/hatchr-app/releases/latest/download/Hatchr-linux.AppImage) · [.deb](https://github.com/hatchrdev/hatchr-app/releases/latest/download/Hatchr-linux.deb) |

The app is not signed by Microsoft or Apple yet, so the first start needs one extra click:

- **Windows:** "Windows protected your PC" → *More info* → *Run anyway*.
- **macOS:** drag Hatchr to Applications and open it once. Then System Settings → Privacy & Security → *Open Anyway*.
- **Linux:** `chmod +x Hatchr-linux.AppImage` and run it, or `sudo apt install ./Hatchr-linux.deb`.

## How it works

- `app/` is the built Chrome extension, copied in by `sync.mjs`.
- `chrome-api.js` gives the extension the `chrome.*` calls it expects (storage, messages, alarms, notifications, tabs, offscreen) on top of Electron.
- `main.js` runs the extension's background worker in a hidden window, the panel in the main window, and Axiom and X in their own windows with the extension's content scripts.
- Settings, wallet and history are saved in the app's own data folder on your computer.

## Where the code lives

- `extension-src/` is the source of the Chrome extension: `src/` (code), `test/` (tests), `build.mjs`.
  Build and test it with `cd extension-src && npm ci && npm test`. The build lands in `extension-src/extension/`.
- `app/` is that build, committed so the desktop installers can be made without a build step. **Do not edit `app/` by
  hand.** Change `extension-src/src/`, then run `npm run build` there and `node sync.mjs` in the repo root, which
  replaces `app/` with the new build.
- `main.js`, `chrome-api.js`, `preload-*.js`, `desktop-callouts.js` are the desktop app around it.
- `docs/` is the hatchr.pro website.
- Bump the version in `extension-src/src/manifest.json`, `extension-src/package.json` and the root `package.json` together.

## Automatic callouts (3.6)

Two switches under **Settings → Callouts**, both off by default and both following TEST / LIVE:

- **Call out a coin right after I buy it myself.** Hatchr notices a buy by the Hatchr wallet (or the wallet entered on
  the Callouts tab) from pump.fun's stream, from a live subscription on your own RPC, or from a check of the wallet's
  latest transactions. Only a transaction your wallet signed and that added a pump.fun coin counts, so coins that are
  sent to you are never called.
- **Buy and call out automatically.** New pump.fun coins are measured against Hatchr's own filters (separate from
  Axiom's; an Axiom Pulse filter export can be imported), with a guard against copies. A coin that passes is bought
  for a small amount, the holding is checked, and the callout is posted. Hatchr never sells here.

Also there: your own callout texts, a delay and a minimum market cap before a callout goes out, an eye to hide coins
on the Callouts tab, and all of these settings in the backup.

Code: `extension-src/src/callout-filters.js` (filters, copy guard, Axiom import; pure logic), `callout-auto.js` (the
engine, running next to the background script, which hands it a fixed set of functions as `HatchrCore`) and
`callout-auto-ui.js` (settings form and status card). They are plain scripts like `callout-client.js`, so the
extension's service worker (`importScripts`), the side panel and the desktop app's `background.html` (see `sync.mjs`)
load the very same files. Tests: `extension-src/test/callout-auto/` (run by `npm test` there, against a stand-in
wallet, RPC, stream and callout API) and `tests/electron-callout-auto.cjs` (the real desktop app, offline).

## CA buy and pump alerts (3.7)

- **CA buy** (Settings → CA buy): when one of the X accounts you list posts a contract address, Hatchr buys it at
  once. The post is handed to `ca-buy.js` before anything else looks at it, and everything the buy needs is kept in
  memory, so between "post arrives" and "transaction sent" there are two network calls: PumpPortal builds the
  transaction (`pool: "auto"`), your RPC takes it. A coin that is not priced in SOL (paired with USDC or another
  pump.fun coin; PumpPortal answers 400) goes through Jupiter, whose price was asked at the same moment (3.7.1). For a coin still on the bonding curve PumpPortal answers 200 even
  when it is priced in another token, and that transaction fails on-chain (6063); so the curve's quote mint is read
  in parallel, and such a coin gets a dry run of PumpPortal's transaction next to Jupiter's build (3.7.2). Off by default, follows TEST / LIVE, each address is bought once.
- **Pump alerts** (Settings → Pump alerts): every 20 seconds the prices of the coins you hold are read (DexScreener,
  or the bonding curve on-chain for coins too new for it). A coin that is up X% since Hatchr started watching it, or
  up Y% within Z minutes, raises a desktop notification, a sound and, when set up, a message to your phone through
  your own Telegram bot. It only tells you; nothing is sold.

**Coins priced in another pump coin (3.9.2)**, `src/lib/hops.js`: pump.fun lets a coin be paired with another pump coin
($Daddy priced in $Huang, $Huang in SOL). PumpPortal and Jupiter cannot trade those with SOL; pump.fun's own
`multi_hop_swap` can, SOL → Huang → Daddy in one transaction. Built with pump.fun's official SDK
(`@pump-fun/pump-sdk` 4.1.0, MIT): the quote chain is read from each curve's quote mint, the route is priced with a dry
run on your RPC (slippage taken off that), and selling walks the chain back to SOL. Checked with real chain data.

**Trade tab (3.9)**: CA buy, Copy trade, Positions, Pump alerts and Auto callouts moved out of Settings into their
own tab (`trade-ui.js`, `callout-auto-ui.js`), each page in short sections whose fields only show when they apply
(`data-if` rules, the same language Settings now uses: `a`, `!a`, `a=x`, `a!=x`, `,` = and, `|` = or). The on/off
switches sit at the top of each page (`switches-ui.js`, read straight from storage).

**Automatic exits (3.9)**, `positions.js`: every buy by CA buy, the launch watch or copy trade opens a position with
that feature's exit rules (take profit in up to three steps, stop loss, trailing stop, market cap, time limit), all
measured from the price paid. Curve coins are priced from the bonding curve every 2 s (one `getMultipleAccounts`),
others from DexScreener every 6 s from a pinned pool, where a rule has to hold twice. TEST buys open paper
positions. Coins Hatchr called out are never sold automatically.

**Copy trade per wallet (3.9)**: each wallet has its own size, sell rule and exits, and can be followed for its buys,
only for the coins it creates (pump.fun `CreateEvent` in its transaction log), or both.

**⚡ Boost (3.9)**, `HatchrRoutes.feeEstimate`: Helius `getPriorityFeeEstimate` ("high") or the 75th percentile of
`getRecentPrioritizationFees` for the pump.fun program, × 150k compute units, between 0.0001 and 0.003 SOL, cached
30 s and refreshed in the background so a buy never waits for it.

**Lighter (3.9)**: the panel no longer polls every feature every 5 s (97 messages a minute idle on the Feed, now 1);
pages ask only while on screen; the Feed is redrawn only when seen; positions write prices every 10 s; the plain
background scripts are minified (readable copies in `source/`).

**Launch watch (3.8)**, part of CA buy: a post from a chosen account with a `$TICKER` and/or a picture but no
address starts a watch. Every new pump.fun coin from PumpPortal's stream (`HatchrCaBuy.onStream`, fed by
background.js) is matched against it: ticker (or name), and the picture by a 64-bit difference hash of both images
(`OffscreenCanvas`), optionally only from the account's dev wallet, which is learned when the account posts the
address of a coin made in the ten minutes before. One buy per post.

**Copy trade (3.8)**, `copytrade.js`: one `logsSubscribe` per followed wallet on your own RPC at "processed".
pump.fun `TradeEvent` and PumpSwap `BuyEvent` / `SellEvent` are decoded straight from the `Program data:` log lines
(layouts from pump.fun's public IDL); anything else is read with `getTransaction`. Buys and sells are built by
`trade-routes.js` (PumpPortal, or Jupiter when PumpPortal cannot), shared with CA buy.

Since 3.7.3 every tab has on/off switches at the top (`switches-ui.js`), and CA buy, auto callouts and pump alerts
run on their own switch: the Feed's "Watch posts" (the old main switch) only stops launching from posts. Axiom and
X tabs are read while either the Feed or CA buy wants posts. After an install or update the background puts the
page bridge back into open Axiom and X tabs (`reconnectTabs`); before, the tab in front was left disconnected until
it was reloaded by hand. The CA buy page shows whether the Axiom tab is connected and when each chosen account's last
post arrived, with a Reconnect button.

Code: `extension-src/src/ca-buy.js`, `pump-alerts.js` (also the phone messages, as `HatchrPush`) and `extras-ui.js`
(both settings pages). Plain scripts like the callout ones, loaded by the service worker, the side panel and the
desktop app's `background.html`. Tests: `extension-src/test/callout-auto/extras.test.js`.

## Direct Pump.fun callouts (3.5.9)

The callout composer posts directly through the Pump.fun API. In the extension,
sign in to Pump.fun in the same Chrome profile. In the desktop app, use its
**Pump.fun** button to sign in once inside Hatchr. The desktop session is separate
from Chrome and uses a sandboxed web window without access to Hatchr's wallet or
settings. Sending a callout does not open that window; only explicit login/view
links do. Pump.fun still enforces account eligibility and holding requirements.

Shared request and composer code lives in `extension-src/src/callout-*.js` (copied into `app/` by the build). The desktop engine
uses `desktop-callouts.js` through a restricted IPC method, and an in-memory
session store retains attempt markers if the engine reloads. No copied auth token
is required. Ambiguous responses are not automatically retried.

Run `npm test` for the request/transport tests. `npx electron
tests/electron-callouts.cjs --no-sandbox` runs an isolated, offline desktop smoke
test; it intercepts HTTPS and never posts a live callout. `tests/electron-callout-auto.cjs`
does the same for the automatic callouts.
On a Linux build machine without a desktop, run it under `xvfb-run -a`.

Pull requests build all desktop targets without publishing. Updating `main`
publishes the installers and an unpacked `Hatchr-extension.zip` together. The
website source is in `docs/`. The Chrome Web Store listing is a separate release
step; a GitHub release does not update it automatically.

## Build

```sh
npm ci
npm start            # run
npm run dist:win     # or dist:mac / dist:linux
```

Every push to `main` that changes the app builds Windows, macOS and Linux on GitHub Actions and puts the files on the release for the version in `package.json`. Bump `version` for a new release.
