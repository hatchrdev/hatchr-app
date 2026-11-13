const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');
const { webcrypto } = require('node:crypto');
const MINT = '93p4QaYFhJyQZSwKbHXLWexVxtLr7HiR35ZdBnUzpump';
const ID = 'test-callout-id';
const INPUT = { id: 'launch-1', mint: MINT, text: 'My own callout text' };
const source = fs.readFileSync(path.join(__dirname, '../callout-client.js'), 'utf8');
const success = () => new Response(JSON.stringify({ callout: { calloutId: ID, coinMint: MINT } }), { status: 201 });

function harness({ response = success, permission = true, storageFailure = false, historyFailure = false, timeout = false } = {}) {
  const session = {};
  const requests = [];
  const records = [];
  const deploys = [{ id: INPUT.id, mint: MINT, ok: true, dryRun: false }];
  const context = vm.createContext({
    crypto: webcrypto, TextEncoder, AbortController,
    setTimeout: timeout ? fn => setTimeout(fn, 1) : setTimeout, clearTimeout,
    fetch: async (url, options) => { requests.push({ url, options }); return response(url, options); },
    chrome: {
      permissions: { contains: async ({ origins }) => {
        assert.deepEqual(Array.from(origins), ['https://pump.fun/*', 'https://frontend-api-v3.pump.fun/*']);
        return permission;
      } },
      storage: {
        local: { get: async () => ({ deploys }) },
        session: {
          get: async key => ({ [key]: session[key] }),
          set: async values => { if (storageFailure) throw new Error('Storage unavailable'); Object.assign(session, values); },
          remove: async key => { delete session[key]; }
        }
      }
    }
  });
  vm.runInContext(source, context);
  const save = async (id, record) => { if (historyFailure) throw new Error('History unavailable'); records.push({ id, record }); };
  return { context, requests, records, session, deploys, create: input => context.HatchrCallouts.create(input || INPUT, save) };
}

test('posts the replay payload with browser credentials and records the confirmed URL', async () => {
  const h = harness();
  const result = await h.create({ ...INPUT, text: '  My own callout text  ' });
  assert.equal(result.sent, true);
  assert.equal(result.url, `https://pump.fun/callouts/${MINT}/${ID}`);
  assert.equal(h.requests.length, 1);
  const { url, options } = h.requests[0];
  assert.equal(url, 'https://frontend-api-v3.pump.fun/callout/create');
  assert.equal(options.method, 'POST');
  assert.equal(options.credentials, 'include');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(JSON.parse(options.body), { coinMint: MINT, thesis: INPUT.text, chainId: 1399811149, version: 2 });
  assert.equal(options.headers['x-pump-platform'], 'web');
  assert.equal(options.headers['x-pump-source'], 'WEB');
  assert.equal(Object.keys(options.headers).some(k => /cookie|authorization|origin|referer|sec-/i.test(k)), false);
  assert.equal(h.records[0].id, INPUT.id);
  assert.equal(h.records[0].record.calloutUrl, result.url);
  assert.equal(JSON.stringify(h.session).includes(INPUT.text), false);
});

test('rejects invalid input and test or mismatched launches without requesting the API', async () => {
  for (const input of [
    { ...INPUT, mint: '../bad' }, { ...INPUT, text: '' }, { ...INPUT, text: 'x'.repeat(2001) },
    { ...INPUT, id: 'missing' }, { ...INPUT, mint: '11111111111111111111111111111111' }
  ]) {
    const h = harness(); await assert.rejects(h.create(input)); assert.equal(h.requests.length, 0);
  }
  const h = harness(); h.deploys[0].dryRun = true;
  await assert.rejects(h.create()); assert.equal(h.requests.length, 0);
});

test('permission denial and unavailable preflight storage never post', async () => {
  const h = harness({ permission: false });
  assert.equal((await h.create()).reason, 'no-permission'); assert.equal(h.requests.length, 0);
  const failed = harness({ storageFailure: true });
  await assert.rejects(failed.create()); assert.equal(failed.requests.length, 0);
});

for (const [status, body, reason] of [
  [401, { message: 'Unauthorized' }, 'not-signed-in'],
  [403, { message: 'Forbidden' }, 'forbidden'],
  [409, { message: 'Already exists' }, 'has-live-callout'],
  [400, { code: 'DUPLICATE_CALLOUT' }, 'has-live-callout'],
  [400, { code: 'INSUFFICIENT_BALANCE' }, 'cannot-call'],
  [400, { code: 'NO_ELIGIBLE_WALLET' }, 'cannot-call'],
  [429, { message: 'Slow down' }, 'rate-limited'],
  [400, { code: 'COOLDOWN' }, 'rate-limited'],
  [400, { message: ['Bad text', 'Try a shorter thesis'] }, 'refused']
]) test(`handles ${status} ${body.code || body.message} without success or retry`, async () => {
  const h = harness({ response: () => new Response(JSON.stringify(body), { status }) });
  const result = await h.create();
  assert.equal(result.sent, false); assert.equal(result.reason, reason);
  assert.equal(h.requests.length, 1); assert.equal(h.records.length, 0);
});

test('does not expose HTML challenge content', async () => {
  const h = harness({ response: () => new Response('<html><script>secret()</script></html>', { status: 403 }) });
  const result = await h.create();
  assert.equal(result.reason, 'forbidden'); assert.equal(result.detail, '');
});

test('coalesces double clicks and blocks different drafts while posting', async () => {
  let resolveResponse;
  const response = new Promise(resolve => { resolveResponse = resolve; });
  const h = harness({ response: () => response });
  const first = h.create(); const second = h.create();
  assert.equal(first, second);
  assert.equal((await h.create({ ...INPUT, text: 'Different text' })).reason, 'in-progress');
  resolveResponse(success());
  assert.equal((await first).sent, true);
  assert.equal((await second).sent, true);
  assert.equal((await h.create()).sent, true);
  assert.equal(h.requests.length, 1);
});

for (const [label, response] of [
  ['network loss', () => { throw new TypeError('Network error'); }],
  ['server error', () => new Response('{}', { status: 500 })],
  ['empty success', () => new Response(null, { status: 204 })],
  ['malformed success', () => new Response('<html>OK</html>')],
  ['unconfirmed success', () => new Response('{"success":true}')],
  ['mismatched coin', () => new Response(JSON.stringify({ callout: { calloutId: ID, coinMint: 'wrong' } }))],
  ['unsafe ID', () => new Response(JSON.stringify({ callout: { calloutId: '../wrong', coinMint: MINT } }))]
]) test(`${label} is unconfirmed and cannot silently retry`, async () => {
  const h = harness({ response });
  const result = await h.create();
  assert.equal(result.reason, 'unknown'); assert.equal(result.sent, false);
  assert.equal((await h.create()).reason, 'unknown');
  assert.equal(h.requests.length, 1); assert.equal(h.records.length, 0);
  await h.create({ ...INPUT, checkedNotPosted: true });
  assert.equal(h.requests.length, 2);
});

test('timeout aborts the request and does not replay it', async () => {
  const h = harness({ timeout: true, response: (_, { signal }) => new Promise((_, reject) => {
    signal.addEventListener('abort', () => reject(new Error('Abort')), { once: true });
  }) });
  assert.equal((await h.create()).reason, 'unknown');
  assert.equal(h.requests[0].options.signal.aborted, true);
  assert.equal(h.requests.length, 1);
});

test('pending state survives a worker restart and needs a user check', async () => {
  const h = harness();
  h.session[`hatchr.callout.${MINT}`] = { state: 'pending' };
  assert.equal((await h.create()).reason, 'unknown'); assert.equal(h.requests.length, 0);
  assert.equal((await h.create({ ...INPUT, checkedNotPosted: true })).sent, true);
  assert.equal(h.requests.length, 1);
});

test('a history storage failure does not misreport a successful post', async () => {
  const h = harness({ historyFailure: true });
  const result = await h.create();
  assert.equal(result.sent, true); assert.equal(result.historyWarning, true);
  await h.create(); assert.equal(h.requests.length, 1);
});

test('desktop uses the fixed IPC transport instead of a renderer request', async () => {
  const h = harness();
  const posted = [];
  h.context.chrome.hatchrCallouts = { post: async payload => {
    posted.push(JSON.parse(JSON.stringify(payload)));
    return { status: 201, body: { callout: { calloutId: ID, coinMint: MINT } } };
  } };
  const result = await h.create();
  assert.equal(result.sent, true);
  assert.equal(h.requests.length, 0);
  assert.deepEqual(posted, [{ coinMint: MINT, thesis: INPUT.text, chainId: 1399811149, version: 2 }]);
});
