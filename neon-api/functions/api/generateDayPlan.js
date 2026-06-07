/** POST /api/generateDayPlan — AI visit briefs for a day's route.
 *  Body: { opts:{ person, date, base?, territories[], types[], stops:[{name,type,territory,address}] } }
 *  Returns { ok, summary, stops:[{name,address,briefing,talkingPoints[],leaveBehind}] }
 *  Env: ANTHROPIC_KEY, CLAUDE_MODEL? */
import { endpoint, preflight, firstJsonObject } from '../_shared.js';

const SYSTEM = 'You prep a field sales rep for in-person visits to referral-partner businesses (realtors, storage facilities, assisted/senior living, apartment complexes, property managers) for a moving & junk-removal company. Be specific, warm, and practical. Output JSON only — no prose, no markdown.';

const handler = endpoint(async ({ env, body, reply }) => {
  if (!env.ANTHROPIC_KEY) return reply({ ok: false, error: 'ai_not_configured' }, 503);
  const opts = body.opts || body;
  const stops = Array.isArray(opts.stops) ? opts.stops : [];
  if (!stops.length) return reply({ ok: false, error: 'no_stops' }, 400);
  const person = String(opts.person || 'the rep');
  const date = String(opts.date || '');

  const list = stops.map((s, i) =>
    `${i + 1}. ${s.name || s.business || 'Stop'} — type: ${s.type || '?'}${s.territory ? ', area: ' + s.territory : ''}${s.address ? ', ' + s.address : ''}`
  ).join('\n');

  const prompt =
    'Rep: ' + person + '\nDate: ' + date + '\nStops (visit in this order):\n' + list +
    '\n\nFor EACH stop, produce a short relationship/recruiting visit brief. Return ONLY this JSON:\n' +
    '{"summary":"<one-line plan summary>","stops":[{"name":"<exact stop name>","briefing":"<1 sentence: who they are + the angle>","talkingPoints":["..","..2-3 total.."],"leaveBehind":"<one concrete item, e.g. business cards, $50 referral one-pager, fridge magnet>"}]}';

  let j;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 1600, system: SYSTEM,
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

  // Fallback: if AI JSON didn't parse, still return the stops so the route renders.
  if (!parsed || !Array.isArray(parsed.stops)) {
    return reply({ ok: true, summary: '', stops: stops.map((s) => ({ name: s.name || s.business || 'Stop', address: s.address || '', briefing: '', talkingPoints: [], leaveBehind: '' })) });
  }
  // Merge each stop's address back in from the input (AI doesn't echo addresses reliably).
  const byName = {};
  stops.forEach((s) => { byName[String(s.name || s.business || '').toLowerCase()] = s; });
  const out = parsed.stops.map((s) => {
    const o = byName[String(s.name || '').toLowerCase()];
    return { name: s.name, address: (o && o.address) || s.address || '', briefing: s.briefing || '', talkingPoints: s.talkingPoints || [], leaveBehind: s.leaveBehind || '' };
  });
  return reply({ ok: true, summary: parsed.summary || '', stops: out });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
