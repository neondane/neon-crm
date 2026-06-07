/** POST /api/checkListings — find an agent's recent active listings (the "strike" signal).
 *  Body: { name, brokerage? }  ·  Returns { ok, count, summary, listings:[] }
 *  Env: ANTHROPIC_KEY, CLAUDE_MODEL? */
import { endpoint, preflight, firstJsonObject } from '../_shared.js';

const SYSTEM = 'You research a real-estate agent\'s current and recent property listings using web search, and report what you actually find. Be thorough: try several sources and name/brokerage/area combinations before concluding there are none. Respond with JSON only.';

const handler = endpoint(async ({ env, body, reply }) => {
  if (!env.ANTHROPIC_KEY) return reply({ ok: false, error: 'ai_not_configured' }, 503);
  const opts = body.opts || body;
  const name = String(opts.name || '').trim();
  const brokerage = String(opts.brokerage || '').trim();
  const area = String(opts.area || opts.territory || '').trim();
  if (!name) return reply({ ok: false, error: 'name_required' }, 400);

  const prompt =
    'Find homes this real-estate agent currently has listed FOR SALE, plus anything they listed or sold in roughly the last 90 days.\n' +
    'Agent: ' + name + '\nBrokerage: ' + brokerage + '\n' + (area ? ('Area: ' + area + '\n') : '') +
    '\nSearch the web thoroughly — try Zillow, Redfin, Realtor.com, Homes.com and the brokerage website. ' +
    'Try queries like "' + name + ' ' + brokerage + '", "' + name + ' realtor listings", and "' + name + ' homes for sale". ' +
    'Include every active or recent listing you can reasonably attribute to this agent, with the real street address and list price when available. ' +
    'Only conclude zero if you genuinely cannot find any after several searches.\n\n' +
    'Respond with ONLY this JSON: {"count": <number you found>, "summary": "<one short line>", "listings": ["<address> - <price> (<status>)", ...]}';

  let j;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 1100, system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 8 }],
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
