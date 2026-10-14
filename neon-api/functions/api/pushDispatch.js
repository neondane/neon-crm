/** POST|GET /api/pushDispatch : turns new CRM events into alerts (see _events.js) and delivers them.
 *  Called instantly by database triggers (inbound text/email, portal referral, referral status,
 *  website/Facebook lead, partner listing) and every 2 minutes by the scheduler as a safety net
 *  (that run also catches follow-ups coming due and quiet-hours summaries). { daily:true } adds
 *  birthdays (8 AM Pacific). Events from server code (SmartMoving jobs, partner applications)
 *  call emitEvent() directly.
 *
 *  No login on purpose: it only reads events already in the database; each alert has a unique
 *  source_key and every delivery is claimed per person + channel, so calling it repeatedly or
 *  in parallel can't duplicate or invent anything.
 */
import { endpoint, preflight } from '../_shared.js';
import { db, deliverEvent, quietSummaries, pacificNow } from '../_push.js';
import { EVENT_BY_KEY } from '../_events.js';

const last10 = (s) => String(s || '').replace(/\D/g, '').slice(-10);
const fmtPhone = (s) => { const d = last10(s); return d.length === 10 ? '(' + d.slice(0, 3) + ') ' + d.slice(3, 6) + '-' + d.slice(6) : String(s || ''); };
const clip = (s, n) => { s = String(s || '').replace(/\s+/g, ' ').trim(); return s.length > n ? s.slice(0, n - 1) + '…' : s; };
const isTest = (s) => /^ZZ /i.test(String(s || ''));

const handler = endpoint(async ({ env, body, reply }) => {
  const d = db(env);
  const since = new Date(Date.now() - 2 * 3600 * 1000).toISOString();
  const enc = encodeURIComponent;
  const out = { ok: true, created: 0, delivered: 0, summaries: [], results: [] };
  const fresh = [];
  const add = (event, title, b, url, key, tag) => fresh.push({ event, title, body: b, url, source_key: key, tag });
  let phoneBook = null;
  const contactByPhone = async (num) => {
    if (!phoneBook) { phoneBook = {}; (await d.get('contacts?select=id,name,phone&phone=not.is.null')).forEach((c) => { const k = last10(c.phone); if (k) phoneBook[k] = c; }); }
    return phoneBook[last10(num)] || null;
  };
  const namesById = async (ids) => {
    ids = [...new Set(ids.filter((x) => x != null))]; if (!ids.length) return {};
    const rows = await d.get('contacts?select=id,name&id=in.(' + ids.join(',') + ')'); const m = {}; rows.forEach((c) => { m[c.id] = String(c.name || '').trim(); }); return m;
  };

  // 1) texts in
  const sms = await d.get('sms_messages?select=id,contact_id,from_number,body,kind,media_url&direction=eq.in&created_at=gte.' + enc(since) + '&order=id.asc&limit=50');
  if (sms.length) {
    const nm = await namesById(sms.map((m) => m.contact_id));
    for (const m of sms) {
      const c = m.contact_id != null ? { id: m.contact_id, name: nm[m.contact_id] } : await contactByPhone(m.from_number);
      const who = c && c.name ? c.name : fmtPhone(m.from_number);
      const key = c ? 'c' + c.id : 'n' + last10(m.from_number);
      const raw = String(m.body || ''); const i = raw.indexOf('::NGMMS::'); const text = (i >= 0 ? raw.slice(0, i) : raw).trim();
      if (m.kind === 'opt_out') add('opt_out', who + ' texted STOP', 'They asked not to be texted again.', '/app/#chat/' + key, 'sms:' + m.id);
      else add('text_in', who, clip(text || (i >= 0 || m.media_url ? 'Sent a photo' : 'New message'), 180), '/app/#chat/' + key, 'sms:' + m.id, 'thread:' + key);
    }
  }
  // 2) emails in
  const em = await d.get('email_messages?select=id,contact_id,from_email,subject&direction=eq.in&created_at=gte.' + enc(since) + '&order=id.asc&limit=30');
  if (em.length) {
    const nm = await namesById(em.map((m) => m.contact_id));
    em.forEach((m) => { const key = m.contact_id != null ? 'c' + m.contact_id : 'e' + String(m.from_email || '').toLowerCase();
      add('email_in', (m.contact_id != null && nm[m.contact_id]) || m.from_email || 'Email reply', clip(m.subject || 'New email', 140), '/app/#chat/' + key, 'email:' + m.id, 'thread:' + key); });
  }
  // 3) portal referrals + 4) referrals stuck before SmartMoving
  const leads = await d.get('portal_leads?select=id,realtorName,customerName,sm_status&submittedAt=gte.' + enc(since) + '&order=id.asc&limit=30');
  leads.filter((l) => !isTest(l.customerName)).forEach((l) => add('referral_new', 'New referral from ' + clip(l.realtorName, 40), clip(l.customerName, 60) + ' needs a moving quote.', '/app/#referrals', 'lead:' + l.id));
  const trouble = await d.get('portal_leads?select=id,realtorName,customerName,sm_status&sm_status=in.(retrying,failed)&submittedAt=gte.' + enc(new Date(Date.now() - 3 * 864e5).toISOString()) + '&limit=20');
  trouble.filter((l) => !isTest(l.customerName)).forEach((l) => { const failed = l.sm_status === 'failed';
    add('referral_stuck', failed ? 'Enter this referral by hand' : 'Referral not in SmartMoving yet', clip(l.realtorName, 30) + ' sent ' + clip(l.customerName, 40) + (failed ? '. It failed 6 times.' : '. Retrying automatically.'), '/app/#referrals', 'sm:' + l.id + ':' + l.sm_status, 'sm:' + l.id); });
  // 5) website + Facebook leads (capped so a flood can't spam phones)
  const il = await d.get('inbound_leads?select=id,source,name,phone,details&created_at=gte.' + enc(since) + '&order=id.asc&limit=10');
  il.forEach((l) => { const fb = l.source === 'facebook'; const det = l.details || {};
    add(fb ? 'lead_facebook' : 'lead_website', (fb ? 'Facebook lead: ' : 'Website lead: ') + clip(l.name || 'New lead', 40), clip([det.moveDate ? 'Move ' + det.moveDate : '', det.from || '', l.phone ? fmtPhone(l.phone) : ''].filter(Boolean).join(' · ') || 'Check SmartMoving for details.', 140), '/app/#home', 'inlead:' + l.id); });
  // 6) partner just listed (morning sweep)
  const aa = await d.get('agent_alerts?select=id,contact_id,agent_name,address,price&created_at=gte.' + enc(since) + '&order=id.asc&limit=30');
  aa.forEach((a) => add('partner_listed', clip(a.agent_name, 40) + ' just listed a home', clip(String(a.address || '').split(',')[0], 60) + (a.price ? ' · $' + Math.round(+a.price).toLocaleString() : ''), a.contact_id ? '/app/#chat/c' + a.contact_id : '/app/#radar', 'listed:' + a.id));
  // 7) follow-ups coming due (Pacific time)
  const pt = pacificNow(); const hhmm = String(pt.hour).padStart(2, '0') + ':' + String(pt.minute).padStart(2, '0');
  const yday = new Date(Date.parse(pt.date + 'T12:00:00Z') - 864e5).toISOString().slice(0, 10);
  const fus = await d.get('followups?select=id,contact_id,due_date,due_time,note&done=eq.false&due_date=gte.' + yday + '&due_date=lte.' + pt.date + '&limit=40');
  const dueNow = fus.filter((f) => f.due_date < pt.date || String(f.due_time || '08:00').slice(0, 5) <= hhmm);
  if (dueNow.length) {
    const nm = await namesById(dueNow.map((f) => f.contact_id));
    dueNow.forEach((f) => add('followup_due', 'Follow up: ' + (nm[f.contact_id] || 'a contact'), clip(f.note || 'You set a follow-up for now.', 140), f.contact_id ? '/app/#p/' + f.contact_id : '/app/#home', 'fu:' + f.id + ':' + f.due_date));
  }
  // 8) birthdays (daily run)
  if (body && body.daily) {
    const people = await d.get('contacts?select=id,name,birthday&birthday=not.is.null');
    people.filter((c) => String(c.birthday).slice(5, 10) === pt.date.slice(5)).forEach((c) => add('birthday', "It's " + String(c.name || '').trim() + "'s birthday", 'Send them a quick happy birthday text.', '/app/#chat/c' + c.id, 'bday:' + pt.date + ':' + c.id));
  }

  if (fresh.length) {
    const rows = fresh.map((f) => ({ event: f.event, category: (EVENT_BY_KEY[f.event] || {}).group || 'Other', title: f.title, body: f.body || null, url: f.url || null, urgent: !!(EVENT_BY_KEY[f.event] || {}).urgent, source_key: f.source_key }));
    const created = await d.post('notifications?on_conflict=source_key', rows, 'resolution=ignore-duplicates,return=representation');
    out.created = (created || []).length;
  }
  const pending = await d.get('notifications?select=id,event,title,body,url,urgent,target_email,source_key&pushed_at=is.null&created_at=gte.' + enc(since) + '&order=id.asc&limit=30');
  for (const n of pending) {
    if (!n.event) continue;
    const claim = await d.patch('notifications?id=eq.' + n.id + '&pushed_at=is.null', { pushed_at: new Date().toISOString() }).catch(() => []);
    if (!claim || !claim.length) continue;
    const f = fresh.find((x) => x.source_key === n.source_key);
    const r = await deliverEvent(env, { ...n, tag: f ? f.tag : undefined });
    out.delivered++; out.results.push({ id: n.id, event: n.event, ...r });
    await d.patch('notifications?id=eq.' + n.id, { push_result: JSON.stringify(r).slice(0, 300) }).catch(() => {});
  }
  out.summaries = await quietSummaries(env).catch((e) => [{ error: String(e.message || e) }]);
  return reply(out);
});

export const onRequestPost = handler;
export const onRequestGet = handler;
export const onRequestOptions = ({ request }) => preflight(request);
