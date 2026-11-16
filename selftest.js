// Run with: HATCHR_SELFTEST=<outdir> electron . --no-sandbox   (CI smoke test, not shipped)
const { app, BrowserWindow } = require("electron");
const fs = require("node:fs");
const path = require("node:path");
module.exports = function selftest(getPanel) {
  const out = process.env.HATCHR_SELFTEST;
  const log = (...a) => console.log("[selftest]", ...a);
  const run = (code) => getPanel().webContents.executeJavaScript(code);
  setTimeout(async () => {
    try {
      log("windows", BrowserWindow.getAllWindows().map((w) => w.webContents.getURL()));
      log("walletPub", await run(`chrome.runtime.sendMessage({type:'walletPub'})`));
      log("createWallet", await run(`chrome.runtime.sendMessage({type:'createWallet'})`));
      log("settings.paused", await run(`chrome.storage.local.get('settings').then(r=>r.settings && r.settings.paused)`));
      log("vanityStart", await run(`chrome.runtime.sendMessage({type:'vanityStart', prefix:'ab'})`));
      let job;
      for (let i = 0; i < 60; i++) {
        await new Promise((r) => setTimeout(r, 500));
        job = await run(`chrome.storage.local.get('vanityJob').then(r=>r.vanityJob)`);
        if (job && job.status !== "running") break;
      }
      log("vanity", job && { status: job.status, tried: job.tried, pub: job.pub });
      log("sound", await run(`chrome.runtime.sendMessage({type:'testSound', kind:'vanity'})`));
      log("manualPost", await run(`chrome.runtime.sendMessage({type:'manualPost', text:'BREAKING: a dog named Biscuit became mayor'})`));
      await new Promise((r) => setTimeout(r, 2500));
      const st = await run(`chrome.storage.local.get('feed').then(r=>(r.feed||[]).map(c=>c.name+' $'+c.ticker+' '+c.status))`);
      log("feed", st);
      log("deploy", await run(`chrome.storage.local.get('feed').then(r=>chrome.runtime.sendMessage({type:'deploy', id:r.feed[0].id}))`));
      await new Promise((r) => setTimeout(r, 1500));
      log("deploys", await run(`chrome.storage.local.get('deploys').then(r=>(r.deploys||[]).map(d=>({ok:d.ok,sim:d.simulated,chk:d.chainCheck,img:!!d.image,err:d.error})))`));
      await run(`document.querySelector('.tabs button[data-tab=launched]').click()`);
      await new Promise((r) => setTimeout(r, 600));
      const img = await getPanel().webContents.capturePage();
      fs.writeFileSync(path.join(out, "panel.png"), img.toPNG());
      await run(`document.querySelector('.tabs button[data-tab=feed]').click()`);
      await new Promise((r) => setTimeout(r, 400));
      fs.writeFileSync(path.join(out, "panel-feed.png"), (await getPanel().webContents.capturePage()).toPNG());
      log("storage file", fs.existsSync(path.join(app.getPath("userData"), "storage.json")));
      // a fake axiom.trade page: does the content script hook WebSocket before the page runs, and reach the engine?
      const { session } = require("electron");
      session.defaultSession.protocol.handle("https", () => new Response(
        "<!doctype html><title>t</title><script>document.title = 'WS=' + window.WebSocket.name + ' hooked=' + String(window.WebSocket).includes('Hook')</script><body>axiom</body>",
        { headers: { "content-type": "text/html" } }));
      await run(`chrome.storage.local.set({axiomStatus:null})`);
      await run(`chrome.tabs.create({url:'https://axiom.trade/pulse', active:true})`);
      await new Promise((r) => setTimeout(r, 14000));
      const site = BrowserWindow.getAllWindows().find((w) => /axiom\.trade/.test(w.webContents.getURL()));
      log("site title", site && site.getTitle());
      log("axiomStatus", await run(`chrome.storage.local.get('axiomStatus').then(r=>r.axiomStatus)`));
      log("tabs.query", await run(`chrome.tabs.query({url:['https://axiom.trade/*']}).then(t=>t.map(x=>x.url))`));
    } catch (e) {
      log("ERROR", e && e.stack || e);
    }
    if (process.env.HATCHR_SELFTEST_QUIT) {
      // the panel's Quit button must really end the app (closing the window only hides it)
      log("quit button", await run(`!!document.querySelector('#titlebar .tb-quit')`));
      setTimeout(() => { log("quit button did not quit"); app.exit(3); }, 8000);
      return run(`document.querySelector('#titlebar .tb-quit').click()`);
    }
    app.exit(0);
  }, 6000);
  // (site test needs ~10s more)
};
