/**
 * /api/placesAutocomplete.js — Google Places Autocomplete proxy
 *
 * Frontend → /api/placesAutocomplete?input=<text>
 * Server-side fetch to Google Maps Places API using GOOGLE_PLACES_KEY env var
 * (never exposed to the browser). Returns trimmed suggestions.
 *
 * Region-biased to the Skagit Valley / Bellingham WA so realtors get local
 * results first.
 */

const PLACES_ENDPOINT = 'https://maps.googleapis.com/maps/api/place/autocomplete/json';

// Skagit Valley region bias — Bellingham/Mt Vernon centroid + ~50mi radius.
const REGION_BIAS = {
  lat: 48.50,
  lng: -122.30,
  radiusMeters: 80000,
};

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
  const input = (url.searchParams.get('input') || '').trim();
  const sessionToken = url.searchParams.get('sessionToken') || '';

  if (!input || input.length < 2) {
    return jsonResponse({ ok: true, predictions: [] }, 200, origin);
  }
  if (!env.GOOGLE_PLACES_KEY) {
    return jsonResponse(
      { ok: false, error: 'GOOGLE_PLACES_KEY env var not set on Pages project.' },
      500,
      origin,
    );
  }

  // Build upstream URL — bias to Skagit Valley, restrict to US addresses.
  const upstream = new URL(PLACES_ENDPOINT);
  upstream.searchParams.set('input', input);
  upstream.searchParams.set('key', env.GOOGLE_PLACES_KEY);
  upstream.searchParams.set('types', 'address');
  upstream.searchParams.set('components', 'country:us');
  upstream.searchParams.set('location', REGION_BIAS.lat + ',' + REGION_BIAS.lng);
  upstream.searchParams.set('radius', String(REGION_BIAS.radiusMeters));
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

  if (data.status && data.status !== 'OK' && data.status !== 'ZERO_RESULTS') {
    return jsonResponse(
      { ok: false, error: 'Places API: ' + data.status, message: data.error_message || '' },
      502,
      origin,
    );
  }

  // Trim Google's full response to just what the UI needs.
  const predictions = (data.predictions || []).map(function (p) {
    return {
      placeId: p.place_id,
      description: p.description,
      main: (p.structured_formatting && p.structured_formatting.main_text) || '',
      secondary: (p.structured_formatting && p.structured_formatting.secondary_text) || '',
    };
  });

  return jsonResponse({ ok: true, predictions: predictions }, 200, origin);
}
