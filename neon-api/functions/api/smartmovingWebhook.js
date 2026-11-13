/** POST /api/smartmovingWebhook — SmartMoving fires { "opportunity-id": "<id>" } on
 *  Opportunity Created / Status Changed / Changed / Deleted.
 *
 *  Flow: fetch the full opportunity from SmartMoving's API, classify its stage,
 *  and write DIRECTLY to Supabase (no Apps Script):
 *    - Affiliate-tagged (opp.affiliateName / referralSource) → match the affiliate to a
 *      CRM contact and create/advance a row in `referrals` (deduped by opp id or any job id in notes).
 *    - No affiliate → advance a matching `portal_leads` row by customer name/phone.
 *  Never sends money; payouts stay human-initiated in the CRM. Status only ever advances.
 *  Amount, service date, and a placeholder job name are refreshed from the opportunity
 *  (final invoice once there is one) without firing payouts.
 *
 *  Env: SUPABASE_URL, SUPABASE_KEY, SMARTMOVING_API_KEY, SMARTMOVING_WEBHOOK_SECRET? */
import { endpoint, preflight, sb } from '../_shared.js';
import { matchContact, loadAliases } from '../_match.js';
import { dispatch } from '../_webhooks.js';
import { emitEvent } from '../_push.js';
import { smOpp, moneyOf, needsSmartMovingCloseOut, oppNoteIds, notesContainId, referralIdFilter, referralFieldPatch } from '../_smopp.js';

const GENERIC = /google|yelp|\bweb\b|website|online|bing|drive.?by|signage|sign\b|past customer|return(ing)? customer|repeat customer|former customer|facebook|instagram|social|yard sign|billboard|angi|thumbtack|home.?advisor|walk.?in|truck|wrap|\bnone\b|^n\/?a$|^other$|unknown|search engine|chat ?gpt|openai|\bclaude\b|perplexity|gemini|copilot|\bai\b/i;
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
// Numeric SmartMoving status first (see reconcileSmartMoving.js for the table). The stage text
// is often stale, and "Estimate Scheduled" must never count as booked.
const SM_STATUS = { 0: 'referred', 1: 'referred', 2: 'referred', 3: 'referred', 4: 'booked', 10: 'completed', 11: 'completed', 20: 'lost', 30: 'lost', 50: 'lost' };
function classifyStage(o) {
  const raw = o && o.status; const n = Number(raw);
  if (raw !== null && raw !== undefined && raw !== '' && !isNaN(n) && SM_STATUS[n]) return SM_STATUS[n] === 'lost' ? 'referred' : SM_STATUS[n];
  const blob = (String(o.leadStatus || '') + ' ' + String(o.status || '') + ' ' + String(o.jobStatus || '')).toLowerCase();
  const today = new Date().toISOString().slice(0, 10);
  const svc = fmtDate(o.serviceDate);
  const paid = Array.isArray(o.payments) && o.payments.some((p) => Number(p && (p.amount || p.total || p.value)) > 0);
  if (/complet|moved|finished|delivered|closed won|paid in full/.test(blob)) return 'completed';
  if (o.serviceDate && svc < today && paid) return 'completed';
  if (/\bbooked\b|confirmed|deposit|\bwon\b/.test(blob)) return 'booked';
  return 'referred';
}
// Lead sources that are not a referral partner (SmartMoving puts these where a partner would go).
const NOT_PARTNER = /^(something else|other|unknown.*|affiliate|realtors?( referral)?|real estate( agency)?|referral|word of mouth|friend.*|direct mail.*|mailer|employee.*|portal - (affiliate|.*test)|.*\btest\b.*|.*debug.*|.*campaign.*|.*\bfb\b.*|snoball.*|capi-.*)$/i;
function partnerOf(o) {
  if (o.affiliateName && String(o.affiliateName).trim() && !GENERIC.test(String(o.affiliateName)) && !NOT_PARTNER.test(String(o.affiliateName).trim())) return String(o.affiliateName).trim();
  const rs = o.referralSource || o.referralSourceName;
  let name = '';
  if (rs) { if (typeof rs === 'string') name = rs.trim(); else if (typeof rs === 'object' && (rs.name || rs.type)) name = String(rs.name || rs.type).trim(); }
  if (!name || GENERIC.test(name) || NOT_PARTNER.test(name)) return '';
  return name;
}
async function rowsMatchingIds(db, ids) {
  const filter = referralIdFilter(ids);
  if (!filter) return [];
  return (await db.select('referrals?' + filter + '&status=neq.duplicate&select=id,contactId,status,notes,jobName,amount,date&order=id.asc&limit=5')) || [];
}

// Fire outbound webhooks + owner SMS when a job actually advances. Best-effort and
// non-blocking: it can never delay or fail the SmartMoving webhook response.
// A brand-new referral that came straight into SmartMoving (phone call, partner booked directly).
// Portal referrals already alert from the portal ("Portal - Name"), and lost / bad leads don't buzz.
function emitNewReferral(env, waitUntil, opp, d) {
  if (/^portal\b/i.test(String(d.partner || ''))) return;
  const n = Number(opp && opp.status); if ([20, 30, 50].includes(n)) return;
  const p = emitEvent(env, { event: 'referral_new', title: 'New referral from ' + String(d.partner || 'a partner').trim(),
    body: (d.customer || 'A customer') + (d.matchedId ? ' · in SmartMoving' : ' · ' + String(d.partner || '').trim() + " isn't in the CRM yet"),
    url: d.matchedId ? '/app/#p/' + d.matchedId : '/app/#referrals', source_key: 'smref:' + d.oppId }).catch(() => {});
  if (typeof waitUntil === 'function') waitUntil(p);
}
// The CRM can't tell for sure who referred this job: ask the team, with a one-tap match screen.
function emitWhoReferred(env, waitUntil, opp, d) {
  if (/^portal\b/i.test(String(d.partner || ''))) return;
  const n = Number(opp && opp.status); if ([20, 30, 50].includes(n)) return;
  const p = emitEvent(env, { event: 'partner_unknown', title: 'Who referred ' + (d.customer || 'this job') + '?',
    body: 'SmartMoving says "' + String(d.partner || '').trim() + '". Tap to credit someone or add them.',
    url: d.refId ? '/app/#match/' + d.refId : '/app/#unmatched', source_key: 'smref:' + d.oppId }).catch(() => {});
  if (typeof waitUntil === 'function') waitUntil(p);
}
async function emitJob(env, waitUntil, stage, data) {
  if (stage !== 'booked' && stage !== 'completed') return;
  const fire = async () => {
    try {
      await dispatch(env, 'job.' + stage, data);
      if (stage === 'completed') await dispatch(env, 'payout.due', data);
      // One alert per job + stage, ever (source_key), so SmartMoving's burst of webhooks can't double-alert.
      await emitEvent(env, { event: stage === 'booked' ? 'job_booked' : 'job_completed',
        title: (stage === 'booked' ? 'Booked: ' : 'Completed: ') + (data.customer || 'a job'),
        body: data.partner ? 'Referred by ' + data.partner + (stage === 'completed' ? '. Their payout is due.' : '.') : (stage === 'completed' ? 'Job completed.' : 'Job booked.'),
        url: stage === 'completed' ? '/app/#payouts' : '/app/#referrals',
        source_key: 'job:' + (data.oppId || data.leadId || data.refId || data.customer || 'x') + ':' + stage }).catch(() => {});
    } catch (_) {}
  };
  if (typeof waitUntil === 'function') waitUntil(fire()); else await fire();
}

const handler = endpoint(async ({ request, env, body, reply, waitUntil }) => {
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

  const g = await smOpp(key, oppId);
  if (!g.ok) return reply({ ok: true, oppId, fetched: false, status: g.status || g.err });
  const opp = g.body;
  const today = new Date().toISOString().slice(0, 10);
  let stage = classifyStage(opp);
  // Paid and invoiced, but SmartMoving still says Booked: don't auto-complete or pay out.
  if (needsSmartMovingCloseOut(opp, today) && stage === 'completed') stage = 'booked';
  const partner = partnerOf(opp);
  const cust = (opp.customer && (opp.customer.name || opp.customer.fullName)) || 'SmartMoving job';
  const phone = String((opp.customer && (opp.customer.phoneNumber || opp.customer.phone || opp.customer.mobile)) || '').replace(/\D/g, '');
  const amount = moneyOf(opp, stage);
  const date = fmtDate(opp.serviceDate);
  const dated = opp.serviceDate ? date : '';
  const ids = oppNoteIds(opp, oppId);
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
      await emitJob(env, waitUntil, stage, { source: 'portal_lead', oppId, leadId: L.id, customer: cust, partner: L.realtorName || null, stage, amount, date });
      return reply({ ok: true, oppId, portal: 'advanced', leadId: L.id, to: stage, realtor: L.realtorName });
    } catch (e) { return reply({ ok: false, error: 'portal_sync_failed', message: e.message }, 500); }
  }

  // --- Affiliate-tagged: match to a CRM contact, upsert a referral in Supabase ---
  let match = null;
  try { match = matchContact(partner, (await db.select('contacts?select=id,name,business,portalActivatedAt')) || [], await loadAliases(db)); } catch (e) {}
  if (!match) {
    // Don't silently drop an affiliate-tagged job. Record it (deduped by the SM tag) with no
    // contactId so the CRM still surfaces + chimes it, and Dane can add/link "<affiliate>".
    try {
      const dup = await rowsMatchingIds(db, ids);
      if (!dup.length) {
        const ins = await db.insert('referrals', {
          contactId: '', contactName: partner, jobName: cust, status: stage,
          date: date, amount: String(amount), enteredBy: 'SmartMoving Webhook',
          notes: '[SM:' + oppId + '] UNMATCHED affiliate "' + partner + '" · ' + lead,
        });
        const refId = ins && ins[0] && ins[0].id;
        emitWhoReferred(env, waitUntil, opp, { oppId, partner, customer: cust, refId });
      } else {
        const row = dup[0];
        const fields = referralFieldPatch(row, { amount, date: dated, jobName: cust });
        const patch = { ...fields };
        const cur = RANK[String(row.status || '').toLowerCase()] || 0;
        const nw = RANK[stage] || 0;
        if (nw > cur) { patch.status = stage; patch.notes = (row.notes || '') + ' | live->' + stage; }
        if (Object.keys(patch).length) await db.update('referrals', `id=eq.${row.id}`, patch);
      }
    } catch (e) { return reply({ ok: false, error: 'unmatched_record_failed', message: e.message }, 500); }
    return reply({ ok: true, oppId, affiliate: partner, matched: false, recorded: true });
  }

  let referrals = [];
  try { referrals = (await db.select(`referrals?contactId=eq.${encodeURIComponent(match.id)}&select=id,status,notes,jobName,amount,date`)) || []; } catch (e) {}
  const existing = referrals.find((r) => notesContainId(r.notes, ids) || String(r.jobName || '').indexOf(String(oppId)) >= 0);
  if (existing) {
    const fields = referralFieldPatch(existing, { amount, date: dated, jobName: cust });
    const cur = RANK[String(existing.status || '').toLowerCase()] || 0;
    const nw = RANK[stage] || 0;
    const patch = { ...fields };
    if (nw > cur) { patch.status = stage; patch.notes = (existing.notes || '') + ' | live->' + stage; }
    if (Object.keys(patch).length) {
      try { await db.update('referrals', `id=eq.${existing.id}`, patch); }
      catch (e) { return reply({ ok: false, error: 'update_failed', message: e.message }, 500); }
    }
    if (nw > cur) {
      await emitJob(env, waitUntil, stage, { source: 'referral', oppId, refId: existing.id, customer: cust, partner: match.name, stage, amount, date });
      return reply({ ok: true, oppId, partner: match.name, action: 'advance', from: existing.status, to: stage, refId: existing.id, refreshed: Object.keys(fields) });
    }
    if (Object.keys(fields).length) return reply({ ok: true, oppId, partner: match.name, action: 'refresh', refId: existing.id, refreshed: Object.keys(fields) });
    return reply({ ok: true, oppId, partner: match.name, action: 'unchanged', status: existing.status });
  }
  // Same job already saved (opp id or any job id in notes)? Update that row instead of
  // inserting a second copy. Legacy "SmartMoving Sync" rows store job ids, not the opp id.
  try {
    const prior = await rowsMatchingIds(db, ids);
    const loose = prior.find((r) => !String(r.contactId || '').trim());
    if (loose) {
      const fields = referralFieldPatch(loose, { amount, date: dated, jobName: cust });
      const up = { ...fields, contactId: String(match.id), contactName: match.name, notes: (loose.notes || '') + ' | linked to ' + match.name };
      if ((RANK[stage] || 0) > (RANK[String(loose.status || '').toLowerCase()] || 0)) up.status = stage;
      await db.update('referrals', `id=eq.${loose.id}`, up);
      if (up.status) await emitJob(env, waitUntil, stage, { source: 'referral', oppId, refId: loose.id, customer: cust, partner: match.name, stage, amount, date });
      return reply({ ok: true, oppId, partner: match.name, action: 'linked', refId: loose.id, refreshed: Object.keys(fields) });
    }
    if (prior.length) {
      const row = prior[0];
      const fields = referralFieldPatch(row, { amount, date: dated, jobName: cust });
      const patch = { ...fields };
      const cur = RANK[String(row.status || '').toLowerCase()] || 0;
      const nw = RANK[stage] || 0;
      if (nw > cur) { patch.status = stage; patch.notes = (row.notes || '') + ' | live->' + stage; }
      if (Object.keys(patch).length) await db.update('referrals', `id=eq.${row.id}`, patch);
      // No emitJob: this branch never alerted, and payout webhooks are not deduped.
      const action = nw > cur ? 'advance' : (Object.keys(fields).length ? 'refresh' : 'unchanged');
      return reply({ ok: true, oppId, partner: match.name, action, note: 'matched existing row by opportunity or job id', refId: row.id, refreshed: Object.keys(fields) });
    }
  } catch (_) { /* fall through to a normal save */ }
  try {
    await db.insert('referrals', {
      contactId: String(match.id), contactName: match.name, jobName: cust, status: stage,
      date: date, amount: String(amount), enteredBy: 'SmartMoving Webhook', notes: '[SM:' + oppId + '] live · ' + lead,
    });
  } catch (e) { return reply({ ok: false, error: 'insert_failed', message: e.message }, 500); }
  if (stage === 'referred') emitNewReferral(env, waitUntil, opp, { oppId, partner: match.name, customer: cust, matchedId: match.id });
  await emitJob(env, waitUntil, stage, { source: 'referral', oppId, customer: cust, partner: match.name, stage, amount, date });
  return reply({ ok: true, oppId, partner: match.name, action: 'create', stage, cust, amount });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
