// portal/functions/api/metaLead.js
/**
 * /api/metaLead — Meta (Facebook/Instagram) Instant Form leads -> SmartMoving.
 *
 * WHY THIS EXISTS: Instant Form leads land in Meta's Leads Center by default,
 * where nobody checks them and they go cold. This receives Meta's leadgen
 * webhook the moment someone submits, pulls the answers, and pushes the lead
 * straight into SmartMoving so it shows up in the pipeline like any other lead.
 *
 * Instant Forms do NOT depend on the website pixel, which is why this path works
 * even while the browser-side pixel is blocked by the cookie-consent gate.
 *
 * ---------------------------------------------------------------------------
 * SETUP (Meta side, one time)
 *   1. developers.facebook.com -> your app -> Webhooks -> Page
 *   2. Callback URL:  https://refer.neongiantmoving.com/api/metaLead
 *      Verify Token:  whatever you set as META_WEBHOOK_VERIFY_TOKEN below
 *   3. Subscribe the Neon Giant Page to the "leadgen" field
 *   4. Generate a Page access token with the leads_retrieval permission
 *
 * ENV VARS (Cloudflare Pages -> neon-portal -> Settings -> Environment variables)
 *   META_PAGE_TOKEN            (required) — Page access token w/ leads_retrieval.
 *   META_WEBHOOK_VERIFY_TOKEN  (required) — any random string; must match what
 *                              you type into Meta's webhook setup screen.
 *   META_APP_SECRET            (optional) — if set, request signatures are
 *                              verified (recommended; rejects spoofed posts).
 *   SMARTMOVING_PROVIDER_KEY   (optional) — same key websiteLead.js uses.
 *   SM_LEAD_BRANCH_ID          (optional) — force a branch.
 *   NG_SMS_NOTIFY_TO           (optional) — phone number to text on new lead.
 *
 * NOTE: we deliberately reuse the SAME SmartMoving provider key as the website
 * form. The ReferralSource field is what separates the channels, so Facebook
 * leads show up as "Facebook: <form name>" next to "Google: <campaign>" etc.
 */

const SM_ENDPOINT = 'https://api.smartmoving.com/api/leads/from-provider/v2';
const GRAPH = 'https://graph.facebook.com/v21.0/';

// ---------------------------------------------------------------------------
// Webhook handshake. Meta calls this once with GET when you save the callback
// URL, and expects the challenge echoed back verbatim.
// ---------------------------------------------------------------------------
export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const mode = url.searchParams.get('hub.mode');
  const token = url.searchParams.get('hub.verify_token');
  const challenge = url.searchParams.get('hub.challenge');

  if (mode === 'subscribe' && token && token === env.META_WEBHOOK_VERIFY_TOKEN) {
    return new Response(challenge || '', { status: 200 });
  }
  return new Response('Forbidden', { status: 403 });
}

// ---------------------------------------------------------------------------
// The actual lead. Meta posts a small envelope; the answers must be fetched
// separately using the leadgen_id. We always return 200 quickly so Meta does
// not retry-storm us, and do the real work in waitUntil().
// ---------------------------------------------------------------------------
export async function onRequestPost(context) {
  const { request, env } = context;

  let raw = '';
  try { raw = await request.text(); } catch (e) { raw = ''; }

  // Optional signature check — proves the post really came from Meta.
  if (env.META_APP_SECRET) {
    const sig = request.headers.get('X-Hub-Signature-256') || '';
    const ok = await verifySignature(raw, sig, env.META_APP_SECRET);
    if (!ok) return new Response('Bad signature', { status: 403 });
  }

  let body = {};
  try { body = JSON.parse(raw || '{}'); } catch (e) { body = {}; }

  const jobs = [];
  const entries = (body && body.entry) || [];
  for (const entry of entries) {
    const changes = entry.changes || [];
    for (const ch of changes) {
      if (ch.field !== 'leadgen') continue;
      const v = ch.value || {};
      if (v.leadgen_id) jobs.push(v);
    }
  }

  if (jobs.length) {
    try {
      context.waitUntil(Promise.all(jobs.map((j) => handleLead(env, j))));
    } catch (e) { /* never block the ack */ }
  }

  return new Response('EVENT_RECEIVED', { status: 200 });
}

// ---------------------------------------------------------------------------
async function handleLead(env, v) {
  try {
    const token = env.META_PAGE_TOKEN;
    if (!token) return;

    // 1. Pull the submitted answers.
    const leadRes = await fetch(
      GRAPH + encodeURIComponent(v.leadgen_id) + '?access_token=' + encodeURIComponent(token)
    );
    const lead = await leadRes.json();
    if (!lead || !lead.field_data) return;

    const answers = {};
    for (const f of lead.field_data) {
      const key = String(f.name || '').toLowerCase();
      const val = (f.values && f.values[0]) || '';
      answers[key] = String(val || '').trim();
    }

    // 2. Work out a readable form name for the source label.
    let formName = '';
    try {
      if (v.form_id) {
        const fRes = await fetch(
          GRAPH + encodeURIComponent(v.form_id) + '?fields=name&access_token=' + encodeURIComponent(token)
        );
        const fJson = await fRes.json();
        formName = String((fJson && fJson.name) || '').trim();
      }
    } catch (e) { /* fall back below */ }

    // 3. Map Meta's field names onto SmartMoving's.
    const first = pick(answers, ['first_name', 'firstname']);
    const last = pick(answers, ['last_name', 'lastname']);
    const full = pick(answers, ['full_name', 'fullname', 'name']);
    let firstName = first;
    let lastName = last;
    if (!firstName && full) {
      const parts = full.split(/\s+/);
      firstName = parts.shift() || '';
      lastName = parts.join(' ');
    }
    if (!lastName) lastName = '(Facebook lead)';

    const phone = pick(answers, ['phone_number', 'phone', 'telephone']);
    const email = pick(answers, ['email', 'email_address']);
    const from = pick(answers, ['moving_from', 'origin', 'from_zip', 'street_address', 'city']);
    const to = pick(answers, ['moving_to', 'destination', 'to_zip']);
    const when = pick(answers, ['move_date', 'when_are_you_moving', 'date']);

    // Anything we did not explicitly map still gets carried across in the notes
    // so the office never loses an answer.
    const mapped = ['first_name','firstname','last_name','lastname','full_name','fullname','name',
      'phone_number','phone','telephone','email','email_address','moving_from','origin','from_zip',
      'street_address','city','moving_to','destination','to_zip','move_date','when_are_you_moving','date'];
    const extras = Object.keys(answers)
      .filter((k) => mapped.indexOf(k) === -1 && answers[k])
      .map((k) => k.replace(/_/g, ' ') + ': ' + answers[k]);

    const noteLines = ['Meta Instant Form lead.'];
    if (formName) noteLines.push('Form: ' + formName);
    if (when) noteLines.push('Requested move date: ' + when);
    if (v.ad_id) noteLines.push('Meta ad id: ' + v.ad_id);
    if (extras.length) noteLines.push(extras.join(' | '));

    const payload = {
      firstName: firstName || 'Facebook',
      lastName: lastName,
      phoneNumber: phone,
      email: email,
      userOptIn: 'true', // they submitted a Meta lead form
      moveDate: normalizeDate(when),
      notes: noteLines.join(' \n'),
      referralSource: 'Facebook: ' + (formName || 'Instant Form'),
      utmSource: 'facebook',
      utmMedium: 'paid_social',
      utmCampaign: formName || 'instant_form',
    };
    if (from) payload.originAddressFull = from;
    if (to) payload.destinationAddressFull = to;

    // 4. Push into SmartMoving.
    const providerKey = env.SMARTMOVING_PROVIDER_KEY || 'd18a311b-7df6-4483-90a7-b3d201630cea';
    let url = SM_ENDPOINT + '?providerKey=' + encodeURIComponent(providerKey);
    if (env.SM_LEAD_BRANCH_ID) url += '&branchId=' + encodeURIComponent(env.SM_LEAD_BRANCH_ID);

    await fetch(url, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });

    // 5. Speed-to-lead. A Meta form lead is an impulse: the first company to
    // respond usually books the job. Text the office immediately so nobody has
    // to be watching Leads Center.
    try { await notifyOffice(env, payload, formName); } catch (e) { /* non-critical */ }
  } catch (e) {
    // Swallow — a webhook that throws gets retried by Meta and can duplicate leads.
  }
}

function pick(obj, keys) {
  for (const k of keys) { if (obj[k]) return obj[k]; }
  return '';
}

// Meta returns dates in a few shapes; SmartMoving wants YYYYMMDD.
function normalizeDate(s) {
  const t = String(s || '').trim();
  if (!t) return '';
  let m = t.match(/^(\d{4})-(\d{2})-(\d{2})/);
  if (m) return m[1] + m[2] + m[3];
  m = t.match(/^(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  if (m) return m[3] + String(m[1]).padStart(2, '0') + String(m[2]).padStart(2, '0');
  return '';
}

async function notifyOffice(env, payload, formName) {
  const to = env.NG_SMS_NOTIFY_TO;
  if (!to) return;
  const who = (payload.firstName + ' ' + payload.lastName).trim();
  const msg = 'NEW FACEBOOK LEAD: ' + who + ' ' + (payload.phoneNumber || payload.email || '') +
              (formName ? ' (' + formName + ')' : '') + '. Call within 5 min.';
  await fetch('https://refer.neongiantmoving.com/api/sendMessage', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ to: to, body: msg, source: 'metaLead' }),
  });
}

// HMAC-SHA256 check of the raw body against Meta's signature header.
async function verifySignature(raw, header, secret) {
  try {
    const expected = String(header || '').replace(/^sha256=/, '');
    if (!expected) return false;
    const key = await crypto.subtle.importKey(
      'raw', new TextEncoder().encode(secret),
      { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']
    );
    const sigBuf = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(raw));
    const hex = Array.from(new Uint8Array(sigBuf))
      .map((x) => x.toString(16).padStart(2, '0')).join('');
    if (hex.length !== expected.length) return false;
    let diff = 0;
    for (let i = 0; i < hex.length; i++) diff |= hex.charCodeAt(i) ^ expected.charCodeAt(i);
    return diff === 0;
  } catch (e) {
    return false;
  }
}
