/** GET /api/placesAutocomplete?input=...&sessionToken=... — Google Places address autocomplete.
 *  Returns { ok, predictions:[{description, place_id}] }
 *  Env: GOOGLE_GEOCODING_KEY (or GOOGLE_PLACES_KEY) — Places API must be enabled on the key. */
import { endpoint, preflight } from '../_shared.js';

const handler = endpoint(async ({ env, body, reply }) => {
  const key = env.GOOGLE_GEOCODING_KEY || env.GOOGLE_PLACES_KEY;
  if (!key) return reply({ ok: false, error: 'places_not_configured' }, 503);
  const input = String(body.input || '').trim();
  if (input.length < 3) return reply({ ok: true, predictions: [] });
  const token = String(body.sessionToken || body.sessiontoken || '');
  const url = 'https://maps.googleapis.com/maps/api/place/autocomplete/json?input=' + encodeURIComponent(input)
    + '&key=' + key + '&components=country:us&types=address' + (token ? '&sessiontoken=' + encodeURIComponent(token) : '');
  let j;
  try { j = await (await fetch(url)).json(); } catch (e) { return reply({ ok: false, error: 'places_network_error', message: e.message }, 502); }
  const predictions = (j.predictions || []).map((p) => ({ description: p.description, place_id: p.place_id }));
  return reply({ ok: true, predictions, status: j.status });
});

export const onRequestGet = handler;
export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
