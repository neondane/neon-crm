/**
 * /api/placesDetails.js — Google Place Details proxy
 *
 * Frontend → /api/placesDetails?placeId=<id>
 * Returns the formatted_address, lat/lng, and basic components for a place
 * the realtor picked from the autocomplete dropdown. Server-side fetch using
 * GOOGLE_PLACES_KEY env var.
 */

const DETAILS_ENDPOINT = 'https://maps.googleapis.com/maps/api/place/details/json';

const ALLOWED_ORIGINS = [
  'https://refer.neongiantmoving.com',
  'https://portal.neongiantmoving.com',
];

function corsHeaders(origin) {
  let allow = ALLOWED_ORIGINS[0];
  if (origin) {
    if (ALLOWED_ORIGINS.includes(origin)) {
      allow = origin;
    } else {
      try {
        const host = new URL(origin).hostname;
        if (host.endsWith('.pages.dev')) allow = origin;
      } catch (e) {}
    }
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function jsonResponse(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      'Content-Type': 'application/json; charset=utf-8',
      'Cache-Control': 'no-store',
      ...corsHeaders(origin),
    },
  });
}

export async function onRequestOptions({ request }) {
  return new Response(null, {
    status: 204,
    headers: corsHeaders(request.headers.get('Origin')),
  });
}

export async function onRequest({ request, env }) {
  const origin = request.headers.get('Origin') || '';
  const url = new URL(request.url);
  const placeId = (url.searchParams.get('placeId') || '').trim();
  const sessionToken = url.searchParams.get('sessionToken') || '';

  if (!placeId) {
    return jsonResponse({ ok: false, error: 'Missing placeId' }, 400, origin);
  }
  if (!env.GOOGLE_PLACES_KEY) {
    return jsonResponse(
      { ok: false, error: 'GOOGLE_PLACES_KEY env var not set on Pages project.' },
      500,
      origin,
    );
  }

  const upstream = new URL(DETAILS_ENDPOINT);
  upstream.searchParams.set('place_id', placeId);
  upstream.searchParams.set('key', env.GOOGLE_PLACES_KEY);
  // Only fetch what we need (cheaper SKU than Place Details Pro).
  upstream.searchParams.set('fields', 'formatted_address,geometry/location,address_components');
  if (sessionToken) upstream.searchParams.set('sessiontoken', sessionToken);

  let resp;
  try {
    resp = await fetch(upstream.toString(), { method: 'GET' });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: 'Upstream fetch failed: ' + err.message },
      502,
      origin,
    );
  }

  const data = await resp.json().catch(() => null);
  if (!data) {
    return jsonResponse(
      { ok: false, error: 'Upstream returned non-JSON', upstreamStatus: resp.status },
      502,
      origin,
    );
  }
  if (data.status && data.status !== 'OK') {
    return jsonResponse(
      { ok: false, error: 'Places API: ' + data.status, message: data.error_message || '' },
      502,
      origin,
    );
  }

  const result = data.result || {};
  const loc = (result.geometry && result.geometry.location) || {};
  return jsonResponse(
    {
      ok: true,
      formattedAddress: result.formatted_address || '',
      lat: loc.lat,
      lng: loc.lng,
      components: result.address_components || [],
    },
    200,
    origin,
  );
}
