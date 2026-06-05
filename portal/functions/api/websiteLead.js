// portal/functions/api/websiteLead.js
/**
 * /api/websiteLead — public website "Get a Quote" form -> SmartMoving Lead API.
 *
 * Why this exists:
 *   The website quote form used to be SmartMoving's iframe embed, which can't
 *   redirect to a thank-you page (so Google Ads can't track conversions). This
 *   function lets us run our OWN form on the site: the browser posts here, we
 *   forward the lead to SmartMoving server-side, and the form then redirects to
 *   the thank-you page. Posting server-side also means no CORS headaches and the
 *   provider key never appears in page source.
 *
 *   NOTE: This is separate from the realtor-portal referral pipeline
 *   (submitReferralLead -> Supabase). Website quote leads belong in SmartMoving
 *   so the office works them like any other lead — exactly like the old iframe.
 *
 * ENV VARS (Cloudflare Pages -> Settings -> Environment variables):
 *   SMARTMOVING_PROVIDER_KEY  (optional) — overrides the built-in key. From
 *       SmartMoving: Settings -> Sales -> Lead Providers -> Your Website ->
 *       View Instructions. This is the LEAD provider key (NOT the Open API key).
 *   SM_LEAD_BRANCH_ID         (optional) — only set this to force a specific
 *       branch; if unset, the "Your Website" provider routes to your primary
 *       branch (Main Office) automatically.
 *
 * Returns: { ok: true } on success (incl. duplicates), { ok: false, error } otherwise.
 */

const ALLOWED_ORIGINS = [
  'https://neongiantmoving.com',
  'https://www.neongiantmoving.com',
  'https://refer.neongiantmoving.com',
];

function corsHeaders(origin) {
  let allow = ALLOWED_ORIGINS[0];
  if (origin) {
    if (ALLOWED_ORIGINS.includes(origin)) {
      allow = origin;
    } else {
      try { if (new URL(origin).hostname.endsWith('.pages.dev')) allow = origin; } catch (e) { /* ignore */ }
    }
  }
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Access-Control-Max-Age': '86400',
    'Vary': 'Origin',
  };
}

function json(body, status, origin) {
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
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin') || '';

  // SmartMoving "Your Website" lead provider key. Prefer the Cloudflare env var
  // if it's set; otherwise fall back to the known key. This key is low-sensitivity
  // (write-only: it can submit leads to this account and nothing else) and the repo
  // is private, so embedding the fallback is an acceptable tradeoff to keep the
  // form working without a dashboard env-var step. To rotate: regenerate it in
  // SmartMoving (Settings -> Sales -> Lead Providers -> Your Website) and/or set
  // SMARTMOVING_PROVIDER_KEY in Cloudflare, which overrides this.
  const providerKey = env.SMARTMOVING_PROVIDER_KEY || 'd18a311b-7df6-4483-90a7-b3d201630cea';

  let b = {};
  try { b = await request.json(); } catch (e) { b = {}; }

  // Honeypot: silently accept (so bots think it worked) but submit nothing.
  if (b.company) return json({ ok: true, skipped: 'bot' }, 200, origin);

  const firstName = String(b.firstName || '').trim();
  const lastName  = String(b.lastName || '').trim();
  const phone     = String(b.phone || b.phoneNumber || '').trim();
  const email     = String(b.email || '').trim();

  if (!firstName || !lastName || (!phone && !email)) {
    return json({ ok: false, error: 'First name, last name, and a phone or email are required.' }, 400, origin);
  }

  // The "Your Website" provider key already routes to the primary branch.
  // Only append a branch if SM_LEAD_BRANCH_ID is explicitly set.
  let url = 'https://api.smartmoving.com/api/leads/from-provider/v2'
          + '?providerKey=' + encodeURIComponent(providerKey);
  if (env.SM_LEAD_BRANCH_ID) {
    url += '&branchId=' + encodeURIComponent(env.SM_LEAD_BRANCH_ID);
  }

  const payload = {
    firstName: firstName,
    lastName: lastName,
    phoneNumber: phone,
    email: email,
    userOptIn: (b.userOptIn === 'true' || b.userOptIn === true) ? 'true' : 'false',
    serviceType: String(b.serviceType || '').trim(),
    moveSize: String(b.moveSize || '').trim(),
    moveDate: String(b.moveDate || '').replace(/-/g, ''), // YYYY-MM-DD -> YYYYMMDD
    originZip: String(b.originZip || '').trim(),
    destinationZip: String(b.destinationZip || '').trim(),
    notes: String(b.notes || '').trim(),
    referralSource: String(b.referralSource || 'Website').trim(),
    utmSource: String(b.utmSource || '').trim(),
    utmMedium: String(b.utmMedium || '').trim(),
    utmCampaign: String(b.utmCampaign || '').trim(),
    utmContent: String(b.utmContent || '').trim(),
    utmKeyword: String(b.utmKeyword || '').trim(),
    utmAdGroup: String(b.utmAdGroup || '').trim(),
    gclid: String(b.gclid || '').trim(),
  };

  let smRes, smText;
  try {
    smRes = await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    smText = await smRes.text();
  } catch (err) {
    return json({ ok: false, error: 'Could not reach SmartMoving: ' + (err && err.message) }, 502, origin);
  }

  if (smRes.ok) return json({ ok: true }, 200, origin);

  // SmartMoving rejects repeats with HTTP 400 "already been submitted" — that's
  // still a real lead, so treat it as success and let the visitor reach thank-you.
  if (smRes.status === 400 && /already/i.test(smText || '')) {
    return json({ ok: true, duplicate: true }, 200, origin);
  }

  return json({ ok: false, status: smRes.status, error: (smText || '').slice(0, 300) }, 502, origin);
}
