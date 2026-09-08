/** /api/v1/[[route]].js — public REST API for Neon Giant, consumed by Dane's
 *  bots/agents with an API key (Authorization: Bearer <key>  or  x-api-key: <key>).
 *  Scopes: read (GET data), write (create/update + manage webhooks), admin (manage API keys).
 *  Read:   GET /api/v1/{leads|contacts|referrals|payouts}[?limit=]  ·  GET /api/v1/leads/:id
 *  Write:  POST /api/v1/leads {realtorId?,customer:{...}}   (delegates to submitReferralLead)
 *          PATCH /api/v1/leads/:id {status?,notes?}
 *  Hooks:  POST /api/v1/webhooks {url,events?,label?}  ·  GET /api/v1/webhooks  ·  DELETE /api/v1/webhooks/:id
 *  Keys:   POST /api/v1/keys {label,scopes[]}  ·  GET /api/v1/keys  ·  DELETE /api/v1/keys/:id   (admin only)
 */
import { sb, json, preflight } from '../../_shared.js';
import { authKey, sha256hex } from '../../_apikeys.js';

function newApiKey() {
  const b = new Uint8Array(24);
  crypto.getRandomValues(b);
  return 'ngk_' + [...b].map((x) => x.toString(16).padStart(2, '0')).join('');
}

export const onRequestOptions = ({ request }) => preflight(request);

export async function onRequest(ctx) {
  const { request, env, params } = ctx;
  const origin = request.headers.get('Origin') || '';
  if (request.method === 'OPTIONS') return preflight(request);
  const reply = (data, status) => json(data, { status: status || 200, origin });

  const seg = params && params.route ? (Array.isArray(params.route) ? params.route : [params.route]) : [];
  const resource = seg[0] || '';
  const id = seg[1] || '';
  const method = request.method;

  try {
    if (resource === '' || resource === 'ping') return reply({ ok: true, service: 'neon-api', version: 'v1' });

    let body = {};
    if (method === 'POST' || method === 'PATCH' || method === 'PUT') { try { body = await request.json(); } catch (_) { body = {}; } }

    if (method === 'GET') {
      const need = resource === 'keys' ? 'admin' : (resource === 'webhooks' ? 'write' : 'read');
      const auth = await authKey(env, request, need);
      if (!auth.ok) return reply({ ok: false, error: auth.error }, auth.status);
      const db = sb(env);
      const limit = Math.min(parseInt(new URL(request.url).searchParams.get('limit') || '50', 10) || 50, 200);

      if (resource === 'leads') {
        if (id) { const r = await db.select(`portal_leads?id=eq.${encodeURIComponent(id)}&limit=1`); return reply({ ok: true, lead: r[0] || null }); }
        const r = await db.select(`portal_leads?select=id,customerName,customerPhone,realtorName,status,smJobId,submittedAt&order=submittedAt.desc&limit=${limit}`);
        return reply({ ok: true, leads: r });
      }
      if (resource === 'contacts') {
        const r = await db.select(`contacts?select=id,name,business,type,email,phone&order=id.desc&limit=${limit}`);
        return reply({ ok: true, contacts: r });
      }
      if (resource === 'referrals') {
        const r = await db.select(`referrals?select=id,contactName,jobName,status,date,amount&order=id.desc&limit=${limit}`);
        return reply({ ok: true, referrals: r });
      }
      if (resource === 'payouts') {
        const r = await db.select(`paid_referrals?order=id.desc&limit=${limit}`);
        return reply({ ok: true, payouts: r });
      }
      if (resource === 'webhooks') {
        const r = await db.select(`webhook_endpoints?select=id,label,url,events,active,last_delivery_at,last_status&order=id.desc`);
        return reply({ ok: true, webhooks: r });
      }
      if (resource === 'keys') {
        const r = await db.select(`api_keys?select=id,label,scopes,active,created_at,last_used_at&order=id.desc`);
        return reply({ ok: true, keys: r });
      }
      return reply({ ok: false, error: 'unknown_resource' }, 404);
    }

    if (method === 'POST' || method === 'PATCH') {
      const need = resource === 'keys' ? 'admin' : 'write';
      const auth = await authKey(env, request, need);
      if (!auth.ok) return reply({ ok: false, error: auth.error }, auth.status);
      const db = sb(env);

      if (resource === 'keys' && method === 'POST') {
        const label = String(body.label || 'unnamed').slice(0, 80);
        const scopes = Array.isArray(body.scopes) && body.scopes.length ? body.scopes : ['read'];
        const key = newApiKey();
        const key_hash = await sha256hex(key);
        const ins = await db.insert('api_keys', { label, key_hash, scopes, active: true });
        const row = ins && ins[0] ? ins[0] : {};
        return reply({ ok: true, id: row.id, label, scopes, key, note: 'Copy this key now - only its hash is stored and it cannot be shown again.' });
      }

      if (resource === 'leads' && method === 'POST') {
        const r = await fetch('https://neon-api.pages.dev/api/submitReferralLead', {
          method: 'POST', headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ realtorId: body.realtorId || null, customer: body.customer || body }),
        });
        const j = await r.json().catch(() => ({}));
        return reply(j, r.status);
      }
      if (resource === 'leads' && method === 'PATCH' && id) {
        const patch = {};
        if (typeof body.status === 'string') patch.status = body.status;
        if (typeof body.notes === 'string') patch.notes = body.notes;
        if (!Object.keys(patch).length) return reply({ ok: false, error: 'nothing_to_update' }, 400);
        await db.update('portal_leads', `id=eq.${encodeURIComponent(id)}`, patch);
        return reply({ ok: true, id, updated: Object.keys(patch) });
      }
      if (resource === 'webhooks' && method === 'POST') {
        const url = String(body.url || '').trim();
        if (!/^https:\/\//i.test(url)) return reply({ ok: false, error: 'https_url_required' }, 400);
        const events = Array.isArray(body.events) && body.events.length ? body.events : ['*'];
        const secret = body.secret || (crypto.randomUUID ? crypto.randomUUID().replace(/-/g, '') : await sha256hex(url + Date.now()));
        const ins = await db.insert('webhook_endpoints', { label: body.label || '', url, secret, events, active: true });
        const row = ins && ins[0] ? ins[0] : {};
        return reply({ ok: true, id: row.id, url, events, secret, note: 'Save this secret; it signs the X-Neon-Signature HMAC on delivered events.' });
      }
      return reply({ ok: false, error: 'unknown_write' }, 404);
    }

    if (method === 'DELETE' && (resource === 'webhooks' || resource === 'keys') && id) {
      const need = resource === 'keys' ? 'admin' : 'write';
      const auth = await authKey(env, request, need);
      if (!auth.ok) return reply({ ok: false, error: auth.error }, auth.status);
      const table = resource === 'keys' ? 'api_keys' : 'webhook_endpoints';
      await sb(env).update(table, `id=eq.${encodeURIComponent(id)}`, { active: false });
      return reply({ ok: true, id, disabled: true });
    }

    return reply({ ok: false, error: 'method_not_allowed' }, 405);
  } catch (e) {
    return reply({ ok: false, error: String((e && e.message) || e) }, 500);
  }
}
