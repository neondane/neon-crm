/** POST /api/inboundEmail — Resend inbound webhook (event: email.received).
 *  A realtor replies to a CRM-sent email; Resend receives it at mail.neongiantmoving.com
 *  and POSTs the metadata here. We fetch the body, match the sender to a CRM contact,
 *  and log it to email_messages as an inbound message. The CRM's existing unread-bell /
 *  Inbox logic (which already reads email_messages where direction=in) lights up from there.
 *
 *  Env: RESEND_API_KEY (to fetch the body), SUPABASE_URL, SUPABASE_KEY,
 *       RESEND_WEBHOOK_SECRET? (whsec_… — if set, Svix signatures are verified)
 */
import { sb, preflight, json } from '../_shared.js';

// Pull a bare email address out of "Name <email@x.com>" or "email@x.com".
function addrOf(s) {
  const m = String(s || '').match(/<([^>]+)>/);
  const raw = (m ? m[1] : String(s || '')).trim();
  const m2 = raw.match(/[^\s<>@]+@[^\s<>@]+\.[^\s<>@]+/);
  return (m2 ? m2[0] : raw).toLowerCase();
}

function stripHtml(h) {
  return String(h || '')
    .replace(/<style[\s\S]*?<\/style>/gi, '')
    .replace(/<script[\s\S]*?<\/script>/gi, '')
    .replace(/<\/(p|div|br|tr|li|h[1-6])>/gi, '\n')
    .replace(/<[^>]+>/g, '')
    .replace(/&nbsp;/g, ' ').replace(/&amp;/g, '&').replace(/&lt;/g, '<').replace(/&gt;/g, '>')
    .replace(/\n{3,}/g, '\n\n').trim();
}

// Best-effort: keep the new reply, drop the quoted history below common markers.
function topReply(text) {
  const t = String(text || '');
  const cuts = [/\n[> ]*On .+wrote:/i, /\n-----Original Message-----/i, /\n_{5,}/, /\nFrom: .+@/i];
  let idx = t.length;
  cuts.forEach((re) => { const m = t.match(re); if (m && m.index < idx) idx = m.index; });
  const head = t.slice(0, idx).trim();
  return (head || t).slice(0, 8000);
}

async function base64ToBytes(b64) {
  const bin = atob(b64); const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function bytesToBase64(bytes) {
  let s = ''; bytes.forEach((b) => { s += String.fromCharCode(b); }); return btoa(s);
}
// Svix signature verification (Resend uses Svix for webhooks).
async function verifySvix(secret, headers, rawBody) {
  const id = headers.get('svix-id'), ts = headers.get('svix-timestamp'), sig = headers.get('svix-signature');
  if (!id || !ts || !sig) return false;
  try {
    const keyBytes = await base64ToBytes(secret.replace(/^whsec_/, ''));
    const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    const mac = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(id + '.' + ts + '.' + rawBody));
    const expected = bytesToBase64(new Uint8Array(mac));
    return sig.split(' ').some((part) => { const p = part.split(','); return p.length === 2 && p[1] === expected; });
  } catch (e) { return false; }
}

export const onRequestOptions = ({ request }) => preflight(request);

export const onRequestPost = async ({ request, env }) => {
  const origin = request.headers.get('Origin') || '';
  const reply = (obj, status) => json(obj, { status: status || 200, origin });
  const raw = await request.text();

  // Verify signature when a secret is configured (otherwise accept, so setup/testing works first).
  if (env.RESEND_WEBHOOK_SECRET) {
    const ok = await verifySvix(env.RESEND_WEBHOOK_SECRET, request.headers, raw);
    if (!ok) return reply({ ok: false, error: 'bad_signature' }, 401);
  }

  let evt; try { evt = JSON.parse(raw); } catch (e) { return reply({ ok: false, error: 'bad_json' }, 400); }
  if (!evt || evt.type !== 'email.received') return reply({ ok: true, ignored: evt && evt.type });

  const d = evt.data || {};
  const fromEmail = addrOf(d.from);
  const toEmail = Array.isArray(d.to) ? String(d.to[0] || '') : String(d.to || '');
  const subject = String(d.subject || '(no subject)').slice(0, 300);

  // Fetch the actual body by id (webhook payload is metadata-only).
  let body = '';
  if (env.RESEND_API_KEY && d.email_id) {
    try {
      const r = await fetch('https://api.resend.com/emails/receiving/' + d.email_id, {
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY },
      });
      if (r.ok) { const full = await r.json(); body = full.text || stripHtml(full.html); }
    } catch (e) { /* fall through: log with subject only */ }
  }
  body = topReply(body);

  // Match the sender to a CRM contact by email.
  let contactId = null;
  try {
    const rows = await sb(env).select('contacts?select=id&limit=1&email=ilike.' + encodeURIComponent(fromEmail));
    if (rows && rows[0]) contactId = rows[0].id;
  } catch (e) { /* leave unmatched */ }

  const row = {
    contact_id: contactId,
    direction: 'in',
    from_email: fromEmail,
    to_email: toEmail,
    subject: subject,
    body: body,
    status: 'received',
    received_at: new Date().toISOString(),
    created_at: d.created_at || new Date().toISOString(),
  };
  try { await sb(env).insert('email_messages', row, { returning: 'minimal' }); }
  catch (e) { return reply({ ok: false, error: 'log_failed', message: String(e && e.message || e) }, 500); }

  return reply({ ok: true, matched: contactId != null });
};
