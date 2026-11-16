// Copies the built Chrome extension into app/. The extension stays the one source of truth:
// the desktop app only adds a window, a tray icon and a small chrome.* layer around it.
import { cpSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
const src = new URL("../tweet2coin/extension/", import.meta.url);
const dst = new URL("./app/", import.meta.url);
if (!existsSync(src)) throw new Error("Build the extension first (tweet2coin: node build.mjs)");
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
cpSync(src, dst, { recursive: true, filter: (p) => !p.includes("/source") && !p.endsWith("README.md") });
writeFileSync(new URL("./background.html", dst), '<!doctype html><meta charset="utf-8"><title>Hatchr engine</title><script src="background.js"></script>\n');
console.log("synced extension into app/");
