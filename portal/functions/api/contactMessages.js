/**
 * /api/contactMessages?id=<contactId>&limit=<n>
 *
 * Returns: { ok:true, contact:{...}, messages:[{kind:'email'|'sms', direction, body, when, ...}] }
 *
 * Merges email_messages + sms_messages for a single contact into a chronological thread.
 * Used by the per-contact Messages section on the CRM contact profile.
 *
 * Env: SUPABASE_URL, SUPABASE_KEY
 */

const ALLOWED_ORIGINS = [
  'https://crm.neongiantmoving.com',
  'https://crm3.neongiantmoving.com',
  'https://refer.neongiantmoving.com',
];

function corsHeaders(origin) {
  let allow = ALLOWED_ORIGINS[0];
  if (origin && ALLOWED_ORIGINS.includes(origin)) allow = origin;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', ...corsHeaders(origin) },
  });
}
async function supa(env, path) {
  const r = await fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
    headers: { 'apikey': env.SUPABASE_KEY, 'Authorization': 'Bearer ' + env.SUPABASE_KEY },
  });
  return r.ok ? await r.json() : [];
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
}

export async function onRequestGet({ request, env }) {
  const origin = request.headers.get('Origin');
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) {
    return json({ ok: false, error: 'supabase_not_configured' }, 503, origin);
  }
  const url = new URL(request.url);
  const cid = url.searchParams.get('id');
  if (!cid) return json({ ok: false, error: 'missing_id' }, 400, origin);
  const limit = Math.min(parseInt(url.searchParams.get('limit') || '100', 10), 200);

  // Pull SMS + email + contact in parallel
  const [sms, emails, contactArr] = await Promise.all([
    supa(env, `sms_messages?contact_id=eq.${cid}&select=*&order=created_at.desc&limit=${limit}`),
    supa(env, `email_messages?contact_id=eq.${cid}&select=*&order=created_at.desc&limit=${limit}`),
    supa(env, `contacts?id=eq.${cid}&select=id,name,business,phone,email,slug&limit=1`),
  ]);

  const messages = [];
  (sms || []).forEach(m => messages.push({
    kind: 'sms',
    direction: m.direction,
    body: m.body,
    when: m.sent_at || m.received_at || m.created_at,
    status: m.status,
    kind_tag: m.kind,
    from: m.from_number, to: m.to_number,
    id: 'sms-' + m.id,
  }));
  (emails || []).forEach(e => messages.push({
    kind: 'email',
    direction: e.direction,
    subject: e.subject,
    body: e.body,
    when: e.sent_at || e.received_at || e.created_at,
    status: e.status,
    from: e.from_email, to: e.to_email,
    sender: e.sender,
    id: 'em-' + e.id,
  }));
  // Newest first
  messages.sort((a, b) => new Date(b.when) - new Date(a.when));

  return json({
    ok: true,
    contact: contactArr[0] || null,
    messages,
    counts: { total: messages.length, sms: sms.length, email: emails.length },
  }, 200, origin);
}
