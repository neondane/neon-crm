/**
 * /api/smsInbound.js — Twilio INBOUND SMS webhook for Neon Giant.
 *
 * Twilio POSTs application/x-www-form-urlencoded to this URL whenever a text
 * arrives at the business number (+13605885228). We:
 *   1. Match the sender (From) to a Supabase `contacts` row by last-10 digits.
 *   2. Insert a direction:'in' row into `sms_messages` so it shows in the
 *      contact's conversation thread (shared across Dane + Valentina).
 *   3. Detect STOP / START language and tag the message (opt-out compliance).
 *   4. Return empty TwiML so Twilio does NOT auto-reply.
 *
 * Set this URL as the inbound webhook in Twilio:
 *   Messaging Service → Integration → "Send a webhook":
 *     https://refer.neongiantmoving.com/api/smsInbound   (HTTP POST)
 *   (or the +13605885228 number's "A message comes in" webhook).
 *
 * Supabase creds: prefers Cloudflare env (SUPABASE_URL / SUPABASE_KEY); if those
 * aren't set it falls back to the same publishable key the CRM browser uses,
 * which already has insert rights on sms_messages. So inbound works out of the box.
 *
 * Optional hardening: set env TWILIO_VALIDATE='1' to enforce Twilio's
 * X-Twilio-Signature (HMAC-SHA1 over URL + sorted params, keyed by TWILIO_TOKEN).
 * Left OFF by default so a URL/proxy mismatch can't silently drop real texts.
 */

const SB_URL_DEFAULT = 'https://aoyfieswynhgqyrveqnp.supabase.co';
const SB_KEY_DEFAULT  = 'sb_publishable_I9S3tXRLe-AdUMdpod08Yg_E87kiArZ';

const STOP_WORDS  = ['STOP', 'STOPALL', 'UNSUBSCRIBE', 'CANCEL', 'END', 'QUIT', 'REVOKE', 'OPTOUT'];
const START_WORDS = ['START', 'YES', 'UNSTOP', 'OPTIN'];

function twiml(message) {
  const xml = message
    ? '<?xml version="1.0" encoding="UTF-8"?><Response><Message>' + message + '</Message></Response>'
    : '<?xml version="1.0" encoding="UTF-8"?><Response></Response>';
  return new Response(xml, { status: 200, headers: { 'Content-Type': 'text/xml; charset=utf-8' } });
}

function last10(raw) {
  const d = String(raw || '').replace(/\D/g, '');
  return d.length >= 10 ? d.slice(-10) : d;
}

function sbHeaders(env, extra) {
  const key = env.SUPABASE_KEY || SB_KEY_DEFAULT;
  return Object.assign({
    'apikey': key,
    'Authorization': 'Bearer ' + key,
    'Content-Type': 'application/json',
  }, extra || {});
}
function sbBase(env) { return env.SUPABASE_URL || SB_URL_DEFAULT; }

// Twilio request signature check (optional). Concatenate the full URL with each
// POST param's key+value in alphabetical key order, HMAC-SHA1 with the auth token,
// base64-encode, compare to X-Twilio-Signature.
async function validTwilioSignature(env, url, params, signature) {
  if (!env.TWILIO_TOKEN || !signature) return false;
  let data = url;
  Object.keys(params).sort().forEach(function (k) { data += k + params[k]; });
  const enc = new TextEncoder();
  const cryptoKey = await crypto.subtle.importKey(
    'raw', enc.encode(env.TWILIO_TOKEN), { name: 'HMAC', hash: 'SHA-1' }, false, ['sign']
  );
  const sig = await crypto.subtle.sign('HMAC', cryptoKey, enc.encode(data));
  const b64 = btoa(String.fromCharCode.apply(null, new Uint8Array(sig)));
  return b64 === signature;
}

export async function onRequestGet() {
  return new Response('smsInbound: ready (Twilio POSTs here)', {
    status: 200, headers: { 'Content-Type': 'text/plain' },
  });
}

export async function onRequestPost({ request, env }) {
  // 1. Parse Twilio's form-encoded body
  let params = {};
  try {
    const usp = new URLSearchParams(await request.text());
    for (const pair of usp.entries()) params[pair[0]] = pair[1];
  } catch (_e) {
    return twiml();
  }

  const from = params.From || '';
  const to = params.To || '';
  const bodyText = (params.Body || '').toString();
  const sid = params.MessageSid || params.SmsSid || null;

  // Looks-like-Twilio guard (don't write junk rows from random POSTs)
  if (!from || !sid) return twiml();

  // 2. Optional signature enforcement
  if (env.TWILIO_VALIDATE === '1' || env.TWILIO_VALIDATE === 'true') {
    const sigHeader = request.headers.get('X-Twilio-Signature');
    const ok = await validTwilioSignature(env, request.url, params, sigHeader).catch(function () { return false; });
    if (!ok) return new Response('invalid signature', { status: 403 });
  }

  // 3. Match sender → contact by last-10 digits
  let contactId = null;
  try {
    const r = await fetch(sbBase(env) + '/rest/v1/contacts?select=id,name,phone&phone=not.is.null', {
      headers: sbHeaders(env),
    });
    if (r.ok) {
      const fromN = last10(from);
      const rows = await r.json();
      const hit = rows.find(function (c) { return last10(c.phone) === fromN; });
      if (hit) contactId = hit.id;
    }
  } catch (_e) { /* unmatched is OK — we still log with contact_id null */ }

  // 4. Opt-out / opt-in keyword detection
  const norm = bodyText.trim().toUpperCase().replace(/[^A-Z]/g, '');
  let kind = 'inbound';
  if (STOP_WORDS.indexOf(norm) >= 0) kind = 'opt_out';
  else if (START_WORDS.indexOf(norm) >= 0) kind = 'opt_in';

  // 5. Log the inbound message (shared thread)
  try {
    await fetch(sbBase(env) + '/rest/v1/sms_messages', {
      method: 'POST',
      headers: sbHeaders(env, { 'Prefer': 'return=minimal' }),
      body: JSON.stringify({
        contact_id: contactId,
        direction: 'in',
        from_number: from,
        to_number: to,
        body: bodyText,
        status: 'received',
        kind: kind,
        twilio_sid: sid,
        received_at: new Date().toISOString(),
      }),
    });
  } catch (_e) { /* non-fatal */ }

  // 6. Best-effort opt-out flag on the contact (harmless if column doesn't exist)
  if (contactId && (kind === 'opt_out' || kind === 'opt_in')) {
    try {
      await fetch(sbBase(env) + '/rest/v1/contacts?id=eq.' + contactId, {
        method: 'PATCH',
        headers: sbHeaders(env, { 'Prefer': 'return=minimal' }),
        body: JSON.stringify({ sms_opt_out: kind === 'opt_out' }),
      });
    } catch (_e) { /* column may not exist yet; non-fatal */ }
  }

  // Empty TwiML — no auto-reply. (Twilio still honors STOP/START at the carrier.)
  return twiml();
}
