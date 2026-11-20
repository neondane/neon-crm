import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';

// neon-api modules are ESM written as .js. Node loads those as ESM only when
// module detection is on, so re-run once under that flag and then continue.
if (!process.execArgv.includes('--experimental-detect-module')) {
  const r = spawnSync(process.execPath, ['--experimental-detect-module', ...process.execArgv, process.argv[1], ...process.argv.slice(2)], { stdio: 'inherit' });
  process.exit(r.status == null ? 1 : r.status);
}

const { PAYOUT_ALERT_DAYS, HISTORICAL_PAYOUT_NOTE, payoutAlertDecision, payoutAlertLookup, appendHistoricalNote } = await import('../neon-api/functions/_payoutGate.js');
const { onRequestPost: webhook } = await import('../neon-api/functions/api/smartmovingWebhook.js');
const { onRequestPost: reconcile } = await import('../neon-api/functions/api/reconcileSmartMoving.js');
const { resetPushContext } = await import('../neon-api/functions/_push.js');

const TODAY = '2026-11-20';
const day = (iso, delta) => {
  const [y, m, d] = iso.split('-').map(Number);
  const dt = new Date(Date.UTC(y, m - 1, d));
  dt.setUTCDate(dt.getUTCDate() + delta);
  return dt.toISOString().slice(0, 10);
};
const daysAgo = (n) => new Date(Date.now() - n * 864e5).toISOString().slice(0, 10);

function decide(over) {
  return payoutAlertDecision({
    date: TODAY, amount: 2500, partner: 'Jamie Alvarez', contactEmail: 'jamie@example.com', skipped: false, paid: false, ...over,
  }, TODAY);
}

assert.equal(PAYOUT_ALERT_DAYS, 14);
assert.equal(decide().ok, true);
assert.equal(decide({ date: day(TODAY, -14) }).ok, true, 'move on the 14th day back still alerts');
assert.equal(decide({ date: day(TODAY, -15) }).ok, false);
assert.equal(decide({ date: day(TODAY, -15) }).reason, 'too_old');
assert.equal(decide({ date: day(TODAY, 1) }).ok, false);
assert.equal(decide({ date: '' }).ok, false);
assert.equal(decide({ date: null }).ok, false);
assert.equal(decide({ amount: 0 }).ok, false);
assert.equal(decide({ amount: '0' }).ok, false);
assert.equal(decide({ amount: '$0' }).ok, false);
assert.equal(decide({ amount: -20 }).ok, false);
assert.equal(decide({ amount: '$1,500.50' }).ok, true);
for (const partner of ['Dane', 'Dane Olson', 'Neon Giant', 'neon giant moving', 'Internal', 'Self', 'Employee']) {
  assert.equal(decide({ partner }).ok, false, partner);
}
assert.equal(decide({ partner: 'Danelle Cho' }).ok, true);
assert.equal(decide({ partner: '   ' }).ok, false);
assert.equal(decide({ partner: '' }).ok, false);
assert.equal(decide({ contactEmail: 'riley@neongiantmoving.com' }).ok, false);
assert.equal(decide({ contactEmail: 'Riley@NeonGiantMoving.com' }).ok, false);
assert.equal(decide({ contactEmail: 'riley@gmail.com' }).ok, true);
assert.equal(decide({ skipped: true }).ok, false);
assert.equal(decide({ paid: true }).ok, false);

const oldNote = appendHistoricalNote('[SM:1] booked | live->completed', day(TODAY, -100), TODAY);
assert.ok(oldNote.endsWith(HISTORICAL_PAYOUT_NOTE));
assert.equal(appendHistoricalNote(oldNote, day(TODAY, -100), TODAY), oldNote);
assert.equal(appendHistoricalNote('recent', day(TODAY, -14), TODAY), 'recent');
assert.equal(appendHistoricalNote('future', day(TODAY, 2), TODAY), 'future');

const down = { select: async () => { throw new Error('db down'); } };
const failed = await payoutAlertLookup(down, { date: TODAY, amount: 100, partner: 'Jamie Alvarez', contactId: '1', referralId: 9 }, TODAY);
assert.equal(failed.ok, false);
assert.equal(failed.reason, 'lookup_failed');
const weird = { select: async () => ({ message: 'nope' }) };
assert.equal((await payoutAlertLookup(weird, { date: TODAY, amount: 100, partner: 'Jamie Alvarez', contactId: '1', referralId: 9 }, TODAY)).ok, false);

const LEDGER = new Set(['payout_skips', 'paid_referrals', 'payout_queue', 'payouts']);
const SKIP_PARAMS = new Set(['select', 'order', 'limit', 'on_conflict']);

function matchOp(row, expr) {
  const m = /^([A-Za-z0-9_]+)\.(eq|neq|gte|gt|lte|lt|ilike|is|in|not\.in)\.(.*)$/.exec(expr);
  if (!m) return true;
  const value = row[m[1]];
  const text = value == null ? '' : String(value);
  const raw = m[3];
  if (m[2] === 'eq') return raw === 'true' ? value === true || text === 'true' : text === raw;
  if (m[2] === 'neq') return text !== raw;
  if (m[2] === 'gte') return text >= raw;
  if (m[2] === 'gt') return text > raw;
  if (m[2] === 'lte') return text <= raw;
  if (m[2] === 'lt') return text < raw;
  if (m[2] === 'is') return raw === 'null' ? value == null : text === raw;
  if (m[2] === 'in') return raw.replace(/^\(/, '').replace(/\)$/, '').split(',').includes(text);
  if (m[2] === 'not.in') return !raw.replace(/^\(/, '').replace(/\)$/, '').split(',').includes(text);
  if (m[2] === 'ilike') {
    const pattern = raw.replace(/[.+?^${}()|[\]\\]/g, '\\$&').replaceAll('\\*', '.*');
    return new RegExp('^' + pattern + '$', 'i').test(text);
  }
  return true;
}

function matchFilter(row, field, value) {
  if (field === 'or') {
    const inner = String(value || '').replace(/^\(/, '').replace(/\)$/, '');
    return inner.split(',').some((part) => matchOp(row, part));
  }
  return matchOp(row, field + '.' + value);
}

function jsonResponse(body, status = 200) {
  const text = JSON.stringify(body);
  return { ok: status >= 200 && status < 300, status, json: async () => JSON.parse(text), text: async () => text };
}

function makeWorld(spec) {
  const contact = { id: 1, name: spec.partner, business: '', email: spec.email || 'jamie@example.com', portalActivatedAt: null };
  const referral = {
    id: spec.refId, contactId: contact.id, contactName: spec.partner, status: spec.from,
    notes: '[SM:' + spec.oppId + '] existing', jobName: spec.customer, amount: '2500', date: spec.move,
  };
  const tables = {
    contacts: [contact],
    referrals: [referral],
    payout_skips: spec.skip ? [{ key: 'manual:' + spec.refId }] : [],
    paid_referrals: spec.paid ? [{ key: 'manual:' + spec.refId }] : [],
    payout_queue: [],
    payouts: [],
    notifications: [],
    app_settings: [],
    app_secrets: [],
    notify_prefs: [],
    push_subscriptions: [],
    webhook_endpoints: [],
    portal_leads: [],
  };
  const ledgerWrites = [];
  const opp = {
    id: spec.oppId,
    status: spec.smStatus == null ? 10 : spec.smStatus,
    affiliateName: spec.partner,
    serviceDate: spec.move,
    customer: { name: spec.customer },
    estimatedTotal: { finalTotal: spec.amount },
    jobs: [{ id: spec.oppId + '-job', actualCharges: spec.amount > 0 ? [{ name: 'Moving Labor', totalCost: spec.amount }] : [] }],
  };
  const fetchImpl = async (url, opts = {}) => {
    const u = new URL(url);
    if (u.hostname === 'api-public.smartmoving.com') {
      const found = decodeURIComponent((u.pathname.match(/\/api\/opportunities\/([^/]+)/) || [])[1] || '');
      if (found !== spec.oppId) return jsonResponse({ message: 'missing opp' }, 404);
      return jsonResponse(opp);
    }
    if (u.hostname !== 'fake.supabase.co') throw new Error('unexpected fetch ' + url);
    const table = u.pathname.replace(/^\/rest\/v1\//, '').split('?')[0];
    const method = String(opts.method || 'GET').toUpperCase();
    if (LEDGER.has(table) && method !== 'GET') ledgerWrites.push(method + ' ' + table);
    const rows = tables[table] || (tables[table] = []);
    const filters = [];
    let limit = null;
    let order = null;
    for (const [key, value] of u.searchParams.entries()) {
      if (key === 'limit') limit = Number(value);
      else if (key === 'order') order = value;
      else if (!SKIP_PARAMS.has(key)) filters.push([key, value]);
    }
    const matched = () => rows.filter((row) => filters.every(([key, value]) => matchFilter(row, key, value)));
    if (method === 'GET') {
      let out = matched().map((row) => ({ ...row }));
      if (order) {
        const [field, dir] = order.split('.');
        out.sort((a, b) => (a[field] > b[field] ? 1 : a[field] < b[field] ? -1 : 0) * (dir === 'desc' ? -1 : 1));
      }
      if (limit != null) out = out.slice(0, limit);
      return jsonResponse(out);
    }
    if (method === 'PATCH') {
      const hits = matched();
      const patch = JSON.parse(opts.body || '{}');
      hits.forEach((row) => Object.assign(row, patch));
      return jsonResponse(hits.map((row) => ({ ...row })));
    }
    if (method === 'POST') {
      const row = { ...JSON.parse(opts.body || '{}') };
      if (table === 'notifications' && row.source_key && rows.some((n) => n.source_key === row.source_key)) return jsonResponse([]);
      if (row.id == null) row.id = rows.reduce((max, item) => Math.max(max, Number(item.id) || 0), 0) + 1;
      rows.push(row);
      return jsonResponse([{ ...row }]);
    }
    return jsonResponse({ message: 'method' }, 405);
  };
  return { tables, ledgerWrites, fetchImpl };
}

const env = { SUPABASE_URL: 'https://fake.supabase.co', SUPABASE_KEY: 'test-key', SMARTMOVING_API_KEY: 'sm-test' };

async function call(world, path, body) {
  const prev = globalThis.fetch;
  globalThis.fetch = world.fetchImpl;
  resetPushContext();
  try {
    const request = new Request('https://neon-api.pages.dev' + path, {
      method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(body),
    });
    const handler = path.endsWith('reconcileSmartMoving') ? reconcile : webhook;
    const res = await handler({ request, env });
    return await res.json();
  } finally {
    globalThis.fetch = prev;
  }
}

function alerts(world, event) {
  return world.tables.notifications.filter((n) => n.event === event);
}

async function runCase(via, spec) {
  const world = makeWorld(spec);
  const customer = spec.customer;
  if (via === 'reconcile') {
    const dry = await call(world, '/api/reconcileSmartMoving', { ids: [spec.oppId], alerts: true, dry: true });
    assert.equal(dry.ok, true, spec.name + ' dry ' + JSON.stringify(dry));
    assert.equal(world.tables.referrals[0].status, spec.from, spec.name + ' dry wrote status');
    assert.equal(world.tables.notifications.length, 0, spec.name + ' dry alerted');
    assert.deepEqual(world.ledgerWrites, [], spec.name + ' dry touched a payout table');
  }
  const body = via === 'reconcile'
    ? await call(world, '/api/reconcileSmartMoving', { ids: [spec.oppId], alerts: true })
    : await call(world, '/api/smartmovingWebhook', { 'opportunity-id': spec.oppId });
  assert.equal(body.ok, true, spec.name + ' ' + via + ' ' + JSON.stringify(body));
  const row = world.tables.referrals[0];
  assert.equal(world.tables.referrals.length, 1, spec.name + ' ' + via + ' created another referral');
  assert.equal(row.status, spec.status, spec.name + ' ' + via + ' status');
  if (spec.historical) assert.ok(String(row.notes).includes(HISTORICAL_PAYOUT_NOTE), row.notes);
  else assert.equal(String(row.notes).includes(HISTORICAL_PAYOUT_NOTE), false, row.notes);
  const want = spec.event;
  const completed = alerts(world, 'job_completed');
  const booked = alerts(world, 'job_booked');
  if (want === 'job_completed') {
    assert.equal(completed.length, 1, spec.name + ' ' + via);
    assert.equal(booked.length, 0);
    assert.equal(completed[0].title, 'Completed: ' + customer);
    const phrase = via === 'reconcile' ? 'Their payout may be due.' : 'Their payout is due.';
    assert.equal(completed[0].body, 'Referred by ' + spec.partner + '. ' + phrase);
  } else if (want === 'job_booked') {
    assert.equal(booked.length, 1, spec.name + ' ' + via);
    assert.equal(completed.length, 0);
    assert.equal(booked[0].title, 'Booked: ' + customer);
    assert.equal(booked[0].body, 'Referred by ' + spec.partner + '.');
  } else {
    assert.equal(completed.length, 0, spec.name + ' ' + via + ' alerted: ' + JSON.stringify(completed));
    assert.equal(booked.length, 0, spec.name + ' ' + via + ' booked alert');
  }
  assert.deepEqual(world.ledgerWrites, [], spec.name + ' ' + via + ' wrote a payout table');
}

const cases = [
  { name: '100-day', days: 100, amount: 2500, partner: 'Jamie Alvarez', from: 'booked', status: 'completed', historical: true, event: null },
  { name: '3-day', days: 3, amount: 2500, partner: 'Jamie Alvarez', from: 'booked', status: 'completed', historical: false, event: 'job_completed' },
  { name: 'zero', days: 3, amount: 0, partner: 'Jamie Alvarez', from: 'booked', status: 'completed', historical: false, event: null },
  { name: 'internal', days: 3, amount: 2500, partner: 'Neon Giant', email: 'studio@gmail.com', from: 'booked', status: 'completed', historical: false, event: null },
  { name: 'staff-email', days: 3, amount: 2500, partner: 'Riley Chen', email: 'riley@neongiantmoving.com', from: 'booked', status: 'completed', historical: false, event: null },
  { name: 'skipped', days: 3, amount: 2500, partner: 'Jamie Alvarez', from: 'booked', skip: true, status: 'completed', historical: false, event: null },
  { name: 'paid', days: 3, amount: 2500, partner: 'Jamie Alvarez', from: 'booked', paid: true, status: 'completed', historical: false, event: null },
  { name: 'duplicate', days: 3, amount: 2500, partner: 'Jamie Alvarez', from: 'duplicate', status: 'duplicate', historical: false, event: null },
  { name: 'lost', days: 3, amount: 2500, partner: 'Jamie Alvarez', from: 'lost', status: 'lost', historical: false, event: null },
  { name: 'booked', days: 0, amount: 2500, partner: 'Jamie Alvarez', from: 'referred', smStatus: 4, status: 'booked', historical: false, event: 'job_booked' },
];

let n = 0;
for (const spec of cases) {
  n += 1;
  const full = { ...spec, refId: 280 + n, oppId: 'opp-' + spec.name, customer: spec.name + ' Customer', move: daysAgo(spec.days) };
  await runCase('webhook', full);
  await runCase('reconcile', full);
}

// Inside the 14-day gate, but outside reconcile's existing 3-day window.
const ten = {
  name: '10-day', days: 10, amount: 2500, partner: 'Jamie Alvarez', from: 'booked', status: 'completed',
  historical: false, refId: 310, oppId: 'opp-10-day', customer: 'Ten Day Customer', move: daysAgo(10),
};
await runCase('webhook', { ...ten, event: 'job_completed' });
await runCase('reconcile', { ...ten, event: null });

console.log('payout alert cutoff tests passed');
