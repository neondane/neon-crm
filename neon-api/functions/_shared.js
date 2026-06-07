/**
 * neon-api — shared foundation
 * ----------------------------
 * Every endpoint imports from here. ONE allow-list, ONE Supabase client, ONE
 * JSON/error shape, ONE request wrapper. No per-file drift — change it once here.
 *
 * Data store: Supabase is the single source of truth. (No Google Sheets.)
 * Secrets: read from env (set in Cloudflare project settings). Never hard-coded.
 */

// --- CORS -------------------------------------------------------------------
export const ALLOWED_ORIGINS = [
  'https://crm3.neongiantmoving.com',
  'https://crm.neongiantmoving.com',
  'https://refer.neongiantmoving.com',
  'https://portal.neongiantmoving.com',
];

export function corsHeaders(origin) {
  let allow = ALLOWED_ORIGINS[0];
  if (origin) {
    if (ALLOWED_ORIGINS.includes(origin)) allow = origin;
    else {
      try { if (new URL(origin).hostname.endsWith('.pages.dev')) allow = origin; } catch (_) {}
    }
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}

// --- responses --------------------------------------------------------------
export function json(data, { status = 200, origin = '' } = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

export function preflight(request) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
}

// --- request body -----------------------------------------------------------
export async function readBody(request) {
  // Accepts JSON body, or query params on GET, so the same handler works either way.
  if (request.method === 'GET') {
    const out = {};
    new URL(request.url).searchParams.forEach((v, k) => { out[k] = v; });
    if (out.payload) { try { Object.assign(out, JSON.parse(out.payload)); } catch (_) {} }
    return out;
  }
  try { return await request.json(); } catch (_) { return {}; }
}

// --- Supabase REST client ---------------------------------------------------
export function sb(env) {
  const base = (env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_KEY;
  const headers = { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' };
  if (!base || !key) throw new Error('supabase_not_configured');
  return {
    async select(pathAndQuery) {
      const r = await fetch(`${base}/rest/v1/${pathAndQuery}`, { headers });
      if (!r.ok) throw new Error(`supabase_select_${r.status}: ${(await r.text()).slice(0, 200)}`);
      return r.json();
    },
    async insert(table, row, { returning = 'representation' } = {}) {
      const r = await fetch(`${base}/rest/v1/${table}`, {
        method: 'POST',
        headers: { ...headers, Prefer: `return=${returning}` },
        body: JSON.stringify(row),
      });
      if (!r.ok) throw new Error(`supabase_insert_${r.status}: ${(await r.text()).slice(0, 200)}`);
      return returning === 'minimal' ? null : r.json();
    },
    async update(table, query, patch) {
      const r = await fetch(`${base}/rest/v1/${table}?${query}`, {
        method: 'PATCH',
        headers: { ...headers, Prefer: 'return=minimal' },
        body: JSON.stringify(patch),
      });
      if (!r.ok) throw new Error(`supabase_update_${r.status}: ${(await r.text()).slice(0, 200)}`);
      return true;
    },
  };
}

// --- handler wrapper --------------------------------------------------------
// Wraps a handler so every endpoint gets: OPTIONS preflight, uniform try/catch,
// CORS on every response, and a ready-to-use json(data, status) helper.
export function endpoint(fn) {
  return async (ctx) => {
    const origin = ctx.request.headers.get('Origin') || '';
    if (ctx.request.method === 'OPTIONS') return preflight(ctx.request);
    const reply = (data, status) => json(data, { status: status || 200, origin });
    try {
      const body = await readBody(ctx.request);
      return await fn({ ...ctx, body, origin, reply });
    } catch (err) {
      return reply({ ok: false, error: String((err && err.message) || err) }, 500);
    }
  };
}

// --- misc helpers -----------------------------------------------------------
export function toE164(raw) {
  if (!raw) return null;
  const d = String(raw).replace(/[^\d]/g, '');
  if (d.length === 11 && d[0] === '1') return '+' + d;
  if (d.length === 10) return '+1' + d;
  if (d.length > 10 && d.length <= 15) return '+' + d;
  return null;
}

export function firstJsonObject(s) {
  if (!s) return null;
  const a = s.indexOf('{'), b = s.lastIndexOf('}');
  if (a < 0 || b < a) return null;
  try { return JSON.parse(s.slice(a, b + 1)); } catch (_) { return null; }
}
