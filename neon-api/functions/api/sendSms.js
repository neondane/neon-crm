/** POST /api/sendSms — send a text via Twilio, log it to Supabase sms_messages.
 *  Body: { to, body, contactId?, kind? }  ·  Returns { ok, sid, status }
 *  Env: TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, SUPABASE_URL, SUPABASE_KEY */
import { endpoint, preflight, sb, toE164 } from '../_shared.js';

async function logSms(env, row) {
  try { await sb(env).insert('sms_messages', row, { returning: 'minimal' }); } catch (_) { /* best-effort */ }
}

const handler = endpoint(async ({ env, body, reply }) => {
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM)
    return reply({ ok: false, error: 'twilio_not_configured' }, 503);

  const to = toE164(body.to);
  const text = String(body.body || '').trim();
  const kind = String(body.kind || 'manual').slice(0, 40);
  const contactId = body.contactId != null ? body.contactId : null;
  if (!to) return reply({ ok: false, error: 'missing_or_invalid_to' }, 400);
  if (!text) return reply({ ok: false, error: 'missing_body' }, 400);

  const form = new URLSearchParams({ To: to, From: env.TWILIO_FROM, Body: text.slice(0, 1500) });
  const auth = btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`);
  let res, j;
  try {
    res = await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    j = await res.json();
  } catch (e) {
    await logSms(env, { direction: 'out', to_number: to, from_number: env.TWILIO_FROM, body: text, kind, contact_id: contactId, status: 'network_error', error_message: e.message });
    return reply({ ok: false, error: 'twilio_network_error', message: e.message }, 502);
  }
  if (!res.ok) {
    await logSms(env, { direction: 'out', to_number: to, from_number: env.TWILIO_FROM, body: text, kind, contact_id: contactId, status: 'failed', error_code: j.code, error_message: j.message });
    return reply({ ok: false, error: 'twilio_rejected', code: j.code, message: j.message }, 502);
  }
  // Note: the CRM logs the successful outbound row itself (single source of truth),
  // so we don't log success here to avoid duplicate conversation entries.
  return reply({ ok: true, sid: j.sid, status: j.status, to: j.to, from: j.from });
});

export const onRequestPost = handler;
export const onRequestGet = handler;
export const onRequestOptions = ({ request }) => preflight(request);

