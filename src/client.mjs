import { PrivateStore, GoToError } from './store.mjs';

export const READ_SCOPES = ['cr.v1.read', 'users.v1.read', 'users.v1.lines.read'];
export const AUTHORIZE_URL = 'https://authentication.logmeininc.com/oauth/authorize';
export const TOKEN_URL = 'https://authentication.logmeininc.com/oauth/token';
const API_ORIGIN = 'https://api.goto.com';
const ALLOWED_PATHS = new Set(['/users/v1/me', '/users/v1/lines', '/call-history/v1/calls']);

export function tokenExpiresAt(token) {
  const expiry = Number(token?.obtained_at || 0) * 1000 + Number(token?.expires_in || 0) * 1000;
  return Number.isFinite(expiry) && Math.abs(expiry) <= 8.64e15 ? expiry : 0;
}

export class GoToClient {
  constructor({ store = new PrivateStore(), fetcher = globalThis.fetch, now = () => Date.now() } = {}) {
    this.store = store;
    this.fetcher = fetcher;
    this.now = now;
    this.refreshInFlight = null;
  }
  async authStatus() {
    const token = await this.store.read('tokens.json');
    const client = await this.store.read('client.json');
    const granted = typeof token?.scope === 'string' ? token.scope.split(/\s+/) : [];
    return {
      authorized: Boolean(token?.access_token), client_configured: Boolean(client?.client_id && client?.client_secret),
      principal: token?.principal || null,
      expires_at: tokenExpiresAt(token) ? new Date(tokenExpiresAt(token)).toISOString() : null,
      refresh_available: Boolean(token?.refresh_token),
      missing_read_scopes: token?.scope ? READ_SCOPES.filter(scope => !granted.includes(scope)) : null,
      business_operations: 'read_only_call_history',
      authorization_action: token?.access_token ? null : 'Run goto-auth locally and complete GoTo login/consent. Do not paste credentials into chat.',
    };
  }
  async token({ force = false, rejectedToken = null } = {}) {
    const current = await this.store.read('tokens.json');
    if (!current?.access_token) throw new GoToError('AUTH_REQUIRED', 'GoTo is not authorized on this computer. Run goto-auth locally. Other integrations are unaffected.');
    if (!force && this.now() < tokenExpiresAt(current) - 60_000) return current;
    if (!this.refreshInFlight) {
      this.refreshInFlight = this.store.withTokenLock(async () => {
        const latest = await this.store.read('tokens.json');
        if (!latest?.access_token) throw new GoToError('AUTH_REQUIRED', 'GoTo authorization is missing.');
        if ((!force || (rejectedToken && latest.access_token !== rejectedToken)) && this.now() < tokenExpiresAt(latest) - 60_000) return latest;
        if (!latest.refresh_token) throw new GoToError('REAUTH_REQUIRED', 'The GoTo authorization needs a new login; no refresh token is available.');
        const refreshed = await this.requestToken({ grant_type: 'refresh_token', refresh_token: latest.refresh_token });
        if (latest.principal && refreshed.principal && latest.principal.toLowerCase() !== refreshed.principal.toLowerCase()) {
          throw new GoToError('IDENTITY_CHANGED', 'GoTo returned a different identity during renewal; this read stopped.');
        }
        const replacement = {
          ...refreshed, refresh_token: refreshed.refresh_token || latest.refresh_token,
          scope: refreshed.scope ?? latest.scope, principal: refreshed.principal ?? latest.principal,
          obtained_at: this.now() / 1000,
        };
        await this.store.write('tokens.json', replacement);
        return replacement;
      }).finally(() => { this.refreshInFlight = null; });
    }
    return this.refreshInFlight;
  }
  async requestToken(parameters) {
    const config = await this.store.read('client.json');
    if (!config?.client_id || !config?.client_secret) throw new GoToError('CLIENT_CONFIG_REQUIRED', 'The local GoTo client configuration is missing. Keep client credentials outside repositories and chat.');
    let response;
    try {
      response = await this.fetcher(TOKEN_URL, {
        method: 'POST', redirect: 'manual', signal: AbortSignal.timeout(30_000),
        headers: { 'Authorization': `Basic ${Buffer.from(`${config.client_id}:${config.client_secret}`).toString('base64')}`, 'Content-Type': 'application/x-www-form-urlencoded', 'Accept': 'application/json' },
        body: new URLSearchParams(parameters).toString(),
      });
    } catch { throw new GoToError('AUTH_NETWORK_ERROR', 'Could not reach GoTo authorization. No credentials were logged.'); }
    if (!response.ok) {
      const needsLogin = [400, 401].includes(response.status);
      throw new GoToError(needsLogin ? 'REAUTH_REQUIRED' : 'AUTH_SERVICE_UNAVAILABLE',
        needsLogin ? 'GoTo rejected this authorization. Sign in again only for this connection; existing tokens were retained.'
          : 'GoTo authorization is temporarily unavailable. Retry later; existing tokens were retained.', response.status);
    }
    let body;
    try { body = await response.json(); } catch { throw new GoToError('INVALID_TOKEN_RESPONSE', 'GoTo returned an unreadable token response.'); }
    if (!body.access_token || (body.token_type && body.token_type.toLowerCase() !== 'bearer')) throw new GoToError('INVALID_TOKEN_RESPONSE', 'GoTo did not return a usable bearer token.');
    return body;
  }
  async get(apiPath, parameters = {}, retried = false) {
    if (!ALLOWED_PATHS.has(apiPath)) throw new GoToError('UNSUPPORTED_OPERATION', 'This release only exposes identity and call-history reads.');
    const token = await this.token();
    const url = new URL(apiPath, API_ORIGIN);
    for (const [key, value] of Object.entries(parameters)) if (value !== undefined && value !== null) url.searchParams.set(key, String(value));
    let response;
    try {
      response = await this.fetcher(url, { method: 'GET', redirect: 'manual', signal: AbortSignal.timeout(30_000), headers: { Authorization: `Bearer ${token.access_token}`, Accept: 'application/json' } });
    } catch { throw new GoToError('NETWORK_ERROR', 'The GoTo read failed or timed out. Its data is unknown, not empty.'); }
    if (response.status === 401 && !retried) {
      await this.token({ force: true, rejectedToken: token.access_token });
      return this.get(apiPath, parameters, true);
    }
    if (!response.ok) {
      const message = response.status === 403
        ? 'GoTo denied access to this scope. Cross-user call history requires GoTo Super Admin permission; this connector does not grant it.'
        : response.status === 429 ? 'GoTo rate-limited this read. Retry later; partial results are not complete.'
          : 'GoTo could not return the requested data. This is not an empty result.';
      throw new GoToError(response.status === 403 ? 'ACCESS_DENIED' : 'API_READ_FAILED', message, response.status);
    }
    try { return await response.json(); }
    catch { throw new GoToError('INVALID_API_RESPONSE', 'GoTo returned unreadable data. This read is incomplete.'); }
  }
  async identity() {
    const token = await this.token();
    const errors = [];
    const read = async (endpoint) => {
      try {
        const data = await this.get(endpoint);
        if (!Array.isArray(data.items)) throw new GoToError('INVALID_API_RESPONSE', 'GoTo identity response has no items array.');
        return data.items;
      } catch (error) { errors.push({ endpoint, ...(error instanceof GoToError ? error.publicResult() : { code: 'READ_FAILED' }) }); return null; }
    };
    const [accounts, lines] = await Promise.all([read('/users/v1/me'), read('/users/v1/lines')]);
    return { principal: token.principal || null, accounts, lines,
      provenance: { retrieved_at: new Date(this.now()).toISOString(), access_errors: errors, complete: errors.length === 0 } };
  }
}
