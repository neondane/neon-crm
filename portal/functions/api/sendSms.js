/**
 * /api/sendSms.js — Server-side wrapper around Twilio's REST API
 *
 *   POST /api/sendSms
 *     Body: { to: "+13605551234", body: "Hi from Neon Giant", kind?: "thanks_24h" }
 *     Returns: { ok:true, sid:"SMxxx...", twilio:{...} } on success
 *
 * Twilio creds are read from Cloudflare Pages environment variables:
 *   TWILIO_SID    — Account SID  (AC23c527...)
 *   TWILIO_TOKEN  — Auth Token   (kept secret in Cloudflare, never exposed)
 *   TWILIO_FROM   — Sender number in E.164 (+13605885228)
 *
 * Why server-side: the Auth Token must NEVER leave the edge. Calling Twilio
 * from the browser would expose it. This function lives on Cloudflare Workers
 * (Pages Functions runtime), holds the secret, and signs the request itself.
 *
 * Failure modes:
 *  - Missing env vars  → 503 with a clear "not configured yet" message
 *  - Bad input         → 400 with the missing field
 *  - Twilio rejected   → 502 with Twilio's error code/message passed through
 *
 * Logging: every send (success or failure) writes a row to sms_messages in
 * Supabase via the SUPABASE_URL + SUPABASE_KEY env vars, so the CRM
 * Conversations tab always reflects reality.
 */

const ALLOWED_ORIGINS = [
  'https://refer.neongiantmoving.com',
  'https://crm.neongiantmoving.com',
  'https://crm3.neongiantmoving.com',
  'https://portal.neongiantmoving.com',
];

function corsHeaders(origin) {
  let allow = ALLOWED_ORIGINS[0];
  if (origin && ALLOWED_ORIGINS.includes(origin)) allow = origin;
  else if (origin) { try { if (new URL(origin).hostname.endsWith('.pages.dev')) allow = origin; } catch (e) {} }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

// E.164 normalize: strips everything but digits, prepends +1 if 10-digit US-shaped.
function toE164(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d]/g, '');
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  if (d.length === 10) return '+1' + d;
  if (d.length > 10 && d.length <= 15) return '+' + d;
  return null;
}

async function logToSupabase(env, row) {
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) return; // logging is best-effort
  try {
    await fetch(env.SUPABASE_URL + '/rest/v1/sms_messages', {
      method: 'POST',
      headers: {
        'apikey': env.SUPABASE_KEY,
        'Authorization': 'Bearer ' + env.SUPABASE_KEY,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(row),
    });
  } catch (_e) { /* swallow — we already returned to caller */ }
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');

  // 1. Env var check — surfaces a friendly error if Twilio creds aren't set yet.
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM) {
    return json({
      ok: false,
      error: 'twilio_not_configured',
      message: 'TWILIO_SID, TWILIO_TOKEN, and TWILIO_FROM must be set as Cloudflare Pages env vars before SMS will work. See SMS-SETUP.md.',
    }, 503, origin);
  }

  // 2. Parse + validate input.
  let body;
  try { body = await request.json(); }
  catch (_e) { return json({ ok: false, error: 'bad_json' }, 400, origin); }

  const to = toE164(body.to);
  const text = (body.body || '').toString().trim();
  const kind = (body.kind || 'manual').toString().slice(0, 40);
  const contactId = body.contactId || null;

  if (!to)   return json({ ok: false, error: 'missing_or_invalid_to' }, 400, origin);
  if (!text) return json({ ok: false, error: 'missing_body' }, 400, origin);
  if (text.length > 1500) return json({ ok: false, error: 'body_too_long', max: 1500 }, 400, origin);

  // 3. Compose Twilio's standard form-encoded payload.
  const form = new URLSearchParams();
  form.set('To', to);
  form.set('From', env.TWILIO_FROM);
  form.set('Body', text);
  // Status callbacks let us mark deliveries failed/delivered in sms_messages later.
  if (env.TWILIO_STATUS_CALLBACK) form.set('StatusCallback', env.TWILIO_STATUS_CALLBACK);

  const auth = btoa(env.TWILIO_SID + ':' + env.TWILIO_TOKEN);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`;

  // 4. Fire to Twilio.
  let twilioRes, twilioJson;
  try {
    twilioRes = await fetch(url, {
      method: 'POST',
      headers: {
        'Authorization': 'Basic ' + auth,
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: form.toString(),
    });
    twilioJson = await twilioRes.json();
  } catch (e) {
    await logToSupabase(env, {
      direction: 'out', to_number: to, from_number: env.TWILIO_FROM,
      body: text, kind, contact_id: contactId, status: 'network_error',
      error_message: e.message,
    });
    return json({ ok: false, error: 'twilio_network_error', message: e.message }, 502, origin);
  }

  // 5. Twilio failure passthrough (e.g. unverified trial recipient, bad number).
  if (!twilioRes.ok) {
    await logToSupabase(env, {
      direction: 'out', to_number: to, from_number: env.TWILIO_FROM,
      body: text, kind, contact_id: contactId, status: 'failed',
      twilio_sid: twilioJson.sid || null,
      error_code: twilioJson.code, error_message: twilioJson.message,
    });
    return json({
      ok: false, error: 'twilio_rejected',
      code: twilioJson.code, message: twilioJson.message, more_info: twilioJson.more_info,
    }, 502, origin);
  }

  // 6. Success — log and return.
  await logToSupabase(env, {
    direction: 'out', to_number: to, from_number: env.TWILIO_FROM,
    body: text, kind, contact_id: contactId,
    status: twilioJson.status || 'queued',
    twilio_sid: twilioJson.sid,
    sent_at: new Date().toISOString(),
  });

  return json({
    ok: true, sid: twilioJson.sid, status: twilioJson.status,
    to: twilioJson.to, from: twilioJson.from,
  }, 200, origin);
}
