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

## Build

```sh
npm ci
npm start            # run
npm run dist:win     # or dist:mac / dist:linux
```

Every push to `main` that changes the app builds Windows, macOS and Linux on GitHub Actions and puts the files on the release for the version in `package.json`. Bump `version` for a new release.
