/** POST /api/checkListings — find an agent's recent active listings (the "strike" signal).
 *  Body: { name, brokerage? }  ·  Returns { ok, count, summary, listings:[] }
 *  Env: ANTHROPIC_KEY, CLAUDE_MODEL? */
import { endpoint, preflight, firstJsonObject } from '../_shared.js';

const SYSTEM = 'You find recent real-estate listings where a specific agent is the LISTING agent. Only count listings you can verify from search results in roughly the last 30 days. If unsure, return 0. Respond with JSON only.';

const handler = endpoint(async ({ env, body, reply }) => {
  if (!env.ANTHROPIC_KEY) return reply({ ok: false, error: 'ai_not_configured' }, 503);
  const opts = body.opts || body;
  const name = String(opts.name || '').trim();
  const brokerage = String(opts.brokerage || '').trim();
  if (!name) return reply({ ok: false, error: 'name_required' }, 400);

  const prompt =
    'Find homes currently or recently (last ~30 days) listed FOR SALE where the listing agent is:\n' +
    'Agent: ' + name + '\nBrokerage: ' + brokerage + '\n\n' +
    'Respond with ONLY this JSON: {"count": <number>, "summary": "<one short line>", "listings": ["address - price", ...]}';

  let j;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 700, system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
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
  if (!parsed) return reply({ ok: true, count: 0, summary: text.slice(0, 300), listings: [] });
  return reply({ ok: true, count: Number(parsed.count) || 0, summary: parsed.summary || '', listings: parsed.listings || [] });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
