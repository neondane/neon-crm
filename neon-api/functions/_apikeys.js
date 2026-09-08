/** _apikeys.js — API key auth for the public /api/v1 surface.
 *  Keys are stored in Supabase as a sha-256 hash (table: api_keys), so a leaked
 *  DB read never exposes usable keys. neon-api uses the Supabase SERVICE key, so
 *  it reads api_keys even though RLS stays ON (the public client key cannot).
 */
import { sb } from './_shared.js';

export async function sha256hex(s) {
  const buf = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(s)));
  return [...new Uint8Array(buf)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Returns { ok:true, keyId, scopes } or { ok:false, status, error }.
export async function authKey(env, request, needScope) {
  const hdr = request.headers.get('Authorization') || '';
  const key = (hdr.replace(/^Bearer\s+/i, '').trim()) || (request.headers.get('x-api-key') || '').trim();
  if (!key) return { ok: false, status: 401, error: 'missing_api_key' };
  let rows;
  try {
    const hash = await sha256hex(key);
    rows = await sb(env).select(`api_keys?key_hash=eq.${hash}&active=eq.true&select=id,scopes&limit=1`);
  } catch (e) {
    return { ok: false, status: 500, error: 'auth_lookup_failed' };
  }
  const k = rows && rows[0];
  if (!k) return { ok: false, status: 401, error: 'invalid_api_key' };
  if (needScope && !((k.scopes || []).includes(needScope) || (k.scopes || []).includes('admin'))) {
    return { ok: false, status: 403, error: 'insufficient_scope', need: needScope };
  }
  try { await sb(env).update('api_keys', `id=eq.${k.id}`, { last_used_at: new Date().toISOString() }); } catch (_) {}
  return { ok: true, keyId: k.id, scopes: k.scopes || [] };
}
