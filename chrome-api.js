// The slice of the chrome.* extension API that Hatchr uses, built on Electron IPC.
// Shared by the app pages (panel, engine, helper) and the site windows (content scripts).
const { ipcRenderer } = require("electron");

function makeEvent() {
  const ls = [];
  return {
    addListener: (f) => { if (typeof f === "function" && !ls.includes(f)) ls.push(f); },
    removeListener: (f) => { const i = ls.indexOf(f); if (i >= 0) ls.splice(i, 1); },
    hasListener: (f) => ls.includes(f),
    _ls: ls,
  };
}

function unwrap(r) {
  if (r && r.error) throw new Error(r.error);
  return r ? r.response : undefined;
}

function buildChrome({ engine = false } = {}) {
  const onMessage = makeEvent();
  const onChanged = makeEvent();
  const onInstalled = makeEvent();
  const onStartup = makeEvent();
  const onAlarm = makeEvent();

  ipcRenderer.on("storage:changed", (_e, changes, area) => {
    for (const f of onChanged._ls) { try { f(changes, area); } catch (err) { console.error(err); } }
  });

  // incoming runtime messages: first listener that answers wins, like Chrome
  ipcRenderer.on("rt:deliver", (_e, id, msg, sender) => {
    let answered = false;
    let asyncPending = false;
    const sendResponse = (response) => {
      if (answered) return;
      answered = true;
      ipcRenderer.send("rt:reply", id, { handled: true, response });
    };
    for (const f of onMessage._ls) {
      let r;
      try { r = f(msg, sender, sendResponse); } catch (err) { console.error(err); }
      if (answered) return;
      if (r === true) asyncPending = true;
      else if (r && typeof r.then === "function") { asyncPending = true; r.then(sendResponse, (err) => sendResponse({ ok: false, error: String(err && err.message || err) })); }
    }
    if (!asyncPending && !answered) ipcRenderer.send("rt:reply", id, { handled: false, listeners: onMessage._ls.length });
  });

  // alarms live in the window that creates them (the engine)
  const alarms = new Map();
  const alarmApi = {
    create(name, info = {}) {
      if (typeof name === "object") { info = name; name = ""; }
      alarmApi.clear(name);
      const period = info.periodInMinutes ? info.periodInMinutes * 60_000 : 0;
      const delay = info.delayInMinutes != null ? info.delayInMinutes * 60_000 : info.when ? Math.max(0, info.when - Date.now()) : period;
      const a = { name, periodInMinutes: info.periodInMinutes, scheduledTime: Date.now() + delay };
      const fire = () => { a.scheduledTime = Date.now() + period; for (const f of onAlarm._ls) { try { f({ name, scheduledTime: Date.now() }); } catch (err) { console.error(err); } } };
      a.t = setTimeout(() => { fire(); if (period) a.i = setInterval(fire, period); else alarms.delete(name); }, delay);
      alarms.set(name, a);
      return Promise.resolve();
    },
    get: (name) => Promise.resolve(alarms.has(name) ? { name, periodInMinutes: alarms.get(name).periodInMinutes, scheduledTime: alarms.get(name).scheduledTime } : undefined),
    clear(name) {
      const a = alarms.get(name);
      if (a) { clearTimeout(a.t); clearInterval(a.i); alarms.delete(name); }
      return Promise.resolve(!!a);
    },
    onAlarm,
  };

  if (engine) {
    window.addEventListener("load", async () => {
      const { reason } = await ipcRenderer.invoke("launch-info");
      setTimeout(() => {
        const ls = reason ? onInstalled._ls : onStartup._ls;
        for (const f of ls) { try { f(reason ? { reason } : undefined); } catch (err) { console.error(err); } }
      }, 0);
    });
  }

  const manifest = ipcRenderer.sendSync("manifest");
  const noop = () => Promise.resolve();
  return {
    runtime: {
      id: "hatchr-desktop",
      sendMessage: (msg) => ipcRenderer.invoke("rt:send", msg).then(unwrap),
      onMessage,
      onInstalled,
      onStartup,
      getManifest: () => manifest,
      getURL: (p) => `app://hatchr/${String(p).replace(/^\//, "")}`,
      getContexts: async (q = {}) => ((q.contextTypes || []).includes("OFFSCREEN_DOCUMENT") && (await ipcRenderer.invoke("offscreen:exists")) ? [{ contextType: "OFFSCREEN_DOCUMENT" }] : []),
      lastError: undefined,
    },
    storage: {
      local: {
        get: (keys) => ipcRenderer.invoke("storage:get", keys === undefined ? null : keys),
        set: (items) => ipcRenderer.invoke("storage:set", items),
        remove: (keys) => ipcRenderer.invoke("storage:remove", keys),
      },
      session: {
        get: (keys) => ipcRenderer.invoke("session:get", keys === undefined ? null : keys),
        set: (items) => ipcRenderer.invoke("session:set", items),
        remove: (keys) => ipcRenderer.invoke("session:remove", keys),
      },
      onChanged,
    },
    hatchrCallouts: { post: (payload) => ipcRenderer.invoke("callout:post", payload) },
    alarms: alarmApi,
    tabs: {
      query: (q) => ipcRenderer.invoke("tabs:query", q),
      create: (o) => ipcRenderer.invoke("tabs:create", o),
      reload: (id) => ipcRenderer.invoke("tabs:reload", id),
      update: (id, o) => ipcRenderer.invoke("tabs:update", id, o),
    },
    offscreen: {
      createDocument: (o = {}) => ipcRenderer.invoke("offscreen:create", o.url),
      hasDocument: () => ipcRenderer.invoke("offscreen:exists"),
    },
    notifications: {
      create: (id, o) => {
        if (typeof id === "object") { o = id; id = ""; }
        return ipcRenderer.invoke("notify", String(o?.title || "Hatchr"), String(o?.message || "")).then(() => id);
      },
      clear: noop,
    },
    permissions: { request: () => Promise.resolve(true), contains: () => Promise.resolve(true) },
    action: {
      setBadgeText: noop,
      setBadgeBackgroundColor: noop,
      setTitle: (o) => ipcRenderer.invoke("title", (o && o.title) || "Hatchr"),
      setIcon: noop,
    },
    sidePanel: { setPanelBehavior: noop, open: noop },
  };
}

module.exports = { buildChrome };
