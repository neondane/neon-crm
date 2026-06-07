/** POST /api/researchAgent — AI recruiting dossier for a real-estate agent (web search).
 *  Body: { name, brokerage? }  ·  Returns { ok, dossier }
 *  Env: ANTHROPIC_KEY, CLAUDE_MODEL? */
import { endpoint, preflight } from '../_shared.js';

const SYSTEM = 'You are a sales-intelligence researcher for a moving company recruiting real-estate agents into a referral partnership. Be concise and factual; only state what you can support from search results. Never invent contact info.';

const handler = endpoint(async ({ env, body, reply }) => {
  if (!env.ANTHROPIC_KEY) return reply({ ok: false, error: 'ai_not_configured' }, 503);
  const name = String(body.name || '').trim();
  const brokerage = String(body.brokerage || '').trim();
  if (!name) return reply({ ok: false, error: 'name_required' }, 400);

  const prompt =
    'Research this real-estate agent and produce a recruiting dossier:\n' +
    'Agent: ' + name + '\nBrokerage: ' + brokerage + '\n\n' +
    'Return plain text in exactly these sections:\n' +
    'CONTACT — phone, email, website, social profiles you can verify (or "not found").\n' +
    'SNAPSHOT — years active, market focus/areas, price range, notable recent activity.\n' +
    'PERSONALITY — what appears to drive them (status / service / money / family-community) from their public presence.\n' +
    'HOW TO WIN THEM — the single best angle, the channel (email/text/DM/in-person) and tone, in one tight paragraph.';

  let j;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 1100, system: SYSTEM,
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
  return reply({ ok: true, dossier: text || 'No results found.' });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
