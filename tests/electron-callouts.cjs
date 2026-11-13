// Runs the real Electron app with an isolated profile and intercepted HTTPS.
// No real Pump.fun request or account is used.
const { app, BrowserWindow, session } = require('electron');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'hatchr-callout-test-'));
const mint = '93p4QaYFhJyQZSwKbHXLWexVxtLr7HiR35ZdBnUzpump';
const apiURL = 'https://frontend-api-v3.pump.fun/callout/create';
app.setPath('userData', profile);
app.commandLine.appendSwitch('disable-gpu');
if (process.platform === 'linux' && !process.env.DISPLAY) app.commandLine.appendSwitch('ozone-platform', 'headless');
fs.writeFileSync(path.join(profile, 'storage.json'), JSON.stringify({
  onboardSeen: true, __desktopAxiomOpened: true, __desktopVersion: '3.5.8',
  settings: { watching: false, aiEnabled: false, dryRun: false, keepAxiomOpen: false, pumpMeta: false, tgEnabled: false },
  deploys: [{ id: 'test-launch', mint, ok: true, dryRun: false, ticker: 'TEST', name: 'Test', time: Date.now() }]
}));
let requests = [];
let responseStatus = 201;
let responseBody = { callout: { calloutId: 'test-electron-id', coinMint: mint } };
app.whenReady().then(() => {
  session.defaultSession.protocol.handle('https', async request => {
    if (request.url === apiURL) {
      requests.push({ method: request.method, body: await request.json() });
      return new Response(JSON.stringify(responseBody), { status: responseStatus, headers: { 'content-type': 'application/json' } });
    }
    return new Response('<!doctype html><title>Offline login fixture</title><p>Mock page</p>', { headers: { 'content-type': 'text/html' } });
  });
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
const deadline = setTimeout(() => { console.error('Electron callout test timed out'); app.exit(1); }, 45000);
app.whenReady().then(async () => {
  try {
    const panel = await waitFor(() => find('/sidepanel.html'), 'panel');
    const engine = await waitFor(() => find('/background.html'), 'engine');
    await waitFor(() => engine.webContents.executeJavaScript('typeof HatchrCallouts !== "undefined"'), 'engine scripts');
    const run = code => panel.webContents.executeJavaScript(code);
    await waitFor(() => run('typeof HatchrCalloutDialog !== "undefined"'), 'composer');
    const message = { type: 'calloutCreate', id: 'test-launch', mint, text: 'My desktop callout' };
    const send = payload => run(`chrome.runtime.sendMessage(${JSON.stringify(payload)})`);
    await waitFor(async () => (await send({ type: 'walletPub' }))?.ok, 'runtime handler');
    const windowCount = BrowserWindow.getAllWindows().length;
    const result = await send(message);
    assert.equal(result.ok, true);
    assert.equal(result.data.sent, true);
    assert.equal(result.data.url, `https://pump.fun/callouts/${mint}/test-electron-id`);
    assert.equal(requests.length, 1);
    assert.deepEqual(requests[0], { method: 'POST', body: { coinMint: mint, thesis: message.text, chainId: 1399811149, version: 2 } });
    assert.equal(BrowserWindow.getAllWindows().length, windowCount);
    assert.equal((await run('chrome.storage.local.get("deploys")')).deploys[0].calloutUrl, result.data.url);
    console.log('PASS: real Electron IPC, request transport, history, and no window opened by sending');

    await engine.webContents.reload();
    await waitFor(() => engine.webContents.executeJavaScript('typeof HatchrCallouts !== "undefined"'), 'reloaded engine');
    assert.equal((await send(message)).data.sent, true);
    assert.equal(requests.length, 1);
    console.log('PASS: session cache survives an engine reload without a second POST');

    responseStatus = 401; responseBody = { message: 'Unauthorized' };
    assert.equal((await send({ ...message, text: 'Another draft' })).data.reason, 'not-signed-in');
    responseStatus = 201; responseBody = {};
    assert.equal((await send({ ...message, text: 'Unknown draft' })).data.reason, 'unknown');
    const before = requests.length;
    await send({ ...message, text: 'Unknown draft' });
    assert.equal(requests.length, before);
    console.log('PASS: expired login and unconfirmed results stay in the app');

    await run('hatchrDesktop.open("pump")');
    const pump = await waitFor(() => BrowserWindow.getAllWindows().find(win => win.webContents.getURL().startsWith('https://pump.fun')), 'login window');
    const preferences = pump.webContents.getLastWebPreferences();
    assert.equal(preferences.sandbox, true);
    assert.equal(preferences.nodeIntegration, false);
    assert.ok(!preferences.preload);
    assert.equal(await pump.webContents.executeJavaScript('typeof window.__hatchrChrome'), 'undefined');
    assert.equal(pump.webContents.session, session.defaultSession);
    console.log('PASS: explicit Pump.fun login window shares the session and has no privileged bridge');

    clearTimeout(deadline);
    app.quit();
  } catch (error) {
    console.error(error.stack || error);
    clearTimeout(deadline);
    app.exit(1);
  }
});
