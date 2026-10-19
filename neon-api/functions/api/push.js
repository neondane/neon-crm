/** POST /api/push : alert settings + feeds for the phone app and the desktop CRM.
 *  Reached only through the CRM gateway (/api/secure/push on crm/crm3), which verifies the
 *  Cloudflare login and passes X-Neon-User. Body { op, ... }:
 *    config      -> { publicKey, events, prefs, myDevices, pushLive, onAllowlist }
 *    subscribe   {subscription, userAgent} / unsubscribe {endpoint}
 *    prefs       {channels:{eventKey:{push,desktop,sms}}, phone, quiet_start, quiet_end}
 *    test        {event?, channels?:['push','sms']} -> sends a test to this person only
 *    list        {limit} -> the in-app alert history (Activity)
 *    lead        {id} -> one website/Facebook lead for the app's lead page
 *    alias       {affiliate, contactId} -> remember who a SmartMoving referrer is, credit their open referrals
 *    feed        {afterId} -> new alerts for the DESKTOP CRM (filtered by the person's desktop switches)
 *    twilio_msg  {sid} -> read-only Twilio timestamps (delay diagnosis)
 */
import { endpoint, preflight } from '../_shared.js';
import { authKey } from '../_apikeys.js';
import { db, pushContext, emitEvent } from '../_push.js';
import { EVENTS, EVENT_BY_KEY, CHANNELS, wants } from '../_events.js';

const handler = endpoint(async ({ env, body, reply, request }) => {
  const keyCheck = await authKey(env, request, 'write');
  if (!keyCheck.ok) return reply({ ok: false, error: keyCheck.error }, keyCheck.status);
  const user = String(request.headers.get('X-Neon-User') || '').trim().toLowerCase();
  if (!user || user === 'unknown') return reply({ ok: false, error: 'no_user', message: 'Sign in to the CRM again.' }, 401);
  const d = db(env); const enc = encodeURIComponent;
  const op = String((body && body.op) || 'config');
  const myPrefs = async () => (await d.get('notify_prefs?user_email=eq.' + enc(user) + '&select=channels,phone,quiet_start,quiet_end'))[0] || { channels: {}, phone: null, quiet_start: 21, quiet_end: 7 };

  if (op === 'config') {
    const ctx = await pushContext(env);
    const [p, mine] = await Promise.all([myPrefs(), d.get('push_subscriptions?user_email=eq.' + enc(user) + '&select=endpoint,user_agent,last_ok_at,created_at')]);
    const allow = (ctx.settings.allow_emails || []).map((e) => String(e).toLowerCase());
    return reply({ ok: true, me: user, publicKey: ctx.publicKey, events: EVENTS, prefs: p, myDevices: mine, pushLive: ctx.settings.push_live === true, onAllowlist: allow.includes(user) });
  }

  if (op === 'subscribe') {
    const s = body.subscription || {}; const k = s.keys || {};
    if (!/^https:\/\//.test(String(s.endpoint || '')) || !k.p256dh || !k.auth) return reply({ ok: false, error: 'bad_subscription' }, 400);
    await d.post('push_subscriptions?on_conflict=endpoint', { user_email: user, endpoint: String(s.endpoint), p256dh: String(k.p256dh), auth: String(k.auth), user_agent: String(body.userAgent || '').slice(0, 200), fail_count: 0 }, 'resolution=merge-duplicates,return=minimal');
    return reply({ ok: true });
  }

  if (op === 'unsubscribe') {
    if (body.endpoint) await d.del('push_subscriptions?endpoint=eq.' + enc(String(body.endpoint)) + '&user_email=eq.' + enc(user));
    return reply({ ok: true });
  }

  if (op === 'prefs') {
    const cur = await myPrefs(); const ch = {}; const inC = body.channels || {};
    EVENTS.forEach((e) => { const v = inC[e.key] || (cur.channels || {})[e.key]; if (v && typeof v === 'object') { ch[e.key] = {}; CHANNELS.forEach((c) => { if (typeof v[c] === 'boolean') ch[e.key][c] = v[c]; }); } });
    const row = { user_email: user, channels: ch, updated_at: new Date().toISOString() };
    if (body.phone !== undefined) { const p10 = String(body.phone || '').replace(/\D/g, '').slice(-10); row.phone = p10.length === 10 ? p10 : null; }
    ['quiet_start', 'quiet_end'].forEach((k) => { if (body[k] !== undefined) { const v = parseInt(body[k], 10); if (!isNaN(v) && v >= 0 && v <= 23) row[k] = v; } });
    await d.post('notify_prefs?on_conflict=user_email', row, 'resolution=merge-duplicates,return=minimal');
    return reply({ ok: true });
  }

  if (op === 'test') {
    const ev = EVENT_BY_KEY[body.event] ? body.event : null;
    const label = ev ? EVENT_BY_KEY[ev].label : 'Neon CRM alerts';
    const p = await myPrefs();
    const chans = ev ? ['push', 'sms'].filter((c) => wants(p, ev, c)) : ['push'];
    if (!chans.length) return reply({ ok: false, message: 'Phone and Text me are both off for this alert, so there is nothing to test.' });
    const n = await emitEvent(env, { event: 'test', title: 'Test: ' + label, body: 'This is how this alert will look.', url: '/app/#alerts', target_email: user, source_key: 'test:' + user + ':' + Date.now() }, { channels: chans });
    const row = n ? (await d.get('notifications?id=eq.' + n.id + '&select=push_result'))[0] : null;
    let r = {}; try { r = JSON.parse((row && row.push_result) || '{}'); } catch (_) {}
    const sent = (r.push || 0) + (r.sms || 0);
    return reply({ ok: sent > 0, result: r, message: sent ? 'Sent' + (r.sms ? ' (phone alert and text)' : '') + '. It should arrive in a few seconds.' : 'Nothing sent. Turn on alerts on this phone, or add your cell number for texts.' });
  }

  if (op === 'list') {
    const lim = Math.min(+body.limit || 40, 150);
    const rows = await d.get('notifications?select=id,event,category,title,body,url,urgent,created_at,source_key&or=(target_email.is.null,target_email.eq.' + enc(user) + ')&order=id.desc&limit=' + lim);
    return reply({ ok: true, items: rows });
  }

  if (op === 'alias') {
    // Someone matched a SmartMoving referrer to a contact in the app. Remember it, and credit every
    // other unmatched referral with the same SmartMoving name.
    const aff = String(body.affiliate || '').trim(); const cid = parseInt(body.contactId, 10);
    const key = aff.toLowerCase().replace(/[^a-z0-9]/g, '');
    if (!key || !(cid > 0)) return reply({ ok: false, error: 'bad_input' }, 400);
    const c = (await d.get('contacts?id=eq.' + cid + '&select=id,name'))[0];
    if (!c) return reply({ ok: false, error: 'no_contact' }, 404);
    const cur = (await d.get('app_settings?key=eq.partner_aliases&select=value'))[0];
    const map = Object.assign({}, (cur && cur.value && cur.value.map) || {}); map[key] = cid;
    await d.post('app_settings?on_conflict=key', { key: 'partner_aliases', value: { map } }, 'resolution=merge-duplicates,return=minimal');
    const loose = await d.get('referrals?contactName=eq.' + enc(aff) + '&or=(contactId.is.null,contactId.eq."")&select=id,notes');
    for (const r of loose) await d.patch('referrals?id=eq.' + r.id, { contactId: String(cid), contactName: c.name, notes: (r.notes || '') + ' | matched to ' + c.name + ' by ' + user }).catch(() => {});
    return reply({ ok: true, linked: loose.length, contact: c.name });
  }

  if (op === 'lead') {
    // One website / Facebook lead, for the app's lead page (the alert links here).
    const id = parseInt(body.id, 10);
    if (!(id > 0)) return reply({ ok: false, error: 'bad_id' }, 400);
    const row = (await d.get('inbound_leads?id=eq.' + id + '&select=id,source,name,phone,email,details,created_at'))[0];
    return row ? reply({ ok: true, lead: row }) : reply({ ok: false, error: 'not_found', message: 'That lead is no longer here.' }, 404);
  }

  if (op === 'feed') {
    const after = parseInt(body.afterId, 10);
    if (isNaN(after)) { const top = await d.get('notifications?select=id&order=id.desc&limit=1'); return reply({ ok: true, lastId: top[0] ? top[0].id : 0, items: [] }); }
    const p = await myPrefs();
    const rows = await d.get('notifications?select=id,event,title,body,url,urgent,created_at,target_email&id=gt.' + after + '&created_at=gte.' + enc(new Date(Date.now() - 3600 * 1000).toISOString()) + '&order=id.asc&limit=25');
    const items = rows.filter((n) => (!n.target_email || n.target_email === user) && n.event && (n.event === 'test' || wants(p, n.event, 'desktop')));
    return reply({ ok: true, lastId: rows.length ? rows[rows.length - 1].id : after, items });
  }

  if (op === 'twilio_msg') {
    const sid = String(body.sid || '');
    if (!/^(SM|MM)[0-9a-f]{32}$/.test(sid) || !env.TWILIO_SID || !env.TWILIO_TOKEN) return reply({ ok: false, error: 'bad_sid_or_not_configured' }, 400);
    const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + env.TWILIO_SID + '/Messages/' + sid + '.json', { headers: { Authorization: 'Basic ' + btoa(env.TWILIO_SID + ':' + env.TWILIO_TOKEN) }, signal: AbortSignal.timeout(8000) });
    const j = await r.json().catch(() => ({}));
    return reply({ ok: r.ok, date_created: j.date_created, date_sent: j.date_sent, date_updated: j.date_updated, status: j.status, direction: j.direction, error_code: j.error_code });
  }

  return reply({ ok: false, error: 'unknown_op' }, 400);
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
