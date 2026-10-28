#!/usr/bin/env node
import http from 'node:http';
import crypto from 'node:crypto';
import { PrivateStore, GoToError, isMain } from './store.mjs';
import { GoToClient, READ_SCOPES, AUTHORIZE_URL } from './client.mjs';

export function authorizationUrl(config, state) {
  const callback = new URL(config.redirect_uri);
  if (callback.protocol !== 'http:' || callback.hostname !== '127.0.0.1' || callback.pathname !== '/app/redirect' || callback.search || callback.hash) {
    throw new GoToError('INVALID_CALLBACK', 'The registered redirect must be http://127.0.0.1:<port>/app/redirect.');
  }
  const url = new URL(AUTHORIZE_URL);
  url.search = new URLSearchParams({ client_id: config.client_id, response_type: 'code', redirect_uri: config.redirect_uri, state, scope: READ_SCOPES.join(' ') }).toString();
  return url.toString();
}
export async function authorize({ store = new PrivateStore(), reauthorize = false, lifetime = 900000, onReady = url => console.log(`Open this GoTo authorization link and complete login/consent:\n${url}`), fetcher = globalThis.fetch } = {}) {
  if (await store.read('tokens.json') && !reauthorize) return { status: 'already_authorized', message: 'Existing authorization retained. Use --reauthorize only when intentionally signing in again.' };
  const config = await store.read('client.json');
  if (!config?.client_id || !config?.client_secret || !config?.redirect_uri) throw new GoToError('CLIENT_CONFIG_REQUIRED', 'Create private client.json as described in README; do not paste credentials into chat.');
  const state = crypto.randomBytes(32).toString('base64url');
  const url = authorizationUrl(config, state);
  const callback = new URL(config.redirect_uri);
  const client = new GoToClient({ store, fetcher });
  return new Promise((resolve, reject) => {
    let consumed = false, finished = false;
    const expiresAt = Date.now() + lifetime;
    const finish = (value, error = false) => { if (finished) return; finished = true; clearTimeout(timer); server.close(); error ? reject(value) : resolve(value); };
    const server = http.createServer(async (request, response) => {
      const reply = (status, text) => {
        // Clear the authorization code from the address bar after the callback.
        response.writeHead(status, { 'Content-Type': 'text/html; charset=utf-8', 'Cache-Control': 'no-store', 'Referrer-Policy': 'no-referrer', 'X-Content-Type-Options': 'nosniff', 'Content-Security-Policy': "default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" });
        response.end(`<!doctype html><title>GoTo authorization</title><script>history.replaceState(null,'','/authorization-result')</script><p>${text}</p>`);
      };
      const parsed = new URL(request.url, 'http://127.0.0.1');
      if (request.method !== 'GET' || request.headers.host !== callback.host || parsed.pathname !== callback.pathname) { reply(404, 'Not found'); return; }
      const supplied = parsed.searchParams.getAll('state');
      if (finished || Date.now() >= expiresAt) { reply(400, 'This authorization has expired.'); return; }
      if (supplied.length !== 1 || Buffer.byteLength(supplied[0]) !== Buffer.byteLength(state) || !crypto.timingSafeEqual(Buffer.from(supplied[0]), Buffer.from(state))) { reply(400, 'Authorization state did not match. Return to Codex.'); return; }
      if (consumed) { reply(400, 'This authorization has already been handled.'); return; }
      consumed = true;
      if (parsed.searchParams.has('error')) { reply(400, 'GoTo authorization was not granted.'); finish({ status: 'not_authorized' }); return; }
      const codes = parsed.searchParams.getAll('code');
      if (codes.length !== 1 || !codes[0]) { reply(400, 'No authorization code was returned.'); finish({ status: 'not_authorized' }); return; }
      try {
        const token = await client.requestToken({ grant_type: 'authorization_code', code: codes[0], redirect_uri: config.redirect_uri });
        token.obtained_at = Date.now() / 1000;
        await store.withTokenLock(() => store.write('tokens.json', token));
        reply(200, 'GoTo authorization completed. Return to Codex. No calls, messages or emails were sent.');
        finish({ status: 'authorized', principal: token.principal || null, refresh_available: Boolean(token.refresh_token) });
      } catch { reply(502, 'Authorization could not be completed. Return to Codex; do not share the callback URL.'); finish(new GoToError('AUTHORIZATION_FAILED', 'GoTo authorization failed; existing tokens were retained.'), true); }
    });
    const timer = setTimeout(() => finish(new GoToError('AUTHORIZATION_EXPIRED', 'The local authorization link expired. Run the command again.'), true), lifetime);
    server.on('error', () => finish(new GoToError('CALLBACK_UNAVAILABLE', 'Could not start the loopback callback. Check whether its port is in use.'), true));
    server.listen(Number(callback.port || 80), '127.0.0.1', () => onReady(url));
  });
}
if (isMain(import.meta.url)) {
  try { console.log(JSON.stringify(await authorize({ reauthorize: process.argv.includes('--reauthorize') }))); }
  catch (error) { console.error(JSON.stringify(error instanceof GoToError ? error.publicResult() : { code: 'AUTHORIZATION_FAILED' })); process.exitCode = 1; }
}
