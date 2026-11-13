// Copies the built Chrome extension into app/. The extension stays the one source of truth:
// its source is in extension-src/ (build it there with `npm run build`), and the desktop app only adds a window,
// a tray icon and a small chrome.* layer around that build. Do not edit files in app/ by hand: this script replaces them.
import { cpSync, rmSync, existsSync, writeFileSync, mkdirSync, readdirSync } from "node:fs";
const src = new URL("./extension-src/extension/", import.meta.url);
const tests = new URL("./extension-src/test/app/", import.meta.url);
const dst = new URL("./app/", import.meta.url);
if (!existsSync(src)) throw new Error("Build the extension first: cd extension-src && npm ci && npm run build");
rmSync(dst, { recursive: true, force: true });
mkdirSync(dst, { recursive: true });
// p uses backslashes on Windows, so compare path parts, not the text
cpSync(src, dst, { recursive: true, filter: (p) => !p.split(/[\\/]/).includes("source") && !p.endsWith("README.md") });
const callouts = existsSync(new URL("./callout-client.js", dst)) ? '<script src="callout-client.js"></script>' : '';
writeFileSync(new URL("./background.html", dst), `<!doctype html><meta charset="utf-8"><title>Hatchr engine</title>${callouts}<script src="background.js"></script>\n`);
// the tests that check the shipped files (run by `npm test` here and in the release workflow)
mkdirSync(new URL("./tests/", dst), { recursive: true });
for (const f of readdirSync(tests)) cpSync(new URL(f, tests), new URL(`./tests/${f}`, dst));
console.log("synced extension into app/");
