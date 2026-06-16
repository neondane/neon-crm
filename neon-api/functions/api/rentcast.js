/** POST /api/rentcast — thin proxy to the RentCast API (https://api.rentcast.io/v1).
 *  Key lives in env RENTCAST_API_KEY (never in the client). Read-only data pulls.
 *
 *  Actions (POST body { action, opts }):
 *   - "probe"        opts {city,state}            → active listings count + sample (w/ listing agent) + 1 owner record. Coverage check.
 *   - "agentListings" opts {agentName,city,state,zipCode,daysOld} → listings in area filtered to that listing agent.
 *   - "ownerLookup"  opts {address}               → property owner name + mailing address (for mailers / seller leads).
 *   - "sellerLeads"  opts {city,state,zipCode,daysOld,limit} → active listings + owner (seller) name/mailing address, for mailer pulls.
 */
import { endpoint, preflight } from '../_shared.js';

const RC_BASE = 'https://api.rentcast.io/v1';
const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');
const qs = (obj) => Object.keys(obj).filter((k) => obj[k] != null && obj[k] !== '').map((k) => k + '=' + encodeURIComponent(obj[k])).join('&');

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
const slimListing = (L) => ({
  address: L.formattedAddress || L.addressLine1, price: L.price, status: L.status, type: L.propertyType,
  beds: L.bedrooms, baths: L.bathrooms, sqft: L.squareFootage, listedDate: L.listedDate || L.listingDate,
  agent: agentOf(L).name || null, agentPhone: agentOf(L).phone || null, agentEmail: agentOf(L).email || null,
  office: officeOf(L).name || null,
});
const ownerOf = (P) => {
  const o = (P && P.owner) || {};
  return { names: o.names || o.name || null, type: o.type || null, mailingAddress: (o.mailingAddress && (o.mailingAddress.formattedAddress || o.mailingAddress)) || null, ownerOccupied: P.ownerOccupied };
};

const handler = endpoint(async ({ env, body, reply }) => {
  if (!env.RENTCAST_API_KEY) return reply({ ok: false, error: 'rentcast_not_configured', note: 'Set RENTCAST_API_KEY in the neon-api environment.' }, 503);
  const p = body || {}; const action = p.action || 'probe'; const o = p.opts || {};

  if (action === 'probe') {
    const city = o.city || 'Bellingham', state = o.state || 'WA';
    const g = await rc(env, '/listings/sale?' + qs({ city, state, status: 'Active', limit: 25 }));
    if (!g.ok) return reply({ ok: false, action, city, state, status: g.status, body: g.body });
    const list = Array.isArray(g.body) ? g.body : [];
    const sample = list.slice(0, 10).map(slimListing);
    let ownerSample = null;
    if (list[0] && (list[0].formattedAddress || list[0].addressLine1)) {
      const pr = await rc(env, '/properties?' + qs({ address: list[0].formattedAddress || list[0].addressLine1 }));
      const arr = Array.isArray(pr.body) ? pr.body : [];
      if (arr[0]) ownerSample = Object.assign({ forAddress: list[0].formattedAddress }, ownerOf(arr[0]));
    }
    const agentsFound = sample.filter((s) => s.agent).length;
    return reply({ ok: true, action, city, state, listingCount: list.length, listingsWithAgent: agentsFound, sample, ownerSample });
  }

  if (action === 'agentListings') {
    const agent = norm(o.agentName);
    const g = await rc(env, '/listings/sale?' + qs({ city: o.city, state: o.state || 'WA', zipCode: o.zipCode, status: o.status || 'Active', limit: 500 }));
    if (!g.ok) return reply({ ok: false, action, status: g.status, body: g.body });
    const list = Array.isArray(g.body) ? g.body : [];
    const matches = list.filter((L) => { const n = norm(agentOf(L).name); return n && agent && (n.indexOf(agent) >= 0 || agent.indexOf(n) >= 0); }).map(slimListing);
    return reply({ ok: true, action, agentName: o.agentName, scanned: list.length, matched: matches.length, listings: matches });
  }

  if (action === 'ownerLookup') {
    const pr = await rc(env, '/properties?' + qs({ address: o.address }));
    if (!pr.ok) return reply({ ok: false, action, status: pr.status, body: pr.body });
    const arr = Array.isArray(pr.body) ? pr.body : [];
    const r0 = arr[0] || {};
    return reply({ ok: true, action, address: o.address, owner: ownerOf(r0), lastSaleDate: r0.lastSaleDate, lastSalePrice: r0.lastSalePrice });
  }

  if (action === 'sellerLeads') {
    const g = await rc(env, '/listings/sale?' + qs({ city: o.city, state: o.state || 'WA', zipCode: o.zipCode, status: 'Active', daysOld: o.daysOld, limit: Math.min(+o.limit || 50, 500) }));
    if (!g.ok) return reply({ ok: false, action, status: g.status, body: g.body });
    const list = Array.isArray(g.body) ? g.body : [];
    const leads = [];
    for (const L of list.slice(0, Math.min(+o.limit || 25, 50))) {
      const addr = L.formattedAddress || L.addressLine1; if (!addr) continue;
      const pr = await rc(env, '/properties?' + qs({ address: addr }));
      const arr = Array.isArray(pr.body) ? pr.body : [];
      leads.push(Object.assign(slimListing(L), { owner: arr[0] ? ownerOf(arr[0]) : null }));
    }
    return reply({ ok: true, action, count: leads.length, leads });
  }

  return reply({ ok: false, error: 'unknown_action', action });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
