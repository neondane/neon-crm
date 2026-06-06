// Cloudflare Pages Function — POST /api/researchAgent
// AI recruit dossier for the Recruit Playbook. Uses the portal's existing
// ANTHROPIC_KEY / CLAUDE_MODEL env vars (same as testAiReply.js), with web search.
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
  if (!name) return J({ error: 'name required' }, 400);
  const key = env.ANTHROPIC_KEY;
  if (!key) return J({ error: 'AI key not configured on the portal' }, 500);
  const model = env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001';
  const system = 'You are a sales-intelligence researcher for a moving company recruiting real-estate agents into a referral partnership. Be concise and factual; only state what you can support from search results. Never invent contact info.';
  const prompt =
    'Research this real-estate agent and produce a recruiting dossier:\n' +
    'Agent: ' + name + '\nBrokerage: ' + brokerage + '\n\n' +
    'Return plain text in exactly these sections:\n' +
    'CONTACT — phone, email, website, social profiles you can verify (or "not found").\n' +
    'SNAPSHOT — years active, market focus/areas, price range, notable recent activity.\n' +
    'PERSONALITY — what appears to drive them (status / service / money / family-community) from their public presence.\n' +
    'HOW TO WIN THEM — the single best angle, the channel (email/text/DM/in-person) and tone, in one tight paragraph.';
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': key, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model, max_tokens: 1100, system,
        messages: [{ role: 'user', content: prompt }],
        tools: [{ type: 'web_search_20250305', name: 'web_search', max_uses: 4 }],
      }),
    });
    const j = await r.json();
    if (j.error) return J({ error: j.error.message || 'AI error' }, 502);
    let text = '';
    (j.content || []).forEach(b => { if (b.type === 'text') text += b.text; });
    return J({ dossier: text || 'No results found.' });
  } catch (e) {
    return J({ error: String(e && e.message || e) }, 502);
  }
}
