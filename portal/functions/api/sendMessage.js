/**
 * /api/sendMessage — Unified send endpoint
 *
 *   POST /api/sendMessage
 *     Body: {
 *       contactId: 42,
 *       mode: 'email' | 'sms',
 *       body: "Hi Sarah...",
 *       subject: "Following up" (email only, optional),
 *       to: "+13605551234" or "sarah@..." (optional — defaults to contact.phone/email),
 *       sender: "dane@neongiantmoving.com" (optional, email only)
 *     }
 *     Returns: { ok:true, sent:true, mode, ... }
 *
 * Routes:
 *   mode='sms'    → POSTs to /api/sendSms (which logs to sms_messages via Twilio)
 *   mode='email'  → POSTs to Apps Script sendEmail + logs to email_messages
 *
 * Env: SUPABASE_URL, SUPABASE_KEY, APPS_SCRIPT_URL
 */

const ALLOWED_ORIGINS = [
  'https://crm.neongiantmoving.com',
  'https://refer.neongiantmoving.com',
];

function corsHeaders(origin) {
  let allow = ALLOWED_ORIGINS[0];
  if (origin && ALLOWED_ORIGINS.includes(origin)) allow = origin;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}
async function supa(env, path, init = {}) {
  return fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
    ...init,
    headers: {
      'apikey': env.SUPABASE_KEY,
      'Authorization': 'Bearer ' + env.SUPABASE_KEY,
      'Content-Type': 'application/json',
      ...(init.headers || {}),
    },
  });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
    return json({ ok: false, error: 'supabase_not_configured' }, 503, origin);
  }

  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'bad_json' }, 400, origin); }

  const cid = parseInt(body.contactId, 10);
  const mode = String(body.mode || '').toLowerCase();
  const text = String(body.body || '').trim();
  if (!cid) return json({ ok: false, error: 'missing_contactId' }, 400, origin);
  if (!text) return json({ ok: false, error: 'missing_body' }, 400, origin);
  if (!['email', 'sms'].includes(mode)) return json({ ok: false, error: 'invalid_mode' }, 400, origin);

  // Look up the contact for to-address fallback
  const cRes = await supa(env, `contacts?id=eq.${cid}&select=phone,email,name`);
  const cArr = cRes.ok ? await cRes.json() : [];
  const contact = cArr[0];
  if (!contact) return json({ ok: false, error: 'contact_not_found' }, 404, origin);

  // ===== SMS =====
  if (mode === 'sms') {
    const to = body.to || contact.phone;
    if (!to) return json({ ok: false, error: 'no_phone_on_contact' }, 400, origin);
    const r = await fetch('https://refer.neongiantmoving.com/api/sendSms', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        to, body: text, contactId: cid, kind: 'manual',
      }),
    });
    const j = await r.json();
    return json({ ...j, mode: 'sms' }, r.ok ? 200 : r.status, origin);
  }

  // ===== EMAIL =====
  const to = body.to || contact.email;
  if (!to) return json({ ok: false, error: 'no_email_on_contact' }, 400, origin);
  const subject = String(body.subject || 'Following up').trim();
  const sender = body.sender || 'dane@neongiantmoving.com';
  const APPS_SCRIPT = env.APPS_SCRIPT_URL ||
    'https://script.google.com/macros/s/AKfycbxh1ecAF9yWN91w04SHROy5T9N-PehvpF29LTFu8M6vjnp1PRyhgxUYf7bfU5DKzbq_nA/exec';

  let r, j;
  try {
    r = await fetch(APPS_SCRIPT + '?action=sendEmail', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({ to, subject, body: text, contactId: cid, sender }),
    });
    j = await r.json();
  } catch (e) {
    return json({ ok: false, error: 'apps_script_network_error', message: e.message }, 502, origin);
  }

  // Log to email_messages regardless of Apps Script response shape
  await supa(env, 'email_messages', {
    method: 'POST',
    headers: { 'Prefer': 'return=minimal' },
    body: JSON.stringify({
      contact_id: cid,
      direction: 'out',
      from_email: sender,
      to_email: to,
      subject,
      body: text,
      status: (j && j.ok) ? 'sent' : 'failed',
      sender: sender.split('@')[0],
      apps_script_id: (j && j.id) || null,
      sent_at: new Date().toISOString(),
    }),
  }).catch(() => {});

  return json({
    ok: !!(j && j.ok),
    sent: !!(j && j.ok),
    mode: 'email',
    error: j && !j.ok ? (j.error || 'apps_script_returned_not_ok') : null,
  }, 200, origin);
}
