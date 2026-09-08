/** /api/whoami — one-off probe. Confirms (a) Pages Functions resolve from this
 *  directory for the crm3 project, and (b) whether Cloudflare Access actually
 *  protects this host. Exposes nothing but your own Access identity. Delete after.
 */
export async function onRequest({ request }) {
  const email = request.headers.get('Cf-Access-Authenticated-User-Email') || '';
  const jwt = request.headers.get('Cf-Access-Jwt-Assertion') || '';
  return new Response(JSON.stringify({
    ok: true,
    functionsResolveFrom: 'root functions/',
    accessProtected: !!(email || jwt),
    email: email || null,
    hasJwt: !!jwt,
  }, null, 2), { headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' } });
}
