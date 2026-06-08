/** POST /api/resolvePlace — find a place's real street address + coordinates.
 *  Body: { name?, business?, area?/territory?, address? }
 *  Strategy: if a usable address is given, geocode it; otherwise Google Places Text Search by name + area.
 *  Returns { ok, address, lat, lon, name, source }
 *  Env: GOOGLE_GEOCODING_KEY (or GOOGLE_PLACES_KEY) — Geocoding + Places APIs enabled. */
import { endpoint, preflight } from '../_shared.js';

const handler = endpoint(async ({ env, body, reply }) => {
  const key = env.GOOGLE_GEOCODING_KEY || env.GOOGLE_PLACES_KEY;
  if (!key) return reply({ ok: false, error: 'maps_not_configured' }, 503);

  const opts = body.opts || body;
  const name = String(opts.name || opts.business || '').trim();
  const area = String(opts.area || opts.territory || '').trim();
  const address = String(opts.address || '').trim();
  if (!name && !address) return reply({ ok: false, error: 'name_or_address_required' }, 400);

  // 1) If we already have something address-like, geocode it directly.
  const looksLikeAddress = /\d/.test(address) && address.length > 6;
  if (looksLikeAddress) {
    try {
      const u = 'https://maps.googleapis.com/maps/api/geocode/json?address=' + encodeURIComponent(address) + '&key=' + key;
      const j = await (await fetch(u)).json();
      const r = (j.results || [])[0];
      if (r && r.geometry && r.geometry.location) {
        return reply({ ok: true, address: r.formatted_address || address, lat: r.geometry.location.lat, lon: r.geometry.location.lng, name: name, source: 'geocode' });
      }
    } catch (_) {}
  }

  // 2) Otherwise find the place by name + area via Places Text Search.
  const region = area ? (area + ', WA') : 'Whatcom or Skagit County, WA';
  const query = (name + ' ' + region).trim();
  try {
    const u = 'https://maps.googleapis.com/maps/api/place/textsearch/json?query=' + encodeURIComponent(query) + '&region=us&key=' + key;
    const j = await (await fetch(u)).json();
    const r = (j.results || [])[0];
    if (r && r.geometry && r.geometry.location) {
      return reply({ ok: true, address: r.formatted_address || '', lat: r.geometry.location.lat, lon: r.geometry.location.lng, name: r.name || name, source: 'places', status: j.status });
    }
    return reply({ ok: false, error: 'not_found', status: j.status, name: name }, 200);
  } catch (e) {
    return reply({ ok: false, error: 'maps_network_error', message: e.message }, 502);
  }
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
