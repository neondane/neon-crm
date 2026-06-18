/** POST /api/sendMms — send a picture text (MMS) via Twilio.
 *
 *  Flow: the CRM sends us the photo as a base64 data URL. We upload it to a PUBLIC
 *  Supabase Storage bucket ("mms"), get a public https URL, then hand that URL to
 *  Twilio as MediaUrl (Twilio fetches the image itself — it cannot read base64).
 *  Storage keys stay server-side; the browser never touches them.
 *
 *  Body: { to, body?, contactId?, kind?, imageBase64 }   imageBase64 = "data:image/jpeg;base64,...."
 *        { probe:true } -> tests bucket + a 1px upload only (no text sent), returns the public URL.
 *  Env:  TWILIO_SID, TWILIO_TOKEN, TWILIO_FROM, SUPABASE_URL, SUPABASE_KEY
 *  Returns: { ok, sid, status, mediaUrl }
 */
import { endpoint, preflight, sb, toE164 } from '../_shared.js';

var BUCKET = 'mms';

function dataUrlToBytes(dataUrl) {
  var m = /^data:([^;]+);base64,(.*)$/.exec(String(dataUrl || ''));
  if (!m) return null;
  var mime = m[1];
  var bin = atob(m[2]);
  var len = bin.length;
  var bytes = new Uint8Array(len);
  for (var i = 0; i < len; i++) bytes[i] = bin.charCodeAt(i);
  return { mime: mime, bytes: bytes };
}

async function ensureBucket(base, key) {
  // idempotent: create a public bucket; "already exists" is fine. Needs a service key.
  var r = await fetch(base + '/storage/v1/bucket', {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json' },
    body: JSON.stringify({ id: BUCKET, name: BUCKET, public: true }),
  });
  return r.status;
}

async function uploadImage(base, key, img) {
  var ext = (String(img.mime).split('/')[1] || 'jpg').replace('jpeg', 'jpg').replace('+xml', '').slice(0, 5);
  var path = 'out/' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.' + ext;
  var r = await fetch(base + '/storage/v1/object/' + BUCKET + '/' + path, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': img.mime, 'x-upsert': 'true' },
    body: img.bytes,
  });
  if (!r.ok) {
    var t = await r.text();
    return { ok: false, status: r.status, message: t.slice(0, 240) };
  }
  return { ok: true, url: base + '/storage/v1/object/public/' + BUCKET + '/' + path };
}

async function logSms(env, row) {
  try { await sb(env).insert('sms_messages', row, { returning: 'minimal' }); } catch (_) {}
}

var handler = endpoint(async function (ctx) {
  var env = ctx.env, body = ctx.body, reply = ctx.reply;
  var base = (env.SUPABASE_URL || '').replace(/\/$/, '');
  var key = env.SUPABASE_KEY;
  if (!base || !key) return reply({ ok: false, error: 'supabase_not_configured' }, 503);

  // PROBE: verify storage works (bucket + tiny upload) without sending anything.
  if (body.probe) {
    var bs = await ensureBucket(base, key);
    var px = dataUrlToBytes('data:image/gif;base64,R0lGODlhAQABAIAAAAAAAP///yH5BAEAAAAALAAAAAABAAEAAAIBRAA7');
    var pu = await uploadImage(base, key, px);
    return reply({ ok: pu.ok, bucketStatus: bs, upload: pu });
  }

  if (!env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM)
    return reply({ ok: false, error: 'twilio_not_configured' }, 503);

  var to = toE164(body.to);
  if (!to) return reply({ ok: false, error: 'missing_or_invalid_to' }, 400);
  var img = dataUrlToBytes(body.imageBase64 || body.image || '');
  if (!img) return reply({ ok: false, error: 'missing_or_bad_image' }, 400);
  var text = String(body.body || '').trim();
  var kind = String(body.kind || 'manual').slice(0, 40);
  var contactId = body.contactId != null ? body.contactId : null;

  await ensureBucket(base, key);
  var up = await uploadImage(base, key, img);
  if (!up.ok) return reply({ ok: false, error: 'storage_upload_failed', status: up.status, message: up.message }, 502);

  var form = new URLSearchParams({ To: to, From: env.TWILIO_FROM, MediaUrl: up.url });
  if (text) form.set('Body', text.slice(0, 1500));
  var auth = btoa(env.TWILIO_SID + ':' + env.TWILIO_TOKEN);
  var res, j;
  try {
    res = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + env.TWILIO_SID + '/Messages.json', {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
    j = await res.json();
  } catch (e) {
    await logSms(env, { direction: 'out', to_number: to, from_number: env.TWILIO_FROM, body: text || '[photo]', kind: kind, contact_id: contactId, status: 'network_error', error_message: e.message });
    return reply({ ok: false, error: 'twilio_network_error', message: e.message }, 502);
  }
  if (!res.ok) {
    await logSms(env, { direction: 'out', to_number: to, from_number: env.TWILIO_FROM, body: text || '[photo]', kind: kind, contact_id: contactId, status: 'failed', error_code: j.code, error_message: j.message });
    return reply({ ok: false, error: 'twilio_rejected', code: j.code, message: j.message }, 502);
  }
  return reply({ ok: true, sid: j.sid, status: j.status, mediaUrl: up.url });
});

export var onRequestPost = handler;
export var onRequestGet = handler;
export var onRequestOptions = function (ctx) { return preflight(ctx.request); };
