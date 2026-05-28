/**
 * /api/draftReviewReply.js — AI-drafted Google review responses
 *
 *   POST /api/draftReviewReply
 *     Body: {
 *       reviewerName: "Sarah J.",
 *       rating: 5,
 *       comment: "Best movers ever! Crew was on time, careful with my piano...",
 *       reviewDate: "2026-05-14",         // optional
 *       googlePlaceId: "ChIJ...",         // optional, for context
 *       autoEmail: true                    // send draft to Dane via Apps Script (default true)
 *     }
 *     Returns: {
 *       ok: true,
 *       draftReply: "Thank you so much Sarah! The crew loved...",
 *       tone: "warm" | "apologetic" | "professional",
 *       confidence: 0.92,
 *       flags: ["mentions_piano","mentions_timeliness"]
 *     }
 *
 * Voice: matches Dane's casual-professional tone. Always personal. Always thanks the
 * customer by name. NEVER generic. For negative reviews, acknowledges the specific
 * issue, doesn't argue, and offers a private channel ("please call 360-588-4700").
 *
 * Env: ANTHROPIC_KEY, CLAUDE_MODEL, APPS_SCRIPT_URL (for the auto-email)
 *
 * Future: when GBP OAuth is granted, add a /api/postReviewReply endpoint that
 * actually posts the approved draft via Google My Business API. Until then,
 * Dane copy-pastes from the email into Google.
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
    status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

const PROMPT = `You are drafting Google review responses for Neon Giant Moving in Skagit Valley, WA.
The owner Dane will copy-paste your draft to post publicly.

VOICE:
- Casual but professional. Sounds like a small-business owner who actually reads each review.
- Always thanks the reviewer by name (their first name only).
- Mentions ONE specific thing from their review so it doesn't read like a template.
- 2-3 sentences max. Public-facing — concise wins.
- Never use em-dashes. Never "I'd be happy to". Never AI-tells.
- Sign off "— Dane, Neon Giant Moving" (this is the owner's signature, not a chatbot).

POSITIVE REVIEWS (4-5 star):
- Open with thanks, name-drop them
- Reference one specific detail they mentioned
- Light forward-looking close ("we're here whenever you need us again")

NEGATIVE REVIEWS (1-3 star):
- Acknowledge what went wrong WITHOUT arguing or making excuses
- Apologize directly and specifically
- Offer a private channel: "I'd like to make this right — please call me directly at (360) 588-4700 or email dane@neongiantmoving.com"
- NEVER include URLs, NEVER promote the business, NEVER ask them to update the review
- Tone is humble, not defensive

NEUTRAL (3 star):
- Thank them for honest feedback
- Acknowledge the specific concern
- Brief offer to discuss

OUTPUT STRICT JSON:
{
  "draftReply": "the text to copy-paste to Google",
  "tone": "warm" | "apologetic" | "professional",
  "confidence": 0.0-1.0,
  "flags": ["array","of","detected","themes"]   // e.g. ["piano","timeliness","price","damage"]
}`;

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');
  if (!env.ANTHROPIC_KEY) return json({ ok: false, error: 'no_claude_key' }, 503, origin);

  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'bad_json' }, 400, origin); }

  const rating = parseInt(body.rating, 10);
  if (!rating || rating < 1 || rating > 5) return json({ ok: false, error: 'invalid_rating' }, 400, origin);
  const reviewerName = String(body.reviewerName || 'Customer').slice(0, 80);
  const firstName = reviewerName.split(' ')[0];
  const comment = String(body.comment || '').slice(0, 2000);

  const userMsg = `New ${rating}★ Google review to respond to:
Reviewer: ${reviewerName}
Date: ${body.reviewDate || 'recent'}

Review text:
"${comment}"

Draft a public reply.`;

  const model = env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
  let claudeRes, claudeJson;
  try {
    claudeRes = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 400, system: PROMPT, messages: [{ role: 'user', content: userMsg }] }),
    });
    claudeJson = await claudeRes.json();
  } catch (e) {
    return json({ ok: false, error: 'claude_network_error', message: e.message }, 502, origin);
  }
  if (!claudeRes.ok) {
    return json({ ok: false, error: 'claude_api_error', status: claudeRes.status, message: claudeJson.error?.message }, 502, origin);
  }
  const text = claudeJson.content?.[0]?.text || '';
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (_) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
  }
  if (!parsed || !parsed.draftReply) return json({ ok: false, error: 'parse_error', raw: text.slice(0, 500) }, 502, origin);

  // Auto-email Dane the draft (best-effort)
  if (body.autoEmail !== false) {
    const APPS_SCRIPT = env.APPS_SCRIPT_URL ||
      'https://script.google.com/macros/s/AKfycbxh1ecAF9yWN91w04SHROy5T9N-PehvpF29LTFu8M6vjnp1PRyhgxUYf7bfU5DKzbq_nA/exec';
    const stars = '★'.repeat(rating) + '☆'.repeat(5 - rating);
    const subject = rating >= 4
      ? `New ${rating}★ Google review from ${firstName} — draft ready`
      : `⚠️ ${rating}★ Google review from ${firstName} — needs your reply`;
    const html = `<!DOCTYPE html><html><body style="font-family:-apple-system,Segoe UI,sans-serif;background:#fff;color:#111;max-width:560px;margin:0 auto;padding:24px">
      <div style="border-left:4px solid ${rating >= 4 ? '#33cc66' : '#ff9933'};padding-left:14px;margin-bottom:18px">
        <div style="font-size:11px;color:#888;letter-spacing:2px;font-weight:800">GOOGLE REVIEW · ${rating >= 4 ? 'POSITIVE' : 'NEEDS ATTENTION'}</div>
        <h1 style="margin:4px 0 0;font-size:20px;color:#111">${reviewerName} left ${rating}★</h1>
      </div>
      <p style="font-size:22px;color:#ffcc44;margin:14px 0;letter-spacing:4px">${stars}</p>
      <div style="background:#f8f8fa;padding:14px 18px;border-radius:8px;margin:14px 0">
        <div style="font-size:11px;color:#888;letter-spacing:1px;margin-bottom:6px">THEIR REVIEW</div>
        <div style="font-size:14px;color:#333;line-height:1.5;font-style:italic">"${comment.replace(/</g, '&lt;')}"</div>
      </div>
      <h2 style="font-size:13px;color:#888;letter-spacing:1px;margin-top:24px">DRAFT REPLY (copy + paste into Google)</h2>
      <div style="background:#e0f4ff;padding:14px 18px;border-radius:8px;border:1px solid #22aee4;font-size:14px;color:#111;line-height:1.5;white-space:pre-wrap">${(parsed.draftReply || '').replace(/</g, '&lt;')}</div>
      <p style="font-size:11px;color:#888;margin-top:8px">Tone: ${parsed.tone || '?'} · Confidence: ${parsed.confidence || '?'} · Themes: ${(parsed.flags || []).join(', ') || 'none'}</p>
      <a href="https://business.google.com/reviews" style="display:inline-block;background:#22aee4;color:#fff;padding:11px 18px;border-radius:7px;text-decoration:none;font-weight:800;font-size:13px;letter-spacing:.5px;margin-top:18px">Open Google Reviews</a>
    </body></html>`;
    fetch(APPS_SCRIPT + '?action=sendEmail', {
      method: 'POST',
      headers: { 'Content-Type': 'text/plain' },
      body: JSON.stringify({
        to: env.REVIEW_REPLY_TO || 'dane@neongiantmoving.com',
        subject, body: html, html: true, sender: 'system@neongiantmoving.com',
      }),
    }).catch(() => {});
  }

  return json({
    ok: true,
    draftReply: parsed.draftReply,
    tone: parsed.tone || null,
    confidence: parsed.confidence || null,
    flags: parsed.flags || [],
    model,
  }, 200, origin);
}
