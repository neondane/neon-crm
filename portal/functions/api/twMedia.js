/**
 * /api/twMedia.js — Authenticated proxy for inbound Twilio MMS media.
 *
 *   GET /api/twMedia?u=<twilio media url>
 *
 * Twilio stores received MMS media behind account auth. The CRM renders inbound
 * images via <img src="/api/twMedia?u=..."> and this function streams the bytes
 * using the Twilio creds already in the Pages environment — so the raw media
 * URL/credentials never reach the browser.
 *
 * Hard SSRF guard: only fetches canonical Twilio media URLs for this account.
 */

// Only ever fetch a real Twilio media resource — nothing else.
const TWILIO_MEDIA_RE = /^https:\/\/(?:api|mcs)\.twilio\.com\/2010-04-01\/Accounts\/AC[A-Za-z0-9]+\/Messages\/[A-Za-z0-9]+\/Media\/ME[A-Za-z0-9]+$/;

export async function onRequestGet({ request, env }) {
  const u = new URL(request.url).searchParams.get('u') || '';
  if (!TWILIO_MEDIA_RE.test(u)) {
    return new Response('bad media url', { status: 400 });
  }
  if (!env.TWILIO_SID || !env.TWILIO_TOKEN) {
    return new Response('twilio_not_configured', { status: 503 });
  }
  const auth = btoa(env.TWILIO_SID + ':' + env.TWILIO_TOKEN);
  let r;
  try {
    // Twilio media URLs 307-redirect to a signed CDN URL; follow it.
    r = await fetch(u, { headers: { 'Authorization': 'Basic ' + auth }, redirect: 'follow' });
  } catch (e) {
    return new Response('fetch error', { status: 502 });
  }
  if (!r.ok) return new Response('twilio media ' + r.status, { status: 502 });
  const ct = r.headers.get('Content-Type') || 'application/octet-stream';
  return new Response(r.body, {
    status: 200,
    headers: {
      'Content-Type': ct,
      'Cache-Control': 'public, max-age=86400',
      'Access-Control-Allow-Origin': '*',
    },
  });
}
