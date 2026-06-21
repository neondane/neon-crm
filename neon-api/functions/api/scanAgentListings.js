/** POST /api/scanAgentListings — the agent-listing morning sweep.
 *  Pulls new ACTIVE for-sale listings across the service-area cities from RentCast,
 *  detects ones we haven't seen, and for each:
 *    - upserts the listing AGENT into market_agents (contact + running listing count),
 *    - matches the agent to a CRM realtor contact,
 *    - if matched (a partner) → drops a ready-to-send nudge draft into agent_alerts,
 *    - if not matched → leaves them as a recruit target in market_agents.
 *  Returns a summary. Designed to be hit once each morning by a scheduled task.
 *
 *  Body (all optional): { opts: { cities:[...], state:'WA', limit:500, maxNew:300 } }
 *  Env: RENTCAST_API_KEY, SUPABASE_URL, SUPABASE_KEY
 */
import { endpoint, preflight, sb } from '../_shared.js';

const RC_BASE = 'https://api.rentcast.io/v1';
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const qs = (o) => Object.keys(o).filter((k) => o[k] != null && o[k] !== '').map((k) => k + '=' + encodeURIComponent(o[k])).join('&');
const firstName = (n) => String(n || '').trim().split(/\s+/)[0] || 'there';

// Neon Giant service area — Skagit + Whatcom + (north) Snohomish. Trim/extend as needed.
const DEFAULT_CITIES = [
  'Bellingham', 'Ferndale', 'Lynden', 'Blaine', 'Birch Bay', 'Everson', 'Sumas', 'Custer',
  'Mount Vernon', 'Burlington', 'Anacortes', 'Sedro-Woolley', 'La Conner', 'Concrete',
  'Stanwood', 'Arlington', 'Marysville', 'Everett', 'Lake Stevens', 'Snohomish', 'Monroe', 'Granite Falls',
];

async function rc(env, path) {
  const r = await fetch(RC_BASE + path, { headers: { 'X-Api-Key': env.RENTCAST_API_KEY, Accept: 'application/json' } });
  const txt = await r.text();
  let body; try { body = JSON.parse(txt); } catch (e) { body = txt; }
  return { ok: r.ok, status: r.status, body };
}

const agentOf = (L) => (L && L.listingAgent) || {};
const officeOf = (L) => (L && L.listingOffice) || {};

// Bulk insert into listing_seen, IGNORING ones we've already recorded; returns only the NEW rows.
async function insertNewListings(env, rows) {
  if (!rows.length) return [];
  const base = (env.SUPABASE_URL || '').replace(/\/$/, '');
  const key = env.SUPABASE_KEY;
  const r = await fetch(`${base}/rest/v1/listing_seen?on_conflict=listing_key`, {
    method: 'POST',
    headers: { apikey: key, Authorization: 'Bearer ' + key, 'Content-Type': 'application/json', Prefer: 'resolution=ignore-duplicates,return=representation' },
    body: JSON.stringify(rows),
  });
  if (!r.ok) throw new Error(`listing_seen_insert_${r.status}: ${(await r.text()).slice(0, 200)}`);
  return r.json();
}

const handler = endpoint(async ({ env, body, reply }) => {
  if (!env.RENTCAST_API_KEY) return reply({ ok: false, error: 'rentcast_not_configured' }, 503);
  const db = sb(env);
  const o = (body && body.opts) || {};
  const cities = Array.isArray(o.cities) && o.cities.length ? o.cities : DEFAULT_CITIES;
  const state = o.state || 'WA';
  const limit = Math.min(+o.limit || 500, 500);
  const maxNew = Math.min(+o.maxNew || 300, 1000);

  // 1) Pull active listings per city, collect raw listing rows for listing_seen.
  let rcCalls = 0, totalActive = 0, cityErrors = [];
  const seenRows = [];        // for listing_seen insert
  const byKey = {};           // listing_key -> { agentName, agentPhone, agentEmail, office, address, city, price }
  for (const city of cities) {
    let res;
    try { res = await rc(env, '/listings/sale?' + qs({ city, state, status: 'Active', limit })); rcCalls++; }
    catch (e) { cityErrors.push({ city, error: String(e.message || e) }); continue; }
    if (!res.ok) { cityErrors.push({ city, status: res.status }); continue; }
    const list = Array.isArray(res.body) ? res.body : [];
    totalActive += list.length;
    for (const L of list) {
      const address = L.formattedAddress || L.addressLine1; if (!address) continue;
      const k = norm(address); if (!k || byKey[k]) continue;
      const a = agentOf(L);
      byKey[k] = {
        address, city, price: L.price || null, status: L.status || 'Active',
        agentName: a.name || null, agentPhone: a.phone || null, agentEmail: a.email || null,
        office: (officeOf(L).name) || null, listedDate: (L.listedDate || L.listingDate || '').slice(0, 10) || null,
      };
      seenRows.push({ listing_key: k, address, city, price: L.price || null, status: L.status || 'Active', agent_name: a.name || null, listed_date: (L.listedDate || L.listingDate || '').slice(0, 10) || null });
    }
  }

  // 2) Insert into listing_seen ignoring dupes → only brand-new listings come back.
  let newRows = [];
  try { newRows = await insertNewListings(env, seenRows); } catch (e) { return reply({ ok: false, error: String(e.message || e), stage: 'listing_seen' }, 500); }
  newRows = newRows.slice(0, maxNew);

  // 3) Load CRM contacts to match agents (name -> contact id).
  let contactMap = {};
  try {
    const cs = await db.select('contacts?select=id,name,type&limit=5000');
    (cs || []).forEach((c) => { const k = norm(c.name); if (k) contactMap[k] = c.id; });
  } catch (e) { /* matching just degrades to "all are recruit targets" */ }

  // 4) Aggregate the new listings by agent for this run.
  const agents = {}; // name_key -> { name, phone, email, office, cities:Set, count, lastListed, listings:[] }
  for (const row of newRows) {
    const info = byKey[row.listing_key]; if (!info || !info.agentName) continue;
    const ak = norm(info.agentName); if (!ak) continue;
    const A = agents[ak] || (agents[ak] = { name: info.agentName, phone: null, email: null, office: null, cities: {}, count: 0, lastListed: null, listings: [] });
    A.count++;
    if (info.agentPhone && !A.phone) A.phone = info.agentPhone;
    if (info.agentEmail && !A.email) A.email = info.agentEmail;
    if (info.office && !A.office) A.office = info.office;
    if (info.city) A.cities[info.city] = 1;
    if (info.listedDate && (!A.lastListed || info.listedDate > A.lastListed)) A.lastListed = info.listedDate;
    A.listings.push(info);
  }

  // 5) Upsert market_agents + create partner nudge drafts.
  let newAgents = 0, updatedAgents = 0, alertsCreated = 0;
  for (const ak of Object.keys(agents)) {
    const A = agents[ak];
    const contactId = contactMap[ak] || null;
    const areas = Object.keys(A.cities).join(', ');
    let existing = null;
    try { const ex = await db.select('market_agents?name_key=eq.' + encodeURIComponent(ak) + '&select=name_key,listing_count,phone,email,office,areas,contact_id'); existing = ex && ex[0]; } catch (e) {}
    if (existing) {
      const mergedAreas = Array.from(new Set((String(existing.areas || '').split(',').map((s) => s.trim()).filter(Boolean)).concat(Object.keys(A.cities)))).join(', ');
      try {
        await db.update('market_agents', 'name_key=eq.' + encodeURIComponent(ak), {
          listing_count: (+existing.listing_count || 0) + A.count,
          phone: existing.phone || A.phone, email: existing.email || A.email, office: existing.office || A.office,
          areas: mergedAreas, last_listed: A.lastListed, contact_id: existing.contact_id || contactId, updated_at: new Date().toISOString(),
        });
        updatedAgents++;
      } catch (e) {}
    } else {
      try {
        await db.insert('market_agents', {
          name_key: ak, name: A.name, phone: A.phone, email: A.email, office: A.office,
          areas, listing_count: A.count, last_listed: A.lastListed, contact_id: contactId,
        }, { returning: 'minimal' });
        newAgents++;
      } catch (e) {}
    }

    // Partner nudge: only for agents matched to a CRM contact.
    if (contactId) {
      for (const L of A.listings) {
        const draft = 'Hi ' + firstName(A.name) + ' — saw your new listing at ' + L.address + ' just hit the market, congrats! '
          + 'Whenever your seller is lining up movers, Neon Giant will take great care of them. Want me to send over your VIP referral link?';
        try {
          await db.insert('agent_alerts', { contact_id: contactId, agent_name: A.name, address: L.address, city: L.city, price: L.price, draft_message: draft, channel: A.phone ? 'text' : 'email', status: 'pending' }, { returning: 'minimal' });
          alertsCreated++;
        } catch (e) {}
      }
    }
  }

  return reply({
    ok: true, citiesScanned: cities.length, rcCalls, totalActive,
    newListings: newRows.length, distinctNewAgents: Object.keys(agents).length,
    newAgents, updatedAgents, alertsCreated, cityErrors,
    sampleNewAgents: Object.keys(agents).slice(0, 8).map((k) => ({ name: agents[k].name, phone: agents[k].phone, email: agents[k].email, listings: agents[k].count, partner: !!contactMap[k] })),
  });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
