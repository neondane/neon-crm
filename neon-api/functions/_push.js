/** _push.js : the ONE delivery service for every Neon CRM alert.
 *  An event becomes one row in `notifications` (unique source_key, so it can only exist once).
 *  deliverEvent() then decides per person and per channel, and records each decision in
 *  `notification_deliveries` (unique per notification + person + channel, so a channel can
 *  only fire once even if two runs overlap):
 *    push    -> Web Push to every phone/browser the person turned alerts on for
 *    sms     -> a text from the business line to the person's own phone ("Text me")
 *    desktop -> not sent from here; the desktop CRM reads its feed (op feed) and chimes once
 *  Quiet hours (Pacific, per person) hold non-urgent push/sms; they are summed up in one
 *  "while you were off" alert when quiet hours end. push_live=false limits push+sms to
 *  app_settings.allow_emails (testing).
 */
import { sendWebPush } from './_webpush.js';
import { EVENT_BY_KEY, wants, isUrgent } from './_events.js';

export function db(env) {
  const base = String(env.SUPABASE_URL || '').replace(/\/$/, '');
  const h = { apikey: env.SUPABASE_KEY, Authorization: 'Bearer ' + env.SUPABASE_KEY, 'Content-Type': 'application/json' };
  const call = async (method, path, body, prefer) => {
    const r = await fetch(base + '/rest/v1/' + path, { method, headers: { ...h, ...(prefer ? { Prefer: prefer } : {}) }, body: body == null ? undefined : JSON.stringify(body), signal: AbortSignal.timeout(8000) });
    if (!r.ok) throw new Error('db_' + method + '_' + r.status + ': ' + (await r.text()).slice(0, 160));
    const t = await r.text(); return t ? JSON.parse(t) : null;
  };
  return {
    get: (p) => call('GET', p),
    post: (p, b, prefer) => call('POST', p, b, prefer || 'return=representation'),
    patch: (p, b) => call('PATCH', p, b, 'return=representation'),
    del: (p) => call('DELETE', p, null, 'return=minimal'),
  };
}

let CTX = null;
export function resetPushContext() { CTX = null; } // tests
export async function pushContext(env) {
  if (CTX && Date.now() - CTX.at < 60000) return CTX;
  const d = db(env);
  const [st, sec] = await Promise.all([d.get('app_settings?key=eq.crm_app&select=value'), d.get('app_secrets?key=eq.vapid_private_jwk&select=value')]);
  const settings = (st && st[0] && st[0].value) || {};
  CTX = { at: Date.now(), settings, jwk: sec && sec[0] ? JSON.parse(sec[0].value) : null, publicKey: settings.vapid_public || '' };
  return CTX;
}

export function pacificNow(now) {
  const p = Object.fromEntries(new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', minute: 'numeric', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit' }).formatToParts(now || new Date()).map((x) => [x.type, x.value]));
  return { hour: Number(p.hour) % 24, minute: Number(p.minute), date: p.year + '-' + p.month + '-' + p.day };
}
export const pacificHour = (now) => pacificNow(now).hour;
export function isQuiet(prefs, now) {
  const qs = prefs && prefs.quiet_start != null ? +prefs.quiet_start : 21;
  const qe = prefs && prefs.quiet_end != null ? +prefs.quiet_end : 7;
  if (qs === qe) return false;
  const h = pacificHour(now);
  return qs > qe ? (h >= qs || h < qe) : (h >= qs && h < qe);
}

/** Everyone who should be considered: anyone with saved settings or a signed-up device. */
export async function team(env) {
  const d = db(env);
  const [prefs, subs] = await Promise.all([
    d.get('notify_prefs?select=user_email,channels,phone,quiet_start,quiet_end,last_summary_at'),
    d.get('push_subscriptions?select=id,user_email,endpoint,p256dh,auth&order=id.asc'),
  ]);
  const people = {};
  (prefs || []).forEach((p) => { people[p.user_email.toLowerCase()] = { email: p.user_email.toLowerCase(), prefs: p, subs: [] }; });
  (subs || []).forEach((s) => { const e = s.user_email.toLowerCase(); (people[e] = people[e] || { email: e, prefs: { channels: {} }, subs: [] }).subs.push(s); });
  return Object.values(people);
}

async function sendSms(env, to, text) {
  const d10 = String(to || '').replace(/\D/g, '').slice(-10);
  if (d10.length !== 10 || !env.TWILIO_SID || !env.TWILIO_TOKEN || !env.TWILIO_FROM) return { ok: false, error: 'sms_not_configured' };
  try {
    const r = await fetch('https://api.twilio.com/2010-04-01/Accounts/' + env.TWILIO_SID + '/Messages.json', {
      method: 'POST', headers: { Authorization: 'Basic ' + btoa(env.TWILIO_SID + ':' + env.TWILIO_TOKEN), 'Content-Type': 'application/x-www-form-urlencoded' },
      body: new URLSearchParams({ To: '+1' + d10, From: env.TWILIO_FROM, Body: String(text).slice(0, 600) }).toString(), signal: AbortSignal.timeout(10000),
    });
    return r.ok ? { ok: true } : { ok: false, error: 'twilio_' + r.status };
  } catch (e) { return { ok: false, error: 'twilio_network' }; }
}

// Claim one (notification, person, channel). Returns true only for the first caller ever.
async function claim(d, nid, email, channel, status, detail) {
  const rows = await d.post('notification_deliveries?on_conflict=notification_id,user_email,channel', { notification_id: nid, user_email: email, channel, status, detail: detail || null }, 'resolution=ignore-duplicates,return=representation').catch(() => []);
  return !!(rows && rows.length);
}
const mark = (d, nid, email, channel, status, detail) => d.patch('notification_deliveries?notification_id=eq.' + nid + '&user_email=eq.' + encodeURIComponent(email) + '&channel=eq.' + channel, { status, detail: detail || null }).catch(() => {});

/** Delivers one notification row (needs id, event, title, body, url, tag?, target_email?). */
export async function deliverEvent(env, n, opts) {
  opts = opts || {};
  const ctx = await pushContext(env); const d = db(env);
  const out = { push: 0, sms: 0, held: 0, skipped: 0, failed: 0, removed: 0 };
  const ev = n.event || 'test';
  const urgent = ev === 'test' || isUrgent(ev) || n.urgent === true;
  const allow = (ctx.settings.allow_emails || []).map((e) => String(e).toLowerCase());
  const live = ctx.settings.push_live === true;
  let people = await team(env);
  const target = String(opts.onlyEmail || n.target_email || '').toLowerCase();
  if (target) people = people.filter((p) => p.email === target);
  const channels = opts.channels || ['push', 'sms'];
  const payload = { title: n.title, body: n.body || '', url: n.url || '/app/#alerts', tag: n.tag || (ev + ':' + n.id), category: ev, id: n.id };
  for (const p of people) {
    const allowed = ev === 'test' || live || allow.includes(p.email);
    const quiet = !urgent && isQuiet(p.prefs);
    for (const ch of channels) {
      if (!wants(p.prefs, ev, ch)) { out.skipped++; continue; }
      if (ch === 'sms' && !(p.prefs && p.prefs.phone)) { out.skipped++; continue; }
      if (ch === 'push' && !p.subs.length) { out.skipped++; continue; }
      if (!allowed) { out.skipped++; continue; }
      if (quiet) { if (await claim(d, n.id, p.email, ch, 'held')) out.held++; continue; }
      if (!(await claim(d, n.id, p.email, ch, 'sending'))) continue; // someone else already did it
      if (ch === 'push') {
        if (!ctx.jwk || !ctx.publicKey) { await mark(d, n.id, p.email, ch, 'failed', 'vapid_missing'); out.failed++; continue; }
        let okAny = false, last = '';
        for (const s of p.subs) {
          const r = await sendWebPush(s, payload, { jwk: ctx.jwk, publicKey: ctx.publicKey, urgency: (urgent || ev === 'text_in') ? 'high' : 'normal', ttl: ev === 'text_in' ? 43200 : 86400 });
          if (r.ok) { okAny = true; d.patch('push_subscriptions?id=eq.' + s.id, { last_ok_at: new Date().toISOString(), fail_count: 0 }).catch(() => {}); }
          else if (r.gone) { out.removed++; await d.del('push_subscriptions?id=eq.' + s.id).catch(() => {}); }
          else last = r.status + ' ' + (r.error || '');
        }
        await mark(d, n.id, p.email, ch, okAny ? 'sent' : 'failed', okAny ? null : last); okAny ? out.push++ : out.failed++;
      } else if (ch === 'sms') {
        const r = await sendSms(env, p.prefs.phone, 'Neon CRM: ' + n.title + (n.body ? '. ' + n.body : ''));
        await mark(d, n.id, p.email, ch, r.ok ? 'sent' : 'failed', r.ok ? null : r.error); r.ok ? out.sms++ : out.failed++;
      }
    }
  }
  return out;
}

/** Create an event once (by source_key) and deliver it right away. Returns the row or null if it already existed. */
export async function emitEvent(env, ev, opts) {
  const d = db(env);
  const meta = EVENT_BY_KEY[ev.event] || {};
  const row = { event: ev.event, category: meta.group || 'Other', title: ev.title, body: ev.body || null, url: ev.url || null, urgent: !!meta.urgent, target_email: ev.target_email || null, source_key: ev.source_key };
  const ins = await d.post('notifications?on_conflict=source_key', row, 'resolution=ignore-duplicates,return=representation').catch(() => []);
  if (!ins || !ins.length) return null;
  const n = ins[0];
  const claimed = await d.patch('notifications?id=eq.' + n.id + '&pushed_at=is.null', { pushed_at: new Date().toISOString() }).catch(() => []);
  if (claimed && claimed.length) {
    const r = await deliverEvent(env, { ...n, tag: ev.tag }, opts);
    await d.patch('notifications?id=eq.' + n.id, { push_result: JSON.stringify(r).slice(0, 300) }).catch(() => {});
  }
  return n;
}

/** When someone's quiet hours end, send ONE push summing up what waited. */
export async function quietSummaries(env, now) {
  const d = db(env); const pt = pacificNow(now); const ctx = await pushContext(env);
  const out = []; const people = await team(env);
  for (const p of people) {
    const qe = p.prefs && p.prefs.quiet_end != null ? +p.prefs.quiet_end : 7;
    const qs = p.prefs && p.prefs.quiet_start != null ? +p.prefs.quiet_start : 21;
    if (qs === qe || pt.hour !== qe || pt.minute > 30 || !p.subs.length) continue;
    const last = p.prefs.last_summary_at ? Date.parse(p.prefs.last_summary_at) : 0;
    if (Date.now() - last < 12 * 3600 * 1000) continue;
    const held = await d.get('notification_deliveries?select=notification_id,channel&user_email=eq.' + encodeURIComponent(p.email) + '&status=eq.held&created_at=gte.' + encodeURIComponent(new Date(Date.now() - 14 * 3600 * 1000).toISOString())).catch(() => []);
    await d.post('notify_prefs?on_conflict=user_email', { user_email: p.email, last_summary_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal').catch(() => {});
    const ids = [...new Set((held || []).filter((h) => h.channel === 'push').map((h) => h.notification_id))];
    if (!ids.length) continue;
    const ns = await d.get('notifications?select=id,event&id=in.(' + ids.join(',') + ')');
    const counts = {}; ns.forEach((n) => { counts[n.event] = (counts[n.event] || 0) + 1; });
    const words = { text_in: ['text', 'texts'], email_in: ['email', 'emails'], referral_new: ['referral', 'referrals'], lead_website: ['website lead', 'website leads'], lead_facebook: ['Facebook lead', 'Facebook leads'] };
    const parts = Object.entries(counts).map(([k, c]) => c + ' ' + ((words[k] || [EVENT_BY_KEY[k] ? EVENT_BY_KEY[k].label.toLowerCase() : k, EVENT_BY_KEY[k] ? EVENT_BY_KEY[k].label.toLowerCase() : k])[c === 1 ? 0 : 1]));
    const sum = await emitEvent(env, { event: 'test', title: 'While you were off', body: parts.join(', '), url: '/app/#alerts', target_email: p.email, source_key: 'summary:' + p.email + ':' + pt.date });
    await d.patch('notification_deliveries?user_email=eq.' + encodeURIComponent(p.email) + '&status=eq.held', { status: 'summarized' }).catch(() => {});
    out.push({ email: p.email, items: ids.length, sent: !!sum });
  }
  return out;
}
