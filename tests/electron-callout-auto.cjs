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
    console.log('PASS: the desktop engine loads the callout automode next to the callout sender');

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
    await run(`document.querySelector('.tabs button[data-tab="settings"]').click(); document.querySelector('#subtabs button[data-sub="callauto"]').click(); true`);
    await waitFor(() => run('!!document.querySelector("#coAutoBox #ca-ownBuys") && !!document.querySelector("#coAutoBox #ca-texts")'), 'Callouts settings form');
    assert.equal(await run('document.querySelector("#ca-buyUsd").value'), '2');
    assert.equal(await run('document.querySelector("#saveBtn").hidden'), true);
    await run(`document.querySelector('.tabs button[data-tab="callouts"]').click(); true`);
    await waitFor(() => run('!!document.querySelector("#coAutoCard .ca-status")'), 'status card on the Callouts tab');
    console.log('PASS: the Callouts settings and the status card render in the desktop panel');

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
