/** _appguard.js : test mode for the new phone app (crm3 /app).
 *
 *  Only requests the CRM gateway marks with X-Neon-App: crm-app are checked, so the
 *  desktop CRM behaves exactly as before. Settings live in Supabase table app_settings
 *  (key 'crm_app'), which the public key cannot read or change:
 *    sends_live      false = the app may only text/email/pay the allowlisted people
 *    allow_phones    e.g. ["3609299723"]   (last 10 digits are compared)
 *    allow_emails    e.g. ["dane@neongiantmoving.com"]
 *    payout_senders  team logins allowed to send payouts from the app
 *  Fails CLOSED: if the settings can't be read, app sends are blocked.
 */

const TEST_MODE_MSG = 'Test mode: the new app can only message Dane, Jeff and Valentina until Dane turns it on.';

export function isAppRequest(request) {
  return (request.headers.get('X-Neon-App') || '') === 'crm-app';
}

async function appSettings(env) {
  try {
    const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
    const r = await fetch(base + '/rest/v1/app_settings?key=eq.crm_app&select=value', {
      headers: { apikey: env.SUPABASE_KEY, Authorization: 'Bearer ' + env.SUPABASE_KEY },
    });
    if (!r.ok) return null;
    const rows = await r.json();
    return (rows && rows[0] && rows[0].value) || null;
  } catch (_) { return null; }
}

const last10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);

/** kind: 'sms' | 'email'. Returns { ok:true } or { ok:false, status, error, message }. */
export async function appSendGuard(env, request, kind, to) {
  if (!isAppRequest(request)) return { ok: true };
  const s = await appSettings(env);
  if (!s) return { ok: false, status: 503, error: 'test_mode_unreadable', message: 'Could not confirm test mode, so nothing was sent.' };
  if (s.sends_live === true) return { ok: true };
  if (kind === 'sms') {
    const d = last10(to);
    if (d && (s.allow_phones || []).map(last10).includes(d)) return { ok: true };
  } else {
    const e = String(to || '').trim().toLowerCase();
    if (e && (s.allow_emails || []).map((x) => String(x).trim().toLowerCase()).includes(e)) return { ok: true };
  }
  return { ok: false, status: 403, error: 'test_mode', message: TEST_MODE_MSG };
}

/** Payouts from the app: only listed senders; while in test mode only to allowlisted emails
 *  (a dry run moves no money, so it is allowed for listed senders). */
export async function appPayoutGuard(env, request, recipientEmail, dryRun) {
  if (!isAppRequest(request)) return { ok: true };
  const s = await appSettings(env);
  if (!s) return { ok: false, status: 503, error: 'test_mode_unreadable', message: 'Could not confirm payout permissions, so nothing was sent.' };
  const user = String(request.headers.get('X-Neon-User') || '').trim().toLowerCase();
  const senders = (s.payout_senders || []).map((x) => String(x).trim().toLowerCase());
  if (!user || !senders.includes(user)) {
    return { ok: false, status: 403, error: 'not_a_payout_sender', message: 'Payouts from the app are limited to the people Dane picked.' };
  }
  if (dryRun === true || s.sends_live === true) return { ok: true };
  const e = String(recipientEmail || '').trim().toLowerCase();
  if ((s.allow_emails || []).map((x) => String(x).trim().toLowerCase()).includes(e)) return { ok: true };
  return { ok: false, status: 403, error: 'test_mode', message: 'Test mode: real payouts from the app are off until Dane turns it on. Use the desktop CRM for now.' };
}
