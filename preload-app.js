// Preload for Hatchr's own pages (panel, engine, helper): gives them window.chrome.
const { contextBridge, ipcRenderer } = require("electron");
const { buildChrome } = require("./chrome-api.js");

const engine = /\/background\.html$/.test(location.pathname);
// Chromium already has a small window.chrome, so expose ours under another name and swap it in
contextBridge.exposeInMainWorld("__hatchrChrome", buildChrome({ engine }));
const swap = () => { Object.defineProperty(window, "chrome", { value: window.__hatchrChrome, configurable: true, writable: true }); };
if (contextBridge.executeInMainWorld) contextBridge.executeInMainWorld({ func: swap });
else require("electron").webFrame.executeJavaScript(`(${swap})()`);

// The panel gets the app's own title bar: Axiom and X windows, Quit, and (Windows/Linux) the window buttons.
if (/\/sidepanel\.html$/.test(location.pathname)) {
  contextBridge.exposeInMainWorld("hatchrDesktop", { open: (what) => ipcRenderer.invoke("desktop:open", what) });
  const info = ipcRenderer.sendSync("win:info");
  const mac = info.platform === "darwin";
  const ICON = {
    ext: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4.5 2.5h5v5M9.5 2.5 3 9"/></svg>',
    quit: '<svg viewBox="0 0 12 12" aria-hidden="true"><path d="M6 1.5V6M3.4 3.2a4 4 0 1 0 5.2 0"/></svg>',
    min: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1 5.5h8"/></svg>',
    max: '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="1.5" width="7" height="7" rx="1"/></svg>',
    restore: '<svg viewBox="0 0 10 10" aria-hidden="true"><rect x="1.5" y="3" width="5.5" height="5.5" rx="1"/><path d="M3.5 3V2.5a1 1 0 0 1 1-1h3a1 1 0 0 1 1 1v3a1 1 0 0 1-1 1H7"/></svg>',
    close: '<svg viewBox="0 0 10 10" aria-hidden="true"><path d="M1.5 1.5l7 7M8.5 1.5l-7 7"/></svg>',
  };
  const css = `
    html.desktop, html.desktop body { height: 100%; overflow: hidden; }
    html.desktop #app { position: fixed; top: 40px; left: 0; right: 0; bottom: 0; overflow-y: auto; overflow-x: hidden; min-height: 0; }
    html.desktop .modal { top: 40px; }
    #titlebar { position: fixed; top: 0; left: 0; right: 0; height: 40px; z-index: 60; display: flex; align-items: center; gap: 6px;
      padding: 0 0 0 12px; background: #0a0b0d; border-bottom: 1px solid #1f2126; -webkit-app-region: drag; user-select: none; }
    html.mac #titlebar { padding-left: 84px; }
    #titlebar button { -webkit-app-region: no-drag; font: 600 12px/1 Inter, "Segoe UI", system-ui, sans-serif; color: #c9cbd1; }
    #titlebar svg { width: 11px; height: 11px; fill: none; stroke: currentColor; stroke-width: 1.4; stroke-linecap: round; stroke-linejoin: round; flex: none; }
    .tb-site { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 11px 0 10px; border-radius: 999px;
      border: 1px solid #26282e; background: #15161a; cursor: pointer; transition: border-color .15s, color .15s; }
    .tb-site svg { color: #6f727c; width: 10px; height: 10px; }
    .tb-site:hover { color: #f4f4f5; border-color: rgba(134, 239, 172, .5); }
    .tb-site:hover svg { color: #86efac; }
    .tb-label { font: 600 11px/1 Inter, "Segoe UI", system-ui, sans-serif; color: #6f727c; letter-spacing: .3px; margin-right: 2px; }
    .tb-fill { flex: 1; align-self: stretch; }
    .tb-quit { display: inline-flex; align-items: center; gap: 6px; height: 26px; padding: 0 11px; margin-right: 6px; border: 0; border-radius: 999px;
      background: transparent; color: #8e909b !important; cursor: pointer; transition: background .15s, color .15s; }
    .tb-quit:hover { background: rgba(248, 113, 113, .12); color: #f87171 !important; }
    .tb-win { display: flex; align-self: stretch; }
    .tb-win button { width: 46px; border: 0; background: transparent; display: grid; place-items: center; cursor: default; color: #c9cbd1; transition: background .12s; }
    .tb-win button svg { width: 10px; height: 10px; stroke-width: 1.1; }
    .tb-win button:hover { background: rgba(255, 255, 255, .08); color: #fff; }
    .tb-win button.close:hover { background: #e5484d; color: #fff; }
    html.mac .tb-win { display: none; }
    @media (max-width: 600px) {
      #titlebar { gap: 4px; padding-left: 8px; }
      .tb-label { display: none; }
      .tb-site { padding: 0 6px; gap: 4px; }
      .tb-quit { padding: 0 7px; margin-right: 2px; }
      .tb-win { flex: none; }
      .tb-win button { width: 32px; }
    }`;
  window.addEventListener("DOMContentLoaded", () => {
    document.documentElement.classList.add("desktop", mac ? "mac" : "win");
    const style = document.createElement("style");
    style.textContent = css;
    document.head.appendChild(style);
    const bar = document.createElement("div");
    bar.id = "titlebar";
    bar.innerHTML = `
      <span class="tb-label">OPEN</span>
      <button class="tb-site" data-open="axiom" title="Open Axiom in its own window">Axiom ${ICON.ext}</button>
      <button class="tb-site" data-open="x" title="Open X in its own window">X ${ICON.ext}</button>
      <button class="tb-site" data-open="pump" title="Sign in to pump.fun for direct callouts">Pump.fun ${ICON.ext}</button>
      <div class="tb-fill"></div>
      <button class="tb-quit" data-open="quit" title="Stop Hatchr completely. Closing the window keeps it running.">${ICON.quit} Quit</button>
      <div class="tb-win">
        <button data-win="min" aria-label="Minimize" title="Minimize">${ICON.min}</button>
        <button data-win="max" aria-label="Maximize" title="Maximize">${ICON.max}</button>
        <button data-win="close" class="close" aria-label="Close" title="Close (Hatchr keeps running)">${ICON.close}</button>
      </div>`;
    const setMax = (m) => {
      const b = bar.querySelector('[data-win="max"]');
      b.innerHTML = m ? ICON.restore : ICON.max;
      b.title = b.ariaLabel = m ? "Restore" : "Maximize";
    };
    setMax(info.maximized);
    ipcRenderer.on("win:state", (_e, st) => setMax(st.maximized));
    bar.addEventListener("click", (e) => {
      const o = e.target.closest("[data-open]");
      if (o) return ipcRenderer.invoke("desktop:open", o.dataset.open);
      const w = e.target.closest("[data-win]");
      if (w) ipcRenderer.send("win:control", w.dataset.win);
    });
    document.body.prepend(bar);
  });
}
