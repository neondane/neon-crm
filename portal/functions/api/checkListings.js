// Cloudflare Pages Function — POST /api/checkListings
// Finds an agent's recent listings (the "strike" signal) via Claude + web search.
// Returns {count, summary, listings}. The CRM front-end records a strike row when count>0.
const ALLOWED = [
  'https://refer.neongiantmoving.com',
  'https://portal.neongiantmoving.com',
  'https://crm.neongiantmoving.com',
  'https://crm3.neongiantmoving.com',
];
function cors(origin) {
  let allow = ALLOWED[0];
  if (origin) {
    if (ALLOWED.includes(origin)) allow = origin;
    else { try { if (new URL(origin).hostname.endsWith('.pages.dev')) allow = origin; } catch (e) {} }
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
function firstJson(s) {
  if (!s) return null;
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (e) { return null; }
}
export async function onRequestOptions({ request }) {
  return new Response(null, { headers: cors(request.headers.get('Origin')) });
}
export async function onRequestPost(context) {
  const { request, env } = context;
  const ch = cors(request.headers.get('Origin'));
  const J = (o, s) => new Response(JSON.stringify(o), { status: s || 200, headers: { 'Content-Type': 'application/json', ...ch } });
  let body = {}; try { body = await request.json(); } catch (e) {}
  const opts = body.opts || body || {};
  const name = (opts.name || '').trim();
  const brokerage = (opts.brokerage || '').trim();
  if (!name) return J({ count: 0, summary: 'name required' }, 400);
  const key = env.ANTHROPIC_KEY;
  if (!key) return J({ error: 'AI key not configured on the portal' }, 500);
  const model = env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
  const system = 'You find recent real-estate listings where a specific agent is the LISTING agent. Only count listings you can verify from search results in roughly the last 30 days. If unsure, return 0. Respond with JSON only.';
  const prompt =
    'Find homes currently or recently (last ~30 days) listed FOR SALE where the listing agent is:\n' +
    'Agent: ' + name + '\nBrokerage: ' + brokerage + '\n\n' +
    'Respond with ONLY this JSON: {"count": <number>, "summary": "<one short line, e.g. 3 active listings, $450k-$1.2M in Anacortes>", "listings": ["address - price", ...]}';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 700, system,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
      }),
    });
    const j = await r.json();
    if (j.error) return J({ error: j.error.message || 'AI error' }, 502);
    let text = '';
    (j.content || []).forEach(b => { if (b.type === 'text') text += b.text; });
    const parsed = firstJson(text);
    if (!parsed) return J({ count: 0, summary: text.slice(0, 300), listings: [] });
    return J({ count: Number(parsed.count) || 0, summary: parsed.summary || '', listings: parsed.listings || [] });
  } catch (e) {
    return J({ error: String(e && e.message || e) }, 502);
  }
}
