/** POST /api/smFindReferral — search recent SmartMoving opportunities by affiliate / referral
 *  source, to find an off-portal referral that never synced (e.g. a realtor who referred a job
 *  but isn't tagged in the CRM). Read-only.
 *
 *  Body: { q: "Berard", pages?: 6 }
 *  Env: SMARTMOVING_API_KEY
 *  Returns: { ok, scanned, matches:[{id,customer,affiliate,serviceDate,status,total}], sampleKeys, lastError }
 */
import { endpoint, preflight } from '../_shared.js';

const SM_BASE = 'https://api-public.smartmoving.com/v1';
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

async function smGet(key, path) {
  try {
    const r = await fetch(SM_BASE + path, { headers: { 'x-api-key': key, Accept: 'application/json' } });
    const t = await r.text();
    let j; try { j = JSON.parse(t); } catch (e) { j = t; }
    return { ok: r.ok, status: r.status, body: j };
  } catch (e) { return { ok: false, status: 0, body: String((e && e.message) || e) }; }
}

function listFrom(body) {
  if (Array.isArray(body)) return body;
  if (!body || typeof body !== 'object') return [];
  return body.pageResults || body.data || body.opportunities || body.results || body.items || [];
}

function affOf(o) {
  var rs = o.referralSource;
  var rsName = rs ? (typeof rs === 'string' ? rs : (rs.name || rs.type || '')) : '';
  return [o.affiliateName, rsName, o.referralSourceName, o.affiliate && o.affiliate.name].filter(Boolean).join(' ');
}

const handler = endpoint(async (ctx) => {
  var env = ctx.env, body = ctx.body || {}, reply = ctx.reply;
  var key = env.SMARTMOVING_API_KEY;
  if (!key) return reply({ ok: false, error: 'sm_not_configured' }, 503);
  if (body.probe) {
    var cands = ['/api/customers', '/api/leads', '/api/opportunities', '/api/jobs', '/api/moves', '/api/referral-sources', '/api/referralsources', '/api/providers', '/api/branches'];
    var probe = [];
    for (var i = 0; i < cands.length; i++) {
      var pg = await smGet(key, cands[i] + '?Page=1&PageSize=3');
      var pl = listFrom(pg.body);
      probe.push({
        path: cands[i], status: pg.status,
        topKeys: (pg.body && typeof pg.body === 'object' && !Array.isArray(pg.body)) ? Object.keys(pg.body).slice(0, 12) : (Array.isArray(pg.body) ? 'array' : typeof pg.body),
        itemKeys: pl[0] ? Object.keys(pl[0]).slice(0, 30) : null,
      });
    }
    return reply({ ok: true, probe: probe });
  }

  var q = norm(body.q || '');
  var pages = Math.min(+body.pages || 10, 20);
  var path = body.path || '/api/customers';
  var matches = [], scanned = 0, sampleKeys = null, sampleOppKeys = null, lastError = null;

  for (var page = 1; page <= pages; page++) {
    var g = await smGet(key, path + (path.indexOf('?') >= 0 ? '&' : '?') + 'Page=' + page + '&PageSize=100');
    if (!g.ok) { lastError = { path: path, status: g.status, body: typeof g.body === 'string' ? g.body.slice(0, 200) : g.body }; break; }
    var list = listFrom(g.body);
    if (!sampleKeys && list[0]) sampleKeys = Object.keys(list[0]);
    if (!list.length) break;
    scanned += list.length;
    list.forEach(function (rec) {
      var opps = Array.isArray(rec.opportunities) ? rec.opportunities : [rec];
      opps.forEach(function (o) {
        if (!sampleOppKeys && rec.opportunities && o && typeof o === 'object') sampleOppKeys = Object.keys(o).slice(0, 35);
        var aff = [affOf(o), affOf(rec)].filter(Boolean).join(' ');
        if (q && norm(aff).indexOf(q) >= 0) {
          matches.push({
            customer: rec.name || rec.customerName || (o.customer && o.customer.name) || '',
            affiliate: aff,
            serviceDate: o.serviceDate || rec.serviceDate || null,
            status: o.status || o.leadStatus || rec.status || null,
            total: (o.estimatedTotal && (o.estimatedTotal.finalTotal || o.estimatedTotal.subtotal)) || o.total || null,
            oppId: o.id || null, customerId: rec.id || null,
          });
        }
      });
    });
    if (list.length < 100) break;
  }
  return reply({ ok: true, q: body.q || '', scanned: scanned, matchCount: matches.length, matches: matches, sampleKeys: sampleKeys, sampleOppKeys: sampleOppKeys, lastError: lastError });
});

export const onRequestPost = handler;
export const onRequestOptions = (ctx) => preflight(ctx.request);
