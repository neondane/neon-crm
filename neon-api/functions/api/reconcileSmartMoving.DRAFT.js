/** DRAFT — POST /api/reconcileSmartMoving — the TRUE backfill the system never had.
 *  Reconciles SmartMoving opportunities into Supabase `referrals` so a missed webhook
 *  (outage, dropped event, >14d old) SELF-HEALS instead of being lost forever — which is
 *  exactly how Andrew Sale's ~$15k SF job (opp 32468) went uncredited.
 *
 *  Reuses the live webhook's proven logic (partnerOf / matchContact / classifyStage), writes
 *  DIRECTLY to Supabase via sb(), dedupes by the [SM:<oppId>] tag, only ADVANCES status,
 *  and NEVER sends money. Idempotent: safe to run repeatedly.
 *
 *  Two modes:
 *    { "ids": ["<oppId>", ...], "dry": true|false }   ← WORKS NOW via the proven single-opp GET.
 *                                                        Use this to fix known-missing jobs today.
 *    { "auto": true, "sinceDays": 180, "dry": true }  ← daily self-heal. Enumerates recent opps.
 *        NOTE: listRecentOpportunities() must be pointed at the correct SmartMoving LIST endpoint.
 *        Until confirmed it returns [] (no-op) — so this mode can never write bad data.
 *
 *  Env: SUPABASE_URL, SUPABASE_KEY, SMARTMOVING_API_KEY  (+ SMARTMOVING_JWT if using the report API)
 */
import { endpoint, preflight, sb } from '../_shared.js';

const SM_BASE = 'https://api-public.smartmoving.com/v1';
const GENERIC = /google|yelp|\bweb\b|website|online|bing|drive.?by|signage|sign\b|past customer|return(ing)? customer|repeat customer|former customer|facebook|instagram|social|yard sign|billboard|angi|thumbtack|home.?advisor|walk.?in|truck|wrap|\bnone\b|^n\/?a$|^other$|unknown|search engine/i;
const RANK = { referred: 1, booked: 2, completed: 3 };
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function fmtDate(d) {
  const s = String(d || '');
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dt = new Date(s); return isNaN(dt.getTime()) ? new Date().toISOString().slice(0, 10) : dt.toISOString().slice(0, 10);
}
function classifyStage(o) {
  const blob = (String(o.leadStatus || '') + ' ' + String(o.status || '') + ' ' + String(o.jobStatus || '')).toLowerCase();
  const today = new Date().toISOString().slice(0, 10); const svc = fmtDate(o.serviceDate);
  const paid = Array.isArray(o.payments) && o.payments.some((p) => Number(p && (p.amount || p.total || p.value)) > 0);
  if (/complet|moved|finished|delivered|closed won|paid in full/.test(blob)) return 'completed';
  if (o.serviceDate && svc < today && paid) return 'completed';
  if (/book|confirm|scheduled|deposit|\bwon\b/.test(blob)) return 'booked';
  return 'referred';
}
function partnerOf(o) {
  if (o.affiliateName && String(o.affiliateName).trim()) return String(o.affiliateName).trim();
  const rs = o.referralSource || o.referralSourceName; let name = '';
  if (rs) { if (typeof rs === 'string') name = rs.trim(); else if (typeof rs === 'object' && (rs.name || rs.type)) name = String(rs.name || rs.type).trim(); }
  if (!name || GENERIC.test(name)) return ''; return name;
}
function matchContact(partner, contacts) {
  const t = norm(partner); if (!t) return null;
  let m = contacts.find((c) => norm(c.name) === t || norm(c.business) === t); if (m) return m;
  if (t.length > 4) {
    m = contacts.find((c) => { const n = norm(c.name); return n.length > 4 && (n.indexOf(t) >= 0 || t.indexOf(n) >= 0); }); if (m) return m;
    m = contacts.find((c) => { const b = norm(c.business); return b.length > 4 && (b.indexOf(t) >= 0 || t.indexOf(b) >= 0); }); if (m) return m;
  }
  return null;
}
async function smGet(key, path) {
  try { const r = await fetch(SM_BASE + path, { headers: { 'x-api-key': key, Accept: 'application/json' } }); if (!r.ok) return { ok: false, status: r.status }; return { ok: true, body: await r.json() }; }
  catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
}

/* ---------------------------------------------------------------------------
 * listRecentOpportunities — the ONE thing to confirm before trusting auto mode.
 * Candidates to verify with SmartMoving (then keep the one that returns opp IDs):
 *   A) Public API list (x-api-key):  GET /api/opportunities?FromServiceDate=YYYYMMDD&ToServiceDate=YYYYMMDD&Page=N
 *   B) Smart Insights report (JWT):  POST /api/reports/viper/run/{lead_source_conversion} (one row per opp)
 *   C) Dispatch jobs (JWT):          GET /api/dispatch/jobs/{y}/{m}/{d}?branchId=...  (walk the date range)
 * Fail-safe: if none confirmed, returns [] so auto mode is a harmless no-op.
 * --------------------------------------------------------------------------- */
async function listRecentOpportunities(env, sinceDays) {
  const key = env.SMARTMOVING_API_KEY; if (!key) return [];
  const since = new Date(Date.now() - (sinceDays || 180) * 86400000);
  const from = since.toISOString().slice(0, 10).replace(/-/g, '');
  const to = new Date().toISOString().slice(0, 10).replace(/-/g, '');
  // Best-effort attempt at the public list endpoint; tolerate any shape, only trust an array of ids.
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
  return ids; // [] if the endpoint isn't the right one — auto mode then no-ops (never writes bad data)
}

// Reconcile a single opportunity into referrals. Returns a small result object. Never pays.
async function reconcileOne(db, oppId, contacts, refsByContact, key, dry) {
  const g = await smGet(key, '/api/opportunities/' + encodeURIComponent(oppId));
  if (!g.ok) return { id: oppId, skip: 'fetch-failed', detail: g.status || g.err };
  const opp = g.body;
  const partner = partnerOf(opp);
  if (!partner) return { id: oppId, skip: 'no-affiliate' }; // (portal_leads path handled by the webhook/sync)
  const match = matchContact(partner, contacts);
  if (!match) return { id: oppId, unmatched: partner };
  const stage = classifyStage(opp);
  const cust = (opp.customer && (opp.customer.name || opp.customer.fullName)) || 'SmartMoving job';
  const amount = Number((opp.estimatedTotal && (opp.estimatedTotal.finalTotal || opp.estimatedTotal.subtotal)) || 0) || 0;
  const date = fmtDate(opp.serviceDate);
  const lead = opp.leadStatus || stage;
  const tag = String(oppId);
  const mine = refsByContact[String(match.id)] || [];
  const existing = mine.find((r) => (String(r.notes || '') + ' ' + String(r.jobName || '')).indexOf(tag) >= 0);

  if (existing) {
    const cur = RANK[String(existing.status || '').toLowerCase()] || 0; const nw = RANK[stage] || 0;
    if (nw > cur) {
      if (!dry) await db.update('referrals', `id=eq.${existing.id}`, { status: stage, notes: (existing.notes || '') + ' | reconcile->' + stage });
      return { id: oppId, partner: match.name, action: 'advance', from: existing.status, to: stage, dry: !!dry };
    }
    return { id: oppId, partner: match.name, action: 'unchanged', status: existing.status };
  }
  if (!dry) {
    await db.insert('referrals', {
      contactId: String(match.id), contactName: match.name, jobName: cust, status: stage,
      date: date, amount: String(amount), enteredBy: 'SmartMoving Reconcile', notes: '[SM:' + oppId + '] reconciled · ' + lead,
    });
  }
  return { id: oppId, partner: match.name, action: 'create', stage, cust, amount, dry: !!dry };
}

const handler = endpoint(async ({ env, body, reply }) => {
  const key = env.SMARTMOVING_API_KEY;
  if (!key) return reply({ ok: false, error: 'sm_not_configured' }, 503);
  const db = sb(env);
  const dry = !!body.dry;

  // Gather IDs to reconcile.
  let ids = Array.isArray(body.ids) ? body.ids.map(String).filter(Boolean) : [];
  let enumerated = 0;
  if (body.auto) { const list = await listRecentOpportunities(env, +body.sinceDays || 180); enumerated = list.length; ids = ids.concat(list); }
  ids = Array.from(new Set(ids));
  if (!ids.length) return reply({ ok: true, note: body.auto ? 'auto enumeration returned 0 — confirm the SmartMoving list endpoint in listRecentOpportunities()' : 'no ids provided', enumerated });

  // Load contacts + referrals once, index referrals by contact for dedupe.
  let contacts = [], refs = [];
  try { contacts = (await db.select('contacts?select=id,name,business')) || []; } catch (e) { return reply({ ok: false, error: 'contacts_load_failed', message: e.message }, 500); }
  try { refs = (await db.select('referrals?select=id,contactId,status,notes,jobName&limit=2000')) || []; } catch (e) {}
  const refsByContact = {}; refs.forEach((r) => { const k = String(r.contactId); (refsByContact[k] = refsByContact[k] || []).push(r); });

  const out = [];
  for (const id of ids) { try { out.push(await reconcileOne(db, id, contacts, refsByContact, key, dry)); } catch (e) { out.push({ id, error: String(e && e.message || e) }); } }
  const tally = (a) => out.filter((o) => o.action === a).length;
  return reply({
    ok: true, dry, scanned: ids.length, enumerated,
    created: tally('create'), advanced: tally('advance'), unchanged: tally('unchanged'),
    unmatched: out.filter((o) => o.unmatched).length, results: out.slice(0, 60),
  });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
