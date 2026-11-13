const { test } = require('node:test');
const assert = require('node:assert/strict');
const { postCallout } = require('../desktop-callouts.js');
const coinMint = '93p4QaYFhJyQZSwKbHXLWexVxtLr7HiR35ZdBnUzpump';

test('desktop posts through its supplied Electron session with a fixed destination and body', async () => {
  const requests = [];
  const result = await postCallout({ fetch: async (...args) => {
    requests.push(args);
    return new Response(JSON.stringify({ callout: { calloutId: 'test-id', coinMint } }), { status: 201 });
  } }, { coinMint, thesis: '  A draft  ', url: 'https://example.com', chainId: 1 });
  assert.equal(requests.length, 1);
  const [url, options] = requests[0];
  assert.equal(url, 'https://frontend-api-v3.pump.fun/callout/create');
  assert.equal(options.credentials, 'include');
  assert.equal(options.redirect, 'error');
  assert.deepEqual(JSON.parse(options.body), { coinMint, thesis: 'A draft', chainId: 1399811149, version: 2 });
  assert.equal(result.status, 201);
  assert.equal(result.body.callout.calloutId, 'test-id');
  assert.equal(Object.keys(options.headers).some(key => /cookie|authorization/i.test(key)), false);
});

test('desktop rejects invalid callout payloads before accessing the session', async () => {
  for (const payload of [null, {}, { coinMint: 'bad', thesis: 'Text' }, { coinMint, thesis: ' ' }, { coinMint, thesis: 'x'.repeat(2001) }]) {
    await assert.rejects(postCallout({ fetch: () => assert.fail('Unexpected request') }, payload), /Invalid callout/);
  }
});

test('desktop preserves API status and does not pretend HTML is a successful callout', async () => {
  const result = await postCallout({ fetch: async () => new Response('<html>Verify</html>', { status: 403 }) }, { coinMint, thesis: 'Text' });
  assert.deepEqual(result, { status: 403, body: null });
});

test('desktop propagates a lost response once without retrying', async () => {
  let requests = 0;
  await assert.rejects(postCallout({ fetch: async () => { requests++; throw new Error('Connection lost'); } }, { coinMint, thesis: 'Text' }), /Connection lost/);
  assert.equal(requests, 1);
});
