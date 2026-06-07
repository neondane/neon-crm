/** POST /api/improveNotes — clean up voice-transcribed visit notes (no facts changed).
 *  Body: { text }  ·  Returns { ok, improved }
 *  Env: ANTHROPIC_KEY, CLAUDE_MODEL? */
import { endpoint, preflight } from '../_shared.js';

const SYSTEM = 'You clean up voice-transcribed visit notes for a moving company CRM. Fix grammar, spelling, punctuation, and capitalization. Tighten run-on sentences. Preserve every fact, name, address, date, dollar amount, and detail exactly. Do NOT add information or invent details. Do NOT summarize. Keep the tone professional but natural. Return ONLY the cleaned-up notes. No preamble, no quotes, no explanations, no markdown.';

const handler = endpoint(async ({ env, body, reply }) => {
  if (!env.ANTHROPIC_KEY) return reply({ ok: false, error: 'ai_not_configured' }, 503);
  const raw = String(body.text || '').trim();
  if (!raw) return reply({ ok: true, improved: '' });
  if (raw.length > 8000) return reply({ ok: false, error: 'too_long', message: 'max 8000 chars' }, 400);

  let j;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 2048, system: SYSTEM,
        messages: [{ role: 'user', content: raw }],
      }),
    });
    j = await r.json();
  } catch (e) {
    return reply({ ok: false, error: 'ai_network_error', message: e.message }, 502);
  }
  if (j.error) return reply({ ok: false, error: j.error.message || 'ai_error' }, 502);
  const improved = (j.content && j.content[0] && j.content[0].text) || '';
  return reply({ ok: true, improved: improved.trim() });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
