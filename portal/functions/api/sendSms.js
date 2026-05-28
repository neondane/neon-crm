/**
 * /api/sendSms.js — Server-side wrapper around Twilio's REST API (SMS + MMS)
 *
 *   POST /api/sendSms
 *     Body: { to:"+1360...", body:"Hi", kind?:"thanks_24h", contactId?:N, mediaUrl?:"https://..." }
 *     Returns: { ok:true, sid:"SMxxx...", status:"queued" } on success
 *
 * Twilio creds are read from Cloudflare Pages environment variables:
 *   TWILIO_SID    — Account SID
 *   TWILIO_TOKEN  — Auth Token   (kept secret in Cloudflare, never exposed)
 *   TWILIO_FROM   — Sender number in E.164 (+13605885228)
 *
 * MMS: when mediaUrl is provided it is passed to Twilio as MediaUrl and a small
 * marker (::NGMMS::[...]) is appended to the body we LOG to Supabase so the CRM
 * thread can render it as an image bubble. The text actually sent to Twilio is
 * never polluted with the marker.
 */

const ALLOWED_ORIGINS = [
  'https://refer.neongiantmoving.com',
  'https://crm.neongiantmoving.com',
];

function corsHeaders(origin) {
  let allow = ALLOWED_ORIGINS[0];
  if (origin && ALLOWED_ORIGINS.includes(origin)) allow = origin;
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

function toE164(raw) {
  if (!raw) return null;
  let d = String(raw).replace(/[^\d]/g, '');
  if (d.length === 11 && d.startsWith('1')) return '+' + d;
  if (d.length === 10) return '+1' + d;
  if (d.length > 10 && d.length <= 15) return '+' + d;
  return null;
}

// Publishable-key fallback (same key the CRM + Worker use) so logging ALWAYS works,
// even when the Pages project has no SUPABASE_* env vars set.
const SB_URL_DEFAULT = 'https://aoyfieswynhgqyrveqnp.supabase.co';
const SB_KEY_DEFAULT  = 'sb_publishable_I9S3tXRLe-AdUMdpod08Yg_E87kiArZ';
async function logToSupabase(env, row) {
  const sbUrl = env.SUPABASE_URL || SB_URL_DEFAULT;
  const sbKey = env.SUPABASE_KEY || SB_KEY_DEFAULT;
  try {
    await fetch(sbUrl + '/rest/v1/sms_messages', {
      method: 'POST',
      headers: {
        'apikey': sbKey,
        'Authorization': 'Bearer ' + sbKey,
        'Content-Type': 'application/json',
        'Prefer': 'return=minimal',
      },
      body: JSON.stringify(row),
    });
  } catch (_e) {}
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM) {
    return json({ ok: false, error: 'twilio_not_configured',
      message: 'TWILIO_SID, TWILIO_TOKEN, and TWILIO_FROM must be set as Cloudflare Pages env vars. See SMS-SETUP.md.' }, 503, origin);
  }
  let body;
  try { body = await request.json(); } catch (_e) { return json({ ok: false, error: 'bad_json' }, 400, origin); }

  const to = toE164(body.to);
  const text = (body.body || '').toString().trim();
  const kind = (body.kind || 'manual').toString().slice(0, 40);
  const contactId = body.contactId || null;
  const mediaUrl = (body.mediaUrl || '').toString().trim();
  const mediaType = (body.mediaType || 'image/jpeg').toString().slice(0, 60);

  if (!to)   return json({ ok: false, error: 'missing_or_invalid_to' }, 400, origin);
  if (!text && !mediaUrl) return json({ ok: false, error: 'missing_body' }, 400, origin);
  if (text.length > 1500) return json({ ok: false, error: 'body_too_long', max: 1500 }, 400, origin);
  if (mediaUrl && !/^https:\/\//i.test(mediaUrl)) return json({ ok: false, error: 'bad_media_url' }, 400, origin);

  const form = new URLSearchParams();
  form.set('To', to);
  form.set('From', env.TWILIO_FROM);
  if (text) form.set('Body', text);
  if (mediaUrl) form.set('MediaUrl', mediaUrl);
  if (env.TWILIO_STATUS_CALLBACK) form.set('StatusCallback', env.TWILIO_STATUS_CALLBACK);

  // The body we LOG carries a hidden marker so the CRM renders the image.
  const logBody = mediaUrl
    ? (text + '\n::NGMMS::' + JSON.stringify([{ u: mediaUrl, t: mediaType }]))
    : text;

  const auth = btoa(env.TWILIO_SID + ':' + env.TWILIO_TOKEN);
  const url = `https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`;

  let twilioRes, twilioJson;
  try {
    twilioRes = await fetch(url, {
      method: 'POST',
      headers: { 'Authorization': 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    twilioJson = await twilioRes.json();
  } catch (e) {
    await logToSupabase(env, { direction:'out', to_number:to, from_number:env.TWILIO_FROM, body:logBody, kind, contact_id:contactId, status:'network_error', error_message:e.message });
    return json({ ok: false, error: 'twilio_network_error', message: e.message }, 502, origin);
  }
  if (!twilioRes.ok) {
    await logToSupabase(env, { direction:'out', to_number:to, from_number:env.TWILIO_FROM, body:logBody, kind, contact_id:contactId, status:'failed', twilio_sid:twilioJson.sid||null, error_code:twilioJson.code, error_message:twilioJson.message });
    return json({ ok: false, error: 'twilio_rejected', code: twilioJson.code, message: twilioJson.message, more_info: twilioJson.more_info }, 502, origin);
  }
  await logToSupabase(env, { direction:'out', to_number:to, from_number:env.TWILIO_FROM, body:logBody, kind, contact_id:contactId, status:twilioJson.status||'queued', twilio_sid:twilioJson.sid, sent_at:new Date().toISOString() });

  return json({ ok: true, sid: twilioJson.sid, status: twilioJson.status, to: twilioJson.to, from: twilioJson.from }, 200, origin);
}
