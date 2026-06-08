/** POST /api/discoverNewLeads — find new referral-partner businesses via AI web search.
 *  Body: { opts:{ territories[], types[], limit? } }
 *  Returns { ok, leads:[{name,type,address,territory}] }
 *  Env: ANTHROPIC_KEY, CLAUDE_MODEL? */
import { endpoint, preflight, firstJsonObject } from '../_shared.js';

const SYSTEM = 'You are a local-business researcher for a moving & junk-removal company seeking new referral partners. Use web search. Only return real, currently-operating businesses with a verifiable name and (where possible) a street address in the requested area. No duplicates and no invented places. Output JSON only.';

const handler = endpoint(async ({ env, body, reply }) => {
  if (!env.ANTHROPIC_KEY) return reply({ ok: false, error: 'ai_not_configured' }, 503);
  const opts = body.opts || body;
  const terrs = (opts.territories || []).join(', ');
  const types = (opts.types || []).join(', ');
  const limit = Math.min(parseInt(opts.limit, 10) || 10, 20);
  const exclude = Array.isArray(opts.exclude) ? opts.exclude.filter(Boolean).slice(0, 200) : [];
  if (!terrs || !types) return reply({ ok: false, error: 'territories_and_types_required' }, 400);

  const excludeBlock = exclude.length
    ? ('\n\nWE ALREADY HAVE THESE — do NOT return any of them or close variations (same business, different spelling/branch):\n' + exclude.join('; ') + '\n')
    : '';

  const prompt =
    'Find up to ' + limit + ' real businesses to approach as NEW referral partners — businesses we do NOT already work with.\n' +
    'Areas: ' + terrs + '\nBusiness types: ' + types + excludeBlock + '\n' +
    'Every result must be a genuinely new business not in the exclusion list above. ' +
    'Return ONLY this JSON: {"leads":[{"name":"<business name>","type":"<which requested type it is>","address":"<street, city>","territory":"<which requested area>"}]}';

  let j;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 1800, system: SYSTEM,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 5 }],
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
  return reply({ ok: true, leads: (parsed && parsed.leads) || [] });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
