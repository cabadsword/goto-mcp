import crypto from 'node:crypto';
import { GoToError } from './store.mjs';

export function validDate(value) {
  return typeof value === 'string' && /^\d{4}-\d{2}-\d{2}$/.test(value)
    && Number.isFinite(Date.parse(`${value}T00:00:00Z`)) && new Date(`${value}T00:00:00Z`).toISOString().slice(0, 10) === value;
}
function dateParts(value, zone) {
  const format = new Intl.DateTimeFormat('en-CA', { timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', hourCycle: 'h23' });
  return Object.fromEntries(format.formatToParts(value).filter(x => x.type !== 'literal').map(x => [x.type, x.value]));
}
export function dateInZone(value, zone) {
  if (typeof value !== 'string' || !/(?:Z|[+-]\d{2}:\d{2})$/i.test(value)) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.valueOf())) return null;
  const parts = dateParts(date, zone);
  return `${parts.year}-${parts.month}-${parts.day}`;
}
export function midnightUtc(day, zone = 'America/Los_Angeles') {
  if (!validDate(day)) throw new GoToError('INVALID_DATE', 'Use a real work date in YYYY-MM-DD format.');
  const target = Date.parse(`${day}T00:00:00Z`);
  let guess = target;
  for (let i = 0; i < 6; i++) {
    let parts;
    try { parts = dateParts(new Date(guess), zone); }
    catch { throw new GoToError('INVALID_TIMEZONE', 'Use a valid IANA timezone.'); }
    const localAsUtc = Date.UTC(+parts.year, +parts.month - 1, +parts.day, +parts.hour, +parts.minute, +parts.second);
    const difference = target - localAsUtc;
    if (difference === 0) return new Date(guess).toISOString();
    guess += difference;
  }
  throw new GoToError('INVALID_DAY_BOUNDARY', 'Could not resolve this local midnight.');
}
export function dayRange(day, zone = 'America/Los_Angeles') {
  if (!validDate(day)) throw new GoToError('INVALID_DATE', 'Use a real work date in YYYY-MM-DD format.');
  const next = new Date(Date.parse(`${day}T00:00:00Z`) + 86400000).toISOString().slice(0, 10);
  return { startTime: midnightUtc(day, zone), endTime: midnightUtc(next, zone) };
}
export function normalizePhone(value) {
  if (typeof value !== 'string') return null;
  const main = value.split(/\s*(?:ext\.?|extension|x|#)\s*\d+\s*$/i)[0];
  if (!/^[\d\s+().-]+$/.test(main)) return null;
  let number = main.replace(/\D/g, '');
  if (number.length === 11 && number.startsWith('1')) return `+${number}`;
  if (number.length === 10) return `+1${number}`;
  if (/^\s*\+/.test(main) && number.length >= 8 && number.length <= 15) return `+${number}`;
  return null; // A short internal extension is not a public phone number.
}
export function normalizeCall(raw, { zone, workDate, knownLocalNumbers = [], knownExtensions = [] }) {
  const local = new Set(knownLocalNumbers.map(normalizePhone).filter(Boolean));
  const callerNumber = raw.caller?.number;
  const calleeNumber = raw.callee?.number;
  const external = [...new Set([callerNumber, calleeNumber].map(normalizePhone).filter(n => n && !local.has(n)))];
  const warnings = [];
  if (!raw.legId) warnings.push('MISSING_SOURCE_ID');
  if (dateInZone(raw.startTime, zone) !== workDate) warnings.push('CALL_OUTSIDE_REQUESTED_LOCAL_DATE');
  if (knownExtensions.includes(callerNumber) && normalizePhone(calleeNumber) && raw.direction === 'INBOUND') warnings.push('DIRECTION_PARTICIPANT_MISMATCH');
  const duration = typeof raw.duration === 'number' && Number.isFinite(raw.duration) && raw.duration >= 0 ? raw.duration : null;
  return {
    source: 'goto_call_history', source_id: raw.legId || null, originator_id: raw.originatorId || null,
    started_at: raw.startTime || null, answered_at: raw.answerTime || null,
    work_date: dateInZone(raw.startTime, zone), answered: Boolean(raw.answerTime && Number.isFinite(Date.parse(raw.answerTime))),
    duration_ms: duration, duration_seconds: duration === null ? null : duration / 1000,
    duration_basis: 'call_leg_duration_not_billable_time', direction_raw: raw.direction || null,
    caller: raw.caller || null, callee: raw.callee || null, owner_phone_number: raw.ownerPhoneNumber || null,
    external_numbers: external, hangup_cause: raw.hangupCause ?? null,
    user_key: raw.userKey || null, account_key: raw.accountKey || null, warnings,
  };
}

export async function getCallDay(client, { work_date, timezone = 'America/Los_Angeles', account_key, user_key, extension, page_size = 100, max_pages = 20 }) {
  const range = dayRange(work_date, timezone);
  const identity = await client.identity();
  let account = account_key;
  if (!account) {
    if (!identity.accounts) throw new GoToError('ACCOUNT_UNAVAILABLE', 'Could not discover GoTo accounts. Supply a verified account key or retry the identity read.');
    if (identity.accounts.length !== 1) throw new GoToError('ACCOUNT_SELECTION_REQUIRED', 'Choose an account key from goto_get_identity; no account was selected automatically.');
    account = identity.accounts[0].accountKey;
  }
  const base = { accountKey: account, ...range, pageSize: page_size };
  if (user_key) base.userKey = user_key;
  if (extension) base.extension = extension;
  const subject = user_key ? { kind: 'specified_user', user_key, account_key: account, principal: null }
    : { kind: 'authenticated_user', principal: identity.principal, account_key: account };
  const localNumbers = (identity.accounts || []).filter(a => a.accountKey === account).flatMap(a => (a.outboundPhoneNumbers || []).map(n => n.number));
  const extensions = extension ? [extension] : user_key ? [] : (identity.lines || []).filter(l => l.accountKey === account).map(l => l.number);
  const raw = [], pages = [], errors = [], seenMarkers = new Set(), seenLegs = new Map();
  let marker = null, complete = false;
  for (let index = 0; index < max_pages; index++) {
    const parameters = { ...base, ...(marker ? { pageMarker: marker } : {}) };
    let result;
    try { result = await client.get('/call-history/v1/calls', parameters); }
    catch (error) { errors.push(error instanceof GoToError ? error.publicResult() : { code: 'READ_FAILED' }); break; }
    if (!result || !Array.isArray(result.items)) { errors.push({ code: 'INVALID_API_RESPONSE' }); break; }
    const next = result.nextPageMarker || null;
    pages.push({ retrieved_at: new Date(client.now()).toISOString(), request_page_marker: marker, next_page_marker: next, item_count: result.items.length });
    for (const row of result.items) {
      if (!row || typeof row !== 'object' || Array.isArray(row)) { errors.push({ code: 'INVALID_CALL_RECORD' }); continue; }
      if (row.legId && seenLegs.has(row.legId)) {
        if (JSON.stringify(row) !== seenLegs.get(row.legId)) errors.push({ code: 'CONFLICTING_DUPLICATE_LEG' });
        continue;
      }
      if (row.legId) seenLegs.set(row.legId, JSON.stringify(row));
      raw.push(row);
    }
    if (!next) { complete = errors.length === 0; break; }
    if (seenMarkers.has(next)) { errors.push({ code: 'REPEATED_PAGE_MARKER' }); break; }
    seenMarkers.add(next); marker = next;
  }
  if (!complete && !errors.length) errors.push({ code: 'PAGE_LIMIT_REACHED' });
  const calls = raw.map(row => normalizeCall(row, { zone: timezone, workDate: work_date, knownLocalNumbers: localNumbers, knownExtensions: extensions }));
  if (calls.some(row => row.warnings.includes('CALL_OUTSIDE_REQUESTED_LOCAL_DATE') || !row.source_id)) {
    errors.push({ code: 'CALL_RECORD_QUALITY_ERROR' }); complete = false;
  }
  return {
    work_date, timezone, subject, calls,
    status: complete ? 'complete' : calls.length ? 'partial' : 'unavailable',
    provenance: { read_id: crypto.randomUUID(), retrieved_at: new Date(client.now()).toISOString(), source_endpoint: '/call-history/v1/calls',
      filters: base, all_pages_complete: complete, pages, access_errors: errors, identity_warnings: identity.provenance.access_errors },
    limitations: ['Durations describe call legs, not billable hours.', 'Direction and participant fields are preserved, not guessed.', 'Cross-employee authorization has not been live-tested in this release.'],
  };
}
