import { build } from "esbuild";
import { cpSync, mkdirSync, rmSync } from "node:fs";

const out = "extension";
rmSync(out, { recursive: true, force: true });
mkdirSync(`${out}/icons`, { recursive: true });

const common = {
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "chrome116",
  define: { global: "globalThis", "process.env.NODE_ENV": '"production"' },
  legalComments: "none",
  logLevel: "info",
};
// The background is a classic service worker: it loads the callout sender, a plain script shared with the desktop app, first.
// (The desktop app has no importScripts; its background.html loads the same file with a script tag.)
// callout-filters.js and callout-auto.js are the callout automode: plain scripts too, so the side panel (filters, for the Axiom
// import) and the desktop app can load the very same files.
const loadCallouts = 'if (typeof importScripts === "function") importScripts("callout-client.js", "callout-filters.js", "callout-auto.js");';
await build({ ...common, entryPoints: ["src/background.js"], outfile: `${out}/background.js`, minify: true, banner: { js: loadCallouts } });
await build({ ...common, entryPoints: ["src/sidepanel.js"], outfile: `${out}/sidepanel.js`, minify: true });
await build({ ...common, entryPoints: ["src/vanity-worker.js"], outfile: `${out}/vanity-worker.js`, minify: true });
await build({ ...common, entryPoints: ["src/splash-boot.js"], outfile: `${out}/splash.js`, minify: true });

for (const f of ["manifest.json", "sidepanel.html", "sidepanel.css", "content-x.js", "content-axiom.js", "content-axiom-main.js", "callout-client.js", "callout-dialog.js", "callout-locales.js", "callout-filters.js", "callout-auto.js", "callout-auto-ui.js", "offscreen.html", "offscreen.js", "README.md"]) cpSync(`src/${f}`, `${out}/${f}`);
cpSync("icons", `${out}/icons`, { recursive: true });

// readable source alongside the bundle
mkdirSync(`${out}/source/lib`, { recursive: true });
for (const f of ["background.js", "sidepanel.js", "vanity-worker.js", "splash-boot.js", "content-x.js", "content-axiom.js", "content-axiom-main.js", "callout-client.js", "callout-dialog.js", "callout-locales.js", "callout-filters.js", "callout-auto.js", "callout-auto-ui.js"]) cpSync(`src/${f}`, `${out}/source/${f}`);
cpSync("src/lib", `${out}/source/lib`, { recursive: true });
cpSync("src/i18n", `${out}/source/i18n`, { recursive: true });
cpSync("build.mjs", `${out}/source/build.mjs`);
