/** POST /api/sendEmail — send an email via Resend, log it to Supabase email_messages.
 *  Body: { to, subject?, body?, html?, contactId?, sender? }  ·  Returns { ok, id }
 *  Env: RESEND_API_KEY, EMAIL_FROM (e.g. "Neon Giant Moving <crew@neongiantmoving.com>"),
 *       SUPABASE_URL, SUPABASE_KEY */
import { endpoint, preflight, sb } from '../_shared.js';

async function logEmail(env, row) {
  try { await sb(env).insert('email_messages', row, { returning: 'minimal' }); } catch (_) {}
}

const handler = endpoint(async ({ env, body, reply }) => {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM)
    return reply({ ok: false, error: 'email_not_configured', message: 'Set RESEND_API_KEY and EMAIL_FROM.' }, 503);

  const to = String(body.to || '').trim();
  const subject = String(body.subject || 'Neon Giant Moving').slice(0, 200);
  const text = String(body.body || '').trim();
  const html = body.html ? String(body.html) : undefined;
  const contactId = body.contactId != null ? body.contactId : null;
  const sender = body.sender ? String(body.sender) : '';
  // Optional attachments: [{ filename, content (base64) }]
  const attachments = Array.isArray(body.attachments)
    ? body.attachments.filter(function (a) { return a && a.filename && a.content; })
        .map(function (a) { return { filename: String(a.filename), content: String(a.content) }; })
    : undefined;
  if (!/^\S+@\S+\.\S+$/.test(to)) return reply({ ok: false, error: 'invalid_email' }, 400);
  if (!text && !html) return reply({ ok: false, error: 'missing_body' }, 400);

  const from = sender && env.EMAIL_FROM.includes('<')
    ? env.EMAIL_FROM.replace(/^[^<]*</, `Neon Giant Moving (${sender}) <`)
    : env.EMAIL_FROM;
  // By default, let replies go to the From address (crew@mail.neongiantmoving.com), which Resend
  // now receives and pipes into the CRM via /api/inboundEmail. Override with EMAIL_REPLY_TO if ever needed.
  const replyTo = body.replyTo || env.EMAIL_REPLY_TO || '';

  let res, j;
  try {
    res = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from, to, reply_to: replyTo, subject, text: text || undefined, html, attachments: (attachments && attachments.length) ? attachments : undefined }),
    });
    j = await res.json();
  } catch (e) {
    await logEmail(env, { direction: 'out', to_address: to, subject, body: text, contact_id: contactId, status: 'network_error', error_message: e.message });
    return reply({ ok: false, error: 'email_network_error', message: e.message }, 502);
  }
  if (!res.ok) {
    await logEmail(env, { direction: 'out', to_address: to, subject, body: text, contact_id: contactId, status: 'failed', error_message: (j && (j.message || j.error)) || ('HTTP ' + res.status) });
    return reply({ ok: false, error: 'email_rejected', message: (j && (j.message || j.error)) || ('HTTP ' + res.status) }, 502);
  }
  await logEmail(env, { direction: 'out', to_address: to, subject, body: text, contact_id: contactId, status: 'sent', provider_id: j.id, sent_at: new Date().toISOString() });
  return reply({ ok: true, id: j.id });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
