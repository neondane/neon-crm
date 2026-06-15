/** GET|POST /api/monitorPipeline?token=...  — server-side guardrail for the
 *  realtor referral pipeline. It (1) confirms SmartMoving is configured and
 *  (2) checks that recent portal referrals all received a SmartMoving lead id.
 *  If anything is wrong it TEXTS ALERT_PHONE via Twilio. Designed to be hit on a
 *  schedule (a Cloudflare Worker Cron Trigger) so it runs 24/7, independent of
 *  any laptop being on.
 *
 *  Auth: requires ?token=<MONITOR_TOKEN> (or {token} in the JSON body) so random
 *  hits can't trigger texts. Add &test=1 to force a "healthy" test text.
 *
 *  Env: MONITOR_TOKEN (required), ALERT_PHONE, SUPABASE_URL, SUPABASE_KEY,
 *       SMARTMOVING_API_KEY, SMARTMOVING_CLIENT_ID, TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM
 */
import { endpoint, preflight, sb, toE164 } from '../_shared.js';

async function sendAlert(env, text) {
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM) return { ok: false, error: 'twilio_not_configured' };
  const to = toE164(env.ALERT_PHONE);
  if (!to) return { ok: false, error: 'no_alert_phone' };
  const form = new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: String(text).slice(0, 1500) });
  const auth = btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`);
  try {
    const res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    const j = await res.json();
    return res.ok ? { ok: true, sid: j.sid } : { ok: false, error: 'twilio_' + (j.code || res.status), message: j.message };
  } catch (e) {
    return { ok: false, error: 'twilio_network_error', message: e.message };
  }
}

const handler = endpoint(async ({ env, body, request, reply }) => {
  const url = new URL(request.url);
  const token = url.searchParams.get('token') || (body && body.token) || '';
  if (!env.MONITOR_TOKEN || token !== env.MONITOR_TOKEN) return reply({ ok: false, error: 'unauthorized' }, 401);

  // 1) config present?
  const config = { apiKey: !!env.SMARTMOVING_API_KEY, clientId: !!env.SMARTMOVING_CLIENT_ID };
  const configOk = config.apiKey && config.clientId;

  // 2) recent portal referrals that never got a SmartMoving id (real misses)
  const sinceIso = new Date(Date.now() - 48 * 3600 * 1000).toISOString();
  let stale = [];
  let dbError = null;
  try {
    const rows = await sb(env).select(
      `portal_leads?select=id,customerName,realtorName,smJobId,submittedAt,notes` +
      `&submittedAt=gte.${encodeURIComponent(sinceIso)}&order=submittedAt.desc&limit=300`
    );
    stale = (rows || []).filter((l) => {
      const noSm = !l.smJobId || String(l.smJobId).trim() === '';
      const isTest = /^ZZ TEST|^AUTOMATED/i.test(l.customerName || '');
      return noSm && !isTest;
    });
  } catch (e) {
    dbError = e.message;
  }

  const problems = [];
  if (!configOk) problems.push(`SmartMoving not configured (apiKey:${config.apiKey} clientId:${config.clientId})`);
  if (dbError) problems.push(`DB check failed: ${dbError}`);
  if (stale.length) problems.push(`${stale.length} referral(s) in last 48h did NOT reach SmartMoving`);

  let alert = null;
  const force = url.searchParams.get('test') === '1';
  if (problems.length || force) {
    const names = stale.slice(0, 5).map((s) => `${s.customerName} (via ${s.realtorName || '?'})`).join('; ');
    const msg = problems.length
      ? `⚠️ Neon Giant: referral pipeline issue - ${problems.join(' | ')}.` +
        (names ? ` Missed: ${names}.` : '') +
        ` Check neon-api SMARTMOVING_* env + neon-portal build.`
      : `✅ Neon Giant monitor test: pipeline healthy.`;
    alert = await sendAlert(env, msg);
  }

  return reply({
    ok: problems.length === 0,
    configOk,
    staleCount: stale.length,
    stale: stale.map((s) => ({ id: s.id, customer: s.customerName, realtor: s.realtorName, when: s.submittedAt })),
    dbError,
    alerted: !!alert,
    alert,
  });
});

export const onRequestGet = handler;
export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
