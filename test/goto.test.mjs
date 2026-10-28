import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { PrivateStore, GoToError } from '../src/store.mjs';
import { GoToClient, READ_SCOPES, TOKEN_URL } from '../src/client.mjs';
import { normalizePhone, dateInZone, dayRange, getCallDay } from '../src/calls.mjs';
import { buildServer } from '../src/server.mjs';
import { authorizationUrl, authorize } from '../src/auth.mjs';

const now = () => Date.parse('2026-10-28T18:00:00Z');
const json = (body, status = 200) => new Response(JSON.stringify(body), { status });
async function temporary(t) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'goto-mcp-test-'));
  const store = new PrivateStore(directory);
  t.after(() => fs.rm(directory, { recursive: true, force: true })); // Only this test's freshly created directory.
  await store.write('client.json', { client_id: 'test-client', client_secret: 'test-secret', redirect_uri: 'http://127.0.0.1:12021/app/redirect' });
  await store.write('tokens.json', { access_token: 'test-access', refresh_token: 'test-refresh', principal: 'employee@example.test', obtained_at: now() / 1000 - 10, expires_in: 3600, scope: READ_SCOPES.join(' ') });
  return store;
}
const row = (legId = 'leg-1') => ({ legId, originatorId: 'conversation-1', startTime: '2026-10-27T17:00:00Z', answerTime: '2026-10-27T17:00:05Z', duration: 65000, caller: { number: '101' }, callee: { number: '(213) 555-0123' }, direction: 'INBOUND' });
function history(results) {
  let index = 0;
  return { now, identity: async () => ({ principal: 'employee@example.test', accounts: [{ accountKey: 'account-1', outboundPhoneNumbers: [{ number: '+12135550199' }] }], lines: [{ accountKey: 'account-1', number: '101' }], provenance: { complete: true, access_errors: [] } }), get: async () => { const value = results[index++]; if (value instanceof Error) throw value; return value; } };
}
test('full phone normalization excludes extensions and invalid text', () => {
  assert.equal(normalizePhone('(213) 555-0123 ext. 42'), '+12135550123');
  assert.equal(normalizePhone('+44 20 7946 0018'), '+442079460018');
  assert.equal(normalizePhone('101'), null);
  assert.equal(normalizePhone('junk2135550123'), null);
});
test('Pacific midnight boundaries include 23/25-hour DST days', () => {
  for (const [day, hours] of [['2026-03-08', 23], ['2026-11-01', 25], ['2026-10-27', 24]]) {
    const range = dayRange(day);
    assert.equal((Date.parse(range.endTime) - Date.parse(range.startTime)) / 3600000, hours);
  }
  assert.throws(() => dayRange('2026-02-30'), /real work date/);
  assert.throws(() => dayRange('2026-10-27', 'invalid/zone'), /IANA/);
  assert.equal(dateInZone(null, 'UTC'), null);
  assert.equal(dateInZone('2026-10-27T10:00:00', 'UTC'), null);
});
test('pagination follows a short and empty cursor page; deduplicates leg IDs', async () => {
  const data = await getCallDay(history([{ items: [row()], nextPageMarker: 'second' }, { items: [], nextPageMarker: 'third' }, { items: [row(), row('leg-2')] }]), { work_date: '2026-10-27' });
  assert.equal(data.calls.length, 2);
  assert.equal(data.provenance.pages.length, 3);
  assert.equal(data.status, 'complete');
  assert.equal(data.calls[0].duration_ms, 65000);
  assert.equal(data.calls[0].duration_seconds, 65);
  assert.equal(data.calls[0].direction_raw, 'INBOUND');
  assert.deepEqual(data.calls[0].external_numbers, ['+12135550123']);
  assert.ok(data.calls[0].warnings.includes('DIRECTION_PARTICIPANT_MISMATCH'));
});
test('repeated cursor and page limit remain partial', async () => {
  const repeated = await getCallDay(history([{ items: [row()], nextPageMarker: 'x' }, { items: [], nextPageMarker: 'x' }]), { work_date: '2026-10-27' });
  assert.equal(repeated.status, 'partial');
  assert.equal(repeated.provenance.access_errors[0].code, 'REPEATED_PAGE_MARKER');
  const limit = await getCallDay(history([{ items: [], nextPageMarker: 'x' }]), { work_date: '2026-10-27', max_pages: 1 });
  assert.equal(limit.provenance.all_pages_complete, false);
  assert.equal(limit.provenance.access_errors[0].code, 'PAGE_LIMIT_REACHED');
});
test('access denial is unknown, not zero activity', async () => {
  const data = await getCallDay(history([new GoToError('ACCESS_DENIED', 'No access', 403)]), { work_date: '2026-10-27' });
  assert.equal(data.status, 'unavailable');
  assert.equal(data.provenance.all_pages_complete, false);
  assert.equal(data.provenance.access_errors[0].http_status, 403);
});
test('malformed, out-of-date and conflicting duplicate rows cannot be complete', async () => {
  for (const items of [[null], [{ ...row(), legId: null }], [{ ...row(), startTime: '2026-10-26T17:00:00Z' }], [row(), { ...row(), duration: 2000 }]]) {
    const data = await getCallDay(history([{ items }]), { work_date: '2026-10-27' });
    assert.equal(data.provenance.all_pages_complete, false);
    assert.ok(data.provenance.access_errors.length);
  }
});
test('an empty complete day remains a complete empty read', async () => {
  assert.equal((await getCallDay(history([{ items: [] }]), { work_date: '2026-10-27' })).status, 'complete');
});
test('identity line denial does not block an authorized own call query', async () => {
  const client = history([{ items: [row()] }]);
  const identity = await client.identity();
  client.identity = async () => ({ ...identity, lines: null, provenance: { complete: false, access_errors: [{ code: 'ACCESS_DENIED' }] } });
  const data = await getCallDay(client, { work_date: '2026-10-27' });
  assert.equal(data.status, 'complete');
  assert.equal(data.provenance.identity_warnings.length, 1);
});
test('explicit target remains separate from reviewing principal (synthetic only)', async () => {
  const data = await getCallDay(history([{ items: [] }]), { work_date: '2026-10-27', user_key: 'target-2' });
  assert.equal(data.subject.principal, null);
  assert.equal(data.subject.user_key, 'target-2');
  assert.equal(data.provenance.filters.userKey, 'target-2');
});
test('private store permissions and serialized renewal retain/rotate refresh tokens', async t => {
  for (const rotation of [null, 'rotated-test-token']) {
    const store = await temporary(t);
    const token = await store.read('tokens.json'); token.expires_in = 0; await store.write('tokens.json', token);
    let refreshes = 0;
    const fetcher = async (url, options) => {
      assert.equal(url, TOKEN_URL); assert.equal(options.method, 'POST');
      refreshes++; await new Promise(resolve => setTimeout(resolve, 20));
      return json({ access_token: 'test-new', expires_in: 3600, ...(rotation ? { refresh_token: rotation } : {}) });
    };
    const clients = [new GoToClient({ store, fetcher, now }), new GoToClient({ store, fetcher, now })];
    await Promise.all([...Array(5)].map((_, i) => clients[i % 2].token()));
    assert.equal(refreshes, 1);
    assert.equal((await store.read('tokens.json')).refresh_token, rotation || 'test-refresh');
    if (process.platform !== 'win32') {
      assert.equal((await fs.stat(store.directory)).mode & 0o777, 0o700);
      assert.equal((await fs.stat(path.join(store.directory, 'tokens.json'))).mode & 0o777, 0o600);
    }
  }
});
test('temporary token service failure preserves credentials and does not ask for login', async t => {
  const store = await temporary(t);
  const old = await store.read('tokens.json'); old.expires_in = 0; await store.write('tokens.json', old);
  const client = new GoToClient({ store, now, fetcher: async () => json({ sensitive: 'never echo this' }, 503) });
  await assert.rejects(client.token(), error => error.code === 'AUTH_SERVICE_UNAVAILABLE' && !error.message.includes('sensitive'));
  assert.deepEqual(await store.read('tokens.json'), old);
});
test('identity changes during token renewal do not overwrite existing account', async t => {
  const store = await temporary(t); const token = await store.read('tokens.json'); token.expires_in = 0; await store.write('tokens.json', token);
  const client = new GoToClient({ store, now, fetcher: async () => json({ access_token: 'different', principal: 'other@example.test', expires_in: 3600 }) });
  await assert.rejects(client.token(), { code: 'IDENTITY_CHANGED' });
  assert.equal((await store.read('tokens.json')).access_token, 'test-access');
});
test('401 refreshes once, retries GET once and never follows redirects', async t => {
  const store = await temporary(t); const methods = [];
  const client = new GoToClient({ store, now, fetcher: async (url, options) => {
    methods.push(options.method); assert.equal(options.redirect, 'manual');
    if (String(url) === TOKEN_URL) return json({ access_token: 'new', expires_in: 3600 });
    return options.headers.Authorization === 'Bearer new' ? json({ items: [] }) : json({}, 401);
  } });
  assert.deepEqual(await client.get('/users/v1/me'), { items: [] });
  assert.deepEqual(methods, ['GET', 'POST', 'GET']);
  await assert.rejects(client.get('/calls/v1/start'), { code: 'UNSUPPORTED_OPERATION' });
});
test('auth status never exposes credentials and handles malformed expiry', async t => {
  const store = await temporary(t); const token = await store.read('tokens.json'); token.expires_in = 'invalid'; await store.write('tokens.json', token);
  const result = await new GoToClient({ store }).authStatus();
  assert.equal(result.expires_at, null);
  assert.ok(!JSON.stringify(result).includes('test-access'));
  assert.ok(!JSON.stringify(result).includes('test-secret'));
});
test('MCP handshake exposes exactly three readonly tools and rejects write/invalid tools', async t => {
  const server = buildServer({ ...history([{ items: [] }]), authStatus: async () => ({ authorized: true }) });
  const client = new Client({ name: 'test', version: '1' });
  const [left, right] = InMemoryTransport.createLinkedPair();
  await server.connect(right); await client.connect(left);
  t.after(async () => { await client.close(); await server.close(); });
  const tools = (await client.listTools()).tools;
  assert.deepEqual(tools.map(t => t.name).sort(), ['goto_auth_status', 'goto_get_call_day', 'goto_get_identity']);
  assert.ok(tools.every(t => t.annotations.readOnlyHint && !t.annotations.destructiveHint));
  const result = await client.callTool({ name: 'goto_get_call_day', arguments: { work_date: '2026-10-27' } });
  assert.equal(JSON.parse(result.content[0].text).status, 'complete');
  const invalid = await client.callTool({ name: 'goto_get_call_day', arguments: { work_date: 'invalid' } });
  assert.equal(invalid.isError, true);
  const unknown = await client.callTool({ name: 'send_email', arguments: {} });
  assert.equal(unknown.isError, true);
});
test('authorization URL requires loopback and asks only for read scopes', () => {
  const url = new URL(authorizationUrl({ client_id: 'test', redirect_uri: 'http://127.0.0.1:12021/app/redirect' }, 'state'));
  assert.deepEqual(url.searchParams.get('scope').split(' '), READ_SCOPES);
  assert.throws(() => authorizationUrl({ redirect_uri: 'https://example.test/app/redirect' }, 'state'), /registered redirect/);
});
test('stdio starts through a symbolic-link launcher without bundled credentials', async t => {
  if (process.platform === 'win32') return t.skip('Windows symlink privileges differ; separate Windows acceptance is required');
  const store = await temporary(t);
  const alias = path.join(store.directory, 'server-alias.mjs');
  await fs.symlink(fileURLToPath(new URL('../src/server.mjs', import.meta.url)), alias);
  const client = new Client({ name: 'launch-test', version: '1' });
  t.after(() => client.close());
  await client.connect(new StdioClientTransport({ command: process.execPath, args: [alias], env: { ...process.env, GOTO_CONFIG_DIR: path.join(store.directory, 'empty-profile') }, stderr: 'pipe' }));
  assert.equal((await client.listTools()).tools.length, 3);
  const status = JSON.parse((await client.callTool({ name: 'goto_auth_status', arguments: {} })).content[0].text);
  assert.equal(status.authorized, false);
});
test('local OAuth callback rejects bad state including Unicode and retains tokens on denied consent', async t => {
  const store = await temporary(t);
  const old = await store.read('tokens.json');
  const probe = net.createServer();
  await new Promise(resolve => probe.listen(0, '127.0.0.1', resolve));
  const port = probe.address().port; await new Promise(resolve => probe.close(resolve));
  const config = await store.read('client.json'); config.redirect_uri = `http://127.0.0.1:${port}/app/redirect`; await store.write('client.json', config);
  let ready; const readyPromise = new Promise(resolve => { ready = resolve; });
  const operation = authorize({ store, reauthorize: true, lifetime: 5000, onReady: ready, fetcher: async () => { throw new Error('Unexpected token exchange'); } });
  const link = new URL(await readyPromise);
  const bad = new URL(config.redirect_uri); bad.searchParams.set('state', '汉'.repeat(43));
  assert.equal((await fetch(bad)).status, 400);
  const deny = new URL(config.redirect_uri); deny.searchParams.set('state', link.searchParams.get('state')); deny.searchParams.set('error', 'access_denied');
  const response = await fetch(deny); assert.equal(response.status, 400);
  assert.ok((await response.text()).includes('history.replaceState'));
  assert.equal((await operation).status, 'not_authorized');
  assert.deepEqual(await store.read('tokens.json'), old);
});
