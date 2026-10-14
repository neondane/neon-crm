/** POST /api/push : the phone app's alert settings. Reached only through the CRM gateway
 *  (/api/secure/push on crm3), which verifies the Cloudflare login and passes X-Neon-User.
 *  Body { op, ... }:
 *    config                 -> { publicKey, prefs, myDevices, pushLive, onAllowlist }
 *    subscribe {subscription:{endpoint,keys:{p256dh,auth}}, userAgent}
 *    unsubscribe {endpoint}
 *    prefs {categories:{messages,referrals,alerts,birthdays}, quiet_start, quiet_end}
 *    test                   -> sends "Push alerts are working" to this person's phones now
 *    list {limit}           -> recent alerts for the in-app list (team-wide + mine)
 */
import { endpoint, preflight } from '../_shared.js';
import { authKey } from '../_apikeys.js';
import { db, pushContext, deliver, CATEGORIES } from '../_push.js';

const handler = endpoint(async ({ env, body, reply, request }) => {
  const keyCheck = await authKey(env, request, 'write');
  if (!keyCheck.ok) return reply({ ok: false, error: keyCheck.error }, keyCheck.status);
  const user = String(request.headers.get('X-Neon-User') || '').trim().toLowerCase();
  if (!user || user === 'unknown') return reply({ ok: false, error: 'no_user', message: 'Sign in to the CRM again.' }, 401);
  const d = db(env);
  const op = String((body && body.op) || 'config');

  if (op === 'config') {
    const ctx = await pushContext(env);
    const [p, mine] = await Promise.all([
      d.get('notify_prefs?user_email=eq.' + encodeURIComponent(user) + '&select=categories,quiet_start,quiet_end'),
      d.get('push_subscriptions?user_email=eq.' + encodeURIComponent(user) + '&select=endpoint,user_agent,last_ok_at,created_at'),
    ]);
    const allow = (ctx.settings.allow_emails || []).map((e) => String(e).toLowerCase());
    return reply({ ok: true, publicKey: ctx.publicKey, prefs: p[0] || { categories: { messages: true, referrals: true, alerts: true, birthdays: true }, quiet_start: 21, quiet_end: 7 }, myDevices: mine, pushLive: ctx.settings.push_live === true, onAllowlist: allow.includes(user) });
  }

  if (op === 'subscribe') {
    const s = body.subscription || {}; const k = s.keys || {};
    if (!/^https:\/\//.test(String(s.endpoint || '')) || !k.p256dh || !k.auth) return reply({ ok: false, error: 'bad_subscription' }, 400);
    const row = { user_email: user, endpoint: String(s.endpoint), p256dh: String(k.p256dh), auth: String(k.auth), user_agent: String(body.userAgent || '').slice(0, 200), fail_count: 0 };
    await d.post('push_subscriptions?on_conflict=endpoint', row, 'resolution=merge-duplicates,return=minimal');
    return reply({ ok: true });
  }

  if (op === 'unsubscribe') {
    if (body.endpoint) await d.del('push_subscriptions?endpoint=eq.' + encodeURIComponent(String(body.endpoint)) + '&user_email=eq.' + encodeURIComponent(user));
    return reply({ ok: true });
  }

  if (op === 'prefs') {
    const c = body.categories || {}; const cats = {};
    CATEGORIES.forEach((k) => { cats[k] = c[k] !== false; });
    const qs = Math.max(0, Math.min(23, parseInt(body.quiet_start, 10)));
    const qe = Math.max(0, Math.min(23, parseInt(body.quiet_end, 10)));
    await d.post('notify_prefs?on_conflict=user_email', { user_email: user, categories: cats, quiet_start: isNaN(qs) ? 21 : qs, quiet_end: isNaN(qe) ? 7 : qe, updated_at: new Date().toISOString() }, 'resolution=merge-duplicates,return=minimal');
    return reply({ ok: true });
  }

  if (op === 'test') {
    const rows = await d.post('notifications', { category: 'test', title: 'Neon CRM alerts are on', body: 'This is your test. Realtor texts will show up just like this.', url: '/app/#home', urgent: true, target_email: user });
    const n = rows[0];
    const r = await deliver(env, n, { onlyEmail: user });
    await d.patch('notifications?id=eq.' + n.id, { pushed_at: new Date().toISOString(), push_result: JSON.stringify(r).slice(0, 300) }).catch(() => {});
    return reply({ ok: r.sent > 0, result: r, message: r.sent ? 'Sent. It should pop up in a few seconds.' : (r.error === 'vapid_missing' ? 'Alerts are not set up on the server yet.' : 'No phone is signed up for alerts yet. Turn alerts on first.') });
  }

  if (op === 'list') {
    const lim = Math.min(+body.limit || 40, 100);
    const rows = await d.get('notifications?select=id,category,title,body,url,urgent,created_at&or=(target_email.is.null,target_email.eq.' + encodeURIComponent(user) + ')&order=id.desc&limit=' + lim);
    return reply({ ok: true, items: rows });
  }

  return reply({ ok: false, error: 'unknown_op' }, 400);
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
