/** _push.js : who gets which alert, and delivery.
 *  Tables (CRM Supabase, public key has NO access): push_subscriptions, notify_prefs,
 *  notifications (the in-app alert list), app_secrets (VAPID private key),
 *  app_settings.crm_app { push_live, allow_emails, vapid_public }.
 *  Rules: push_live=false -> only allow_emails get pushes. Per-person category switches.
 *  Quiet hours (default 9 PM to 7 AM Pacific) hold non-urgent alerts; they still land in
 *  the in-app list. Dead subscriptions (404/410) are deleted.
 */
import { sendWebPush } from './_webpush.js';

export const CATEGORIES = ['messages', 'referrals', 'alerts', 'birthdays'];

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
export async function pushContext(env) {
  if (CTX && Date.now() - CTX.at < 60000) return CTX;
  const d = db(env);
  const [st, sec] = await Promise.all([
    d.get('app_settings?key=eq.crm_app&select=value'),
    d.get('app_secrets?key=eq.vapid_private_jwk&select=value'),
  ]);
  const settings = (st && st[0] && st[0].value) || {};
  const jwk = sec && sec[0] ? JSON.parse(sec[0].value) : null;
  CTX = { at: Date.now(), settings, jwk, publicKey: settings.vapid_public || '' };
  return CTX;
}

export function pacificHour(now) {
  const h = new Intl.DateTimeFormat('en-US', { timeZone: 'America/Los_Angeles', hour: 'numeric', hour12: false }).format(now || new Date());
  return Number(h) % 24;
}
export function isQuiet(prefs, now) {
  const qs = prefs && prefs.quiet_start != null ? +prefs.quiet_start : 21;
  const qe = prefs && prefs.quiet_end != null ? +prefs.quiet_end : 7;
  if (qs === qe) return false; // quiet hours off
  const h = pacificHour(now);
  return qs > qe ? (h >= qs || h < qe) : (h >= qs && h < qe);
}
export function catOn(prefs, cat) {
  if (cat === 'test') return true;
  const c = (prefs && prefs.categories) || {};
  return c[cat] !== false;
}

/** Delivers one notification row. onlyEmail limits to one person (test). Returns summary. */
export async function deliver(env, n, opts) {
  opts = opts || {};
  const ctx = await pushContext(env);
  const d = db(env);
  const out = { sent: 0, held: 0, skipped: 0, failed: 0, removed: 0 };
  if (!ctx.jwk || !ctx.publicKey) { out.error = 'vapid_missing'; return out; }
  let subs = await d.get('push_subscriptions?select=id,user_email,endpoint,p256dh,auth&order=id.asc');
  const target = (opts.onlyEmail || n.target_email || '').toLowerCase();
  if (target) subs = subs.filter((s) => s.user_email.toLowerCase() === target);
  const allow = (ctx.settings.allow_emails || []).map((e) => String(e).toLowerCase());
  const prefsRows = subs.length ? await d.get('notify_prefs?select=user_email,categories,quiet_start,quiet_end') : [];
  const prefs = {}; prefsRows.forEach((p) => { prefs[p.user_email.toLowerCase()] = p; });
  const payload = { title: n.title, body: n.body || '', url: n.url || '/app/#home', tag: n.tag || (n.category + ':' + (n.id || '')), category: n.category, id: n.id || null };
  for (const s of subs) {
    const email = s.user_email.toLowerCase(); const p = prefs[email];
    if (n.category !== 'test' && ctx.settings.push_live !== true && !allow.includes(email)) { out.skipped++; continue; }
    if (!catOn(p, n.category)) { out.skipped++; continue; }
    if (!n.urgent && n.category !== 'test' && isQuiet(p)) { out.held++; continue; }
    const r = await sendWebPush(s, payload, { jwk: ctx.jwk, publicKey: ctx.publicKey, urgency: n.urgent ? 'high' : 'normal', ttl: n.category === 'messages' ? 43200 : 86400 });
    if (r.ok) { out.sent++; d.patch('push_subscriptions?id=eq.' + s.id, { last_ok_at: new Date().toISOString(), fail_count: 0 }).catch(() => {}); }
    else if (r.gone) { out.removed++; await d.del('push_subscriptions?id=eq.' + s.id).catch(() => {}); }
    else { out.failed++; out.lastError = r.status + ' ' + (r.error || ''); }
  }
  return out;
}
