# Hatchr desktop

Hatchr turns breaking posts from Axiom's X tracker, X and public Telegram channels into pump.fun coins, by hand or automatically.

Website: **[hatchr.pro](https://hatchr.pro)** · [Privacy](https://hatchr.pro/#privacy)

**The main way to use Hatchr is the Chrome extension.** This repo is the desktop app: the same extension, unchanged, running in its own window, for people who would rather not use Chrome.

## Download

| System | File |
|---|---|
| Windows 10/11 (64-bit) | [Hatchr-Setup.exe](https://github.com/sologgg/hatchr/releases/latest/download/Hatchr-Setup.exe) · [portable zip](https://github.com/sologgg/hatchr/releases/latest/download/Hatchr-win.zip) |
| macOS 13 Ventura or newer (Apple Silicon and Intel) | [Hatchr-mac.dmg](https://github.com/sologgg/hatchr/releases/latest/download/Hatchr-mac.dmg) |
| Linux (64-bit) | [Hatchr-linux.AppImage](https://github.com/sologgg/hatchr/releases/latest/download/Hatchr-linux.AppImage) · [.deb](https://github.com/sologgg/hatchr/releases/latest/download/Hatchr-linux.deb) |

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
