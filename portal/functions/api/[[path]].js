// build-stamp: 2026-05-18T12:46:57.565Z (Twilio env vars activated)
/**
 * /api/[[path]].js — Cloudflare Pages Function proxy to Apps Script
 *
 * Routes ALL /api/* requests to the Apps Script web app, bypassing CORS
 * and the Google Workspace login redirect because this runs server-to-server.
 *
 * Why GET upstream, not POST?
 *   Anonymous POSTs to Apps Script /macros/s/.../exec return a 302 to
 *   script.googleusercontent.com/macros/echo, and that host returns 405 for
 *   POST. The canonical pattern for anonymous Apps Script calls is GET with
 *   ?action=...&payload=<JSON>. The backend's doGet() already supports it.
 *
 * URL pattern (browser → this Function):
 *   POST /api/<action>  body: JSON payload
 *   GET  /api/<action>?param=value...
 *
 * Bound at: refer.neongiantmoving.com/api/*
 */

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbxh1ecAF9yWN91w04SHROy5T9N-PehvpF29LTFu8M6vjnp1PRyhgxUYf7bfU5DKzbq_nA/exec';

const ALLOWED_ORIGINS = [
  'https://refer.neongiantmoving.com',
  'https://portal.neongiantmoving.com',
  'https://crm.neongiantmoving.com',
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
      } catch (e) { /* ignore malformed Origin */ }
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

  // Gather the payload from POST body or GET query.
  let payload = {};
  if (request.method === 'POST') {
    const ct = (request.headers.get('Content-Type') || '').toLowerCase();
    if (ct.includes('application/json')) {
      try { payload = await request.json(); } catch (e) { payload = {}; }
    } else if (ct.includes('form-urlencoded')) {
      const form = await request.formData();
      form.forEach((v, k) => { payload[k] = v; });
    } else {
      const raw = await request.text();
      if (raw) {
        try { payload = JSON.parse(raw); } catch (e) { payload = {}; }
      }
    }
  } else if (request.method === 'GET') {
    const url = new URL(request.url);
    url.searchParams.forEach((v, k) => { payload[k] = v; });
  } else if (request.method !== 'OPTIONS') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405, origin);
  }

  payload.action = action;

  // Forward to Apps Script as a GET with payload encoded as a query param.
  // The backend doGet() parses ?payload=<JSON> and dispatches to the action.
  const upstreamUrl = new URL(APPS_SCRIPT_URL);
  upstreamUrl.searchParams.set('action', action);
  upstreamUrl.searchParams.set('payload', JSON.stringify(payload));

  let upstream;
  try {
    upstream = await fetch(upstreamUrl.toString(), {
      method: 'GET',
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
  } catch (e) {
    return jsonResponse(
      {
        ok: false,
        error:
          'Upstream returned non-JSON. The Apps Script deploy must be set to ' +
          '"Who has access: Anyone" AND the workspace must allow public Apps ' +
          'Script web apps (admin.google.com → Apps → Apps Script).',
        upstreamStatus: upstream.status,
        upstreamPreview: text.substring(0, 200),
      },
      502,
      origin,
    );
  }

  return jsonResponse(body, 200, origin);
}
