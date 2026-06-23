/** DRAFT — POST /api/requestReview — ask a finished customer for a review, then we surface it
 *  to the referring realtor in the portal. Review this, then save as requestReview.js + deploy.
 *
 *  Triggered when a move hits the "complete" stage (the webhook can call this, or the CRM can,
 *  or a daily sweep can catch any completed-without-request). Source-agnostic: pass the
 *  customer's contact directly.
 *
 *  Body: { table:'referrals'|'portal_leads', id, customerName, toEmail?, toPhone?, realtorFirst? }
 *  Env: RESEND_API_KEY, EMAIL_FROM (already set), REVIEW_URL (your Google review link),
 *       SUPABASE_URL, SUPABASE_KEY
 *  Sends the email review-ask via Resend (the channel we just authenticated). SMS is optional and
 *  left as a follow-up (it can POST to the existing /api/sendSms). Never double-asks: stamps
 *  review_requested_at and skips if already set.
 */
import { endpoint, preflight, sb } from '../_shared.js';

const REVIEW_FALLBACK = 'https://g.page/r/neon-giant-moving/review'; // placeholder — set REVIEW_URL env

function reviewEmailHtml(name, reviewUrl) {
  var first = String(name || '').trim().split(/\s+/)[0] || 'there';
  return '<div style="font-family:Arial,Helvetica,sans-serif;max-width:540px;margin:0 auto;color:#1d2330">'
    + '<h2 style="color:#FF2FA0;margin:0 0 6px">How did we do, ' + first + '?</h2>'
    + '<p style="font-size:15px;line-height:1.6">Thanks for moving with Neon Giant Moving &amp; Junk Removal! It truly was our pleasure. '
    + 'If the crew took good care of you, a quick review would mean the world to us and helps other families find a mover they can trust.</p>'
    + '<p style="margin:22px 0"><a href="' + reviewUrl + '" style="background:linear-gradient(266deg,#2BC6FF,#FF2FA0);color:#fff;font-weight:700;text-decoration:none;padding:14px 26px;border-radius:50px;display:inline-block">Leave a quick review</a></p>'
    + '<p style="font-size:13px;color:#8b929c">It only takes a minute. Thank you for letting us be part of your move!<br>— The Neon Giant crew · 360.588.4700</p></div>';
}

const handler = endpoint(async ({ env, body, reply }) => {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return reply({ ok: false, error: 'email_not_configured' }, 503);
  const table = (body.table === 'portal_leads') ? 'portal_leads' : 'referrals';
  const id = body.id;
  const name = String(body.customerName || '').trim();
  const toEmail = String(body.toEmail || '').trim();
  const reviewUrl = env.REVIEW_URL || REVIEW_FALLBACK;
  if (!id) return reply({ ok: false, error: 'missing_id' }, 400);
  const db = sb(env);

  // Don't double-ask: skip if review_requested_at already set.
  try {
    const rows = await db.select(`${table}?id=eq.${encodeURIComponent(id)}&select=id,review_requested_at`);
    if (rows && rows[0] && rows[0].review_requested_at) {
      return reply({ ok: true, skipped: 'already_requested', at: rows[0].review_requested_at });
    }
  } catch (e) { /* column may not exist yet — proceed, the schema migration adds it */ }

  let sent = false, sendErr = null;
  if (toEmail && /^\S+@\S+\.\S+$/.test(toEmail)) {
    try {
      const r = await fetch('https://api.resend.com/emails', {
        method: 'POST',
        headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
        body: JSON.stringify({ from: env.EMAIL_FROM, to: toEmail, subject: 'How did your move go?', html: reviewEmailHtml(name, reviewUrl) }),
      });
      sent = r.ok; if (!r.ok) sendErr = 'resend_' + r.status;
    } catch (e) { sendErr = String(e && e.message || e); }
  } else {
    sendErr = 'no_email_on_file'; // SMS fallback is a follow-up (POST to /api/sendSms)
  }

  try { await db.update(table, `id=eq.${encodeURIComponent(id)}`, { review_requested_at: new Date().toISOString() }); }
  catch (e) { /* column may not exist yet */ }

  return reply({ ok: true, sent, channel: sent ? 'email' : null, sendErr, reviewUrl });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
