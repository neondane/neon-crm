/** POST /api/sendPayout — send a Tremendous reward (recipient picks Visa/Amazon/PayPal/etc).
 *  Accepts the CRM's payload: { realtorEmail, realtorName, amount (dollars), leadId?, customerName? }
 *  (also accepts recipientEmail/recipientName/amountCents for forward-compat).
 *  Logs to Supabase paid_referrals for the double-pay guard. Returns { ok, orderId }.
 *  Env: TREMENDOUS_KEY, TREMENDOUS_FUNDING, TREMENDOUS_CAMPAIGN?, SUPABASE_URL, SUPABASE_KEY
 *
 *  NOTE: real money. Validates strictly and fails closed (never sends on bad input). */
import { endpoint, preflight, sb } from '../_shared.js';

const handler = endpoint(async ({ env, body, reply }) => {
  // Accept either key name; pick prod/sandbox from TREMENDOUS_ENV (defaults to prod).
  const TKEY = env.TREMENDOUS_KEY || env.TREMENDOUS_API_KEY;
  const TREMENDOUS_BASE = (String(env.TREMENDOUS_ENV || '').toLowerCase() === 'sandbox')
    ? 'https://testflight.tremendous.com/api/v2'
    : 'https://www.tremendous.com/api/v2';
  if (!TKEY) return reply({ ok: false, error: 'tremendous_not_configured' }, 503);

  const email = String(body.recipientEmail || body.realtorEmail || '').trim();
  const name = String(body.recipientName || body.realtorName || '').trim();
  // amountCents wins; otherwise treat `amount` as DOLLARS (that's what the CRM sends).
  const cents = body.amountCents != null
    ? parseInt(body.amountCents, 10)
    : Math.round(parseFloat(body.amount) * 100);
  const leadKey = body.leadId != null ? String(body.leadId) : (body.key != null ? String(body.key) : '');
  const customerName = String(body.customerName || '').trim();
  const campaign = String(body.campaign || 'crm_referral_payout');

  if (!email || !/^\S+@\S+\.\S+$/.test(email)) return reply({ ok: false, error: 'invalid_email' }, 400);
  if (!name) return reply({ ok: false, error: 'missing_name' }, 400);
  if (!cents || cents < 100) return reply({ ok: false, error: 'invalid_amount', message: 'min $1' }, 400);

  // Idempotency: if this lead+campaign was already paid, return the prior result (no double-send).
  const db = sb(env);
  if (leadKey) {
    try {
      const prior = await db.select(`paid_referrals?key=eq.${encodeURIComponent(campaign + ':' + leadKey)}&select=*&limit=1`);
      if (prior && prior[0]) return reply({ ok: true, alreadyPaid: true, orderId: prior[0].order_id || null });
    } catch (_) {}
  }

  // Funding source: use explicit env if set, else auto-discover from the Tremendous account.
  let fundingId = env.TREMENDOUS_FUNDING;
  if (!fundingId) {
    try {
      const fr = await fetch(TREMENDOUS_BASE + '/funding_sources', { headers: { Authorization: 'Bearer ' + TKEY } });
      const fj = await fr.json();
      const list = (fj && fj.funding_sources) || [];
      const pick = list.find((f) => /balance/i.test((f.method || '') + (f.type || ''))) || list[0];
      fundingId = pick && pick.id;
    } catch (_) {}
  }
  if (!fundingId) return reply({ ok: false, error: 'no_funding_source', message: 'No Tremendous funding source found on the account.' }, 503);

  const tremReq = {
    payment: { funding_source_id: fundingId },
    reward: {
      value: { denomination: cents / 100, currency_code: 'USD' },
      campaign_id: env.TREMENDOUS_CAMPAIGN || undefined,
      products: ['CHOICE_LINK'],
      recipient: { name, email },
      delivery: { method: 'EMAIL' },
    },
  };

  let res, j;
  try {
    res = await fetch(TREMENDOUS_BASE + '/orders', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + TKEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(tremReq),
    });
    j = await res.json();
  } catch (e) {
    return reply({ ok: false, error: 'tremendous_network_error', message: e.message }, 502);
  }
  if (!res.ok || !j.order) {
    const msg = (j.errors && j.errors.message) || JSON.stringify(j).slice(0, 300);
    return reply({ ok: false, error: 'tremendous_rejected', status: res.status, message: msg }, 502);
  }

  const order = j.order;
  const reward = (order.rewards && order.rewards[0]) || {};
  // Record in the paid ledger (best-effort; the CRM also guards on its side).
  try {
    await db.insert('paid_referrals', {
      key: campaign + ':' + leadKey,
      partner: name,
      amount: cents / 100,
      order_id: order.id,
      customer: customerName,
      paid_at: new Date().toISOString().slice(0, 10),
    }, { returning: 'minimal' });
  } catch (_) {}

  return reply({ ok: true, orderId: order.id, rewardId: reward.id, deliveryStatus: order.status });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
