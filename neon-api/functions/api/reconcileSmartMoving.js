/** POST /api/reconcileSmartMoving — the TRUE backfill the system never had.
 *  Reconciles SmartMoving opportunities into Supabase `referrals` so a missed webhook
 *  (outage, dropped event, >14d old) SELF-HEALS instead of being lost forever — which is
 *  exactly how Andrew Sale's ~$15k SF job (opp 32468) went uncredited.
 *
 *  Reuses the live webhook's proven logic (partnerOf / matchContact / classifyStage), writes
 *  DIRECTLY to Supabase via sb(), dedupes by the opp id or any job id in notes, only ADVANCES
 *  status, refreshes amount / service date / placeholder job name from the final invoice,
 *  and NEVER sends money. Idempotent: safe to run repeatedly.
 *
 *  Two modes:
 *    { "ids": ["<oppId>", ...], "dry": true|false }   ← WORKS NOW via the proven single-opp GET.
 *                                                        Use this to fix known-missing jobs today.
 *    { "open": true, "batch": 35, "dry": true }       ← HOURLY (Oct 2026): re-checks referrals,
 *                                                        a batch per run, rotating (cursor in app_settings).
 *        referred + booked use the 120-day service-date window. completed uses 365 days.
 *        Every uuid in notes is tried (legacy rows store job ids). A 400 is flagged, not fatal.
 *        Moves forward on its own (referred -> booked -> completed). Lost in SmartMoving is only
 *        reported, unless "applyLost": true (Dane confirms first).
 *        Booked + past + invoiced + paid in full is listed under needsCloseOut and NOT completed.
 *    { "auto": true, "sinceDays": 180, "dry": true }  ← daily self-heal. Enumerates recent opps.
 *        listRecentOpportunities() must be pointed at the correct SmartMoving LIST endpoint.
 *        Until confirmed it returns [] (no-op) — so auto mode can never write bad data.
 *
 *  Env: SUPABASE_URL, SUPABASE_KEY, SMARTMOVING_API_KEY
 */
import { endpoint, preflight, sb } from '../_shared.js';
import { matchContact, loadAliases } from '../_match.js';
import { emitEvent } from '../_push.js';
import { loadOpp, moneyOf, needsSmartMovingCloseOut, oppNoteIds, notesContainId, referralIdFilter, referralFieldPatch, uuidsInNotes } from '../_smopp.js';

const SM_BASE = 'https://api-public.smartmoving.com/v1';
const GENERIC = /google|yelp|\bweb\b|website|online|bing|drive.?by|signage|sign\b|past customer|return(ing)? customer|repeat customer|former customer|facebook|instagram|social|yard sign|billboard|angi|thumbtack|home.?advisor|walk.?in|truck|wrap|\bnone\b|^n\/?a$|^other$|unknown|search engine|chat ?gpt|openai|\bclaude\b|perplexity|gemini|copilot|\bai\b/i;
const RANK = { referred: 1, booked: 2, completed: 3 };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function fmtDate(d) {
  const s = String(d || '');
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dt = new Date(s); return isNaN(dt.getTime()) ? new Date().toISOString().slice(0, 10) : dt.toISOString().slice(0, 10);
}
// SmartMoving's real opportunity status is a NUMBER (the stage text, e.g. "4) Estimate Scheduled",
// is usually stale). Read from Neon Giant's own jobs, Oct 2026:
//   0-3 open lead/quote, 4 booked, 10 completed, 11 closed (completed + closed out),
//   20/30 lost or cancelled, 50 bad lead / duplicate.
const SM_STATUS = { 0: 'referred', 1: 'referred', 2: 'referred', 3: 'referred', 4: 'booked', 10: 'completed', 11: 'completed', 20: 'lost', 30: 'lost', 50: 'lost' };
export function classifyStage(o) {
  const raw = o && o.status; const n = Number(raw);
  if (raw !== null && raw !== undefined && raw !== '' && !isNaN(n) && SM_STATUS[n]) return SM_STATUS[n];
  // Fallback for text statuses only. "Estimate Scheduled" is NOT booked, so no "scheduled" here.
  const blob = (String(o.leadStatus || '') + ' ' + String(o.status || '') + ' ' + String(o.jobStatus || '')).toLowerCase();
  if (/complet|moved|finished|delivered|closed won|paid in full/.test(blob)) return 'completed';
  if (/\bbooked\b|confirmed|deposit paid|\bwon\b/.test(blob)) return 'booked';
  return 'referred';
}
// Lead sources that are not a referral partner (SmartMoving puts these where a partner would go).
const NOT_PARTNER = /^(something else|other|unknown.*|affiliate|realtors?( referral)?|real estate( agency)?|referral|word of mouth|friend.*|direct mail.*|mailer|employee.*|portal - (affiliate|.*test)|.*\btest\b.*|.*debug.*|.*campaign.*|.*\bfb\b.*|snoball.*|capi-.*)$/i;
function partnerOf(o) {
  if (o.affiliateName && String(o.affiliateName).trim() && !GENERIC.test(String(o.affiliateName)) && !NOT_PARTNER.test(String(o.affiliateName).trim())) return String(o.affiliateName).trim();
  const rs = o.referralSource || o.referralSourceName; let name = '';
  if (rs) { if (typeof rs === 'string') name = rs.trim(); else if (typeof rs === 'object' && (rs.name || rs.type)) name = String(rs.name || rs.type).trim(); }
  if (!name || GENERIC.test(name) || NOT_PARTNER.test(name)) return ''; return name;
}
async function smGet(key, path) {
  try { const r = await fetch(SM_BASE + path, { headers: { 'x-api-key': key, Accept: 'application/json' } }); if (!r.ok) return { ok: false, status: r.status }; return { ok: true, body: await r.json() }; }
  catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
}

/* listRecentOpportunities — confirm the SmartMoving LIST endpoint before trusting auto mode.
 * Candidates to verify (keep the one that returns opp IDs):
 *   A) Public API (x-api-key): GET /api/opportunities?FromServiceDate=YYYYMMDD&ToServiceDate=YYYYMMDD&Page=N
 *   B) Smart Insights report (JWT): POST /api/reports/viper/run/{lead_source_conversion}
 *   C) Dispatch jobs (JWT): GET /api/dispatch/jobs/{y}/{m}/{d}?branchId=...
 * Fail-safe: if none confirmed, returns [] so auto mode is a harmless no-op. */
async function listRecentOpportunities(env, sinceDays) {
  const key = env.SMARTMOVING_API_KEY; if (!key) return [];
  const since = new Date(Date.now() - (sinceDays || 180) * 86400000);
  const from = since.toISOString().slice(0, 10).replace(/-/g, '');
  const to = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  const ids = [];
  try {
    let page = 1, pages = 1;
    do {
      const r = await smGet(key, '/api/opportunities?FromServiceDate=' + from + '&ToServiceDate=' + to + '&Page=' + page + '&PageSize=200');
      if (!r.ok) break;
      const b = r.body || {};
      const arr = Array.isArray(b) ? b : (b.pageResults || b.results || b.data || b.opportunities || []);
      if (!Array.isArray(arr) || !arr.length) break;
      arr.forEach((o) => { const id = o && (o.id || o.opportunityId || o.opportunityID); if (id) ids.push(String(id)); });
      pages = Number(b.totalPages || 1) || 1; page += 1;
    } while (page <= pages && page <= 50);
  } catch (e) { /* endpoint shape not confirmed — stay safe */ }
  return ids;
}

let ALIASES = {};

function rowMatches(r, ids, oppId) {
  return notesContainId(r && r.notes, ids) || (oppId && String((r && r.jobName) || '').indexOf(String(oppId)) >= 0);
}

async function findReferral(db, refsByContact, ids, oppId, preferContactId) {
  const mine = refsByContact[String(preferContactId)] || [];
  let existing = mine.find((r) => rowMatches(r, ids, oppId));
  if (!existing) {
    const lists = Object.keys(refsByContact).map((k) => refsByContact[k]);
    for (let i = 0; i < lists.length && !existing; i++) existing = (lists[i] || []).find((r) => rowMatches(r, ids, oppId));
  }
  if (!existing) {
    const filter = referralIdFilter(ids);
    if (filter) {
      try {
        const rows = (await db.select('referrals?' + filter + '&status=neq.duplicate&select=id,contactId,status,notes,jobName,amount,date&order=id.asc&limit=5')) || [];
        existing = rows[0] || null;
        if (existing) {
          const k = String(existing.contactId || '');
          (refsByContact[k] = refsByContact[k] || []).push(existing);
        }
      } catch (_) { /* in-memory list still stands */ }
    }
  }
  return existing || null;
}

async function reconcileOne(db, oppId, contacts, refsByContact, key, dry, applyLost, env, alerts, seen) {
  const loaded = await loadOpp(key, oppId);
  if (!loaded.ok) {
    if (loaded.flagged) return { id: oppId, skip: 'not-opportunity', flagged: true, detail: loaded.status || 400 };
    return { id: oppId, skip: 'fetch-failed', detail: loaded.status || loaded.err };
  }
  const opp = loaded.opp || {};
  const resolved = String(opp.id || loaded.id || oppId).toLowerCase();
  if (seen) {
    if (seen.has(resolved)) return { id: oppId, skip: 'duplicate-opp', oppId: loaded.id, mappedFrom: loaded.mappedFrom };
    seen.add(resolved);
  }
  const today = new Date().toISOString().slice(0, 10);
  const closeOut = needsSmartMovingCloseOut(opp, today);
  let stage = classifyStage(opp);
  // Invoiced and paid, but SmartMoving still says Booked. Do not auto-mark completed.
  if (closeOut && stage === 'completed') stage = 'booked';
  const cust = (opp.customer && (opp.customer.name || opp.customer.fullName)) || 'SmartMoving job';
  const amount = moneyOf(opp, stage);
  const date = fmtDate(opp.serviceDate);
  const dated = opp.serviceDate ? date : '';
  const ids = oppNoteIds(opp, oppId);
  const stamp = (result, refreshed) => {
    if (loaded.mappedFrom) result.mappedFrom = loaded.mappedFrom;
    result.oppId = opp.id || loaded.id || oppId;
    if (refreshed && refreshed.length) result.refreshed = refreshed;
    if (closeOut) {
      result.needsCloseOut = {
        id: String(opp.id || loaded.id || oppId), requestedId: String(oppId),
        partner: result.partner || null, customer: cust, amount, serviceDate: dated || null,
        smStatus: opp.status, reason: 'Needs close-out in SmartMoving',
      };
    }
    return result;
  };
  const partner = partnerOf(opp);
  if (!partner) return stamp({ id: oppId, skip: 'no-affiliate' });
  const match = matchContact(partner, contacts, ALIASES);
  if (!match) return stamp({ id: oppId, unmatched: partner });
  const lead = opp.leadStatus || stage;
  const existing = await findReferral(db, refsByContact, ids, oppId, match.id);
  if (existing) {
    const fromStatus = existing.status;
    const fields = referralFieldPatch(existing, { amount, date: dated, jobName: cust });
    const refreshed = Object.keys(fields);
    const patch = { ...fields };
    if (!String(existing.contactId || '').trim()) {
      patch.contactId = String(match.id);
      patch.contactName = match.name;
    }
    if (stage === 'lost') {
      // Never demote on our own: report it, and only write when Dane has said yes (applyLost).
      if (applyLost && String(fromStatus || '').toLowerCase() !== 'lost') {
        patch.status = 'lost';
        patch.notes = (existing.notes || '') + ' | reconcile->lost';
        if (!dry) await db.update('referrals', `id=eq.${existing.id}`, patch);
        Object.assign(existing, patch);
        return stamp({ id: oppId, partner: match.name, cust, action: 'lost', from: fromStatus, dry: !!dry }, refreshed);
      }
      if (Object.keys(patch).length && !dry) await db.update('referrals', `id=eq.${existing.id}`, patch);
      if (Object.keys(patch).length) Object.assign(existing, patch);
      return stamp({ id: oppId, partner: match.name, cust, action: 'lost_in_sm', status: fromStatus, smStatus: opp.status }, refreshed);
    }
    const cur = RANK[String(fromStatus || '').toLowerCase()] || 0; const nw = RANK[stage] || 0;
    if (nw > cur) {
      patch.status = stage;
      patch.notes = (existing.notes || '') + ' | reconcile->' + stage;
      if (!dry) await db.update('referrals', `id=eq.${existing.id}`, patch);
      Object.assign(existing, patch);
      // Alert only for CURRENT jobs (a missed webhook), never for old history being cleaned up.
      // Same source_key as the live webhook, so a job can never alert twice.
      // Amount / date / name refreshes do not alert and do not pay out.
      const ago = (d) => new Date(Date.now() - d * 864e5).toISOString().slice(0, 10);
      if (!dry && alerts && ((stage === 'booked' && date >= ago(1)) || (stage === 'completed' && date >= ago(3) && date <= today))) {
        await emitEvent(env, { event: stage === 'booked' ? 'job_booked' : 'job_completed', title: (stage === 'booked' ? 'Booked: ' : 'Completed: ') + cust,
          body: 'Referred by ' + match.name + (stage === 'completed' ? '. Their payout may be due.' : '.'), url: stage === 'completed' ? '/app/#payouts' : '/app/#referrals',
          source_key: 'job:' + (opp.id || oppId) + ':' + stage }).catch(() => {});
      }
      return stamp({ id: oppId, partner: match.name, cust, action: 'advance', from: fromStatus, to: stage, amount, dry: !!dry }, refreshed);
    }
    if (Object.keys(patch).length) {
      if (!dry) await db.update('referrals', `id=eq.${existing.id}`, patch);
      Object.assign(existing, patch);
      return stamp({ id: oppId, partner: match.name, cust, action: 'refresh', status: fromStatus, amount, dry: !!dry }, refreshed);
    }
    return stamp({ id: oppId, partner: match.name, action: 'unchanged', status: fromStatus });
  }
  if (stage === 'lost') return stamp({ id: oppId, partner: match.name, cust, action: 'skip_lost' });
  if (!dry) {
    await db.insert('referrals', {
      contactId: String(match.id), contactName: match.name, jobName: cust, status: stage,
      date: date, amount: String(amount), enteredBy: 'SmartMoving Reconcile', notes: '[SM:' + String(opp.id || oppId) + '] reconciled · ' + lead,
    });
  }
  return stamp({ id: oppId, partner: match.name, action: 'create', stage, cust, amount, dry: !!dry });
}

const handler = endpoint(async ({ env, body, reply }) => {
  const key = env.SMARTMOVING_API_KEY;
  if (!key) return reply({ ok: false, error: 'sm_not_configured' }, 503);
  const db = sb(env);
  const dry = !!body.dry;
  let ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
  const applyLost = !!body.applyLost;
  let enumerated = 0, openTotal = 0, cursorFrom = null, cursorNext = null;
  if (body.auto) { const list = await listRecentOpportunities(env, +body.sinceDays || 180); enumerated = list.length; ids = ids.concat(list); }
  if (body.open) {
    // referred / booked: stored service date within 120 days (unchanged window).
    // completed: 365-day window, so a finished job is rechecked against the final invoice
    // instead of being frozen on the estimate. Legacy notes store a comma-separated list of
    // JOB ids, so every uuid is collected — not only the first [SM:<opp>] tag.
    const since120 = new Date(Date.now() - 120 * 864e5).toISOString().slice(0, 10);
    const since365 = new Date(Date.now() - 365 * 864e5).toISOString().slice(0, 10);
    // [SM:…] tags and legacy "SmartMoving Sync" rows (job ids in a comma list).
    // Filtering here keeps unrelated referrals from crowding the 1000-row cap.
    const smNotes = 'or=(notes.ilike.*%5BSM:*,notes.ilike.*SmartMoving*,enteredBy.ilike.*SmartMoving*)';
    const openRows = (await db.select('referrals?select=id,notes&status=in.(referred,booked)&contactId=neq.&date=gte.' + since120 + '&' + smNotes + '&order=id.asc&limit=1000')) || [];
    const doneRows = (await db.select('referrals?select=id,notes&status=eq.completed&contactId=neq.&date=gte.' + since365 + '&' + smNotes + '&order=id.asc&limit=1000')) || [];
    const oppIds = [];
    const seenU = new Set();
    openRows.concat(doneRows).forEach((r) => {
      uuidsInNotes(r.notes).forEach((u) => {
        const k = String(u).toLowerCase();
        if (seenU.has(k)) return;
        seenU.add(k);
        oppIds.push(u);
      });
    });
    openTotal = oppIds.length;
    const batch = Math.max(1, Math.min(+body.batch || 35, 60));
    let off = 0;
    try { const cs = (await db.select('app_settings?key=eq.sm_reconcile&select=value'))[0]; off = Number(cs && cs.value && cs.value.offset) || 0; } catch (_) {}
    if (off >= openTotal) off = 0;
    cursorFrom = off; ids = ids.concat(oppIds.slice(off, off + batch)); cursorNext = off + batch >= openTotal ? 0 : off + batch;
  }
  const seenId = new Set();
  ids = ids.filter((id) => { const k = String(id).toLowerCase(); if (seenId.has(k)) return false; seenId.add(k); return true; });
  if (!ids.length) return reply({ ok: true, note: body.auto ? 'auto enumeration returned 0 — confirm the SmartMoving list endpoint in listRecentOpportunities()' : 'no ids provided', enumerated });
  let contacts = [], refs = []; ALIASES = await loadAliases(db);
  try { contacts = (await db.select('contacts?select=id,name,business,portalActivatedAt')) || []; } catch (e) { return reply({ ok: false, error: 'contacts_load_failed', message: e.message }, 500); }
  try { refs = (await db.select('referrals?select=id,contactId,status,notes,jobName,amount,date&limit=2000')) || []; } catch (e) {}
  const refsByContact = {}; refs.forEach((r) => { const k = String(r.contactId); (refsByContact[k] = refsByContact[k] || []).push(r); });
  const out = [];
  const seenOpp = new Set();
  for (const id of ids) { try { out.push(await reconcileOne(db, id, contacts, refsByContact, key, dry, applyLost, env, !!body.alerts, seenOpp)); } catch (e) { out.push({ id, error: String(e && e.message || e) }); } }
  if (body.open && !dry && cursorNext !== null) {
    try { await db.update('app_settings', 'key=eq.sm_reconcile', { value: { offset: cursorNext, at: new Date().toISOString() } }); } catch (_) {}
  }
  const tally = (a) => out.filter((o) => o.action === a).length;
  const needsCloseOut = out.map((o) => o.needsCloseOut).filter(Boolean);
  const flaggedJobIds = out.filter((o) => o.flagged).map((o) => ({ id: o.id, detail: o.detail || 400, skip: o.skip || 'not-opportunity' }));
  return reply({
    ok: true, dry, scanned: ids.length, enumerated,
    created: tally('create'), advanced: tally('advance'), unchanged: tally('unchanged'),
    refreshed: out.filter((o) => o.refreshed && o.refreshed.length).length,
    lostInSmartMoving: tally('lost_in_sm'), markedLost: tally('lost'), fetchFailed: out.filter((o) => o.skip === 'fetch-failed').length,
    flaggedJobIds, needsCloseOut,
    unmatched: out.filter((o) => o.unmatched).length, openTotal, cursorFrom, cursorNext,
    results: out.filter((o) => o.action !== 'unchanged' && o.skip !== 'duplicate-opp').slice(0, 80),
  });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
