/** POST /api/smartmovingWebhook — SmartMoving fires { "opportunity-id": "<id>" } on
 *  Opportunity Created / Status Changed / Changed / Deleted.
 *
 *  Flow: fetch the full opportunity from SmartMoving's API, classify its stage,
 *  and write DIRECTLY to Supabase (no Apps Script):
 *    - Affiliate-tagged (opp.affiliateName / referralSource) → match the affiliate to a
 *      CRM contact and create/advance a row in `referrals` (deduped by [SM:<oppId>]).
 *    - No affiliate → advance a matching `portal_leads` row by customer name/phone.
 *  Never sends money; payouts stay human-initiated in the CRM. Only ever advances a status.
 *
 *  Env: SUPABASE_URL, SUPABASE_KEY, SMARTMOVING_API_KEY, SMARTMOVING_WEBHOOK_SECRET? */
import { endpoint, preflight, sb } from '../_shared.js';

const SM_BASE = 'https://api-public.smartmoving.com/v1';
const GENERIC = /google|yelp|\bweb\b|website|online|bing|drive.?by|signage|sign\b|past customer|return(ing)? customer|repeat customer|former customer|facebook|instagram|social|yard sign|billboard|angi|thumbtack|home.?advisor|walk.?in|truck|wrap|\bnone\b|^n\/?a$|^other$|unknown|search engine/i;
const RANK = { referred: 1, booked: 2, completed: 3 };
const PRANK = { 'new': 0, contacted: 1, booked: 2, completed: 3, lost: 0 };

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function fmtDate(d) {
  const s = String(d || '');
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? new Date().toISOString().slice(0, 10) : dt.toISOString().slice(0, 10);
}
function classifyStage(o) {
  // Read BOTH the sales leadStatus and the opportunity status — SmartMoving shows
  // "Booked" on opp.status even while leadStatus is still "New Lead".
  const blob = (String(o.leadStatus || '') + ' ' + String(o.status || '') + ' ' + String(o.jobStatus || '')).toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  const svc = fmtDate(o.serviceDate);
  const paid = Array.isArray(o.payments) && o.payments.some((p) => Number(p && (p.amount || p.total || p.value)) > 0);
  if (/complet|moved|finished|delivered|closed won|paid in full/.test(blob)) return 'completed';
  if (o.serviceDate && svc < today && paid) return 'completed';
  if (/book|confirm|scheduled|deposit|\bwon\b/.test(blob)) return 'booked';
  return 'referred';
}
function partnerOf(o) {
  if (o.affiliateName && String(o.affiliateName).trim()) return String(o.affiliateName).trim();
  const rs = o.referralSource || o.referralSourceName;
  let name = '';
  if (rs) { if (typeof rs === 'string') name = rs.trim(); else if (typeof rs === 'object' && (rs.name || rs.type)) name = String(rs.name || rs.type).trim(); }
  if (!name || GENERIC.test(name)) return '';
  return name;
}
function matchContact(partner, contacts) {
  const t = norm(partner); if (!t) return null;
  let m = contacts.find((c) => norm(c.name) === t || norm(c.business) === t);
  if (m) return m;
  if (t.length > 4) {
    m = contacts.find((c) => { const n = norm(c.name); return n.length > 4 && (n.indexOf(t) >= 0 || t.indexOf(n) >= 0); });
    if (m) return m;
    m = contacts.find((c) => { const b = norm(c.business); return b.length > 4 && (b.indexOf(t) >= 0 || t.indexOf(b) >= 0); });
    if (m) return m;
  }
  return null;
}
async function smGet(key, path) {
  try {
    const r = await fetch(SM_BASE + path, { headers: { 'x-api-key': key, Accept: 'application/json' } });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, body: await r.json() };
  } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
}

const handler = endpoint(async ({ request, env, body, reply }) => {
  if (env.SMARTMOVING_WEBHOOK_SECRET) {
    const url = new URL(request.url);
    const got = url.searchParams.get('secret') || request.headers.get('x-webhook-secret') || request.headers.get('x-ng-secret') || '';
    if (got !== env.SMARTMOVING_WEBHOOK_SECRET) return reply({ ok: false, error: 'unauthorized' }, 401);
  }

  const p = body || {};
  const oppId = p['opportunity-id'] || p.opportunityId || p.opportunityID || p.id || '';
  if (!oppId) return reply({ ok: true, received: true, note: 'no opportunity id' });
  const key = env.SMARTMOVING_API_KEY;
  if (!key) return reply({ ok: false, error: 'sm_not_configured' }, 503);

  const g = await smGet(key, '/api/opportunities/' + encodeURIComponent(oppId));
  if (!g.ok) return reply({ ok: true, oppId, fetched: false, status: g.status || g.err });
  const opp = g.body;
  const stage = classifyStage(opp);
  const partner = partnerOf(opp);
  const cust = (opp.customer && (opp.customer.name || opp.customer.fullName)) || 'SmartMoving job';
  const phone = String((opp.customer && (opp.customer.phoneNumber || opp.customer.phone || opp.customer.mobile)) || '').replace(/\D/g, '');
  const amount = Number((opp.estimatedTotal && (opp.estimatedTotal.finalTotal || opp.estimatedTotal.subtotal)) || 0) || 0;
  const date = fmtDate(opp.serviceDate);
  const lead = opp.leadStatus || stage;
  const db = sb(env);

  // --- No affiliate: advance a matching portal lead by name/phone ---
  if (!partner) {
    try {
      const leads = await db.select('portal_leads?select=id,customerName,customerPhone,status,realtorName');
      const nc = norm(cust);
      const cands = (leads || []).filter((l) => {
        const ln = norm(l.customerName); const lp = String(l.customerPhone || '').replace(/\D/g, '');
        const nameHit = !!(nc && ln && ln === nc);
        const phoneHit = !!(phone.length >= 7 && lp.length >= 7 && lp.slice(-10) === phone.slice(-10));
        return nameHit || phoneHit;
      });
      if (cands.length !== 1) return reply({ ok: true, oppId, affiliate: null, portal: 'no-unique-match', candidates: cands.length });
      const L = cands[0];
      const cur = PRANK[String(L.status || 'new').toLowerCase()] || 0;
      const nw = PRANK[stage] || 0;
      if (nw <= cur) return reply({ ok: true, oppId, portal: 'unchanged', status: L.status });
      const patch = { status: stage }; if (stage === 'completed') patch.completedAt = new Date().toISOString();
      await db.update('portal_leads', `id=eq.${L.id}`, patch);
      return reply({ ok: true, oppId, portal: 'advanced', leadId: L.id, to: stage, realtor: L.realtorName });
    } catch (e) { return reply({ ok: false, error: 'portal_sync_failed', message: e.message }, 500); }
  }

  // --- Affiliate-tagged: match to a CRM contact, upsert a referral in Supabase ---
  let match = null;
  try { match = matchContact(partner, (await db.select('contacts?type=eq.Realtor&select=id,name,business')) || []); } catch (e) {}
  if (!match) { try { match = matchContact(partner, (await db.select('contacts?select=id,name,business')) || []); } catch (e) {} }
  if (!match) {
    // Don't silently drop an affiliate-tagged job. Record it (deduped by the SM tag) with no
    // contactId so the CRM still surfaces + chimes it, and Dane can add/link "<affiliate>".
    try {
      const dup = (await db.select('referrals?notes=ilike.*' + encodeURIComponent('[SM:' + oppId + ']') + '*&select=id&limit=1')) || [];
      if (!dup.length) {
        await db.insert('referrals', {
          contactId: '', contactName: partner, jobName: cust, status: stage,
          date: date, amount: String(amount), enteredBy: 'SmartMoving Webhook',
          notes: '[SM:' + oppId + '] UNMATCHED affiliate "' + partner + '" — add them to contacts to credit · ' + lead,
        });
      }
    } catch (e) { return reply({ ok: false, error: 'unmatched_record_failed', message: e.message }, 500); }
    return reply({ ok: true, oppId, affiliate: partner, matched: false, recorded: true });
  }

  let referrals = [];
  try { referrals = (await db.select(`referrals?contactId=eq.${encodeURIComponent(match.id)}&select=id,status,notes,jobName`)) || []; } catch (e) {}
  const tag = String(oppId);
  const existing = referrals.find((r) => (String(r.notes || '') + ' ' + String(r.jobName || '')).indexOf(tag) >= 0);
  if (existing) {
    const cur = RANK[String(existing.status || '').toLowerCase()] || 0;
    const nw = RANK[stage] || 0;
    if (nw > cur) {
      try { await db.update('referrals', `id=eq.${existing.id}`, { status: stage, notes: (existing.notes || '') + ' | live->' + stage }); }
      catch (e) { return reply({ ok: false, error: 'update_failed', message: e.message }, 500); }
      return reply({ ok: true, oppId, partner: match.name, action: 'advance', from: existing.status, to: stage, refId: existing.id });
    }
    return reply({ ok: true, oppId, partner: match.name, action: 'unchanged', status: existing.status });
  }
  try {
    await db.insert('referrals', {
      contactId: String(match.id), contactName: match.name, jobName: cust, status: stage,
      date: date, amount: String(amount), enteredBy: 'SmartMoving Webhook', notes: '[SM:' + oppId + '] live · ' + lead,
    });
  } catch (e) { return reply({ ok: false, error: 'insert_failed', message: e.message }, 500); }
  return reply({ ok: true, oppId, partner: match.name, action: 'create', stage, cust, amount });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
