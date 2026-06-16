/** GET/POST /api/tremendousAudit — READ-ONLY reconciliation helper.
 *  Lists the actual orders/rewards on the Tremendous account so we can compare
 *  what was REALLY paid vs. what the CRM marked "paid". Never sends money.
 *  Returns: env mode, funding balance, and a flat list of rewards (recipient, amount, date, status, ids).
 *  Env: TREMENDOUS_KEY (or TREMENDOUS_API_KEY), TREMENDOUS_ENV. */
import { endpoint, preflight } from '../_shared.js';

const run = async ({ env, reply }) => {
  const TKEY = env.TREMENDOUS_KEY || env.TREMENDOUS_API_KEY;
  const mode = (String(env.TREMENDOUS_ENV || '').toLowerCase() === 'sandbox') ? 'sandbox' : 'production';
  const BASE = mode === 'sandbox' ? 'https://testflight.tremendous.com/api/v2' : 'https://www.tremendous.com/api/v2';
  if (!TKEY) return reply({ ok: false, error: 'tremendous_not_configured' }, 503);
  const H = { Authorization: 'Bearer ' + TKEY, Accept: 'application/json' };

  const TIMEOUT = (ms) => (typeof AbortSignal !== 'undefined' && AbortSignal.timeout ? AbortSignal.timeout(ms) : undefined);
  // Funding balance (sanity: is this the account Dane is looking at?)
  let funding = [];
  try {
    const fr = await fetch(BASE + '/funding_sources', { headers: H, signal: TIMEOUT(8000) });
    const fj = await fr.json();
    funding = ((fj && fj.funding_sources) || []).map((f) => ({ id: f.id, method: f.method, type: f.type, balance: f.meta && f.meta.available_cents != null ? f.meta.available_cents / 100 : (f.amount || null) }));
  } catch (_) {}

  // Pull orders — single page (100 is plenty for reconciliation; keeps the worker well under its time limit).
  const out = [];
  let total = 0;
  try {
    const r = await fetch(BASE + '/orders?limit=100', { headers: H, signal: TIMEOUT(9000) });
    const j = await r.json();
    const orders = (j && j.orders) || [];
    total = orders.length;
    orders.forEach((o) => {
      (o.rewards || [{}]).forEach((rw) => {
        out.push({
          orderId: o.id,
          rewardId: rw.id || null,
          status: o.status || (rw.delivery && rw.delivery.status) || null,
          createdAt: o.created_at || null,
          name: (rw.recipient && rw.recipient.name) || null,
          email: (rw.recipient && rw.recipient.email) || null,
          amount: (rw.value && rw.value.denomination) || null,
        });
      });
    });
  } catch (e) { return reply({ ok: false, error: 'orders_fetch_failed', message: e.message, mode, funding }); }

  out.sort((a, b) => String(b.createdAt || '').localeCompare(String(a.createdAt || '')));
  return reply({ ok: true, mode, funding, orderCount: total, rewards: out });
};

export const onRequestGet = endpoint(run);
export const onRequestPost = endpoint(run);
export const onRequestOptions = ({ request }) => preflight(request);
