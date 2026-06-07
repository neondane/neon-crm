/** /api/jobStatus — customer job tracking (GET) + crew status update (POST).
 *  GET ?j=<jobId>  -> { ok, jobId, current, history, job }
 *  POST { jobId, status, message?, crewMember?, crewId?, lat?, lon?, photoUrl? } + header X-Crew-Token
 *  Env: SUPABASE_URL, SUPABASE_KEY, CREW_TOKEN (fallback), SM_JWT? (optional header brief) */
import { endpoint, preflight, sb } from '../_shared.js';

const VALID = ['scheduled', 'on_way', 'arrived', 'loading', 'driving', 'unloading', 'done', 'delayed', 'cancelled'];

async function jobBrief(env, jobId) {
  if (!env.SM_JWT) return null;
  try {
    const r = await fetch(`https://app.smartmoving.com/api/jobs/${encodeURIComponent(jobId)}`, { headers: { Authorization: 'Bearer ' + env.SM_JWT, Accept: 'application/json' } });
    if (!r.ok) return null;
    const j = await r.json();
    return {
      customerFirstName: (j.customer && j.customer.firstName) || ((j.customer && j.customer.name || '').split(' ')[0]) || null,
      fromCity: (j.origin && j.origin.city) || j.fromCity || null,
      toCity: (j.destination && j.destination.city) || j.toCity || null,
      scheduledTime: j.startTime || j.scheduledTime || null,
      moveSize: j.moveSize || j.size || null,
    };
  } catch (_) { return null; }
}

const handler = endpoint(async ({ request, env, body, reply }) => {
  const db = sb(env);
  if (request.method === 'GET') {
    const jobId = body.j || body.jobId;
    if (!jobId) return reply({ ok: false, error: 'missing_job_id' }, 400);
    let history = [];
    try { history = await db.select(`job_status?job_id=eq.${encodeURIComponent(jobId)}&order=created_at.desc&limit=20`); } catch (_) {}
    return reply({ ok: true, jobId, current: history[0] || null, history, job: await jobBrief(env, jobId) });
  }
  // POST — crew update, soft-auth by shared token
  const supplied = request.headers.get('X-Crew-Token') || '';
  if (supplied !== (env.CREW_TOKEN || 'neongiantcrew')) return reply({ ok: false, error: 'unauthorized' }, 401);
  const jobId = String(body.jobId || '').trim();
  const status = String(body.status || '').toLowerCase().trim();
  if (!jobId) return reply({ ok: false, error: 'missing_job_id' }, 400);
  if (!VALID.includes(status)) return reply({ ok: false, error: 'invalid_status', allowed: VALID }, 400);
  const row = {
    job_id: jobId, status,
    message: body.message ? String(body.message).slice(0, 500) : null,
    crew_id: body.crewId ? parseInt(body.crewId, 10) : null,
    crew_member: body.crewMember ? String(body.crewMember).slice(0, 80) : null,
    lat: body.lat ? parseFloat(body.lat) : null,
    lon: body.lon ? parseFloat(body.lon) : null,
    photo_url: body.photoUrl || null,
  };
  let created;
  try { created = (await db.insert('job_status', row))[0]; } catch (e) { return reply({ ok: false, error: 'insert_failed', message: e.message }, 500); }
  return reply({ ok: true, id: created && created.id, status, jobId, createdAt: created && created.created_at });
});

export const onRequestGet = handler;
export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
