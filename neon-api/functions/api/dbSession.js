/** POST /api/dbSession : a one-hour database login for a signed-in CRM user.
 *
 *  Reached only through the CRM gateway (/api/secure/dbSession on crm/crm3), which has
 *  already verified the Cloudflare Access login and passes the person's email in
 *  X-Neon-User. We then ask Supabase's own login service for a normal session for that
 *  email (no email is sent, no password exists). The session's role is "authenticated"
 *  and it carries app_metadata.neon_staff = true, which is what the database rules check.
 *  Only the server key can set app_metadata, so nobody can give themselves that flag.
 *
 *  Returns { ok, token, expiresAt } (expiresAt in ms). Sessions are reused per person
 *  until 15 minutes before they expire, so many tabs don't mean many logins.
 *
 *  Env: SUPABASE_URL, SUPABASE_KEY (secret key)
 */
import { endpoint, preflight } from '../_shared.js';
import { authKey } from '../_apikeys.js';

const CACHE = new Map(); // email -> { token, expiresAt }
const READY = new Set(); // emails whose staff flag is confirmed in this worker

const handler = endpoint(async ({ env, reply, request }) => {
  const keyCheck = await authKey(env, request, 'write');
  if (!keyCheck.ok) return reply({ ok: false, error: keyCheck.error }, keyCheck.status);
  const user = String(request.headers.get('X-Neon-User') || '').trim().toLowerCase();
  if (!/^[^@\s]+@[^@\s]+\.[a-z]{2,}$/.test(user)) return reply({ ok: false, error: 'no_user', message: 'Sign in to the CRM again.' }, 401);
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) return reply({ ok: false, error: 'server_not_configured' }, 503);

  const hit = CACHE.get(user);
  if (hit && hit.expiresAt - Date.now() > 15 * 60 * 1000) return reply({ ok: true, token: hit.token, expiresAt: hit.expiresAt, cached: true });

  const base = String(env.SUPABASE_URL).replace(/\/$/, '') + '/auth/v1';
  const h = { apikey: env.SUPABASE_KEY, Authorization: 'Bearer ' + env.SUPABASE_KEY, 'Content-Type': 'application/json' };
  const call = async (method, path, body) => {
    const r = await fetch(base + path, { method, headers: h, body: body ? JSON.stringify(body) : undefined, signal: AbortSignal.timeout(8000) });
    const t = await r.text(); let j = {}; try { j = t ? JSON.parse(t) : {}; } catch (_) {}
    return { status: r.status, ok: r.ok, j };
  };
  const STAFF = { neon_staff: true };

  // 0) First time this worker sees the person: make sure the login exists, confirmed,
  //    with no password (422 = it already exists, which is fine).
  if (!READY.has(user)) {
    const cu = await call('POST', '/admin/users', { email: user, email_confirm: true, app_metadata: STAFF });
    if (!cu.ok && cu.status !== 422) return reply({ ok: false, error: 'create_user_failed', status: cu.status }, 502);
  }
  // 1) A magic-link token for this person (admin call: nothing is emailed), 2) traded for a session.
  let v = null;
  for (let tryNo = 0; tryNo < 2; tryNo++) {
    const gl = await call('POST', '/admin/generate_link', { type: 'magiclink', email: user });
    if (!gl.ok) return reply({ ok: false, error: 'link_failed', status: gl.status }, 502);
    const u = gl.j.user || gl.j;
    if (!READY.has(user)) {
      if (!(u && u.app_metadata && u.app_metadata.neon_staff === true) && u && u.id) {
        const up = await call('PUT', '/admin/users/' + u.id, { app_metadata: STAFF });
        if (!up.ok) return reply({ ok: false, error: 'flag_failed', status: up.status }, 502);
      }
      READY.add(user);
    }
    const hashed = gl.j.hashed_token || (gl.j.properties && gl.j.properties.hashed_token);
    if (!hashed) return reply({ ok: false, error: 'no_token_hash' }, 502);
    v = await call('POST', '/verify', { type: 'magiclink', token_hash: hashed });
    if (v.ok && v.j.access_token) break;
  }
  if (!v || !v.ok || !v.j.access_token) return reply({ ok: false, error: 'verify_failed', status: v && v.status }, 502);
  const expiresAt = (Number(v.j.expires_at) ? Number(v.j.expires_at) * 1000 : Date.now() + (Number(v.j.expires_in) || 3600) * 1000);
  CACHE.set(user, { token: v.j.access_token, expiresAt });
  return reply({ ok: true, token: v.j.access_token, expiresAt });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
