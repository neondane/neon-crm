/**
 * /api/[[path]].js — Cloudflare Pages Function proxy to Apps Script
 *
 * Routes ALL /api/* requests to the Apps Script web app, bypassing CORS
 * and the Google Workspace login redirect because this code runs
 * server-to-server inside Cloudflare's edge network.
 *
 * URL pattern (browser → this Function):
 *   POST  /api/submitReferralLead     body: { realtorId, customer: {...} }
 *   POST  /api/getRealtorBySlug       body: { slug }
 *   POST  /api/getRealtorPortalView   body: { realtorId } or { slug }
 *
 * The Function pulls the action name from the URL path and merges it into
 * the JSON payload before forwarding upstream.
 *
 * Why a proxy at all?
 *   - Apps Script /macros/s/.../exec redirects unauthenticated browsers to a
 *     workspace-restricted /a/macros/neongiantmoving.com/s/.../exec URL that
 *     returns "Page Not Found" for anyone who isn't signed into the workspace.
 *   - A Cloudflare Pages Function has no Google cookies, so it gets a clean
 *     JSON response from Apps Script (once the deploy is set to "Anyone" access).
 *   - We re-emit the response with proper CORS headers for the browser.
 *
 * Bound at: refer.neongiantmoving.com/api/*
 */

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbxh1ec9k_uwCmgqRsBeMEtZ9OdjxsINY-ngzgPGBoyD9pe4-Df2YsEQWrYwRYkP7GW4jw/exec';

// Origins permitted to call this proxy. Anything else is forced to the canonical
// origin in CORS responses (so curl / Postman still work for diagnostics).
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
        if (host.endsWith('.pages.dev')) allow = origin; // preview deploys
      } catch { /* ignore malformed Origin */ }
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

export async function onRequest({ request, params }) {
  const origin = request.headers.get('Origin') || '';
  const action = (params.path || [])[0];

  if (!action) {
    return jsonResponse(
      { ok: false, error: 'Missing action. Use /api/<actionName>.' },
      400,
      origin,
    );
  }

  // Gather payload from POST body, GET query, or empty.
  let payload = {};
  if (request.method === 'POST') {
    const ct = (request.headers.get('Content-Type') || '').toLowerCase();
    if (ct.includes('application/json')) {
      try { payload = await request.json(); } catch { payload = {}; }
    } else if (ct.includes('form-urlencoded')) {
      const form = await request.formData();
      form.forEach((v, k) => { payload[k] = v; });
    } else {
      // Treat raw text body as JSON (refer.html historically used text/plain
      // to avoid CORS preflight; preserve that compatibility).
      const raw = await request.text();
      if (raw) {
        try { payload = JSON.parse(raw); } catch { payload = {}; }
      }
    }
  } else if (request.method === 'GET') {
    const url = new URL(request.url);
    url.searchParams.forEach((v, k) => { payload[k] = v; });
  } else if (request.method !== 'OPTIONS') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405, origin);
  }

  payload.action = action;

  // Forward to Apps Script.
  let upstream;
  try {
    upstream = await fetch(APPS_SCRIPT_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      redirect: 'follow',
    });
  } catch (err) {
    return jsonResponse(
      { ok: false, error: 'Upstream fetch failed: ' + err.message },
      502,
      origin,
    );
  }

  const text = await upstream.text();

  // Apps Script returns JSON on success and HTML when the workspace login
  // redirect blocks anonymous access. Detect that and surface a useful error.
  let body;
  try {
    body = JSON.parse(text);
  } catch {
    return jsonResponse(
      {
        ok: false,
        error:
          'Upstream returned non-JSON. Apps Script deploy likely needs to be set ' +
          'to "Who has access: Anyone". See README.',
        upstreamStatus: upstream.status,
        upstreamPreview: text.substring(0, 200),
      },
      502,
      origin,
    );
  }

  return jsonResponse(body, 200, origin);
}
