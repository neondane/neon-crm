/** POST /api/parseContact — turn a business-card photo OR a spoken/typed note into structured contact fields.
 *  Body: { image?: "<dataURL or base64>", mediaType?: "image/jpeg", text?: "<voice/typed note>" }
 *  Returns { ok, contact:{ name, business, role, phone, email, territory, type, notes } }
 *  Env: ANTHROPIC_KEY, CLAUDE_MODEL? */
import { endpoint, preflight, firstJsonObject } from '../_shared.js';

const TYPES = ['Realtor', 'Self-Storage Facility', 'Assisted Living', 'Senior Living', 'Apartment Complex', 'Property Management', 'Other'];
const SYS = 'You extract structured contact details for a moving-company CRM from a business card image and/or a short spoken note. Respond with ONLY JSON.';

const handler = endpoint(async ({ env, body, reply }) => {
  if (!env.ANTHROPIC_KEY) return reply({ ok: false, error: 'ai_not_configured' }, 503);

  const text = String(body.text || '').trim();
  let image = body.image || body.imageBase64 || '';
  let mediaType = body.mediaType || 'image/jpeg';
  if (image && image.indexOf('data:') === 0) {
    const m = image.match(/^data:([^;]+);base64,(.*)$/);
    if (m) { mediaType = m[1]; image = m[2]; }
  }
  if (!text && !image) return reply({ ok: false, error: 'need_text_or_image' }, 400);

  const instr =
    'Extract the contact and respond with ONLY this JSON (use "" for anything unknown — never guess):\n' +
    '{"name":"","business":"","role":"","phone":"","email":"","territory":"","type":"","notes":""}\n' +
    'Rules: "name" = the person. "business" = company/brokerage/facility. "type" MUST be exactly one of: ' + TYPES.join(', ') + '. ' +
    'For a real-estate agent use "Realtor". Format phone as (xxx) xxx-xxxx when possible. ' +
    '"notes" = any extra context in one short line (else "").';

  const content = [];
  if (image) content.push({ type: 'image', source: { type: 'base64', media_type: mediaType, data: image } });
  content.push({ type: 'text', text: instr + (text ? ('\n\nSpoken/typed note:\n' + text) : '\n\nRead the business card image above.') });

  let j;
  try {
    const r = await fetch('https://api.anthropic.com/v1/messages', {
      method: 'POST',
      headers: { 'x-api-key': env.ANTHROPIC_KEY, 'anthropic-version': '2023-06-01', 'content-type': 'application/json' },
      body: JSON.stringify({
        model: env.CLAUDE_MODEL || 'claude-haiku-4-5-20251001',
        max_tokens: 500, system: SYS,
        messages: [{ role: 'user', content }],
      }),
    });
    j = await r.json();
  } catch (e) {
    return reply({ ok: false, error: 'ai_network_error', message: e.message }, 502);
  }
  if (j.error) return reply({ ok: false, error: j.error.message || 'ai_error' }, 502);

  let out = '';
  (j.content || []).forEach((b) => { if (b.type === 'text') out += b.text; });
  const p = firstJsonObject(out) || {};
  const pick = (v) => (typeof v === 'string' ? v.trim() : '');
  let type = pick(p.type);
  if (type && TYPES.indexOf(type) < 0) {
    const low = type.toLowerCase();
    type = TYPES.find((t) => t.toLowerCase() === low) || (/realtor|agent|broker/.test(low) ? 'Realtor' : 'Other');
  }
  return reply({ ok: true, contact: {
    name: pick(p.name), business: pick(p.business), role: pick(p.role), phone: pick(p.phone),
    email: pick(p.email), territory: pick(p.territory), type: type, notes: pick(p.notes),
  } });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
