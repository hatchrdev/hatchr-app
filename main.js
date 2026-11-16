// Hatchr desktop: runs the Chrome extension's code in Electron.
// - app://hatchr/ serves the extension files
// - a hidden "engine" window runs background.js, a hidden helper runs offscreen.html
// - the panel window shows sidepanel.html
// - Axiom / X open in "site" windows with the extension's content scripts injected
const { app, BrowserWindow, ipcMain, protocol, net, shell, Tray, Menu, Notification, nativeImage, screen } = require("electron");
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
let storeFile;
let store = {};
let saveTimer = null;
function loadStore() {
  storeFile = path.join(app.getPath("userData"), "storage.json");
  try { store = JSON.parse(fs.readFileSync(storeFile, "utf8")); } catch { store = {}; }
}
function saveStore() {
  clearTimeout(saveTimer);
  saveTimer = setTimeout(() => {
    const tmp = storeFile + ".tmp";
    fs.writeFileSync(tmp, JSON.stringify(store));
    fs.renameSync(tmp, storeFile);
  }, 250);
}
function flushStore() {
  if (!storeFile) return;
  clearTimeout(saveTimer);
  try { fs.writeFileSync(storeFile, JSON.stringify(store)); } catch {}
}
const clone = (v) => (v === undefined ? undefined : JSON.parse(JSON.stringify(v)));
function broadcast(channel, ...args) {
  for (const w of BrowserWindow.getAllWindows()) if (!w.isDestroyed()) w.webContents.send(channel, ...args);
}
ipcMain.handle("storage:get", (_e, keys) => {
  const out = {};
  if (keys == null) return clone(store);
  if (typeof keys === "string") keys = [keys];
  if (Array.isArray(keys)) { for (const k of keys) if (k in store) out[k] = clone(store[k]); return out; }
  for (const [k, def] of Object.entries(keys)) out[k] = k in store ? clone(store[k]) : def;
  return out;
});
ipcMain.handle("storage:set", (_e, items) => {
  const changes = {};
  for (const [k, v] of Object.entries(items || {})) {
    changes[k] = { oldValue: store[k], newValue: v };
    store[k] = v;
  }
  saveStore();
  broadcast("storage:changed", changes, "local");
});
ipcMain.handle("storage:remove", (_e, keys) => {
  const changes = {};
  for (const k of [].concat(keys)) if (k in store) { changes[k] = { oldValue: store[k] }; delete store[k]; }
  saveStore();
  broadcast("storage:changed", changes, "local");
});

// ---------------- messages (chrome.runtime.sendMessage) ----------------
const pending = new Map();
let msgSeq = 0;
const internalWindows = () => [engineWin, helperWin, panelWin].filter((w) => w && !w.isDestroyed());
ipcMain.handle("rt:send", (e, msg) => {
  const from = BrowserWindow.fromWebContents(e.sender);
  const site = siteWindows.has(from?.id);
  const sender = site ? { tab: { id: from.id, url: e.sender.getURL() }, url: e.sender.getURL() } : { id: "hatchr", url: e.sender.getURL() };
  const targets = internalWindows().filter((w) => w.webContents !== e.sender);
  if (!targets.length) return { error: "Could not establish connection. Receiving end does not exist." };
  const id = ++msgSeq;
  return new Promise((resolve) => {
    const state = { left: targets.length, listeners: 0, done: false, resolve };
    pending.set(id, state);
    for (const w of targets) w.webContents.send("rt:deliver", id, msg, sender);
    setTimeout(() => finish(id, { error: "Message timed out" }), 5 * 60_000);
  });
});
function finish(id, result) {
  const st = pending.get(id);
  if (!st || st.done) return;
  st.done = true;
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

function createEngine() {
  engineWin = new BrowserWindow({ show: false, webPreferences: appPrefs() });
  engineWin.loadURL(`${ORIGIN}/background.html`);
  engineWin.on("closed", () => { engineWin = null; if (!quitting) setTimeout(createEngine, 1000); });
}

function createHelper(url) {
  if (helperWin && !helperWin.isDestroyed()) return;
  helperWin = new BrowserWindow({ show: false, webPreferences: appPrefs({ autoplayPolicy: "no-user-gesture-required" }) });
  helperWin.loadURL(`${ORIGIN}/${String(url || "offscreen.html").replace(/^\//, "")}`);
  helperWin.on("closed", () => { helperWin = null; });
}
ipcMain.handle("offscreen:create", (_e, url) => createHelper(url));
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
  return visible ? b : { width: Math.min(b.width, area.width), height: Math.min(b.height, area.height) };
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
  panelWin.loadURL(`${ORIGIN}/sidepanel.html`);
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
  if (!w) return;
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
    shell.openExternal(u);
    return { action: "deny" };
  });
  win.on("closed", () => siteWindows.delete(win.id));
  return win;
}
function openUrl(url, active = true, pinned = false) {
  let u;
  try { u = new URL(url); } catch { return null; }
  if (u.protocol === "chrome:") return null;
  if (SITE_HOSTS.test(u.hostname)) return createSite(url, { active, pinned });
  shell.openExternal(url);
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
ipcMain.handle("desktop:open", (_e, what) => {
  if (what === "axiom") openSite("https://axiom.trade/pulse");
  else if (what === "x") openSite("https://x.com/home");
  else if (what === "quit") { quitting = true; app.quit(); }
});

// ---------------- tabs ----------------
const matchUrl = (url, patterns) => [].concat(patterns || []).some((p) => new RegExp("^" + p.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$").test(url));
ipcMain.handle("tabs:query", (_e, q = {}) => {
  const focused = BrowserWindow.getFocusedWindow();
  return [...siteWindows.values()].filter(({ win }) => !win.isDestroyed()).map(({ win, pinned, url }) => ({
    id: win.id, windowId: win.id, url: win.webContents.getURL() || url, title: win.getTitle(),
    active: focused === win, pinned, discarded: false, status: win.webContents.isLoading() ? "loading" : "complete",
  })).filter((t) => !q.url || matchUrl(t.url, q.url));
});
ipcMain.handle("tabs:create", (_e, o = {}) => {
  const w = openUrl(o.url, o.active !== false, !!o.pinned);
  return w ? { id: w.id, url: o.url, active: o.active !== false } : { id: -1, url: o.url };
});
ipcMain.handle("tabs:reload", (_e, id) => { const s = siteWindows.get(id); if (s && !s.win.isDestroyed()) s.win.webContents.reload(); });
ipcMain.handle("tabs:update", () => {});

// ---------------- notifications, badge, startup info ----------------
ipcMain.handle("notify", (_e, title, body) => {
  if (!Notification.isSupported()) return;
  const n = new Notification({ title, body, icon: icon() });
  n.on("click", showPanel);
  n.show();
});
// the extension's toolbar tooltip ("Hatchr · paused" …) becomes the window title and tray tooltip
ipcMain.handle("title", (_e, title) => {
  const t = String(title || "Hatchr");
  if (tray) tray.setToolTip(t);
  if (panelWin && !panelWin.isDestroyed()) panelWin.setTitle(t);
});
let launchInfo = null;
ipcMain.handle("launch-info", () => {
  if (launchInfo) return { reason: null };
  const last = store.__desktopVersion;
  launchInfo = last == null ? "install" : last !== app.getVersion() ? "update" : null;
  store.__desktopVersion = app.getVersion();
  saveStore();
  return { reason: launchInfo };
});
ipcMain.on("manifest", (e) => {
  try { e.returnValue = JSON.parse(fs.readFileSync(path.join(APP_DIR, "manifest.json"), "utf8")); } catch { e.returnValue = { version: app.getVersion() }; }
});
ipcMain.on("content-script", (e, name) => {
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
    { label: `Hatchr ${app.getVersion()} · get the latest`, click: () => shell.openExternal("https://hatchr.pro/#desktop") },
    { type: "separator" },
    { label: "Quit Hatchr", click: () => { quitting = true; app.quit(); } },
  ]));
  tray.on("click", showPanel);
}

if (process.env.HATCHR_SELFTEST) {
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
  const splashAt = process.env.HATCHR_SELFTEST ? 0 : createSplash();
  loadStore();
  if (store.__desktopVersion == null) store.onboardSeen = true; // the Chrome-only "keep Axiom running" tip doesn't apply here
  protocol.handle("app", (req) => {
    const { pathname } = new URL(req.url);
    const file = path.normalize(path.join(APP_DIR, decodeURIComponent(pathname)));
    if (!file.startsWith(APP_DIR)) return new Response("Not found", { status: 404 });
    return net.fetch(pathToFileURL(file).toString());
  });
  // macOS needs the app and Edit menus for Cmd+Q and copy/paste; Windows and Linux need none
  Menu.setApplicationMenu(process.platform === "darwin"
    ? Menu.buildFromTemplate([{ role: "appMenu" }, { role: "editMenu" }, { role: "windowMenu" }])
    : null);
  createTray();
  createEngine();
  createPanel({ splashAt });
  if (process.env.HATCHR_SELFTEST) return require("./selftest.js")(() => panelWin);
  // first run: open Axiom so you can log in
  if (!store.__desktopAxiomOpened) {
    store.__desktopAxiomOpened = true;
    saveStore();
    setTimeout(() => openSite("https://axiom.trade/pulse"), 1500);
  }
});
