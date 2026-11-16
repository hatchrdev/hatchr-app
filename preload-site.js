// Preload for the Axiom / X windows: runs the extension's content scripts, like Chrome would.
const { ipcRenderer, webFrame } = require("electron");
const { buildChrome } = require("./chrome-api.js");

const host = location.hostname;
const chrome = buildChrome();
const runIsolated = (name) => {
  const code = ipcRenderer.sendSync("content-script", name);
  if (!code) return;
  try { new Function("chrome", code)(chrome); } catch (err) { console.error("[hatchr]", name, err); }
};

if (/(^|\.)axiom\.trade$/.test(host)) {
  // page-world script first (hooks the WebSocket before Axiom's own code runs), then the bridge
  const main = ipcRenderer.sendSync("content-script", "content-axiom-main.js");
  if (main) webFrame.executeJavaScript(main).catch((err) => console.error("[hatchr] axiom main", err));
  runIsolated("content-axiom.js");
}
if (/(^|\.)(x\.com|twitter\.com)$/.test(host)) {
  const go = () => runIsolated("content-x.js");
  if (document.readyState === "loading") window.addEventListener("DOMContentLoaded", go, { once: true });
  else go();
}
