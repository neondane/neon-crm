/**
 * /api/testAiReply.js — Dry-run version of smsAiReply for the demo harness
 * Powers sms-ai-demo.html. Returns Claude's structured response without sending real SMS.
 * Env: ANTHROPIC_KEY, CLAUDE_MODEL, DEMO_TOKEN (defaults 'neongiant')
 */

const SYSTEM_PROMPT = `You are the AI text assistant for Neon Giant Moving & Junk Removal,
a small moving company in Skagit Valley, WA. Customers texted YOU first (they're past customers
following up after a completed move). Your job is to reply briefly and helpfully.

VOICE: Friendly, casual. Use first name. Single emoji max. 1-3 sentences. No em-dashes.
Sign "— Neon Giant". First message in thread ends with "Reply STOP to opt out."

DISCLOSURE: If asked if you're a bot, answer honestly: "I'm Neon Giant's automated assistant — a real person reads everything and jumps in when it matters. Want me to grab Dane?"

REFERRAL CAPTURE (highest-value job):
If customer mentions ANYONE they know who might be moving, collect name + phone (or email) + city over 1-3 friendly messages, one question per message. When you have all three, emit { "referral": {...} }.

REVIEW MOMENT:
On genuine positive sentiment ("you guys were awesome", "best move ever"), drop the Google review link casually if not already asked in this thread.

ESCALATE (do NOT reply) when: damage/loss/injury, refunds/disputes/lawsuits, asks for Dane/owner, wants NEW move quote, anger/frustration, <80% confidence.

SILENT when: just "thanks", "ok", closed convo.

OUTPUT STRICT JSON ONLY:
{ "reply": "..." } OR { "escalate": "reason" } OR { "silent": "reason" } OR { "referral": {"name","phone","email","city","moveSize","moveDate","notes"}, "reply": "Got it..." }`;

const ALLOWED_ORIGINS = ['https://refer.neongiantmoving.com', 'https://crm.neongiantmoving.com', 'null'];

function corsHeaders(origin) {
  let allow = ALLOWED_ORIGINS[0];
  if (origin && ALLOWED_ORIGINS.includes(origin)) allow = origin;
  if (origin === null || origin === 'null') allow = '*';
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, X-Demo-Token',
    'Vary': 'Origin',
  };
}
function json(body, status, origin) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } });
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');
  const token = request.headers.get('X-Demo-Token') || '';
  const expected = env.DEMO_TOKEN || 'neongiant';
  if (token !== expected) return json({ ok: false, error: 'unauthorized', hint: 'set X-Demo-Token header' }, 401, origin);
  if (!env.ANTHROPIC_KEY) return json({ ok: false, error: 'no_claude_key' }, 503, origin);

  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'bad_json' }, 400, origin); }
  const messages = Array.isArray(body.messages) ? body.messages : [];
  if (!messages.length) return json({ ok: false, error: 'no_messages' }, 400, origin);

  const cleaned = messages.filter(m => m && typeof m.content === 'string' && m.content.trim())
                          .map(m => ({ role: m.role === 'user' ? 'user' : 'assistant', content: m.content }));
  if (!cleaned.length) return json({ ok: false, error: 'no_valid_messages' }, 400, origin);

  const ctx = body.contactName ? `Customer: ${body.contactName}. Referral slug: ${body.contactSlug || '(none)'}.` : 'Customer: unknown (demo mode).';
  const sys = SYSTEM_PROMPT + '\n\nCONTACT CONTEXT:\n' + ctx;
  const model = env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';

  const t0 = Date.now();
  let r, j;
  try {
    r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({ model, max_tokens: 400, system: sys, messages: cleaned }),
    });
    j = await r.json();
  } catch (e) { return json({ ok: false, error: 'claude_network_error', message: e.message }, 502, origin); }
  const elapsedMs = Date.now() - t0;
  if (!r.ok) return json({ ok: false, error: 'claude_api_error', status: r.status, message: j.error?.message }, 502, origin);

  const text = j.content?.[0]?.text || '';
  let parsed;
  try { parsed = JSON.parse(text); }
  catch (_) {
    const m = text.match(/\{[\s\S]*\}/);
    if (m) { try { parsed = JSON.parse(m[0]); } catch (_) {} }
  }
  if (!parsed) return json({ ok: true, action: 'parse_error', raw: text, model, elapsedMs }, 200, origin);

  let action = 'unknown';
  if (parsed.escalate) action = 'escalated';
  else if (parsed.silent) action = 'silent';
  else if (parsed.referral && parsed.referral.name && (parsed.referral.phone || parsed.referral.email)) action = 'referral_captured';
  else if (parsed.reply) action = 'replied';

  return json({
    ok: true, action,
    reply: parsed.reply || null, escalate: parsed.escalate || null, silent: parsed.silent || null,
    referral: parsed.referral || null, raw: parsed,
    model, elapsedMs,
    inputTokens: j.usage?.input_tokens || null, outputTokens: j.usage?.output_tokens || null,
  }, 200, origin);
}
