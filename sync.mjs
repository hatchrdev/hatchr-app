// Copies the built Chrome extension into app/. The extension stays the one source of truth:
// the desktop app only adds a window, a tray icon and a small chrome.* layer around it.
import { cpSync, rmSync, existsSync, writeFileSync, mkdirSync } from "node:fs";
const src = new URL("../tweet2coin/extension/", import.meta.url);
const dst = new URL("./app/", import.meta.url);
if (!existsSync(src)) throw new Error("Build the extension first (tweet2coin: node build.mjs)");
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
// p uses backslashes on Windows, so compare path parts, not the text
cpSync(src, dst, { recursive: true, filter: (p) => !p.split(/[\\/]/).includes("source") && !p.endsWith("README.md") });
const callouts = existsSync(new URL("./callout-client.js", dst)) ? '<script src="callout-client.js"></script>' : '';
writeFileSync(new URL("./background.html", dst), `<!doctype html><meta charset="utf-8"><title>Hatchr engine</title>${callouts}<script src="background.js"></script>\n`);
console.log("synced extension into app/");
