// Hatchr desktop: runs the Chrome extension's code in Electron.
// - app://hatchr/ serves the extension files
// - a hidden "engine" window runs background.js, a hidden helper runs offscreen.html
// - the panel window shows sidepanel.html
// - Axiom / X open in "site" windows with the extension's content scripts injected
const { app, BrowserWindow, ipcMain, protocol, net, session, shell, Tray, Menu, Notification, nativeImage, screen, dialog } = require("electron");
const { postCallout } = require("./desktop-callouts.js");
const path = require("node:path");
const fs = require("node:fs");
const { pathToFileURL } = require("node:url");

// The Windows installer (Squirrel) starts the app with these flags while installing, updating or
// removing it: make or remove the Desktop and Start menu shortcuts, then exit straight away.
if (process.platform === "win32" && /^--squirrel-/.test(process.argv[1] || "") && process.argv[1] !== "--squirrel-firstrun") {
  const flag = process.argv[1];
  const update = path.resolve(path.dirname(process.execPath), "..", "Update.exe");
  const exe = path.basename(process.execPath);
  const args = flag === "--squirrel-uninstall" ? [`--removeShortcut=${exe}`]
    : flag === "--squirrel-install" || flag === "--squirrel-updated" ? [`--createShortcut=${exe}`] : null;
  if (args) {
    try {
      require("node:child_process").spawn(update, args, { detached: true, stdio: "ignore" })
        .on("close", () => app.quit()).on("error", () => app.quit());
    } catch { app.quit(); }
    setTimeout(() => app.quit(), 8000);
  } else app.quit();
  return; // nothing else runs for an installer event
}

const APP_DIR = path.join(__dirname, "app");
const ORIGIN = "app://hatchr";
const SITE_HOSTS = /(^|\.)(axiom\.trade|x\.com|twitter\.com)$/i;

protocol.registerSchemesAsPrivileged([{ scheme: "app", privileges: { standard: true, secure: true, supportFetchAPI: true, corsEnabled: true, stream: true, allowServiceWorkers: false } }]);

if (!app.requestSingleInstanceLock()) { app.quit(); process.exit(0); }
// Windows matches notifications to the Start menu shortcut by this ID; the installer's shortcut uses Squirrel's form
const squirrelInstall = process.platform === "win32" && fs.existsSync(path.resolve(path.dirname(process.execPath), "..", "Update.exe"));
app.setAppUserModelId(squirrelInstall ? "com.squirrel.hatchr.Hatchr" : "com.hatchr.desktop");
// sites see a normal Chrome browser
app.userAgentFallback = app.userAgentFallback.replace(/ Electron\/\S+/, "").replace(/ hatchr(-desktop)?\/\S+/i, "");
app.commandLine.appendSwitch("disable-renderer-backgrounding");

// ---------------- storage (chrome.storage.local) ----------------
// One file holds everything, the wallet key included, so it is never replaced by something worse:
// - a file that exists but can't be read (antivirus, a backup tool) stops the start instead of starting empty;
// - a damaged file is kept under another name and the last good copy (.bak) is used;
// - every save is written to a temp file, flushed to disk and renamed over the old one.
let storeFile;
let store = {};
let saveTimer = null;
let dirty = false;
let saveFails = 0;
let lastBak = 0;
const BUSY = new Set(["EPERM", "EACCES", "EBUSY"]);
const sleepSync = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
/** Runs fn, trying again after each pause in `waits` while another program holds the file. */
function whileBusy(fn, waits) {
  for (let i = 0; ; i++) {
    try { return fn(); } catch (e) {
      if (!BUSY.has(e.code) || i >= waits.length) throw e;
      sleepSync(waits[i]);
    }
  }
}
const PATIENT = [25, 60, 120, 250, 500, 800];
const parseStore = (txt) => {
  const v = JSON.parse(txt);
  if (!v || typeof v !== "object" || Array.isArray(v)) throw new Error("not a settings object");
  return v;
};
/** The newest good data among the leftovers of an interrupted save (.tmp) and the last good copy (.bak). */
function recoverStore(newerThan = 0) {
  for (const f of [storeFile + ".tmp", storeFile + ".bak"]) {
    try {
      if (f.endsWith(".tmp") && fs.statSync(f).mtimeMs <= newerThan) continue; // an old leftover, the main file is newer
      return parseStore(whileBusy(() => fs.readFileSync(f, "utf8"), PATIENT));
    } catch { /* try the next one */ }
  }
  return null;
}
/** false = the data file exists but can't be read right now; the caller must not go on (and never save over it). */
function loadStore() {
  storeFile = path.join(app.getPath("userData"), "storage.json");
  let txt, mtime = 0;
  try {
    txt = whileBusy(() => fs.readFileSync(storeFile, "utf8"), PATIENT);
    mtime = fs.statSync(storeFile).mtimeMs;
  } catch (e) {
    if (e.code !== "ENOENT") {
      dialog.showErrorBox("Hatchr can't read its data file", `Another program is holding this file:\n${storeFile}\n(${e.code || e.message})\n\nNothing was changed. Close backup or antivirus scans that may be using it and start Hatchr again.`);
      return false;
    }
  }
  if (txt === undefined) { store = recoverStore() || {}; return true; } // first start, or the main file went missing
  try { store = parseStore(txt); } catch {
    try { fs.renameSync(storeFile, `${storeFile}.corrupt-${Date.now()}`); } catch { /* it stays where it is; the next save replaces it */ }
    store = recoverStore() || {};
    return true;
  }
  // a save that was written but could not be moved into place last time is newer than the main file
  try { if (fs.statSync(storeFile + ".tmp").mtimeMs > mtime) store = recoverStore(mtime) || store; } catch { /* no leftover */ }
  try { fs.copyFileSync(storeFile, storeFile + ".bak"); lastBak = Date.now(); } catch { /* best effort */ }
  return true;
}
function writeStore(waits) {
  const tmp = storeFile + ".tmp";
  const fd = fs.openSync(tmp, "w");
  try { fs.writeSync(fd, JSON.stringify(store)); fs.fsyncSync(fd); } finally { fs.closeSync(fd); }
  // the file being replaced is a complete earlier save: keep it as the fallback copy now and then
  if (Date.now() - lastBak > 60_000) { try { fs.copyFileSync(storeFile, storeFile + ".bak"); lastBak = Date.now(); } catch { /* none yet, or busy */ } }
  whileBusy(() => fs.renameSync(tmp, storeFile), waits);
  dirty = false;
  saveFails = 0;
}
function saveSoon(ms) {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    try { writeStore([15, 40, 80]); } catch (e) {
      // another program has the file open: the change stays in memory (and in the temp file) and is tried again
      saveFails++;
      if (saveFails === 1 || saveFails % 20 === 0) console.error("[hatchr] could not save yet:", e.code || e.message);
      saveSoon(Math.min(5000, 400 * saveFails));
    }
  }, ms);
}
function saveStore() { dirty = true; saveSoon(250); }
function flushStore() {
  if (!storeFile || !dirty) return;
  clearTimeout(saveTimer);
  try { writeStore(PATIENT); } catch (e) { console.error("[hatchr] could not save on exit:", e.code || e.message); }
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
// Who is asking. Hatchr's own pages (panel, engine, helper) get everything. Axiom and X windows run other people's
// pages next to our page scripts, so they only get what those scripts need: never the wallet, the keys or the app controls.
const isApp = (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  return !!w && [engineWin, helperWin, panelWin].includes(w) && String(e.senderFrame?.url || "").startsWith(ORIGIN + "/");
};
const SITE_KEYS = new Set(["settings", "xShare"]);
const SECRET_FIELD = /(key|jwt|token|secret|password)$|^rpcUrl$/i;
const forSite = (k, v) => {
  if (k !== "settings" || !v || typeof v !== "object") return v;
  const out = {};
  for (const [f, val] of Object.entries(v)) if (!SECRET_FIELD.test(f)) out[f] = val;
  return out;
};
const siteView = (obj) => {
  const out = {};
  for (const [k, v] of Object.entries(obj)) if (SITE_KEYS.has(k)) out[k] = forSite(k, v);
  return out;
};
const SITE_MESSAGES = new Set(["hello", "post", "pulse", "axiomStatus"]);
const appOnly = (fn, fallback) => (e, ...a) => (isApp(e) ? fn(e, ...a) : fallback);
function broadcastChanges(changes) {
  if (!Object.keys(changes).length) return;
  const site = {};
  for (const [k, c] of Object.entries(changes)) {
    if (!SITE_KEYS.has(k)) continue;
    site[k] = {};
    if ("oldValue" in c) site[k].oldValue = forSite(k, c.oldValue);
    if ("newValue" in c) site[k].newValue = forSite(k, c.newValue);
  }
  for (const w of BrowserWindow.getAllWindows()) {
    if (w.isDestroyed()) continue;
    if ([engineWin, helperWin, panelWin].includes(w)) w.webContents.send("storage:changed", changes, "local");
    else if (w !== splashWin && Object.keys(site).length) w.webContents.send("storage:changed", site, "local");
  }
}
ipcMain.handle("storage:get", (e, keys) => {
  const out = {};
  if (!isApp(e)) {
    const all = siteView(store);
    if (keys == null) return clone(all);
    if (typeof keys === "string") keys = [keys];
    if (Array.isArray(keys)) { for (const k of keys) if (k in all) out[k] = clone(all[k]); return out; }
    for (const [k, def] of Object.entries(keys)) out[k] = k in all ? clone(all[k]) : def;
    return out;
  }
  if (keys == null) return clone(store);
  if (typeof keys === "string") keys = [keys];
  if (Array.isArray(keys)) { for (const k of keys) if (k in store) out[k] = clone(store[k]); return out; }
  for (const [k, def] of Object.entries(keys)) out[k] = k in store ? clone(store[k]) : def;
  return out;
});
ipcMain.handle("storage:set", (e, items) => {
  if (!isApp(e)) return; // page scripts only read
  const changes = {};
  for (const [k, v] of Object.entries(items || {})) {
    // like Chrome: a value that did not change is not reported, and a new key has no oldValue
    if (k in store && JSON.stringify(store[k]) === JSON.stringify(v)) continue;
    changes[k] = k in store ? { oldValue: store[k], newValue: v } : { newValue: v };
    store[k] = v;
  }
  if (!Object.keys(changes).length) return;
  saveStore();
  broadcastChanges(changes);
});
ipcMain.handle("storage:remove", (e, keys) => {
  const app_ = isApp(e);
  const changes = {};
  for (const k of [].concat(keys)) {
    if (!app_ && k !== "xShare") continue; // the X page script clears the share it just used, nothing else
    if (k in store) { changes[k] = { oldValue: store[k] }; delete store[k]; }
  }
  if (!Object.keys(changes).length) return;
  saveStore();
  broadcastChanges(changes);
});

// Ephemeral storage survives an engine reload and disappears when Hatchr quits,
// matching chrome.storage.session. Remote site windows cannot access it.
const sessionStore = new Map();
ipcMain.handle("session:get", appOnly((_e, keys) => {
  if (keys == null) return clone(Object.fromEntries(sessionStore));
  if (typeof keys === "string") keys = [keys];
  if (Array.isArray(keys)) return clone(Object.fromEntries(keys.filter(k => sessionStore.has(k)).map(k => [k, sessionStore.get(k)])));
  return clone(Object.fromEntries(Object.entries(keys).map(([k, value]) => [k, sessionStore.has(k) ? sessionStore.get(k) : value])));
}, {}));
ipcMain.handle("session:set", appOnly((_e, items) => {
  for (const [key, value] of Object.entries(items || {})) sessionStore.set(key, clone(value));
}));
ipcMain.handle("session:remove", appOnly((_e, keys) => {
  for (const key of [].concat(keys)) sessionStore.delete(key);
}));
ipcMain.handle("callout:post", (e, payload) => {
  if (!isApp(e) || e.sender !== engineWin?.webContents || e.senderFrame?.url !== `${ORIGIN}/background.html`) {
    throw new Error("Callouts can only be sent by the Hatchr engine");
  }
  return postCallout(session.defaultSession, payload);
});

// ---------------- messages (chrome.runtime.sendMessage) ----------------
const pending = new Map();
let msgSeq = 0;
const internalWindows = () => [engineWin, helperWin, panelWin].filter((w) => w && !w.isDestroyed());
ipcMain.handle("rt:send", (e, msg) => {
  const from = BrowserWindow.fromWebContents(e.sender);
  const site = !isApp(e);
  if (site && !SITE_MESSAGES.has(msg && msg.type)) return { error: "Could not establish connection. Receiving end does not exist." };
  const sender = site ? { tab: { id: from ? from.id : -1, url: e.sender.getURL() }, url: e.sender.getURL() } : { id: "hatchr-desktop", url: e.senderFrame?.url || e.sender.getURL() };
  const targets = internalWindows().filter((w) => w.webContents !== e.sender);
  if (!targets.length) return { error: "Could not establish connection. Receiving end does not exist." };
  const id = ++msgSeq;
  return new Promise((resolve) => {
    const state = { left: targets.length, listeners: 0, done: false, resolve };
    pending.set(id, state);
    for (const w of targets) w.webContents.send("rt:deliver", id, msg, sender);
    state.timer = setTimeout(() => finish(id, { error: "Message timed out" }), 5 * 60_000);
  });
});
function finish(id, result) {
  const st = pending.get(id);
  if (!st || st.done) return;
  st.done = true;
  clearTimeout(st.timer);
  pending.delete(id);
  st.resolve(result);
}
// each window answers: { listeners, handled, response }
ipcMain.on("rt:reply", (_e, id, r) => {
  const st = pending.get(id);
  if (!st) return;
  if (r.handled) return finish(id, { response: r.response });
  st.listeners += r.listeners || 0;
  if (--st.left === 0) finish(id, st.listeners ? { response: undefined } : { error: "Could not establish connection. Receiving end does not exist." });
});

// ---------------- windows ----------------
let engineWin = null, helperWin = null, panelWin = null, splashWin = null, tray = null, quitting = false;
const isMac = process.platform === "darwin";
const siteWindows = new Map(); // id -> { win, pinned }
const icon = () => nativeImage.createFromPath(path.join(APP_DIR, "icons", "icon128.png"));
const appPrefs = (extra = {}) => ({
  preload: path.join(__dirname, "preload-app.js"),
  contextIsolation: true,
  nodeIntegration: false,
  sandbox: false,
  webSecurity: false, // like an extension's host permissions: our own pages may call the APIs directly
  backgroundThrottling: false,
  ...extra,
});

// Hatchr's own windows only ever show Hatchr's own pages: anything else would inherit their access to the wallet.
function stayHome(win) {
  const guard = (e, url) => { if (!String(url).startsWith(ORIGIN + "/")) e.preventDefault(); };
  win.webContents.on("will-navigate", guard);
  win.webContents.on("will-redirect", guard);
  win.webContents.on("will-attach-webview", (e) => e.preventDefault());
}
// links leave the app only as ordinary web or mail links, never as a file or another program's link type
function openOutside(url) {
  try { if (/^(https?|mailto):$/.test(new URL(url).protocol)) return shell.openExternal(url); } catch { /* not a link */ }
}

function createEngine() {
  engineWin = new BrowserWindow({ show: false, webPreferences: appPrefs() });
  const win = engineWin;
  stayHome(win);
  win.loadURL(`${ORIGIN}/background.html`);
  // if the engine's page crashes, close it: "closed" then starts a fresh one, so auto mode doesn't stop silently
  win.webContents.on("render-process-gone", () => { if (!quitting && !win.isDestroyed()) win.destroy(); });
  win.on("closed", () => { if (engineWin === win) engineWin = null; if (!quitting) setTimeout(() => { if (!engineWin) createEngine(); }, 1000); });
}

function createHelper(url) {
  if (helperWin && !helperWin.isDestroyed()) return;
  helperWin = new BrowserWindow({ show: false, webPreferences: appPrefs({ autoplayPolicy: "no-user-gesture-required" }) });
  const win = helperWin;
  stayHome(win);
  win.loadURL(`${ORIGIN}/${String(url || "offscreen.html").replace(/^\//, "")}`);
  win.webContents.on("render-process-gone", () => { if (!win.isDestroyed()) win.destroy(); }); // made again when it is next needed
  win.on("closed", () => { if (helperWin === win) helperWin = null; });
}
ipcMain.handle("offscreen:create", appOnly((_e, url) => createHelper(url)));
ipcMain.handle("offscreen:exists", () => !!(helperWin && !helperWin.isDestroyed()));

// The start-up splash: the egg hatching, while the app loads behind it
function createSplash() {
  splashWin = new BrowserWindow({
    width: 320, height: 340, frame: false, transparent: true, resizable: false, movable: true,
    skipTaskbar: true, show: false, center: true, hasShadow: false, icon: icon(),
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true },
  });
  splashWin.loadFile(path.join(__dirname, "ui", "splash.html"));
  splashWin.once("ready-to-show", () => splashWin && splashWin.show());
  splashWin.on("closed", () => { splashWin = null; });
  return Date.now();
}
function closeSplash() {
  if (!splashWin || splashWin.isDestroyed()) return;
  const w = splashWin;
  let o = 1;
  const t = setInterval(() => { o -= 0.12; if (w.isDestroyed()) return clearInterval(t); if (o <= 0) { clearInterval(t); w.destroy(); } else w.setOpacity(o); }, 16);
}

// a squarish app window that remembers where you left it
function savedBounds() {
  const b = store.__desktopBounds;
  if (!b || !(b.width > 300 && b.height > 300)) return null;
  const area = screen.getDisplayMatching(b).workArea;
  const visible = b.x < area.x + area.width - 80 && b.x + b.width > area.x + 80 && b.y >= area.y - 10 && b.y < area.y + area.height - 80;
  const fit = { width: Math.min(b.width, area.width), height: Math.min(b.height, area.height) };
  return visible ? { ...b, ...fit } : fit;
}
function rememberBounds() {
  if (!panelWin || panelWin.isDestroyed() || panelWin.isMinimized() || panelWin.isFullScreen()) return;
  store.__desktopBounds = { ...panelWin.getNormalBounds(), maximized: panelWin.isMaximized() };
  saveStore();
}

function createPanel({ showWhenReady = true, splashAt = 0 } = {}) {
  const b = savedBounds();
  panelWin = new BrowserWindow({
    width: 1040, height: 760, minWidth: 420, minHeight: 560, ...(b ? { x: b.x, y: b.y, width: b.width, height: b.height } : {}),
    title: "Hatchr", icon: icon(), backgroundColor: "#0e0f12", show: false,
    // our own title bar: no system frame on Windows/Linux, the Mac keeps its traffic lights
    frame: isMac, titleBarStyle: isMac ? "hiddenInset" : "default", trafficLightPosition: { x: 14, y: 13 },
    webPreferences: appPrefs(),
  });
  stayHome(panelWin);
  panelWin.loadURL(`${ORIGIN}/sidepanel.html`);
  panelWin.webContents.on("render-process-gone", () => { if (!quitting && panelWin && !panelWin.isDestroyed()) panelWin.webContents.reload(); });
  panelWin.on("session-end", flushStore); // Windows shutting down or logging off
  panelWin.once("ready-to-show", () => {
    if (!showWhenReady) return;
    // let the egg finish hatching, then swap to the app
    setTimeout(() => {
      if (panelWin) { if (store.__desktopBounds?.maximized) panelWin.maximize(); panelWin.show(); panelWin.focus(); }
      closeSplash();
    }, Math.max(0, 1750 - (Date.now() - splashAt)));
  });
  panelWin.webContents.setWindowOpenHandler(({ url }) => { openUrl(url, true); return { action: "deny" }; });
  panelWin.on("close", (e) => { rememberBounds(); if (!quitting) { e.preventDefault(); panelWin.hide(); } });
  panelWin.on("closed", () => { panelWin = null; });
  let moveTimer;
  for (const ev of ["resize", "move"]) panelWin.on(ev, () => { clearTimeout(moveTimer); moveTimer = setTimeout(rememberBounds, 400); });
  for (const ev of ["maximize", "unmaximize", "enter-full-screen", "leave-full-screen"]) {
    panelWin.on(ev, () => { panelWin.webContents.send("win:state", { maximized: panelWin.isMaximized() || panelWin.isFullScreen() }); rememberBounds(); });
  }
}
// title bar buttons in the panel
ipcMain.on("win:control", (e, action) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  if (!w || !isApp(e)) return;
  if (action === "min") w.minimize();
  else if (action === "max") w.isMaximized() ? w.unmaximize() : w.maximize();
  else if (action === "close") w.close();
});
ipcMain.on("win:info", (e) => {
  const w = BrowserWindow.fromWebContents(e.sender);
  e.returnValue = { platform: process.platform, maximized: !!(w && w.isMaximized()), version: app.getVersion() };
});
function showPanel() {
  if (!panelWin) createPanel();
  else { panelWin.show(); panelWin.focus(); }
}

function createSite(url, { active = true, pinned = false } = {}) {
  const win = new BrowserWindow({
    width: 1280, height: 860, title: "Hatchr", icon: icon(), autoHideMenuBar: true, show: false,
    webPreferences: { preload: path.join(__dirname, "preload-site.js"), contextIsolation: true, nodeIntegration: false, sandbox: false, backgroundThrottling: false },
  });
  siteWindows.set(win.id, { win, pinned, url });
  win.loadURL(url);
  win.once("ready-to-show", () => { if (active) { win.show(); win.focus(); } else { win.showInactive(); win.minimize(); } });
  win.webContents.setWindowOpenHandler(({ url: u }) => {
    let host = "";
    try { host = new URL(u).hostname; } catch {}
    if (SITE_HOSTS.test(host)) return { action: "allow" }; // sign-in popups etc. stay in the app
    openOutside(u);
    return { action: "deny" };
  });
  win.on("closed", () => siteWindows.delete(win.id));
  return win;
}

// Pump.fun login lives in the app's own cookie session. These are ordinary,
// sandboxed web pages: no preload, Chrome bridge, wallet keys, or Node access.
let pumpWin = null;
function guardPumpWindow(win) {
  const guard = (event, url) => {
    try { if (new URL(url).protocol === "https:") return; } catch {}
    event.preventDefault();
  };
  win.webContents.on("will-navigate", guard);
  win.webContents.on("will-redirect", guard);
  win.webContents.on("will-attach-webview", event => event.preventDefault());
  win.webContents.setWindowOpenHandler(({ url }) => {
    try {
      if (new URL(url).protocol === "https:") return {
        action: "allow",
        overrideBrowserWindowOptions: { webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true } }
      };
    } catch {}
    return { action: "deny" };
  });
  win.webContents.on("did-create-window", child => guardPumpWindow(child));
}
function openPump(url = "https://pump.fun") {
  if (pumpWin && !pumpWin.isDestroyed()) {
    if (pumpWin.isMinimized()) pumpWin.restore();
    if (pumpWin.webContents.getURL() !== url) pumpWin.loadURL(url);
    pumpWin.show(); pumpWin.focus();
    return pumpWin;
  }
  pumpWin = new BrowserWindow({
    width: 1100, height: 800, title: "Pump.fun — Hatchr", icon: icon(), autoHideMenuBar: true,
    webPreferences: { contextIsolation: true, nodeIntegration: false, sandbox: true, webSecurity: true }
  });
  guardPumpWindow(pumpWin);
  pumpWin.on("closed", () => { pumpWin = null; });
  pumpWin.loadURL(url);
  return pumpWin;
}
function openUrl(url, active = true, pinned = false) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol === "chrome:") return null;
  if (u.protocol === "https:" && u.hostname === "pump.fun") return openPump(url);
  if (/^https:$/.test(u.protocol) && SITE_HOSTS.test(u.hostname)) return createSite(url, { active, pinned });
  openOutside(url);
  return null;
}
function openSite(url) {
  const host = new URL(url).hostname;
  for (const { win } of siteWindows.values()) {
    let h = "";
    try { h = new URL(win.webContents.getURL() || siteWindows.get(win.id).url).hostname; } catch {}
    if (!win.isDestroyed() && h === host) { if (win.isMinimized()) win.restore(); win.show(); win.focus(); return; }
  }
  createSite(url);
}
ipcMain.handle("desktop:open", appOnly((_e, what) => {
  if (what === "axiom") openSite("https://axiom.trade/pulse");
  else if (what === "x") openSite("https://x.com/home");
  else if (what === "pump") openPump();
  else if (what === "quit") { quitting = true; app.quit(); }
}));

// ---------------- tabs ----------------
const matchUrl = (url, patterns) => [].concat(patterns || []).some((p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(url));
ipcMain.handle("tabs:query", (_e, q = {}) => {
  const focused = BrowserWindow.getFocusedWindow();
  return [...siteWindows.values()].filter(({ win }) => !win.isDestroyed()).map(({ win, pinned, url }) => ({
    id: win.id, windowId: win.id, url: win.webContents.getURL() || url, title: win.getTitle(),
    active: focused === win, pinned, discarded: false, status: win.webContents.isLoading() ? "loading" : "complete",
  })).filter((t) => !q.url || matchUrl(t.url, q.url));
});
ipcMain.handle("tabs:create", appOnly((_e, o = {}) => {
  const w = openUrl(o.url, o.active !== false, !!o.pinned);
  return w ? { id: w.id, url: o.url, active: o.active !== false } : { id: -1, url: o.url };
}, { id: -1 }));
ipcMain.handle("tabs:reload", appOnly((_e, id) => { const s = siteWindows.get(id); if (s && !s.win.isDestroyed()) s.win.webContents.reload(); }));
// The engine marks site windows "keep awake" while Hatchr is watching and releases them when it is switched off:
// a released window is throttled in the background like any other, so it stops costing processor time.
ipcMain.handle("tabs:update", appOnly((_e, id, o = {}) => {
  const s = siteWindows.get(id);
  if (s && !s.win.isDestroyed() && typeof o.autoDiscardable === "boolean") s.win.webContents.setBackgroundThrottling(o.autoDiscardable);
}));

// ---------------- notifications, badge, startup info ----------------
ipcMain.handle("notify", appOnly((_e, title, body) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: icon() });
  n.on("click", showPanel);
  n.show();
}));
// the extension's toolbar tooltip ("Hatchr · paused" …) becomes the window title and tray tooltip
ipcMain.handle("title", appOnly((_e, title) => {
  const t = String(title || "Hatchr");
  if (tray) tray.setToolTip(t);
  if (panelWin && !panelWin.isDestroyed()) panelWin.setTitle(t);
}));
let launchInfo = null;
ipcMain.handle("launch-info", appOnly(() => {
  if (launchInfo) return { reason: null };
  const last = store.__desktopVersion;
  launchInfo = last == null ? "install" : last !== app.getVersion() ? "update" : null;
  store.__desktopVersion = app.getVersion();
  saveStore();
  return { reason: launchInfo };
}, { reason: null }));
ipcMain.on("manifest", (e) => {
  try { e.returnValue = JSON.parse(fs.readFileSync(path.join(APP_DIR, "manifest.json"), "utf8")); } catch { e.returnValue = { version: app.getVersion() }; }
});
ipcMain.on("content-script", (e, name) => {
  // only the extension's own page scripts, by plain file name: no paths
  if (!/^content-[\w-]+\.js$/.test(String(name))) { e.returnValue = ""; return; }
  try { e.returnValue = fs.readFileSync(path.join(APP_DIR, name), "utf8"); } catch { e.returnValue = ""; }
});

// ---------------- tray ----------------
function createTray() {
  tray = new Tray(nativeImage.createFromPath(path.join(APP_DIR, "icons", "icon32.png")));
  tray.setToolTip("Hatchr");
  tray.setContextMenu(Menu.buildFromTemplate([
    { label: "Show Hatchr", click: showPanel },
    { label: "Open Axiom", click: () => openSite("https://axiom.trade/pulse") },
    { label: "Open X", click: () => openSite("https://x.com/home") },
    { type: "separator" },
    { label: `Hatchr ${app.getVersion()} · get the latest`, click: () => openOutside("https://hatchr.pro/#desktop") },
    { type: "separator" },
    { label: "Quit Hatchr", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", showPanel);
}

// the self-test is a developer tool: it never runs in an installed copy
const SELFTEST = !app.isPackaged && process.env.HATCHR_SELFTEST;
if (SELFTEST) {
  app.on("web-contents-created", (_e, wc) => {
    wc.on("console-message", (ev) => console.log(`[${(wc.getURL() || "").split("/").pop()}]`, ev.level || "", ev.message));
    wc.on("preload-error", (_ev, p, err) => console.log("[preload-error]", p, err));
  });
}

app.on("second-instance", showPanel);
app.on("before-quit", () => { quitting = true; flushStore(); });
app.on("window-all-closed", () => { /* keep running in the tray */ });
app.on("activate", showPanel);

app.whenReady().then(() => {
  // Show the hatching splash first thing, before the heavier setup, so it appears instantly.
  const splashAt = SELFTEST ? 0 : createSplash();
  if (!loadStore()) { storeFile = null; app.exit(1); return; } // unreadable data file: stop, and never write over it
  if (store.__desktopVersion == null) store.onboardSeen = true; // the Chrome-only "keep Axiom running" tip doesn't apply here
  protocol.handle("app", (req) => {
    let file;
    try { file = path.normalize(path.join(APP_DIR, decodeURIComponent(new URL(req.url).pathname))); } catch { return new Response("Not found", { status: 404 }); }
    const rel = path.relative(APP_DIR, file);
    if (!rel || rel.startsWith("..") || path.isAbsolute(rel)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  // macOS needs the app and Edit menus for Cmd+Q and copy/paste; Windows and Linux need none
  Menu.setApplicationMenu(process.platform === "darwin"
    ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
    : null);
  createTray();
  createEngine();
  createPanel({ splashAt });
  if (SELFTEST) return require("./selftest.js")(() => panelWin);
  // first run: open Axiom so you can log in
  if (!store.__desktopAxiomOpened) {
    store.__desktopAxiomOpened = true;
    saveStore();
    setTimeout(() => openSite("https://axiom.trade/pulse"), 1500);
  }
});
