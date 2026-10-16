// build-stamp: 2026-10-15 (Supabase-backed portal API; Apps Script fallback REMOVED in Phase 2)
/**
 * /api/[[path]].js — Cloudflare Pages Function for the Neon Giant realtor portal.
 *
 * WHAT CHANGED (2026-06-01):
 *   The CRM now runs on Supabase (project aoyfieswynhgqyrveqnp), but the portal
 *   was still reading the old Google Sheets / Apps Script backend, so it could
 *   only see a partial, stale slice of realtors and none of the CRM headshots.
 *   This function now serves the portal's data actions straight from Supabase,
 *   so realtors + headshots always match the CRM. PHASE 2 (2026-10-15): actions it
 *   does not know now get 404. The old Apps Script proxy is gone (it leaked data).
 *
 * SAFE ROLLOUT:
 *   Supabase is only used when the SUPABASE_KEY environment variable is set in
 *   the Cloudflare Pages project (it is). Without it the portal answers nothing. Set SUPABASE_KEY to
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


const DEFAULT_SUPABASE_URL = 'https://aoyfieswynhgqyrveqnp.supabase.co';

// Actions this function answers directly from Supabase (when SUPABASE_KEY is set):
//   getRealtorPortalView              -> realtor dashboard reads full name + headshot + leads from Supabase
//   getRealtorPublic/getRealtorBySlug -> realtor name + headshot for the branded client page
//   submitReferralLead                -> the client's referral lands in Supabase portal_leads
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

// Only the partner's public-facing identity. Never phone/email/notes/leads.
function realtorPublic(c) {
  const name = String(c.name || '').trim();
  const photo = c.profilePic || c.cardImage || '';
  return {
    id: c.id,
    name: name,
    firstName: firstNameOf(name),
    business: c.business || '',
    profilePic: photo,
    photo: photo, // alias so older client code that reads r.photo also works
    kind: kindOf(c.type),
  };
}

// Any referral partner can have a portal: realtors, storage facilities, senior living,
// apartments, property managers and others. (Until Oct 2026 only type "Realtor" worked.)
function isPartner(c) {
  return !!(c && c.id != null && !/^(customer|vendor|crew|employee)$/i.test(String(c.type || '').trim()));
}
// Which wording the portal pages use for this partner.
function kindOf(type) {
  const t = String(type || '').toLowerCase();
  if (/realtor|broker|agent/.test(t)) return 'realtor';
  if (/storage/.test(t)) return 'storage';
  if (/assisted|senior|retire|care/.test(t)) return 'senior';
  if (/apartment/.test(t)) return 'apartment';
  if (/property/.test(t)) return 'property';
  return 'other';
}

/* --------- Realtor referral -> SmartMoving (same proven push the website uses) -------- */
// Mirrors websiteLead.js: POSTs to SmartMoving's from-provider Lead API with the
// "Your Website" provider key (env override, else the built-in key that the live
// website form already uses successfully). This is how portal referrals land in
// SmartMoving for the office to work — like they did before the Supabase migration.
// BEST-EFFORT: this never throws; if SmartMoving is unreachable the caller still
// saves the lead to Supabase, so a referral is never lost.
const SM_PROVIDER_KEY_FALLBACK = 'd18a311b-7df6-4483-90a7-b3d201630cea';

function splitName(full) {
  const parts = String(full || '').trim().split(/\s+/).filter(Boolean);
  if (parts.length <= 1) return { firstName: parts[0] || '', lastName: '' };
  return { firstName: parts[0], lastName: parts.slice(1).join(' ') };
}

// Builds the exact SmartMoving lead. Stored on the portal_leads row (sm_payload) so the
// retry job in neon-api (/api/retryReferrals) can resend the identical lead later.
function buildSmPayload(cust, realtor) {
  const nm = splitName(cust.name);
  const rName = String(realtor.name || '').trim();
  const noteLines = ['REALTOR REFERRAL: submitted via the Neon Giant referral portal.'];
  noteLines.push('Referred by (Realtor Affiliate): ' + (rName || 'Unknown'));
  if (realtor.business) noteLines.push('Brokerage: ' + realtor.business);
  if (realtor.email) noteLines.push('Realtor email: ' + realtor.email);
  if (cust.notes) noteLines.push('Customer notes: ' + cust.notes);
  const payload = {
    firstName: nm.firstName || String(cust.name || '').trim(),
    lastName: nm.lastName,
    phoneNumber: String(cust.phone || '').trim(),
    email: String(cust.email || '').trim(),
    // SmartMoving's accepted values are 'Moving' and 'JunkRemoval' (no space).
    serviceType: /junk/i.test(cust.moveSize || '') ? 'JunkRemoval' : 'Moving',
    moveSize: String(cust.moveSize || '').trim(),
    moveDate: String(cust.moveDate || '').replace(/-/g, ''), // YYYY-MM-DD -> YYYYMMDD
    notes: noteLines.join('\n'),
    // Without this SmartMoving labels every portal lead "Your Website".
    referralSource: rName ? ('Portal - ' + rName) : 'Realtor Portal',
  };
  const oFull = String(cust.fromAddress || '').trim();
  const dFull = String(cust.toAddress || '').trim();
  if (oFull) payload.originAddressFull = oFull;
  if (dFull) payload.destinationAddressFull = dFull;
  return payload;
}

// Sends one lead. Never throws. A timeout or any non-2xx is a FAILURE (never success).
async function sendToSmartMoving(env, payload) {
  if (payload && payload.__simulateFailure) return { ok: false, error: 'simulated_failure' }; // test hook (Dane Test only)
  const providerKey = (env && env.SMARTMOVING_PROVIDER_KEY) || SM_PROVIDER_KEY_FALLBACK;
  let url = 'https://api.smartmoving.com/api/leads/from-provider/v2?providerKey=' + encodeURIComponent(providerKey);
  if (env && env.SM_LEAD_BRANCH_ID) url += '&branchId=' + encodeURIComponent(env.SM_LEAD_BRANCH_ID);
  try {
    const r = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
      signal: AbortSignal.timeout(10000),
    });
    const txt = await r.text();
    if (r.ok) { let j = {}; try { j = JSON.parse(txt); } catch (_) {} return { ok: true, smJobId: String((j && (j.leadId || j.id)) || '') }; }
    if (r.status === 400 && /already/i.test(txt || '')) return { ok: true, duplicate: true, smJobId: '' };
    return { ok: false, error: 'smartmoving_' + r.status, body: (txt || '').slice(0, 200) };
  } catch (e) {
    const timedOut = e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    return { ok: false, error: timedOut ? 'smartmoving_timeout' : 'smartmoving_network_error', message: e && e.message };
  }
}

async function sbPatch(baseUrl, key, query, obj) {
  const r = await fetch(baseUrl + '/rest/v1/' + query, {
    method: 'PATCH',
    headers: { ...sbHeaders(key), Prefer: 'return=minimal' },
    body: JSON.stringify(obj),
  });
  if (!r.ok) throw new Error('Supabase PATCH ' + r.status + ': ' + (await r.text()).slice(0, 200));
}

const RETRY_URL = 'https://neon-api.pages.dev/api/retryReferrals';

async function handleSupabaseAction(action, payload, baseUrl, key, origin, env, bg) {
  /* ----- realtor dashboard: realtor + their leads + totals ----- */
  if (action === 'getRealtorPortalView') {
    const id = slugToId(payload.slug);
    if (!id) return jsonResponse({ ok: false, error: 'This link is missing the partner ID.' }, 200, origin);

    const rows = await sbGet(baseUrl, key,
      'contacts?id=eq.' + id +
      '&select=id,name,role,business,email,phone,type,profilePic,cardImage,portalActivatedAt');
    const c = rows[0];
    if (!isPartner(c)) {
      return jsonResponse({ ok: false, error: "This referral link isn't recognized." }, 200, origin);
    }

    let leads = [];
    try {
      leads = await sbGet(baseUrl, key,
        'portal_leads?realtorId=eq.' + id +
        '&select=id,customerName,moveSize,moveDate,status,submittedAt,rewardSent,customerDiscountApplied' +
        '&order=submittedAt.desc');
    } catch (e) { leads = []; }

    // Pending/Paid $ come ONLY from real portal_leads rewards — never from the
    // backfilled referral history merged in below (those stay $0, per spec).
    let earnedPaid = 0, earnedPending = 0;
    leads.forEach(function (l) {
      const st = String(l.status || '').toLowerCase();
      if (l.rewardSent) earnedPaid += 50;
      else if (st === 'completed' || st === 'booked') earnedPending += 50;
    });

    // Also surface the realtor's referral history (CRM `referrals` table) as
    // read-only pipeline entries: customer name + Completed/Referred status only.
    // No dollars, and this table does NOT feed the auto-payout cron.
    let refLeads = [];
    try {
      const refs = await sbGet(baseUrl, key,
        'referrals?contactId=eq.' + id +
        '&select=id,jobName,contactName,status,date&order=date.desc');
      refLeads = refs.map(function (r) {
        const st = String(r.status || '').toLowerCase();
        const display = (st === 'completed') ? 'completed'
                      : (st === 'booked') ? 'booked'
                      : (/^(lost|dead|cancel|declin|unqualif|not.?book|junk|no.?go)/.test(st)) ? 'lost'
                      : (/^(contact|attempt|quot|estimat)/.test(st)) ? 'contacted'
                      : 'new';
        return {
          id: 'ref-' + r.id,
          customerName: r.jobName || r.contactName || 'Referral',
          moveSize: '',
          moveDate: r.date || null,
          status: display,
          submittedAt: r.date || null,
          historical: true,
        };
      });
    } catch (e) { refLeads = []; }

    // De-duplicate by customer name (portal_leads + backfilled referral history can
    // double up the same person). Keep the richest record: a real portal_lead over a
    // historical referral, then the more-advanced status.
    const __rank = { completed: 4, booked: 3, contacted: 2, lost: 1, 'new': 0 };
    const __seen = {}; const __merged = [];
    leads.concat(refLeads).forEach(function (l) {
      const k = String(l.customerName || '').trim().toLowerCase();
      if (!k) { __merged.push(l); return; }
      if (!(k in __seen)) { __seen[k] = __merged.length; __merged.push(l); return; }
      const ex = __merged[__seen[k]];
      // Keep the portal record (it has move size etc.), but always show the most advanced status:
      // the SmartMoving copy is the one that says booked / completed. (Jen's Sandy Hirzel, Oct 2026.)
      const rl = __rank[String(l.status || '').toLowerCase()] || 0, re = __rank[String(ex.status || '').toLowerCase()] || 0;
      const keep = (!l.historical && ex.historical) ? l : (l.historical && !ex.historical) ? ex : (rl > re ? l : ex);
      __merged[__seen[k]] = Object.assign({}, keep, { status: rl > re ? l.status : ex.status });
    });
    const allLeads = __merged.sort(function (a, b) {
      return new Date(b.submittedAt || 0) - new Date(a.submittedAt || 0);
    });

    const realtor = Object.assign(realtorPublic(c), {
      email: c.email || '',
      phone: c.phone || '',
      activated: !!c.portalActivatedAt,
      activatedAt: c.portalActivatedAt || null,
    });

    // Real money: sum actual Tremendous payouts from the payouts ledger (source of truth).
    let paidCents = 0;
    try {
      const pays = await sbGet(baseUrl, key,
        'payouts?partner_id=eq.' + id + '&status=in.(sent,delivered,opened,redeemed)&select=amount_cents');
      (pays || []).forEach(function (p) { paidCents += (parseInt(p.amount_cents, 10) || 0); });
    } catch (e) { paidCents = 0; }
    const ledgerPaid = Math.round(paidCents / 100);
    let completedCount = 0;
    allLeads.forEach(function (l) { if (String(l.status || '').toLowerCase() === 'completed') completedCount++; });

    return jsonResponse({
      ok: true,
      realtor: realtor,
      totals: {
        total: allLeads.length,
        completed: completedCount,
        earnedPending: earnedPending,
        earnedPaid: (ledgerPaid > 0 ? ledgerPaid : earnedPaid),
      },
      leads: allLeads,
    }, 200, origin);
  }

  /* ----- client landing page: realtor identity ONLY (no leads) ----- */
  if (action === 'getRealtorPublic' || action === 'getRealtorBySlug') {
    const id = slugToId(payload.slug);
    if (!id) return jsonResponse({ ok: false, error: 'This link is missing the partner ID.' }, 200, origin);
    const rows = await sbGet(baseUrl, key, 'contacts?id=eq.' + id + '&select=id,name,business,type,profilePic,cardImage');
    const c = rows[0];
    if (!isPartner(c)) return jsonResponse({ ok: false, error: 'Partner not found.' }, 200, origin);
    return jsonResponse({ ok: true, realtor: realtorPublic(c) }, 200, origin);
  }

  /* ----- client submits a referral -> push to SmartMoving + insert into portal_leads ----- */
  if (action === 'submitReferralLead') {
    const realtorId = payload.realtorId;
    const cust = payload.customer || {};
    if (!realtorId) return jsonResponse({ ok: false, error: 'Missing realtorId.' }, 200, origin);
    if (!cust.name || !cust.phone) {
      return jsonResponse({ ok: false, error: 'Name and phone are required.' }, 200, origin);
    }

    // Look up the realtor so the lead carries their name/email/brokerage (best-effort).
    let realtorName = '', realtorEmail = '', realtorBusiness = '';
    try {
      const rows = await sbGet(baseUrl, key, 'contacts?id=eq.' + realtorId + '&select=name,email,business');
      if (rows[0]) { realtorName = rows[0].name || ''; realtorEmail = rows[0].email || ''; realtorBusiness = rows[0].business || ''; }
    } catch (e) { /* non-fatal */ }

    // RELIABILITY RULE: a referral that doesn't reach SmartMoving must never look like
    // success. Order: (1) save the lead + the exact SmartMoving payload, (2) send to
    // SmartMoving, (3) record the result. Reply ok:true ONLY if SmartMoving accepted it,
    // or if it is safely saved and queued for automatic retry (neon-api retryReferrals,
    // run every 10 minutes by the database scheduler, which also texts the owner).
    const smPayload = buildSmPayload(cust, { name: realtorName, email: realtorEmail, business: realtorBusiness });
    if (String(realtorId) === '231' && /^ZZ FAILTEST/i.test(String(cust.name || ''))) smPayload.__simulateFailure = true; // test hook: Dane Test only

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
      smJobId: '',
      sm_status: 'pending',
      sm_attempts: 0,
      sm_payload: smPayload,
    };

    let newId = null, saveError = null;
    try {
      const inserted = await sbInsert(baseUrl, key, 'portal_leads', row);
      newId = (inserted && inserted[0] && inserted[0].id) || null;
    } catch (e) { saveError = e.message; }

    const sm = await sendToSmartMoving(env, smPayload);
    const nowIso = new Date().toISOString();

    if (newId) {
      const patch = sm.ok
        ? { sm_status: sm.duplicate ? 'duplicate' : 'accepted', smJobId: sm.smJobId || '', sm_error: null, sm_attempts: 1, sm_last_attempt_at: nowIso }
        : { sm_status: 'retrying', sm_error: (sm.error || 'unknown') + (sm.body ? ': ' + sm.body : ''), sm_attempts: 1, sm_last_attempt_at: nowIso };
      try { await sbPatch(baseUrl, key, 'portal_leads?id=eq.' + newId, patch); } catch (_) { /* the retry job treats a stale 'pending' row as due */ }
    }
    // On failure, wake the retry job right away so the owner gets texted now, not in 10 min.
    if (!sm.ok && bg) bg(fetch(RETRY_URL, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: '{}' }).catch(() => {}));

    if (sm.ok) {
      return jsonResponse({ ok: true, id: newId, smartmoving: { ok: true, duplicate: !!sm.duplicate }, saved: !!newId }, 200, origin);
    }
    if (newId) {
      return jsonResponse({ ok: true, id: newId, queued: true,
        message: 'Got it! Your referral is saved and our team has been notified.' }, 200, origin);
    }
    // Neither SmartMoving nor our database has it: this is a real failure. Say so.
    return jsonResponse({ ok: false, error: 'not_saved',
      message: "Sorry, we couldn't save this referral. Please try again in a minute, or text us the details.",
      detail: { smartmoving: sm.error || null, database: saveError } }, 200, origin);
  }

  return null; // not a Supabase action
}

/* --------------------------------- Router ---------------------------------- */

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
}

export async function onRequest(context) {
  const { request, params, env } = context;
  const bg = (p) => { try { context.waitUntil(p); } catch (_) {} };
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
      const res = await handleSupabaseAction(action, payload, SUPABASE_URL, SUPABASE_KEY, origin, env, bg);
      if (res) return res;
    } catch (err) {
      return jsonResponse({ ok: false, error: 'Supabase error: ' + err.message }, 200, origin);
    }
  }

  // ---- Never route referrals to the old Apps Script path (it never reached SmartMoving) ----
  if (action === 'submitReferralLead') {
    return jsonResponse({ ok: false, error: 'not_saved', message: "Sorry, we couldn't save this referral. Please try again in a minute, or text us the details." }, 503, origin);
  }

  // ---- Nothing else is answered here (Phase 2) ----
  // This used to forward ANY other action to the old Google Apps Script, which handed out
  // the old CRM's data (getAll) and sent texts (smsOut) for anyone who asked. Closed.
  return jsonResponse({ ok: false, error: 'unknown_action' }, 404, origin);
}
