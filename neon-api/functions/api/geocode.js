/** POST /api/geocode — Google Geocoding wrapper (keeps the key server-side).
 *  Body: { address }  ·  Returns { ok, lat, lon, formatted, placeId }
 *  Env: GOOGLE_GEOCODING_KEY */
import { endpoint, preflight } from '../_shared.js';

const handler = endpoint(async ({ env, body, reply }) => {
  const GKEY = env.GOOGLE_GEOCODING_KEY || env.GOOGLE_PLACES_KEY;
  if (!GKEY) return reply({ ok: false, error: 'geocoding_not_configured' }, 503);
  const address = String(body.address || '').trim();
  if (!address) return reply({ ok: false, error: 'missing_address' }, 400);

  const url = 'https://maps.googleapis.com/maps/api/geocode/json?address='
    + encodeURIComponent(address) + '&key=' + GKEY;
  let j;
  try {
    j = await (await fetch(url)).json();
  } catch (e) {
    return reply({ ok: false, error: 'geocode_network_error', message: e.message }, 502);
  }
  if (j.status !== 'OK' || !j.results || !j.results.length)
    return reply({ ok: false, error: 'no_result', status: j.status }, 200);

  const r = j.results[0];
  return reply({
    ok: true,
    lat: r.geometry.location.lat,
    lon: r.geometry.location.lng,
    formatted: r.formatted_address,
    placeId: r.place_id,
  });
});

export const onRequestPost = handler;
export const onRequestGet = handler;
export const onRequestOptions = ({ request }) => preflight(request);
