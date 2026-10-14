/** POST|GET /api/pushDispatch : turns new CRM events into alerts and pushes them.
 *  Called by database triggers (new inbound text, new portal referral, a referral that
 *  failed to reach SmartMoving) and by a scheduler every 2 minutes as a safety net.
 *  Body { daily:true } also adds today's birthdays (scheduler, 8 AM Pacific).
 *
 *  No login on purpose, like retryReferrals: it only reads events already in the database,
 *  each alert has a unique source_key (inserted once, ever), and each send is "claimed"
 *  first, so repeated or parallel calls can't double-send or invent content.
 */
import { endpoint, preflight } from '../_shared.js';
import { db, deliver } from '../_push.js';

const last10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const fmtPhone = (s) => { const d = last10(s); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : String(s || ''); };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
function cleanSms(body) { const s = String(body || ''); const i = s.indexOf('::NGMMS::'); return i >= 0 ? { text: s.slice(0, i).trim(), photo: true } : { text: s.trim(), photo: false }; }

const handler = endpoint(async ({ env, body, reply }) => {
  const d = db(env);
  const since = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const out = { ok: true, created: 0, delivered: 0, results: [] };
  const fresh = [];

  // 1) Inbound texts -> "messages"
  const sms = await d.get('sms_messages?select=id,contact_id,from_number,body,kind,media_url,created_at&direction=eq.in&created_at=gte.' + encodeURIComponent(since) + '&order=id.asc&limit=50');
  if (sms.length) {
    const ids = [...new Set(sms.map((m) => m.contact_id).filter((x) => x != null))];
    const named = ids.length ? await d.get('contacts?select=id,name,phone&id=in.(' + ids.join(',') + ')') : [];
    const byId = {}; named.forEach((c) => { byId[c.id] = c; });
    const unknown = sms.filter((m) => m.contact_id == null);
    let byPhone = {};
    if (unknown.length) { const all = await d.get('contacts?select=id,name,phone&phone=not.is.null'); all.forEach((c) => { const k = last10(c.phone); if (k) byPhone[k] = c; }); }
    for (const m of sms) {
      const c = m.contact_id != null ? byId[m.contact_id] : byPhone[last10(m.from_number)];
      const who = c ? String(c.name || '').trim() : fmtPhone(m.from_number);
      const cs = cleanSms(m.body);
      const isStop = m.kind === 'opt_out';
      const key = m.contact_id != null ? 'c' + m.contact_id : (c ? 'c' + c.id : 'n' + last10(m.from_number));
      fresh.push({
        category: isStop ? 'alerts' : 'messages', urgent: false,
        title: isStop ? who + ' texted STOP' : who,
        body: isStop ? 'They asked not to be texted again.' : clip(cs.text || (cs.photo || m.media_url ? 'Sent a photo' : 'New message'), 180),
        url: '/app/#chat/' + key, source_key: 'sms:' + m.id, tag: 'thread:' + key,
      });
    }
  }

  // 2) New portal referrals -> "referrals"; SmartMoving trouble -> urgent "alerts"
  const leads = await d.get('portal_leads?select=id,realtorName,customerName,submittedAt,sm_status&submittedAt=gte.' + encodeURIComponent(since) + '&order=id.asc&limit=30');
  leads.filter((l) => !/^ZZ /i.test(l.customerName || '')).forEach((l) => {
    fresh.push({ category: 'referrals', urgent: false, title: 'New referral from ' + clip(l.realtorName, 40), body: clip(l.customerName, 60) + ' needs a moving quote.', url: '/app/#referrals', source_key: 'lead:' + l.id, tag: 'lead:' + l.id });
  });
  const trouble = await d.get('portal_leads?select=id,realtorName,customerName,sm_status&sm_status=in.(retrying,failed)&submittedAt=gte.' + encodeURIComponent(new Date(Date.now() - 3 * 864e5).toISOString()) + '&limit=20');
  trouble.filter((l) => !/^ZZ /i.test(l.customerName || '')).forEach((l) => {
    const failed = l.sm_status === 'failed';
    fresh.push({ category: 'alerts', urgent: true, title: failed ? 'Enter this referral by hand' : 'Referral not in SmartMoving yet',
      body: clip(l.realtorName, 30) + ' sent ' + clip(l.customerName, 40) + (failed ? '. It failed 6 times.' : '. Retrying automatically.'),
      url: '/app/#referrals', source_key: 'sm:' + l.id + ':' + l.sm_status, tag: 'sm:' + l.id });
  });

  // 3) Birthdays (daily run only)
  if (body && body.daily) {
    const now = new Date(); const pt = new Intl.DateTimeFormat('en-CA', { timeZone: 'America/Los_Angeles', year: 'numeric', month: '2-digit', day: '2-digit' }).format(now);
    const md = pt.slice(5);
    const people = await d.get('contacts?select=id,name,birthday&birthday=not.is.null');
    people.filter((c) => String(c.birthday).slice(5, 10) === md).forEach((c) => {
      fresh.push({ category: 'birthdays', urgent: false, title: "It's " + String(c.name || '').trim() + "'s birthday", body: 'Send them a quick happy birthday text.', url: '/app/#chat/c' + c.id, source_key: 'bday:' + pt + ':' + c.id, tag: 'bday:' + c.id });
    });
  }

  // Insert once ever (source_key is unique); only rows actually inserted come back.
  if (fresh.length) {
    const rows = fresh.map(({ tag, ...r }) => r);
    const created = await d.post('notifications?on_conflict=source_key', rows, 'resolution=ignore-duplicates,return=representation');
    out.created = (created || []).length;
  }
  // Deliver anything not yet pushed from the last 2 hours (covers a crashed earlier run).
  const pending = await d.get('notifications?select=id,category,title,body,url,urgent,target_email,source_key&pushed_at=is.null&category=neq.test&created_at=gte.' + encodeURIComponent(since) + '&order=id.asc&limit=30');
  for (const n of pending) {
    const claim = await d.patch('notifications?id=eq.' + n.id + '&pushed_at=is.null', { pushed_at: new Date().toISOString() }).catch(() => []);
    if (!claim || !claim.length) continue;
    const f = fresh.find((x) => x.source_key === n.source_key);
    const r = await deliver(env, { ...n, tag: f ? f.tag : undefined });
    out.delivered++; out.results.push({ id: n.id, ...r });
    await d.patch('notifications?id=eq.' + n.id, { push_result: JSON.stringify(r).slice(0, 300) }).catch(() => {});
  }
  return reply(out);
});

export const onRequestPost = handler;
export const onRequestGet = handler;
export const onRequestOptions = ({ request }) => preflight(request);
