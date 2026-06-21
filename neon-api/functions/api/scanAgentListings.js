/** POST /api/scanAgentListings — the agent-listing morning sweep.
 *  Pulls ACTIVE for-sale listings across the service-area cities from RentCast,
 *  records any we haven't seen into listing_seen (which also drives the market_agents
 *  view used by the Recruit Board), and for genuinely-new listings (posted in the last
 *  RECENT_DAYS) whose listing agent matches a CRM contact, drops a ready-to-send nudge
 *  draft into agent_alerts. Designed to be hit once each morning by a scheduled task.
 *
 *  Body (all optional): { opts: { cities:[...], state:'WA', limit:500, recentDays:7 } }
 *  Env: RENTCAST_API_KEY, SUPABASE_URL, SUPABASE_KEY
 */
import { endpoint, preflight, sb } from '../_shared.js';

const RC_BASE = 'https://api.rentcast.io/v1';
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const qs = (o) => Object.keys(o).filter((k) => o[k] != null && o[k] !== '').map((k) => k + '=' + encodeURIComponent(o[k])).join('&');
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';

const DEFAULT_CITIES = [
  'Bellingham', 'Ferndale', 'Lynden', 'Blaine', 'Birch Bay', 'Everson', 'Sumas', 'Custer',
  'Mount Vernon', 'Burlington', 'Anacortes', 'Sedro-Woolley', 'La Conner', 'Concrete',
  'Stanwood', 'Arlington', 'Marysville', 'Everett', 'Lake Stevens', 'Snohomish', 'Monroe', 'Granite Falls',
];

async function rc(env, path) {
  try {
    const r = await fetch(RC_BASE + path, { headers: { 'X-Api-Key': env.RENTCAST_API_KEY, Accept: 'application/json' } });
    const txt = await r.text();
    let body; try { body = JSON.parse(txt); } catch (e) { body = txt; }
    return { ok: r.ok, status: r.status, body };
  } catch (e) { return { ok: false, status: 0, body: String((e && e.message) || e) }; }
}

const agentOf = (L) => (L && L.listingAgent) || {};
const officeOf = (L) => (L && L.listingOffice) || {};

// Insert into listing_seen ignoring dupes; returns ONLY the newly-inserted rows. Chunked.
async function insertNew(env, rows) {
  const base = (env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_KEY;
  const out = [];
  for (let i = 0; i < rows.length; i += 1000) {
    const chunk = rows.slice(i, i + 1000);
    const r = await fetch(`${base}/rest/v1/listing_seen?on_conflict=listing_key`, {
      method: 'POST',
      headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' },
      body: JSON.stringify(chunk),
    });
    if (!r.ok) throw new Error(`listing_seen_${r.status}: ${(await r.text()).slice(0, 200)}`);
    const got = await r.json();
    if (Array.isArray(got)) got.forEach((x) => out.push(x));
  }
  return out;
}

const handler = endpoint(async ({ env, body, reply }) => {
  if (!env.RENTCAST_API_KEY) return reply({ ok: false, error: 'rentcast_not_configured' }, 503);
  const db = sb(env);
  const o = (body && body.opts) || {};
  const cities = Array.isArray(o.cities) && o.cities.length ? o.cities : DEFAULT_CITIES;
  const state = o.state || 'WA';
  const limit = Math.min(+o.limit || 500, 500);
  const recentDays = Math.min(+o.recentDays || 7, 60);

  // 1) Pull every city's active listings IN PARALLEL.
  const results = await Promise.all(cities.map((city) => rc(env, '/listings/sale?' + qs({ city, state, status: 'Active', limit })).then((res) => ({ city, res }))));

  // 2) Flatten into listing rows (dedupe by address within this run).
  const seen = {}; const rows = []; let totalActive = 0; const cityErrors = [];
  for (const { city, res } of results) {
    if (!res.ok) { cityErrors.push({ city, status: res.status }); continue; }
    const list = Array.isArray(res.body) ? res.body : [];
    totalActive += list.length;
    for (const L of list) {
      const address = L.formattedAddress || L.addressLine1; if (!address) continue;
      const k = norm(address); if (!k || seen[k]) continue; seen[k] = 1;
      const a = agentOf(L);
      rows.push({
        listing_key: k, address, city, price: L.price || null, status: L.status || 'Active',
        agent_name: a.name || null, agent_phone: a.phone || null, agent_email: a.email || null,
        office: officeOf(L).name || null, listed_date: String(L.listedDate || L.listingDate || '').slice(0, 10) || null,
      });
    }
  }

  // 3) Record new listings (ignore dupes) → newRows are the genuinely-new ones.
  let newRows = [];
  try { newRows = await insertNew(env, rows); } catch (e) { return reply({ ok: false, error: String(e.message || e), stage: 'listing_seen', scanned: rows.length }, 500); }

  // 4) Partner nudges: only for NEW listings posted within recentDays whose agent is in the CRM.
  const cutoff = new Date(Date.now() - recentDays * 86400000).toISOString().slice(0, 10);
  let alertsCreated = 0, partnerMatches = 0, alertError = null;
  const recent = newRows.filter((r) => r.agent_name && (!r.listed_date || r.listed_date >= cutoff));
  if (recent.length) {
    let contactMap = {};
    try {
      const cs = await db.select('contacts?select=id,name&limit=5000');
      (cs || []).forEach((c) => { const k = norm(c.name); if (k) contactMap[k] = c.id; });
    } catch (e) { alertError = 'contacts:' + String(e.message || e); }
    const alertRows = [];
    for (const r of recent) {
      const cid = contactMap[norm(r.agent_name)]; if (!cid) continue;
      partnerMatches++;
      alertRows.push({
        contact_id: cid, agent_name: r.agent_name, address: r.address, city: r.city,
        price: (r.price == null || r.price === '') ? null : Number(r.price),
        channel: r.agent_phone ? 'text' : 'email', status: 'pending',
        draft_message: 'Hi ' + firstName(r.agent_name) + ' — saw your new listing at ' + r.address + ' just hit the market, congrats! '
          + 'Whenever your seller is lining up movers, Neon Giant will take great care of them. Want me to send over your VIP referral link?',
      });
    }
    // Insert in small batches so one bad row can't sink them all, and surface any error.
    for (let i = 0; i < alertRows.length; i += 25) {
      try { await db.insert('agent_alerts', alertRows.slice(i, i + 25), { returning: 'minimal' }); alertsCreated += Math.min(25, alertRows.length - i); }
      catch (e) { if (!alertError) alertError = 'insert:' + String(e.message || e); }
    }
  }

  return reply({
    ok: true, citiesScanned: cities.length, rcCalls: cities.length, totalActive,
    scanned: rows.length, newListings: newRows.length, partnerMatches, alertsCreated, alertError, cityErrors,
  });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
