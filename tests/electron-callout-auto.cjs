// Runs the real Electron app with an isolated profile and intercepted HTTPS, and checks that the callout automode
// (extension-src/src/callout-auto.js and friends) is loaded and reachable in the desktop app the same way as in Chrome.
// Nothing is bought or posted: the automode stays switched off, and every HTTPS request is answered by a fixture.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hatchr-callout-auto-test-'));
const mint = '93p4QaYFhJyQZSwKbHXLWexVxtLr7HiR35ZdBnUzpump';
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');
if (process.platform === 'linux' && !process.env.DISPLAY) app.commandLine.appendSwitch('ozone-platform', 'headless');
fs.writeFileSync(path.join(profile, 'storage.json'), JSON.stringify({
  onboardSeen: true, __desktopAxiomOpened: true, __desktopVersion: '3.6.7',
  settings: { watching: false, aiEnabled: false, dryRun: true, keepAxiomOpen: false, pumpMeta: false, tgEnabled: false },
  heldCoins: [{ id: `held:${mint}`, mint, ok: true, dryRun: false, ticker: 'TEST', name: 'Test Coin', amount: 1000 }],
  heldInfo: { at: Date.now(), error: '', wallets: 1 }
}));
app.whenReady().then(() => {
  session.defaultSession.protocol.handle('https', async () => new Response('{}', { status: 503, headers: { 'content-type': 'application/json' } }));
});
require('../main.js');
const pause = ms => new Promise(resolve => setTimeout(resolve, ms));
async function waitFor(fn, label) {
  for (let i = 0; i < 150; i++) {
    try { const value = await fn(); if (value) return value; } catch {}
    await pause(100);
  }
  throw new Error(`Timed out: ${label}`);
}
const find = suffix => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().endsWith(suffix));
const deadline = setTimeout(() => { console.error('Electron callout automode test timed out'); app.exit(1); }, 60000);
app.whenReady().then(async () => {
  try {
    const panel = await waitFor(() => find('/sidepanel.html'), 'panel');
    const engine = await waitFor(() => find('/background.html'), 'engine');
    const inEngine = code => engine.webContents.executeJavaScript(code);
    const run = code => panel.webContents.executeJavaScript(code);
    const send = payload => run(`chrome.runtime.sendMessage(${JSON.stringify(payload)})`);

    await waitFor(() => inEngine('typeof HatchrCalloutAuto !== "undefined" && typeof HatchrCalloutFilters !== "undefined" && typeof HatchrCore !== "undefined"'), 'automode scripts in the engine');
    assert.equal(await inEngine('HatchrCore.isDesktop'), true);
    assert.equal(await inEngine('HatchrCalloutAuto.wantsStream()'), false, 'off until it is switched on');
    assert.equal(await inEngine('typeof HatchrCaBuy !== "undefined" && typeof HatchrPumpAlerts !== "undefined" && typeof HatchrPush !== "undefined" && typeof HatchrCopy !== "undefined" && typeof HatchrRoutes !== "undefined" && typeof HatchrCaBuy.onStream === "function" && typeof HatchrCore.sound === "function"'), true, 'CA buy and pump alerts are loaded too');
    console.log('PASS: the desktop engine loads the callout automode, CA buy and pump alerts next to the callout sender');

    // the panel talks to it (the engine only answers Hatchr's own panel)
    const got = await waitFor(async () => { const r = await send({ type: 'coAutoGet' }); return r && r.ok ? r : null; }, 'coAutoGet from the panel');
    assert.equal(got.data.config.enabled, false);
    assert.equal(got.data.config.ownBuys, false);
    assert.equal(got.data.config.minIntervalMin, 0);
    const saved = await send({ type: 'coAutoSave', config: { ...got.data.config, buyUsd: 2, texts: ['{ticker} from the desktop app'], filters: { ...got.data.config.filters, holders: { min: 33, max: null } } } });
    assert.equal(saved.ok, true);
    assert.equal(saved.data.config.buyUsd, 2);
    assert.equal((await run('chrome.storage.local.get("coAuto")')).coAuto.filters.holders.min, 33);
    console.log('PASS: settings are read and saved through the real Electron IPC');

    // its settings page and the eye on a held coin are drawn
    await waitFor(() => run('typeof HatchrCalloutFilters !== "undefined" && typeof HatchrBackupNote === "function"'), 'automode UI script in the panel');
    // the feature pages live in the Trade tab now, each with its switches at the top
    await run(`document.querySelector('.tabs button[data-tab="trade"]').click(); document.querySelector('#subtabs button[data-sub="callauto"]').click(); true`);
    await waitFor(() => run('!!document.querySelector("#coAutoBox #ca-texts") && document.querySelector("#coAutoBox").offsetParent !== null'), 'Auto callouts page in the Trade tab');
    assert.equal(await run('document.querySelector("#ca-buyUsd").value'), '2');
    await waitFor(() => run('/Call out my own buys/.test(document.querySelector("#tab-trade .tab-switches").innerText)'), 'its switches at the top');
    assert.equal(await run('[...document.querySelectorAll("#settingsForm .sec")].some(s => s.dataset.sub === "callauto")'), false, 'no longer in Settings');
    await run(`document.querySelector('.tabs button[data-tab="callouts"]').click(); true`);
    await waitFor(() => run('!!document.querySelector("#coAutoCard .ca-status")'), 'status card on the Callouts tab');
    // CA buy and pump alerts: their pages render, their settings save, and a post from a chosen account reaches the buyer
    await run(`document.querySelector('.tabs button[data-tab="trade"]').click(); document.querySelector('#subtabs button[data-sub="cabuy"]').click(); true`);
    await waitFor(() => run('!!document.querySelector("#caBuyBox #cb-handles")'), 'CA buy form');
    await run(`document.querySelector('#subtabs button[data-sub="positions"]').click(); true`);
    await waitFor(() => run('/Positions/.test(document.querySelector("#posBox").innerText)'), 'positions page');
    await run(`document.querySelector('#subtabs button[data-sub="pumps"]').click(); true`);
    await waitFor(() => run('!!document.querySelector("#pumpBox #pa-risePct")'), 'pump alerts form');
    const ca = await send({ type: 'caBuySave', config: { enabled: true, handles: '@Caller', buySol: 0.1 } });
    assert.equal(ca.ok, true);
    assert.deepEqual(ca.data.config.handles, ['caller']);
    assert.equal(ca.data.test, true, 'the fixture profile is in TEST mode');
    await run(`document.querySelector('#subtabs button[data-sub="copy"]').click(); true`);
    await waitFor(() => run('!!document.querySelector("#copyBox #ctNewAddr")'), 'copy trade form');
    const copy = await send({ type: 'copySave', config: { enabled: false, wallets: 'whale: 5Q544fKrFoe6tsEbD7S8EmxGTJYAKtTVhAW5Q5pge4j1', buySol: 0.2 } });
    assert.equal(copy.ok, true);
    assert.equal(copy.data.config.wallets[0].label, 'whale');
    const smart = await send({ type: 'caBuySave', config: { enabled: true, handles: '@Caller', smart: true, smartMatch: 'ticker' } });
    assert.equal(smart.data.config.smart, true);
    const pumps = await send({ type: 'pumpSave', config: { enabled: false, risePct: 75 } });
    assert.equal(pumps.data.config.risePct, 75);
    assert.equal(await run('typeof HatchrPositions'), 'undefined', 'positions run in the engine, not the panel');
    assert.equal(await inEngine('typeof HatchrPositions.open === "function" && typeof HatchrRoutes.feeEstimate === "function"'), true);
    // 3.9.4: the watchlist runs in the engine and has its own Trade page
    assert.equal(await inEngine('typeof HatchrWatch.poll === "function" && HatchrWatch.num("4k") === 4000'), true);
    assert.equal(await run('!!document.querySelector(\'#subtabs button[data-sub="watch"]\') || !!document.querySelector(\'.trade-page[data-page="watch"]\')'), true);
    console.log('PASS: the Trade tab (CA buy, copy trade, positions, pump alerts, auto callouts) renders and saves in the desktop panel');

    // the callout window offers the saved texts, and the backup carries the settings
    const texts = await send({ type: 'calloutTexts', id: `held:${mint}` });
    assert.equal(texts.ok, true);
    assert.deepEqual(texts.data.texts, ['$TEST from the desktop app']);
    const backup = await send({ type: 'exportBackup', password: '', includeHistory: false });
    assert.equal(backup.ok, true);
    assert.equal(backup.data.data.calloutAuto.buyUsd, 2);
    assert.deepEqual(backup.data.data.calloutAuto.texts, ['{ticker} from the desktop app']);
    console.log('PASS: saved callout texts reach the callout window, and the backup holds the callout settings');

    clearTimeout(deadline);
    app.quit();
  } catch (error) {
    console.error(error.stack || error);
    clearTimeout(deadline);
    app.exit(1);
  }
});
