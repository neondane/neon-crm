/** POST /api/smartmovingWebhook — SmartMoving fires { "opportunity-id": "<id>" } on
 *  Opportunity Created / Status Changed / Changed / Deleted.
 *
 *  Flow: fetch the full opportunity from SmartMoving's API, classify its stage,
 *  and write DIRECTLY to Supabase (no Apps Script):
 *    - Affiliate-tagged (opp.affiliateName / referralSource) → match the affiliate to a
 *      CRM contact and create/advance a row in `referrals` (deduped GLOBALLY by [SM:<oppId>]
 *      and any jobs[] ids — re-fired webhooks never create a second referral).
 *    - No affiliate (or affiliate not in the CRM) → advance a matching `portal_leads`
 *      row by customer name/phone, so leads never fall between the two tables.
 *  Never sends money; payouts stay human-initiated in the CRM. Only ever advances a status.
 *
 *  RESILIENCE CONTRACT: after the secret check, this endpoint NEVER returns a non-200.
 *  Bad payloads, SmartMoving API errors/timeouts, and Supabase hiccups all reply
 *  200 with { ok:false, error } so SmartMoving never disables or hammers the hook.
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
  // Read the sales leadStatus, the opportunity status, the job-level status, AND
  // every jobs[] status — SmartMoving shows "Booked"/"Completed" in different spots
  // depending on workflow, and we must register Booked AND Completed every time.
  const jobsBlob = Array.isArray(o.jobs)
    ? o.jobs.map((j) => String((j && (j.jobStatus || j.status)) || '')).join(' ')
    : '';
  const blob = (String(o.leadStatus || '') + ' ' + String(o.status || '') + ' ' + String(o.jobStatus || '') + ' ' + jobsBlob).toLowerCase();
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
function smIdsOf(oppId, opp) {
  // Every id a past sync may have tagged a referral with: the opportunity id + job ids.
  const ids = [String(oppId)];
  if (opp && Array.isArray(opp.jobs)) opp.jobs.forEach((j) => { if (j && j.id) ids.push(String(j.id)); });
  return ids.filter(Boolean);
}
function findExistingRef(referrals, ids) {
  for (const r of referrals || []) {
    const tag = String(r.notes || '') + ' ' + String(r.jobName || '');
    for (const id of ids) { if (id && tag.indexOf(id) >= 0) return r; }
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

// --- Portal-lead path: advance a matching portal_leads row by name/phone -----
async function syncPortalLead(db, { oppId, cust, phone, stage }) {
  let leads = [];
  try { leads = (await db.select('portal_leads?select=id,customerName,customerPhone,status,realtorName,smJobId')) || []; }
  catch (e) { return { portal: 'lookup_failed', message: e.message }; }
  const nc = norm(cust);
  let cands = leads.filter((l) => {
    const ln = norm(l.customerName); const lp = String(l.customerPhone || '').replace(/\D/g, '');
    const nameHit = !!(nc && ln && ln === nc);
    const phoneHit = !!(phone.length >= 7 && lp.length >= 7 && lp.slice(-10) === phone.slice(-10));
    return nameHit || phoneHit;
  });
  if (cands.length > 1) {
    // Narrow deterministically: a lead already tagged with this opp wins; then
    // prefer leads still in flight (not completed/lost); then the newest row.
    const tagged = cands.filter((l) => String(l.smJobId || '') === String(oppId));
    if (tagged.length) cands = tagged;
    else {
      const open = cands.filter((l) => !/complet|lost/i.test(String(l.status || '')));
      if (open.length) cands = open;
      cands.sort((a, b) => (+b.id || 0) - (+a.id || 0));
      cands = cands.slice(0, 1);
    }
  }
  if (cands.length !== 1) return { portal: 'no-match', candidates: cands.length };
  const L = cands[0];
  const cur = PRANK[String(L.status || 'new').toLowerCase()] || 0;
  const nw = PRANK[stage] || 0;
  const patch = {};
  if (!L.smJobId) patch.smJobId = String(oppId); // remember the link for crew lookups
  if (nw > cur) { patch.status = stage; if (stage === 'completed') patch.completedAt = new Date().toISOString(); }
  if (!Object.keys(patch).length) return { portal: 'unchanged', leadId: L.id, status: L.status };
  try { await db.update('portal_leads', `id=eq.${L.id}`, patch); }
  catch (e) { return { portal: 'update_failed', leadId: L.id, message: e.message }; }
  return nw > cur
    ? { portal: 'advanced', leadId: L.id, to: stage, realtor: L.realtorName }
    : { portal: 'tagged', leadId: L.id, status: L.status };
}

const handler = endpoint(async ({ request, env, body, reply }) => {
  if (env.SMARTMOVING_WEBHOOK_SECRET) {
    const url = new URL(request.url);
    const got = url.searchParams.get('secret') || request.headers.get('x-webhook-secret') || request.headers.get('x-ng-secret') || '';
    if (got !== env.SMARTMOVING_WEBHOOK_SECRET) return reply({ ok: false, error: 'unauthorized' }, 401);
  }

  // From here on, NEVER non-200 — log the problem in the response body instead.
  try {
    const p = body || {};
    const oppId = p['opportunity-id'] || p.opportunityId || p.opportunityID || p.id || '';
    if (!oppId) return reply({ ok: true, received: true, note: 'no opportunity id' });
    const key = env.SMARTMOVING_API_KEY;
    if (!key) return reply({ ok: false, received: true, error: 'sm_not_configured' });

    const g = await smGet(key, '/api/opportunities/' + encodeURIComponent(oppId));
    if (!g.ok) return reply({ ok: true, oppId, fetched: false, status: g.status || g.err });
    const opp = g.body || {};
    const stage = classifyStage(opp);
    const partner = partnerOf(opp);
    const cust = (opp.customer && (opp.customer.name || opp.customer.fullName)) || 'SmartMoving job';
    const phone = String((opp.customer && (opp.customer.phoneNumber || opp.customer.phone || opp.customer.mobile)) || '').replace(/\D/g, '');
    const amount = Number((opp.estimatedTotal && (opp.estimatedTotal.finalTotal || opp.estimatedTotal.subtotal)) || 0) || 0;
    const date = fmtDate(opp.serviceDate);
    const lead = opp.leadStatus || stage;
    const db = sb(env);
    const tagIds = smIdsOf(oppId, opp);

    // --- Idempotency first: GLOBAL dedupe by [SM:<oppId>] / job ids, across ALL
    // contacts, so a retried webhook can never create a double referral even if
    // the affiliate→contact match would land somewhere new.
    let tagged = [];
    try { tagged = (await db.select('referrals?select=id,contactId,status,notes,jobName&notes=like.*SM:*')) || []; }
    catch (e) { tagged = []; }
    const existing = findExistingRef(tagged, tagIds);
    if (existing) {
      const cur = RANK[String(existing.status || '').toLowerCase()] || 0;
      const nw = RANK[stage] || 0;
      if (nw > cur) {
        try { await db.update('referrals', `id=eq.${existing.id}`, { status: stage, notes: (existing.notes || '') + ' | live->' + stage }); }
        catch (e) { return reply({ ok: false, oppId, error: 'update_failed', message: e.message }); }
        return reply({ ok: true, oppId, action: 'advance', from: existing.status, to: stage, refId: existing.id });
      }
      return reply({ ok: true, oppId, action: 'unchanged', status: existing.status, refId: existing.id });
    }

    // --- No affiliate: advance a matching portal lead by name/phone ---
    if (!partner) {
      const res = await syncPortalLead(db, { oppId, cust, phone, stage });
      return reply({ ok: true, oppId, affiliate: null, ...res });
    }

    // --- Affiliate-tagged: match to a CRM contact, insert a referral ---
    let match = null;
    try { match = matchContact(partner, (await db.select('contacts?type=eq.Realtor&select=id,name,business')) || []); } catch (e) {}
    if (!match) { try { match = matchContact(partner, (await db.select('contacts?select=id,name,business')) || []); } catch (e) {} }
    if (!match) {
      // Affiliate isn't in the CRM (yet) — don't drop the lead between tables:
      // try the portal-lead path before giving up.
      const res = await syncPortalLead(db, { oppId, cust, phone, stage });
      return reply({ ok: true, oppId, affiliate: partner, matched: false, note: 'affiliate not in CRM yet', ...res });
    }

    // Shrink the insert race window: re-check the tag right before inserting.
    try {
      const again = (await db.select('referrals?select=id,status,notes,jobName&notes=like.*SM:*')) || [];
      const dup = findExistingRef(again, tagIds);
      if (dup) return reply({ ok: true, oppId, action: 'unchanged', status: dup.status, refId: dup.id, note: 'raced' });
    } catch (e) {}
    try {
      await db.insert('referrals', {
        contactId: String(match.id), contactName: match.name, jobName: cust, status: stage,
        date: date, amount: String(amount), enteredBy: 'SmartMoving Webhook', notes: '[SM:' + oppId + '] live · ' + lead,
      });
    } catch (e) { return reply({ ok: false, oppId, error: 'insert_failed', message: e.message }); }
    return reply({ ok: true, oppId, partner: match.name, action: 'create', stage, cust, amount });
  } catch (e) {
    // Absolute backstop — a webhook must never 500.
    return reply({ ok: false, error: 'webhook_error', message: String((e && e.message) || e) });
  }
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
