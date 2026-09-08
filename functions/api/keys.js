/** /api/keys — Access-gated API key management for the CRM Settings tab.
 *
 *  Anyone signed in to crm3 with a @neongiantmoving.com Google account can
 *  generate / list / revoke keys. Nobody pastes a secret.
 *
 *  SECURITY: this file lives in root functions/, which is also served on
 *  hostname(s) that are NOT behind Cloudflare Access (the public Twilio webhook
 *  lives here too). So we do NOT trust host-level Access. We require and
 *  cryptographically VERIFY the Cf-Access-Jwt-Assertion against the issuing
 *  team's JWKS, then require the @neongiantmoving.com domain. No valid JWT =
 *  denied, on every hostname.
 *
 *  Env (on the crm3 Pages project): NEON_ADMIN_KEY (an admin-scope ngk_ key),
 *  optional ACCESS_AUD (the Access application AUD tag, pins the audience).
 */

function b64urlBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat(s.length % 4 ? 4 - (s.length % 4) : 0);
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlJson(s) { return JSON.parse(new TextDecoder().decode(b64urlBytes(s))); }

async function verifyAccessJwt(token, env) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, error: 'malformed_jwt' };
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); }
  catch (_) { return { ok: false, error: 'unreadable_jwt' }; }

  const iss = String(payload.iss || '').replace(/\/$/, '');
  if (!/^https:\/\/[a-z0-9-]+\.cloudflareaccess\.com$/i.test(iss)) return { ok: false, error: 'bad_issuer' };

  const now = Math.floor(Date.now() / 1000);
  if (payload.exp && now > payload.exp) return { ok: false, error: 'expired' };
  if (payload.nbf && now < payload.nbf - 60) return { ok: false, error: 'not_yet_valid' };
  if (env.ACCESS_AUD) {
    const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
    if (auds.indexOf(env.ACCESS_AUD) < 0) return { ok: false, error: 'bad_audience' };
  }

  let jwks = null;
  try { jwks = await fetch(iss + '/cdn-cgi/access/certs').then((r) => r.json()); } catch (_) {}
  if (!jwks || !Array.isArray(jwks.keys)) return { ok: false, error: 'jwks_unavailable' };
  const jwk = jwks.keys.find((k) => k.kid === header.kid);
  if (!jwk) return { ok: false, error: 'unknown_kid' };

  let valid = false;
  try {
    const key = await crypto.subtle.importKey('jwk',
      { kty: jwk.kty, n: jwk.n, e: jwk.e, alg: 'RS256', ext: true },
      { name: 'RSASSA-PKCS1-v1_5', hash: 'SHA-256' }, false, ['verify']);
    valid = await crypto.subtle.verify('RSASSA-PKCS1-v1_5', key,
      b64urlBytes(parts[2]), new TextEncoder().encode(parts[0] + '.' + parts[1]));
  } catch (_) { valid = false; }
  if (!valid) return { ok: false, error: 'bad_signature' };

  return { ok: true, email: String(payload.email || '').toLowerCase() };
}

export async function onRequest({ request, env }) {
  const j = (d, s) => new Response(JSON.stringify(d), {
    status: s || 200, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' },
  });

  const token = request.headers.get('Cf-Access-Jwt-Assertion') || '';
  if (!token) return j({ ok: false, error: 'sign_in_required' }, 401);
  const v = await verifyAccessJwt(token, env);
  if (!v.ok) return j({ ok: false, error: v.error }, 401);
  if (!/@neongiantmoving\.com$/i.test(v.email || '')) return j({ ok: false, error: 'not_authorized', email: v.email || null }, 403);
  if (!env.NEON_ADMIN_KEY) return j({ ok: false, error: 'server_not_configured', hint: 'Add NEON_ADMIN_KEY to this Pages project' }, 503);

  const path = new URL(request.url).pathname.replace(/^\/api\/keys\/?/, '');
  const target = 'https://neon-api.pages.dev/api/v1/keys' + (path ? '/' + path : '');
  const init = { method: request.method, headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + env.NEON_ADMIN_KEY } };
  if (request.method === 'POST' || request.method === 'PATCH') init.body = await request.text();

  const r = await fetch(target, init);
  const txt = await r.text();
  return new Response(txt, { status: r.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
