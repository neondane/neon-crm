/** POST|GET /api/retryReferrals : makes sure every portal referral reaches SmartMoving.
 *
 *  The portal (refer.neongiantmoving.com) saves each referral to portal_leads FIRST, with
 *  the exact SmartMoving payload in sm_payload, then sends it. If SmartMoving rejects it or
 *  can't be reached, the row is left as sm_status = 'retrying'. This job:
 *    1. resends due rows (backoff 5, 10, 20, 40, 80 min; 6 tries total),
 *    2. texts the owner ONCE on the first failure, once if it later recovers, and once
 *       with the customer's details if all 6 tries fail ("enter it by hand"),
 *    3. treats a row stuck in 'pending' for 3+ minutes as due (the portal died mid-way).
 *  Runs every 10 minutes from the CRM database scheduler (pg_cron job
 *  'neon-portal-referral-retry'), and right away when the portal sees a failure.
 *
 *  No login needed on purpose: it only acts on rows already in the database, respects the
 *  backoff, and can't be made to text anything except these fixed alerts. Each try is
 *  "claimed" first, so two runs at once can't send the same lead twice.
 *
 *  Env: SUPABASE_URL, SUPABASE_KEY, SMARTMOVING_PROVIDER_KEY?, SM_LEAD_BRANCH_ID?,
 *       ALERT_PHONE, TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM
 */
import { endpoint, preflight } from '../_shared.js';
import { notifyOwner } from '../_webhooks.js';

const SM_PROVIDER_KEY_FALLBACK = 'd18a311b-7df6-4483-90a7-b3d201630cea'; // TODO Phase 2: remove after the key is rotated
const MAX_ATTEMPTS = 6;
const WAIT_MIN = [0, 5, 10, 20, 40, 80]; // minutes to wait after N attempts before the next one
const PENDING_STALE_MS = 3 * 60 * 1000;

async function sendToSmartMoving(env, payload) {
  if (payload && payload.__simulateFailure) return { ok: false, error: 'simulated_failure' };
  const providerKey = env.SMARTMOVING_PROVIDER_KEY || SM_PROVIDER_KEY_FALLBACK;
  let url = 'https://api.smartmoving.com/api/leads/from-provider/v2?providerKey=' + encodeURIComponent(providerKey);
  if (env.SM_LEAD_BRANCH_ID) url += '&branchId=' + encodeURIComponent(env.SM_LEAD_BRANCH_ID);
  try {
    const r = await fetch(url, {
      method: 'POST', headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload), signal: AbortSignal.timeout(10000),
    });
    const txt = await r.text();
    if (r.ok) { let j = {}; try { j = JSON.parse(txt); } catch (_) {} return { ok: true, smJobId: String((j && (j.leadId || j.id)) || '') }; }
    if (r.status === 400 && /already/i.test(txt || '')) return { ok: true, duplicate: true, smJobId: '' };
    return { ok: false, error: 'smartmoving_' + r.status + ': ' + (txt || '').slice(0, 160) };
  } catch (e) {
    const t = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, error: t ? 'smartmoving_timeout' : 'smartmoving_network_error' };
  }
}

function db(env) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const h = { apikey: env.SUPABASE_KEY, Authorization: 'Bearer ' + env.SUPABASE_KEY, 'Content-Type': 'application/json' };
  return {
    async get(q) {
      const r = await fetch(base + '/rest/v1/' + q, { headers: h });
      if (!r.ok) throw new Error('db_get_' + r.status + ': ' + (await r.text()).slice(0, 160));
      return r.json();
    },
    // PATCH with a filter; returns the rows it actually changed (empty = someone else got there first).
    async patch(q, obj) {
      const r = await fetch(base + '/rest/v1/' + q, { method: 'PATCH', headers: { ...h, Prefer: 'return=representation' }, body: JSON.stringify(obj) });
      if (!r.ok) throw new Error('db_patch_' + r.status + ': ' + (await r.text()).slice(0, 160));
      return r.json();
    },
  };
}

const who = (row) => `${(row.realtorName || 'Unknown realtor').trim()}'s referral for ${(row.customerName || 'a customer').trim()}`;

const handler = endpoint(async ({ env, reply }) => {
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) return reply({ ok: false, error: 'supabase_not_configured' }, 503);
  const d = db(env);
  const now = Date.now();
  const out = { ok: true, checked: 0, sent: 0, recovered: 0, stillRetrying: 0, gaveUp: 0, alerts: 0, waiting: 0, errors: [] };

  let rows = [];
  try {
    rows = await d.get('portal_leads?select=id,submittedAt,realtorName,customerName,customerPhone,customerEmail,fromAddress,toAddress,moveDate,sm_status,sm_attempts,sm_last_attempt_at,sm_alerted_at,sm_payload,sm_error' +
      '&sm_status=in.(pending,retrying)&order=id.asc&limit=25');
  } catch (e) { return reply({ ok: false, error: String(e.message || e) }, 500); }

  for (const row of rows) {
    out.checked++;
    const attempts = Number(row.sm_attempts) || 0;
    const lastAt = row.sm_last_attempt_at ? Date.parse(row.sm_last_attempt_at) : 0;
    const createdAt = Date.parse(row.submittedAt || '') || 0;

    // First-failure alert (once), even while we wait for the next try.
    if (row.sm_status === 'retrying' && !row.sm_alerted_at) {
      const claimed = await d.patch(`portal_leads?id=eq.${row.id}&sm_alerted_at=is.null`, { sm_alerted_at: new Date().toISOString() }).catch(() => []);
      if (claimed.length) {
        out.alerts++;
        await notifyOwner(env, `Neon Giant: ${who(row)} did NOT reach SmartMoving yet (${String(row.sm_error || 'unknown error').slice(0, 80)}). It's saved and retrying automatically. Customer: ${row.customerPhone || 'no phone'}.`);
      }
    }

    const due = row.sm_status === 'pending'
      ? (now - (lastAt || createdAt)) >= PENDING_STALE_MS
      : (now - lastAt) >= (WAIT_MIN[Math.min(attempts, WAIT_MIN.length - 1)] * 60000);
    if (!due) { out.waiting++; continue; }

    if (!row.sm_payload) {
      await d.patch(`portal_leads?id=eq.${row.id}`, { sm_status: 'failed', sm_error: 'no saved payload' }).catch(() => {});
      out.gaveUp++; out.alerts++;
      await notifyOwner(env, `Neon Giant: ${who(row)} never reached SmartMoving. Please enter it by hand. Customer: ${row.customerName}, ${row.customerPhone || 'no phone'}.`);
      continue;
    }

    // Claim this attempt so a parallel run can't send the same lead twice.
    const claim = await d.patch(`portal_leads?id=eq.${row.id}&sm_attempts=eq.${attempts}&sm_status=in.(pending,retrying)`,
      { sm_attempts: attempts + 1, sm_last_attempt_at: new Date().toISOString() }).catch((e) => { out.errors.push(String(e.message || e)); return []; });
    if (!claim.length) continue;

    out.sent++;
    const sm = await sendToSmartMoving(env, row.sm_payload);
    if (sm.ok) {
      await d.patch(`portal_leads?id=eq.${row.id}`, { sm_status: sm.duplicate ? 'duplicate' : 'accepted', smJobId: sm.smJobId || '', sm_error: null }).catch((e) => out.errors.push(String(e.message || e)));
      out.recovered++;
      if (row.sm_alerted_at || row.sm_status === 'retrying') {
        out.alerts++;
        await notifyOwner(env, `Neon Giant: fixed. ${who(row)} reached SmartMoving on try ${attempts + 1}. Nothing to do.`);
      }
    } else if (attempts + 1 >= MAX_ATTEMPTS) {
      await d.patch(`portal_leads?id=eq.${row.id}`, { sm_status: 'failed', sm_error: sm.error }).catch((e) => out.errors.push(String(e.message || e)));
      out.gaveUp++; out.alerts++;
      await notifyOwner(env, `Neon Giant: ${who(row)} still failed after ${MAX_ATTEMPTS} tries. Please enter it in SmartMoving by hand. Customer: ${row.customerName}, ${row.customerPhone || 'no phone'}${row.customerEmail ? ', ' + row.customerEmail : ''}. Move: ${row.fromAddress || '?'} to ${row.toAddress || '?'}${row.moveDate ? ' on ' + row.moveDate : ''}.`);
    } else {
      await d.patch(`portal_leads?id=eq.${row.id}`, { sm_status: 'retrying', sm_error: sm.error }).catch((e) => out.errors.push(String(e.message || e)));
      out.stillRetrying++;
      if (!row.sm_alerted_at && row.sm_status === 'pending') {
        const c2 = await d.patch(`portal_leads?id=eq.${row.id}&sm_alerted_at=is.null`, { sm_alerted_at: new Date().toISOString() }).catch(() => []);
        if (c2.length) {
          out.alerts++;
          await notifyOwner(env, `Neon Giant: ${who(row)} did NOT reach SmartMoving yet (${String(sm.error).slice(0, 80)}). It's saved and retrying automatically. Customer: ${row.customerPhone || 'no phone'}.`);
        }
      }
    }
  }
  return reply(out);
});

export const onRequestPost = handler;
export const onRequestGet = handler;
export const onRequestOptions = ({ request }) => preflight(request);
