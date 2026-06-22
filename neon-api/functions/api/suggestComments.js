/** POST /api/suggestComments — write a few natural social-media comments for an agent's new listing.
 *  Body: { agentName, address?, city?, channel? }  ·  Returns { ok, comments:[ ... ] }
 *  Env: ANTHROPIC_KEY, CLAUDE_MODEL?
 *  These are short, supportive comments a moving company would leave on a partner agent's
 *  "just listed" post. Goal: organic relationship-building, NOT a sales pitch.
 */
import { endpoint, preflight, firstJsonObject } from '../_shared.js';

const SYSTEM =
  'You write short, warm, genuine social-media comments that a local moving company (Neon Giant Moving) would leave on a real-estate agent\'s "just listed" post. ' +
  'The goal is to support the agent and look organic, NOT to pitch moving services. ' +
  'Rules: sound like a real person, casual and friendly. 1 to 2 sentences each. ' +
  'No em dashes. No hashtags. At most one tasteful emoji, and only sometimes. ' +
  'Do not mention moving, movers, boxes, or any sales angle. Just hype the agent and the home. ' +
  'Vary the wording so the three options feel different. Respond with JSON only.';

const handler = endpoint(async ({ env, body, reply }) => {
  if (!env.ANTHROPIC_KEY) return reply({ ok: false, error: 'ai_not_configured' }, 503);
  const o = body.opts || body;
  const agent = String(o.agentName || o.agent || '').trim();
  const address = String(o.address || '').split(',')[0].trim();
  const city = String(o.city || '').trim();
  if (!agent) return reply({ ok: false, error: 'agent_required' }, 400);

  const prompt =
    'Write 3 different short, supportive comments to leave on this agent\'s new-listing social post.\n' +
    'Agent first name to address (optional, only if natural): ' + agent.split(/\s+/)[0] + '\n' +
    (address ? ('Listing street: ' + address + '\n') : '') +
    (city ? ('City: ' + city + '\n') : '') +
    '\nExamples of the vibe (do not copy): "Gorgeous listing! Whoever lands this one is lucky." / "This one is going to go fast, congrats!" / "Love it. Great looking home and a great agent behind it."\n' +
    'Respond with ONLY this JSON: {"comments": ["...", "...", "..."]}';

  let j;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 400, system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
      }),
    });
    j = await r.json();
  } catch (e) {
    return reply({ ok: false, error: 'ai_network_error', message: e.message }, 502);
  }
  if (j.error) return reply({ ok: false, error: j.error.message || 'ai_error' }, 502);
  let text = '';
  (j.content || []).forEach((b) => { if (b.type === 'text') text += b.text; });
  const parsed = firstJsonObject(text);
  let comments = (parsed && Array.isArray(parsed.comments)) ? parsed.comments : [];
  // strip any stray em dashes just in case, and trim
  comments = comments.map((c) => String(c || '').replace(/\s[—–]\s/g, ', ').trim()).filter(Boolean).slice(0, 3);
  if (!comments.length) comments = ['Beautiful listing, congrats!', 'This one is going to go fast.', 'Love it. Great home, great agent.'];
  return reply({ ok: true, comments });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
