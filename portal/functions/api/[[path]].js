// build-stamp: 2026-06-01 (Supabase-backed portal API; Apps Script fallback for legacy actions)
/**
 * /api/[[path]].js — Cloudflare Pages Function for the Neon Giant realtor portal.
 *
 * WHAT CHANGED (2026-06-01):
 *   The CRM now runs on Supabase (project aoyfieswynhgqyrveqnp), but the portal
 *   was still reading the old Google Sheets / Apps Script backend, so it could
 *   only see a partial, stale slice of realtors and none of the CRM headshots.
 *   This function now serves the portal's data actions straight from Supabase,
 *   so realtors + headshots always match the CRM. Any action it does NOT know
 *   about (e.g. geocode) is still proxied to Apps Script, so legacy integrations
 *   keep working untouched.
 *
 * SAFE ROLLOUT:
 *   Supabase is only used when the SUPABASE_KEY environment variable is set in
 *   the Cloudflare Pages project. If it is missing, every action falls back to
 *   the Apps Script proxy (the previous behavior) — so deploying this file can
 *   never break the live portal before you flip the switch. Set SUPABASE_KEY to
 *   the project's publishable key (the same sb_publishable_... value the CRM
 *   already uses client-side) to turn on the Supabase path.
 *
 * ENV VARS (Cloudflare Pages → Settings → Environment variables):
 *   SUPABASE_KEY  (required to enable Supabase)  e.g. sb_publishable_...
 *   SUPABASE_URL  (optional)  defaults to https://aoyfieswynhgqyrveqnp.supabase.co
 *
 * Actions served from Supabase:
 *   getRealtorPortalView { slug }   -> realtor dashboard (realtor + totals + leads)
 *   getRealtorPublic     { slug }   -> client landing page (realtor identity ONLY, no leads)
 *   getRealtorBySlug     { slug }   -> alias of getRealtorPublic
 *   submitReferralLead   { realtorId, customer:{...} } -> inserts portal_leads
 */

const APPS_SCRIPT_URL =
  'https://script.google.com/macros/s/AKfycbxh1ecAF9yWN91w04SHROy5T9N-PehvpF29LTFu8M6vjnp1PRyhgxUYf7bfU5DKzbq_nA/exec';

const DEFAULT_SUPABASE_URL = 'https://aoyfieswynhgqyrveqnp.supabase.co';

// Actions this function answers directly from Supabase (when SUPABASE_KEY is set).
const SUPABASE_ACTIONS = new Set([
  'getRealtorPortalView',
  'getRealtorPublic',
  'getRealtorBySlug',
  'submitReferralLead',
]);

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

/* ----------------------------- Supabase helpers ---------------------------- */

function sbHeaders(key) {
  return { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
}

async function sbGet(baseUrl, key, path) {
  const r = await fetch(baseUrl + '/rest/v1/' + path, { headers: sbHeaders(key) });
  if (!r.ok) throw new Error('Supabase GET ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}

async function sbInsert(baseUrl, key, table, obj) {
  const r = await fetch(baseUrl + '/rest/v1/' + table, {
    method: 'POST',
    headers: { ...sbHeaders(key), Prefer: 'return=representation' },
    body: JSON.stringify(obj),
  });
  if (!r.ok) throw new Error('Supabase INSERT ' + r.status + ': ' + (await r.text()).slice(0, 200));
  return r.json();
}

function slugToId(slug) {
  const m = String(slug || '').match(/-(\d+)$/);
  return m ? m[1] : null;
}

function firstNameOf(name) {
  return String(name || '').trim().split(/\s+/)[0] || '';
}

// Only the realtor's public-facing identity. Never phone/email/notes/leads.
function realtorPublic(c) {
  const name = String(c.name || '').trim();
  const photo = c.profilePic || '';
  return {
    id: c.id,
    name: name,
    firstName: firstNameOf(name),
    business: c.business || '',
    profilePic: photo,
    photo: photo, // alias so older client code that reads r.photo also works
  };
}

function isRealtor(c) {
  return c && String(c.type || '').toLowerCase() === 'realtor';
}

async function handleSupabaseAction(action, payload, baseUrl, key, origin) {
  /* ----- realtor dashboard: realtor + their leads + totals ----- */
  if (action === 'getRealtorPortalView') {
    const id = slugToId(payload.slug);
    if (!id) return jsonResponse({ ok: false, error: 'This link is missing the realtor ID.' }, 200, origin);

    const rows = await sbGet(baseUrl, key,
      'contacts?id=eq.' + id +
      '&select=id,name,role,business,email,phone,type,profilePic,portalActivatedAt');
    const c = rows[0];
    if (!isRealtor(c)) {
      return jsonResponse({ ok: false, error: "This referral link isn't recognized." }, 200, origin);
    }

    let leads = [];
    try {
      leads = await sbGet(baseUrl, key,
        'portal_leads?realtorId=eq.' + id +
        '&select=id,customerName,moveSize,moveDate,status,submittedAt,rewardSent,customerDiscountApplied' +
        '&order=submittedAt.desc');
    } catch (e) { leads = []; }

    let earnedPaid = 0, earnedPending = 0;
    leads.forEach(function (l) {
      const st = String(l.status || '').toLowerCase();
      if (l.rewardSent) earnedPaid += 50;
      else if (st === 'completed' || st === 'booked') earnedPending += 50;
    });

    const realtor = Object.assign(realtorPublic(c), {
      email: c.email || '',
      phone: c.phone || '',
      activated: !!c.portalActivatedAt,
      activatedAt: c.portalActivatedAt || null,
    });

    return jsonResponse({
      ok: true,
      realtor: realtor,
      totals: { total: leads.length, earnedPending: earnedPending, earnedPaid: earnedPaid },
      leads: leads,
    }, 200, origin);
  }

  /* ----- client landing page: realtor identity ONLY (no leads) ----- */
  if (action === 'getRealtorPublic' || action === 'getRealtorBySlug') {
    const id = slugToId(payload.slug);
    if (!id) return jsonResponse({ ok: false, error: 'This link is missing the realtor ID.' }, 200, origin);
    const rows = await sbGet(baseUrl, key, 'contacts?id=eq.' + id + '&select=id,name,business,type,profilePic');
    const c = rows[0];
    if (!isRealtor(c)) return jsonResponse({ ok: false, error: 'Realtor not found.' }, 200, origin);
    return jsonResponse({ ok: true, realtor: realtorPublic(c) }, 200, origin);
  }

  /* ----- client submits a referral -> insert into portal_leads ----- */
  if (action === 'submitReferralLead') {
    const realtorId = payload.realtorId;
    const cust = payload.customer || {};
    if (!realtorId) return jsonResponse({ ok: false, error: 'Missing realtorId.' }, 200, origin);
    if (!cust.name || !cust.phone) {
      return jsonResponse({ ok: false, error: 'Name and phone are required.' }, 200, origin);
    }

    // Look up the realtor so the lead carries their name/email (best-effort).
    let realtorName = '', realtorEmail = '';
    try {
      const rows = await sbGet(baseUrl, key, 'contacts?id=eq.' + realtorId + '&select=name,email');
      if (rows[0]) { realtorName = rows[0].name || ''; realtorEmail = rows[0].email || ''; }
    } catch (e) { /* non-fatal */ }

    const row = {
      submittedAt: new Date().toISOString(),
      realtorId: (Number(realtorId) || realtorId),
      realtorName: realtorName,
      realtorEmail: realtorEmail,
      customerName: String(cust.name).trim(),
      customerPhone: String(cust.phone).trim(),
      customerEmail: (cust.email || '').trim(),
      fromAddress: (cust.fromAddress || '').trim(),
      toAddress: (cust.toAddress || '').trim(),
      moveDate: cust.moveDate ? cust.moveDate : null,
      moveSize: (cust.moveSize || '').trim(),
      notes: (cust.notes || '').trim(),
      status: 'New',
      sourceTag: 'portal',
    };

    const inserted = await sbInsert(baseUrl, key, 'portal_leads', row);
    const newId = (inserted && inserted[0] && inserted[0].id) || null;
    return jsonResponse({ ok: true, id: newId }, 200, origin);
  }

  return null; // not a Supabase action
}

/* --------------------- Apps Script proxy (legacy fallback) ------------------ */

async function proxyToAppsScript(action, payload, origin) {
  const upstreamUrl = new URL(APPS_SCRIPT_URL);
  upstreamUrl.searchParams.set('action', action);
  upstreamUrl.searchParams.set('payload', JSON.stringify(payload));

  let upstream;
  try {
    upstream = await fetch(upstreamUrl.toString(), { method: 'GET', redirect: 'follow' });
  } catch (err) {
    return jsonResponse({ ok: false, error: 'Upstream fetch failed: ' + err.message }, 502, origin);
  }
  const text = await upstream.text();
  let body;
  try {
    body = JSON.parse(text);
  } catch (e) {
    return jsonResponse({
      ok: false,
      error: 'Upstream returned non-JSON. Check the Apps Script deploy access.',
      upstreamStatus: upstream.status,
      upstreamPreview: text.substring(0, 200),
    }, 502, origin);
  }
  return { __body: body, __origin: origin };
}

/* --------------------------------- Router ---------------------------------- */

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
}

export async function onRequest({ request, params, env }) {
  const origin = request.headers.get('Origin') || '';
  const action = (params.path || [])[0];

  if (!action) {
    return jsonResponse({ ok: false, error: 'Missing action. Use /api/<actionName>.' }, 400, origin);
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
      if (raw) { try { payload = JSON.parse(raw); } catch (e) { payload = {}; } }
    }
  } else if (request.method === 'GET') {
    const url = new URL(request.url);
    url.searchParams.forEach((v, k) => { payload[k] = v; });
  } else if (request.method !== 'OPTIONS') {
    return jsonResponse({ ok: false, error: 'Method not allowed' }, 405, origin);
  }
  payload.action = action;

  // Accept whatever the key is named in the Cloudflare project env.
  const SUPABASE_KEY = (env && (
    env.SUPABASE_KEY || env.SUPABASE_ANON_KEY || env.SUPABASE_PUBLISHABLE_KEY ||
    env.SB_KEY || env.SB_PUBLISHABLE_KEY || env.SUPABASE_SERVICE_ROLE_KEY || env.SUPABASE_SERVICE_KEY
  )) || '';
  const SUPABASE_URL = (env && (env.SUPABASE_URL || env.SB_URL)) || DEFAULT_SUPABASE_URL;
  const supabaseOn = !!SUPABASE_KEY;

  // ---- Supabase path (when enabled) ----
  if (supabaseOn && SUPABASE_ACTIONS.has(action)) {
    try {
      const res = await handleSupabaseAction(action, payload, SUPABASE_URL, SUPABASE_KEY, origin);
      if (res) return res;
    } catch (err) {
      return jsonResponse({ ok: false, error: 'Supabase error: ' + err.message }, 200, origin);
    }
  }

  // ---- Fallback: Apps Script proxy ----
  // getRealtorPublic / getRealtorBySlug aren't known to Apps Script, so map them
  // to getRealtorPortalView and strip everything except the realtor identity, so
  // the client landing page never receives the realtor's leads even pre-Supabase.
  const isPublicOnly = (action === 'getRealtorPublic' || action === 'getRealtorBySlug');
  const proxied = await proxyToAppsScript(isPublicOnly ? 'getRealtorPortalView' : action, payload, origin);
  if (proxied instanceof Response) return proxied; // an error Response

  let body = proxied.__body;
  if (isPublicOnly && body && body.realtor) {
    body = { ok: true, realtor: realtorPublic(body.realtor) };
  }
  return jsonResponse(body, 200, origin);
}
