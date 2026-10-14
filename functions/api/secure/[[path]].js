/** /api/secure/<action> : the ONLY way the CRM sends texts, emails, and payouts.
 *
 *  Why this exists: neon-api's sendSms / sendMms / sendEmail / sendPayout used to
 *  accept calls from anyone on the internet. They now require an API key. This
 *  gateway runs on the CRM's own site (crm / crm3, behind Cloudflare Access), proves
 *  the caller is signed in to the CRM, and only then forwards the request to neon-api
 *  with the server-held NEON_ADMIN_KEY. The browser never sees a key.
 *
 *  SECURITY: root functions/ is ALSO served on hostnames that are NOT behind Access
 *  (for example neon-crm-v3.pages.dev). So we never trust the hostname. We require
 *  and cryptographically verify the Cf-Access-Jwt-Assertion header, and we pin it to
 *  OUR Access team and OUR CRM application. A token minted by any other Access team,
 *  or for any other app, is rejected.
 *
 *  Env (neon-crm-v3 Pages project): NEON_ADMIN_KEY (already set, used by /api/keys).
 */

const ACCESS_TEAM = 'https://winter-snowflake-2c4e.cloudflareaccess.com';
// AUD tag of the Neon CRM Access application (same app covers crm + crm3).
const ACCESS_AUD = '635d889655dc3b6db0081aa5b767da6bbe30d5e5105e158e416bb07ddee000a9';
const NEON_API = 'https://neon-api.pages.dev/api/';
const ALLOWED = { sendSms: 1, sendMms: 1, sendEmail: 1, sendPayout: 1 };

function b64urlBytes(s) {
  s = String(s).replace(/-/g, '+').replace(/_/g, '/');
  s += '='.repeat(s.length % 4 ? 4 - (s.length % 4) : 0);
  const bin = atob(s), out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}
function b64urlJson(s) { return JSON.parse(new TextDecoder().decode(b64urlBytes(s))); }

export async function verifyAccessJwt(token, env) {
  const parts = String(token || '').split('.');
  if (parts.length !== 3) return { ok: false, error: 'malformed_jwt' };
  let header, payload;
  try { header = b64urlJson(parts[0]); payload = b64urlJson(parts[1]); }
  catch (_) { return { ok: false, error: 'unreadable_jwt' }; }

  const team = String((env && env.ACCESS_TEAM) || ACCESS_TEAM).replace(/\/$/, '');
  const aud = String((env && env.ACCESS_AUD) || ACCESS_AUD);
  const iss = String(payload.iss || '').replace(/\/$/, '');
  if (iss !== team) return { ok: false, error: 'bad_issuer' };
  const auds = Array.isArray(payload.aud) ? payload.aud : [payload.aud];
  if (auds.indexOf(aud) < 0) return { ok: false, error: 'bad_audience' };

  const now = Math.floor(Date.now() / 1000);
  if (!payload.exp || now > payload.exp) return { ok: false, error: 'expired' };
  if (payload.nbf && now < payload.nbf - 60) return { ok: false, error: 'not_yet_valid' };

  let jwks = null;
  try { jwks = await fetch(team + '/cdn-cgi/access/certs').then((r) => r.json()); } catch (_) {}
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
  if (request.method !== 'POST') return j({ ok: false, error: 'method_not_allowed' }, 405);

  const action = new URL(request.url).pathname.replace(/^\/api\/secure\/?/, '').replace(/\/+$/, '');
  if (!ALLOWED[action]) return j({ ok: false, error: 'unknown_action' }, 404);

  const token = request.headers.get('Cf-Access-Jwt-Assertion') || '';
  if (!token) return j({ ok: false, error: 'sign_in_required', message: 'Sign in to the CRM again, then retry.' }, 401);
  const v = await verifyAccessJwt(token, env);
  if (!v.ok) return j({ ok: false, error: v.error, message: 'Sign in to the CRM again, then retry.' }, 401);
  if (!env.NEON_ADMIN_KEY) return j({ ok: false, error: 'server_not_configured', message: 'NEON_ADMIN_KEY is missing on the CRM site.' }, 503);

  const body = await request.text();
  let r;
  try {
    r = await fetch(NEON_API + action, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        Authorization: 'Bearer ' + env.NEON_ADMIN_KEY,
        'X-Neon-User': v.email || 'unknown',
        ...(request.headers.get('X-Neon-App') === 'crm-app' ? { 'X-Neon-App': 'crm-app' } : {}),
      },
      body,
    });
  } catch (e) {
    return j({ ok: false, error: 'backend_unreachable', message: String((e && e.message) || e) }, 502);
  }
  const txt = await r.text();
  return new Response(txt, { status: r.status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
