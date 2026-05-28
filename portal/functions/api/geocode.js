/**
 * /api/geocode.js — Server-side Google Geocoding wrapper
 *
 *   POST /api/geocode                 — single address
 *     Body: { address: "123 Main St, Bellingham WA", contactId?: 42 }
 *     Returns: { ok:true, lat, lon, formatted, place_id }
 *
 *   POST /api/geocode?mode=batch      — backfill mode
 *     Body: { items: [{ id: 42, address: "..." }, ...] }
 *
 *   POST /api/geocode?mode=backfill   — auto-pull contacts missing lat/lon
 *
 * Env: GOOGLE_GEOCODING_KEY, SUPABASE_URL, SUPABASE_KEY
 */

const ALLOWED_ORIGINS = ['https://crm.neongiantmoving.com', 'https://refer.neongiantmoving.com'];

function corsHeaders(origin) {
  let allow = ALLOWED_ORIGINS[0];
  if (origin && ALLOWED_ORIGINS.includes(origin)) allow = origin;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
function json(body, status, origin) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) } });
}

const REGION_BIAS = {
  language: 'en', region: 'us',
  bounds: '47.85,-123.20|49.00,-121.20',
  components: 'country:US|administrative_area:WA',
};

async function geocodeOne(address, apiKey) {
  if (!address || !address.trim()) return { ok: false, error: 'empty_address' };
  const url = new URL('https://maps.googleapis.com/maps/api/geocode/json');
  url.searchParams.set('address', address);
  url.searchParams.set('key', apiKey);
  url.searchParams.set('language', REGION_BIAS.language);
  url.searchParams.set('region', REGION_BIAS.region);
  url.searchParams.set('bounds', REGION_BIAS.bounds);
  url.searchParams.set('components', REGION_BIAS.components);
  let r, j;
  try { r = await fetch(url.toString()); j = await r.json(); }
  catch (e) { return { ok: false, error: 'network_error', message: e.message }; }
  if (j.status === 'ZERO_RESULTS') return { ok: false, error: 'not_found', address };
  if (j.status !== 'OK') return { ok: false, error: 'google_error', status: j.status, message: j.error_message };
  const top = j.results[0];
  if (!top) return { ok: false, error: 'no_result' };
  return { ok: true, lat: top.geometry.location.lat, lon: top.geometry.location.lng, formatted: top.formatted_address, place_id: top.place_id, location_type: top.geometry.location_type };
}

async function supaPatch(env, contactId, lat, lon, formatted) {
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) return;
  await fetch(`${env.SUPABASE_URL}/rest/v1/contacts?id=eq.${contactId}`, {
    method: 'PATCH',
    headers: { 'apikey': env.SUPABASE_KEY, 'Authorization': 'Bearer ' + env.SUPABASE_KEY, 'Content-Type': 'application/json', 'Prefer': 'return=minimal' },
    body: JSON.stringify({ lat, lon, formatted_address: formatted, geocoded_at: new Date().toISOString() }),
  }).catch(() => {});
}

async function supaGetMissing(env, limit) {
  if (!env.SUPABASE_URL || !env.SUPABASE_KEY) return [];
  const url = `${env.SUPABASE_URL}/rest/v1/contacts?select=id,name,business,address,city,state,zip&or=(lat.is.null,lon.is.null)&address=not.is.null&limit=${limit || 30}`;
  try {
    const r = await fetch(url, { headers: { 'apikey': env.SUPABASE_KEY, 'Authorization': 'Bearer ' + env.SUPABASE_KEY } });
    return r.ok ? await r.json() : [];
  } catch (_e) { return []; }
}

function buildAddressQuery(c) {
  if (c.address && c.address.trim()) return [c.address, c.city, c.state, c.zip].filter(Boolean).join(', ');
  if (c.business && c.city) return [c.business, c.city, c.state || 'WA'].filter(Boolean).join(', ');
  return null;
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');
  if (!env.GOOGLE_GEOCODING_KEY) {
    return json({ ok: false, error: 'not_configured', message: 'GOOGLE_GEOCODING_KEY env var must be set on Cloudflare Pages.' }, 503, origin);
  }
  const url = new URL(request.url);
  const mode = url.searchParams.get('mode') || 'single';

  if (mode === 'single') {
    let body;
    try { body = await request.json(); } catch (_e) { return json({ ok: false, error: 'bad_json' }, 400, origin); }
    const result = await geocodeOne(body.address || '', env.GOOGLE_GEOCODING_KEY);
    if (result.ok && body.contactId) await supaPatch(env, body.contactId, result.lat, result.lon, result.formatted);
    return json(result, result.ok ? 200 : 422, origin);
  }
  if (mode === 'batch') {
    let body;
    try { body = await request.json(); } catch (_e) { return json({ ok: false, error: 'bad_json' }, 400, origin); }
    const items = Array.isArray(body.items) ? body.items : [];
    if (!items.length) return json({ ok: false, error: 'no_items' }, 400, origin);
    if (items.length > 50) return json({ ok: false, error: 'too_many', max: 50 }, 400, origin);
    const results = [], failed = [];
    for (const it of items) {
      const r = await geocodeOne(it.address || '', env.GOOGLE_GEOCODING_KEY);
      if (r.ok) { results.push({ id: it.id, ...r }); if (it.id) await supaPatch(env, it.id, r.lat, r.lon, r.formatted); }
      else failed.push({ id: it.id, address: it.address, error: r.error });
      await new Promise(res => setTimeout(res, 100));
    }
    return json({ ok: true, geocoded: results.length, failed: failed.length, results, failures: failed }, 200, origin);
  }
  if (mode === 'backfill') {
    let body = {};
    try { body = await request.json(); } catch (_e) {}
    const limit = Math.min(parseInt(body.limit || 30, 10), 50);
    const missing = await supaGetMissing(env, limit);
    if (!missing.length) return json({ ok: true, geocoded: 0, message: 'no_missing' }, 200, origin);
    let success = 0, fail = 0;
    const failures = [];
    for (const c of missing) {
      const q = buildAddressQuery(c);
      if (!q) { fail++; failures.push({ id: c.id, error: 'no_address_or_business' }); continue; }
      const r = await geocodeOne(q, env.GOOGLE_GEOCODING_KEY);
      if (r.ok) { await supaPatch(env, c.id, r.lat, r.lon, r.formatted); success++; }
      else { failures.push({ id: c.id, name: c.name || c.business, query: q, error: r.error }); fail++; }
      await new Promise(res => setTimeout(res, 120));
    }
    return json({ ok: true, scanned: missing.length, geocoded: success, failed: fail, failures, message: `Geocoded ${success} of ${missing.length}.${missing.length === limit ? ' More remain — run again.' : ''}` }, 200, origin);
  }
  return json({ ok: false, error: 'unknown_mode', mode }, 400, origin);
}
