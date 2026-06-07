/** POST /api/submitReview — internal review capture + smart routing.
 *  Body: { rating(1-5), comment?, contactId?, jobId?, crewId?, customerName?, customerPhone? }
 *  5★ -> google, 4★ -> optional_google, 1-3★ -> private (alerts the team).
 *  Returns { ok, reviewId, rating, nextStep, googleUrl }
 *  Env: SUPABASE_URL, SUPABASE_KEY, RESEND_API_KEY?, EMAIL_FROM?, NEG_REVIEW_TO? */
import { endpoint, preflight, sb } from '../_shared.js';

async function alertTeam(env, row, crewName) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return; // email pending Resend setup
  const to = env.NEG_REVIEW_TO || 'dane@neongiantmoving.com';
  const stars = '★'.repeat(row.rating) + '☆'.repeat(5 - row.rating);
  const html = `<div style="font-family:Arial,sans-serif;max-width:560px">
    <h2 style="color:#c0392b">⚠️ ${row.rating}★ from ${row.customer_name || 'a customer'} — intercepted</h2>
    <p style="font-size:20px;color:#c0392b;letter-spacing:4px">${stars}</p>
    ${row.comment ? `<blockquote style="border-left:3px solid #c0392b;padding-left:12px;color:#333">"${String(row.comment).replace(/</g, '&lt;')}"</blockquote>` : '<p style="color:#888">No comment.</p>'}
    <p><b>Customer:</b> ${row.customer_name || '?'}${row.customer_phone ? ' · ' + row.customer_phone : ''}<br>
    <b>Job:</b> ${row.job_id || 'unknown'} · <b>Crew:</b> ${crewName || 'unattributed'}</p>
    <p style="background:#fff8e6;padding:10px;border-radius:6px">We did NOT show them the Google link — call and make it right.</p></div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to, subject: `[Neon Giant ⚠️] ${row.rating}★ from ${row.customer_name || 'a customer'} — intercepted`, html }),
    });
  } catch (_) {}
}

const handler = endpoint(async ({ request, env, body, reply }) => {
  const db = sb(env);
  const rating = parseInt(body.rating, 10);
  if (!rating || rating < 1 || rating > 5) return reply({ ok: false, error: 'invalid_rating' }, 400);

  const row = {
    contact_id: body.contactId ? parseInt(body.contactId, 10) : null,
    job_id: body.jobId ? String(body.jobId).slice(0, 80) : null,
    crew_id: body.crewId ? parseInt(body.crewId, 10) : null,
    customer_name: String(body.customerName || '').slice(0, 120),
    customer_phone: String(body.customerPhone || '').slice(0, 30),
    rating,
    comment: String(body.comment || '').slice(0, 2000),
    sent_to_google: rating === 5,
    ip_address: request.headers.get('CF-Connecting-IP') || null,
    user_agent: request.headers.get('User-Agent') || null,
  };
  let created;
  try { created = (await db.insert('internal_reviews', row))[0]; } catch (e) { return reply({ ok: false, error: 'insert_failed', message: e.message }, 500); }

  let nextStep, googleUrl = null;
  if (rating >= 4) {
    nextStep = rating === 5 ? 'google' : 'optional_google';
    googleUrl = 'https://refer.neongiantmoving.com/api/reviewTrack?c=' + (row.contact_id || '0');
  } else {
    nextStep = 'private';
    let crewName = null;
    if (row.crew_id) { try { const a = await db.select(`crews?id=eq.${row.crew_id}&select=name&limit=1`); crewName = a[0] && a[0].name; } catch (_) {} }
    alertTeam(env, row, crewName).catch(() => {});
  }
  return reply({ ok: true, reviewId: created && created.id, rating, nextStep, googleUrl });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
