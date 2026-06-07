/** GET /api/placesDetails?placeId=...&sessionToken=... — Google Place details for a chosen prediction.
 *  Returns { ok, address, lat, lon, result }
 *  Env: GOOGLE_GEOCODING_KEY (or GOOGLE_PLACES_KEY) — Places API enabled. */
import { endpoint, preflight } from '../_shared.js';

const handler = endpoint(async ({ env, body, reply }) => {
  const key = env.GOOGLE_GEOCODING_KEY || env.GOOGLE_PLACES_KEY;
  if (!key) return reply({ ok: false, error: 'places_not_configured' }, 503);
  const placeId = String(body.placeId || body.place_id || '').trim();
  if (!placeId) return reply({ ok: false, error: 'missing_place_id' }, 400);
  const token = String(body.sessionToken || body.sessiontoken || '');
  const url = 'https://maps.googleapis.com/maps/api/place/details/json?place_id=' + encodeURIComponent(placeId)
    + '&fields=formatted_address,geometry,address_components&key=' + key + (token ? '&sessiontoken=' + encodeURIComponent(token) : '');
  let j;
  try { j = await (await fetch(url)).json(); } catch (e) { return reply({ ok: false, error: 'places_network_error', message: e.message }, 502); }
  const r = j.result || {};
  const loc = (r.geometry && r.geometry.location) || {};
  return reply({ ok: true, address: r.formatted_address || '', lat: loc.lat || null, lon: loc.lng || null, result: r, status: j.status });
});

export const onRequestGet = handler;
export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
