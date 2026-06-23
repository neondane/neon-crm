/** DRAFT — Move Tracker upgrade of /api/smartmovingWebhook.
 *  REVIEW, then replace smartmovingWebhook.js with this and deploy with deploy-neon-api.bat.
 *
 *  What's different vs the live version (all ADDITIVE — nothing removed):
 *   - Keeps the exact same coarse `status` writes (referred/booked/completed) the portal reads today.
 *   - ADDS a granular client-facing `stage` (received→quote→booked→prepping→moveday→complete) +
 *     a `stage_times` jsonb timestamp map, written to referrals AND portal_leads.
 *   - Tracker fields only ever ADVANCE (never go backwards); each stage's time is stamped once.
 *   - Requires movetracker_schema.sql to have been run first (adds the nullable columns).
 *  Still never sends money. Safe: if the new columns don't exist yet, the tracker patch is skipped.
 *
 *  Env: SUPABASE_URL, SUPABASE_KEY, SMARTMOVING_API_KEY, SMARTMOVING_WEBHOOK_SECRET? */
import { endpoint, preflight, sb } from '../_shared.js';

const SM_BASE = 'https://api-public.smartmoving.com/v1';
const GENERIC = /google|yelp|\bweb\b|website|online|bing|drive.?by|signage|sign\b|past customer|return(ing)? customer|repeat customer|former customer|facebook|instagram|social|yard sign|billboard|angi|thumbtack|home.?advisor|walk.?in|truck|wrap|\bnone\b|^n\/?a$|^other$|unknown|search engine/i;
const RANK = { referred: 1, booked: 2, completed: 3 };
const PRANK = { 'new': 0, contacted: 1, booked: 2, completed: 3, lost: 0 };
// [TRACKER] granular 7-stage funnel (reviewed is set by the review flow, not here)
const TRANK = { received: 1, quote: 2, booked: 3, prepping: 4, moveday: 5, complete: 6, reviewed: 7 };

const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
function fmtDate(d) {
  const s = String(d || '');
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? new Date().toISOString().slice(0, 10) : dt.toISOString().slice(0, 10);
}
function classifyStage(o) {
  const blob = (String(o.leadStatus || '') + ' ' + String(o.status || '') + ' ' + String(o.jobStatus || '')).toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  const svc = fmtDate(o.serviceDate);
  const paid = Array.isArray(o.payments) && o.payments.some((p) => Number(p && (p.amount || p.total || p.value)) > 0);
  if (/complet|moved|finished|delivered|closed won|paid in full/.test(blob)) return 'completed';
  if (o.serviceDate && svc < today && paid) return 'completed';
  if (/book|confirm|scheduled|deposit|\bwon\b/.test(blob)) return 'booked';
  return 'referred';
}
// [TRACKER] granular stage from SmartMoving's numbered lead funnel + job status + service date.
// Tolerant: matches keywords AND leading "N)" numbers, with safe fallbacks for unknown labels.
function trackerStage(o) {
  const lead = String(o.leadStatus || '').trim();
  const blob = (lead + ' ' + String(o.status || '') + ' ' + String(o.jobStatus || '')).toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  const svc = fmtDate(o.serviceDate);
  const paid = Array.isArray(o.payments) && o.payments.some((p) => Number(p && (p.amount || p.total || p.value)) > 0);
  // complete
  if (/complet|moved in|finished|delivered|closed won|paid in full/.test(blob)) return 'complete';
  if (o.serviceDate && svc < today && paid) return 'complete';
  // move day — in progress, or service date is today
  if (/in progress|on(-| )?site|loading|en ?route|out for (delivery|move)|crew dispatched/.test(blob)) return 'moveday';
  if (o.serviceDate && svc === today) return 'moveday';
  // booked / confirmed / won  (keywords or high lead numbers 7-9)
  const isBooked = /book|confirm|deposit|\bwon\b/.test(blob) || /^[789]\D/.test(lead);
  // "scheduled" with a real future service date also counts as booked
  if (isBooked || (/scheduled/.test(blob) && o.serviceDate && svc >= today)) {
    if (o.serviceDate) { const days = (new Date(svc) - new Date(today)) / 86400000; if (days >= 0 && days <= 3) return 'prepping'; }
    return 'booked';
  }
  // quote / estimate sent or scheduled  (keywords or lead numbers 4-5)
  if (/estimate sent|quote sent|proposal sent/.test(blob) || /^5\D/.test(lead)) return 'quote';
  if (/estimate scheduled|estimate|\bquote\b/.test(blob) || /^4\D/.test(lead)) return 'quote';
  // default: received (new lead, attempted contact, contacted, future move, etc.)
  return 'received';
}
// [TRACKER] forward-only merge: advance `stage` and stamp its time once. Returns null if no advance.
function trackerPatch(curStage, curTimes, nextStage) {
  if (!nextStage) return null;
  const curRank = TRANK[String(curStage || '').toLowerCase()] || 0;
  const nextRank = TRANK[nextStage] || 0;
  if (nextRank <= curRank) return null; // never go backwards / no change
  const times = (curTimes && typeof curTimes === 'object') ? Object.assign({}, curTimes) : {};
  if (!times[nextStage]) times[nextStage] = new Date().toISOString();
  return { stage: nextStage, stage_times: times };
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
  const tstage = trackerStage(opp); // [TRACKER]
  const partner = partnerOf(opp);
  const cust = (opp.customer && (opp.customer.name || opp.customer.fullName)) || 'SmartMoving job';
  const phone = String((opp.customer && (opp.customer.phoneNumber || opp.customer.phone || opp.customer.mobile)) || '').replace(/\D/g, '');
  const amount = Number((opp.estimatedTotal && (opp.estimatedTotal.finalTotal || opp.estimatedTotal.subtotal)) || 0) || 0;
  const date = fmtDate(opp.serviceDate);
  const lead = opp.leadStatus || stage;
  const db = sb(env);

  // [TRACKER] best-effort tracker write; if the new columns don't exist yet it just no-ops.
  async function applyTracker(table, id, curStage, curTimes) {
    try {
      const patch = trackerPatch(curStage, curTimes, tstage);
      if (patch) await db.update(table, `id=eq.${id}`, patch);
    } catch (e) { /* columns may not exist yet — ignore, coarse status already saved */ }
  }

  // --- No affiliate: advance a matching portal lead by name/phone ---
  if (!partner) {
    try {
      const leads = await db.select('portal_leads?select=id,customerName,customerPhone,status,realtorName,stage,stage_times');
      const nc = norm(cust);
      const cands = (leads || []).filter((l) => {
        const ln = norm(l.customerName); const lp = String(l.customerPhone || '').replace(/\D/g, '');
        const nameHit = !!(nc && ln && ln === nc);
        const phoneHit = !!(phone.length >= 7 && lp.length >= 7 && lp.slice(-10) === phone.slice(-10));
        return nameHit || phoneHit;
      });
      if (cands.length !== 1) return reply({ ok: true, oppId, affiliate: null, portal: 'no-unique-match', candidates: cands.length });
      const L = cands[0];
      // coarse status (unchanged behavior)
      const cur = PRANK[String(L.status || 'new').toLowerCase()] || 0;
      const nw = PRANK[stage] || 0;
      if (nw > cur) {
        const patch = { status: stage }; if (stage === 'completed') patch.completedAt = new Date().toISOString();
        await db.update('portal_leads', `id=eq.${L.id}`, patch);
      }
      await applyTracker('portal_leads', L.id, L.stage, L.stage_times); // [TRACKER]
      return reply({ ok: true, oppId, portal: (nw > cur ? 'advanced' : 'status-unchanged'), trackerStage: tstage, leadId: L.id, realtor: L.realtorName });
    } catch (e) { return reply({ ok: false, error: 'portal_sync_failed', message: e.message }, 500); }
  }

  // --- Affiliate-tagged: match to a CRM contact, upsert a referral in Supabase ---
  let match = null;
  try { match = matchContact(partner, (await db.select('contacts?type=eq.Realtor&select=id,name,business')) || []); } catch (e) {}
  if (!match) { try { match = matchContact(partner, (await db.select('contacts?select=id,name,business')) || []); } catch (e) {} }
  if (!match) return reply({ ok: true, oppId, affiliate: partner, matched: false, note: 'affiliate not in CRM yet' });

  let referrals = [];
  try { referrals = (await db.select(`referrals?contactId=eq.${encodeURIComponent(match.id)}&select=id,status,notes,jobName,stage,stage_times`)) || []; } catch (e) {}
  const tag = String(oppId);
  const existing = referrals.find((r) => (String(r.notes || '') + ' ' + String(r.jobName || '')).indexOf(tag) >= 0);
  if (existing) {
    const cur = RANK[String(existing.status || '').toLowerCase()] || 0;
    const nw = RANK[stage] || 0;
    if (nw > cur) {
      try { await db.update('referrals', `id=eq.${existing.id}`, { status: stage, notes: (existing.notes || '') + ' | live->' + stage }); }
      catch (e) { return reply({ ok: false, error: 'update_failed', message: e.message }, 500); }
    }
    await applyTracker('referrals', existing.id, existing.stage, existing.stage_times); // [TRACKER]
    return reply({ ok: true, oppId, partner: match.name, action: (nw > cur ? 'advance' : 'status-unchanged'), to: stage, trackerStage: tstage, refId: existing.id });
  }
  try {
    // [TRACKER] new referral seeds stage + stamps the current stage time
    const seedTimes = {}; if (tstage) seedTimes[tstage] = new Date().toISOString();
    await db.insert('referrals', {
      contactId: String(match.id), contactName: match.name, jobName: cust, status: stage,
      date: date, amount: String(amount), enteredBy: 'SmartMoving Webhook', notes: '[SM:' + oppId + '] live · ' + lead,
      stage: tstage, stage_times: seedTimes,
    });
  } catch (e) {
    // If tracker columns don't exist yet, retry the original insert shape so nothing is lost.
    try {
      await db.insert('referrals', {
        contactId: String(match.id), contactName: match.name, jobName: cust, status: stage,
        date: date, amount: String(amount), enteredBy: 'SmartMoving Webhook', notes: '[SM:' + oppId + '] live · ' + lead,
      });
    } catch (e2) { return reply({ ok: false, error: 'insert_failed', message: e2.message }, 500); }
  }
  return reply({ ok: true, oppId, partner: match.name, action: 'create', stage, trackerStage: tstage, cust, amount });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
