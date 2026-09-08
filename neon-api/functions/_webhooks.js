/** _webhooks.js — outbound event delivery to subscriber bots + owner SMS.
 *  dispatch(env,event,data) POSTs an HMAC-SHA256-signed JSON payload to every
 *  active webhook_endpoints row subscribed to that event (or '*'). Best-effort;
 *  never throws into the caller. Call it via ctx.waitUntil so it can't slow the
 *  response. notifyOwner(env,text) texts ALERT_PHONE via the existing Twilio.
 */
import { sb } from './_shared.js';

async function hmacHex(secret, body) {
  const k = await crypto.subtle.importKey('raw', new TextEncoder().encode(String(secret || '')),
    { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  const sig = await crypto.subtle.sign('HMAC', k, new TextEncoder().encode(body));
  return [...new Uint8Array(sig)].map((b) => b.toString(16).padStart(2, '0')).join('');
}

export async function dispatch(env, event, data) {
  let eps = [];
  try { eps = await sb(env).select(`webhook_endpoints?active=eq.true&select=id,url,secret,events`); }
  catch (_) { return; }
  const payload = JSON.stringify({ event, data, sentAt: new Date().toISOString() });
  const targets = (eps || []).filter((e) => Array.isArray(e.events) && (e.events.includes(event) || e.events.includes('*')));
  await Promise.all(targets.map(async (e) => {
    let status = 'error';
    try {
      const sig = await hmacHex(e.secret, payload);
      const r = await fetch(e.url, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Neon-Event': event, 'X-Neon-Signature': 'sha256=' + sig },
        body: payload,
      });
      status = 'http_' + r.status;
    } catch (err) { status = 'error:' + String(err && err.message).slice(0, 80); }
    try { await sb(env).update('webhook_endpoints', `id=eq.${e.id}`, { last_delivery_at: new Date().toISOString(), last_status: status }); } catch (_) {}
  }));
}

export async function notifyOwner(env, text) {
  if (!env.ALERT_PHONE || !env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM) return;
  const form = new URLSearchParams({ To: env.ALERT_PHONE, From: env.TWILIO_FROM, Body: String(text).slice(0, 1500) });
  const auth = btoa(`${env.TWILIO_SID}:${env.TWILIO_TOKEN}`);
  try {
    await fetch(`https://api.twilio.com/2010-04-01/Accounts/${env.TWILIO_SID}/Messages.json`, {
      method: 'POST',
      headers: { Authorization: 'Basic ' + auth, 'Content-Type': 'application/x-www-form-urlencoded' },
      body: form.toString(),
    });
  } catch (_) {}
}
