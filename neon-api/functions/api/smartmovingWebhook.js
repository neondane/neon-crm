/** POST /api/smartmovingWebhook — SmartMoving fires this when a job changes status.
 *  Matches the job to a portal_lead and updates its status (e.g. -> 'completed' or 'booked').
 *  DELIBERATELY does NOT send money — payouts stay human-initiated in the CRM "Payouts Due"
 *  view. This only flips the lead's status so it surfaces there.
 *
 *  Configure in SmartMoving: webhook URL = https://neon-api.pages.dev/api/smartmovingWebhook
 *  (append ?secret=... if SMARTMOVING_WEBHOOK_SECRET is set).
 *
 *  Accepts a flexible payload — matches on smJobId first, then customerName + phone.
 *  Env: SUPABASE_URL, SUPABASE_KEY, SMARTMOVING_WEBHOOK_SECRET? */
import { endpoint, preflight, sb } from '../_shared.js';

function mapStatus(raw) {
  const s = String(raw || '').toLowerCase();
  if (/complete|closed.?won|finished|done|paid/.test(s)) return 'completed';
  if (/book|scheduled|won|sold/.test(s)) return 'booked';
  if (/lost|cancel|dead/.test(s)) return 'lost';
  return null; // unknown/irrelevant status — ignore
}

const handler = endpoint(async ({ request, env, body, reply }) => {
  // Optional shared-secret gate (query param or header).
  if (env.SMARTMOVING_WEBHOOK_SECRET) {
    const url = new URL(request.url);
    const got = url.searchParams.get('secret') || request.headers.get('x-webhook-secret') || '';
    if (got !== env.SMARTMOVING_WEBHOOK_SECRET) return reply({ ok: false, error: 'unauthorized' }, 401);
  }

  const p = body || {};
  const smJobId = p.smJobId || p.jobId || p.jobNumber || p.leadId || (p.job && p.job.id) || '';
  const custName = p.customerName || p.fullName || p.name || (p.customer && p.customer.name) || '';
  const phone = String(p.customerPhone || p.phone || p.phoneNumber || (p.customer && p.customer.phone) || '').replace(/[^\d]/g, '');
  const newStatus = mapStatus(p.status || p.jobStatus || (p.job && p.job.status));
  if (!newStatus) return reply({ ok: true, ignored: true, reason: 'status not actionable' });

  const db = sb(env);
  // Find the matching portal lead.
  let lead = null;
  try {
    if (smJobId) {
      const r = await db.select(`portal_leads?smJobId=eq.${encodeURIComponent(smJobId)}&select=id,status,realtorId&limit=1`);
      lead = r && r[0];
    }
    if (!lead && custName) {
      const r = await db.select(`portal_leads?customerName=ilike.${encodeURIComponent('%' + custName + '%')}&select=id,status,customerPhone,realtorId&order=submittedAt.desc&limit=5`);
      const cands = r || [];
      lead = phone ? cands.find((c) => String(c.customerPhone || '').replace(/[^\d]/g, '').endsWith(phone.slice(-7))) : cands[0];
    }
  } catch (e) {
    return reply({ ok: false, error: 'lookup_failed', message: e.message }, 500);
  }
  if (!lead) return reply({ ok: true, matched: false, reason: 'no matching portal lead' });

  // Don't downgrade a completed lead back to booked.
  const rank = { lost: 0, new: 1, contacted: 1, booked: 2, completed: 3 };
  if ((rank[String(lead.status || '').toLowerCase()] || 0) >= (rank[newStatus] || 0) && newStatus !== 'lost') {
    return reply({ ok: true, matched: true, leadId: lead.id, unchanged: true, status: lead.status });
  }

  try {
    const patch = { status: newStatus };
    if (newStatus === 'completed') patch.completedAt = new Date().toISOString();
    await db.update('portal_leads', `id=eq.${lead.id}`, patch);
  } catch (e) {
    return reply({ ok: false, error: 'update_failed', message: e.message }, 500);
  }
  return reply({ ok: true, matched: true, leadId: lead.id, newStatus });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
