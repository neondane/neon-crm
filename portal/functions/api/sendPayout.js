/**
 * /api/sendPayout.js — Send a referral reward (gift card) via Tremendous.
 *
 *   POST /api/sendPayout
 *     Body: {
 *       leadId:        portal-lead id (for logging/dedup),
 *       realtorName:   "Kate Fadden",
 *       realtorEmail:  "katefadden@johnlscott.com",
 *       amount:        50,                  // USD
 *       customerName:  "Margaret Binder",   // for the reward note
 *       testMode:      true|false           // optional override
 *     }
 *     Returns: { ok:true, rewardId, orderId, env } on success
 *              { ok:false, error } on failure / not configured
 *
 * Credentials come from Cloudflare Pages environment variables (Dane sets
 * these himself in the dashboard — Claude never handles the key):
 *   TREMENDOUS_API_KEY     — required. Test or Production key.
 *   TREMENDOUS_ENV         — "test" | "production" (default "test")
 *   TREMENDOUS_FUNDING_ID  — optional; funding source id
 *   TREMENDOUS_CAMPAIGN_ID — optional; reward campaign id (recipient-choice)
 *
 * Safety: if TREMENDOUS_API_KEY is missing, this returns a clear
 * "not configured" message and sends NOTHING. Real money only moves when
 * a Production key is set AND testMode is false.
 */

const ALLOWED_ORIGINS = [
  'https://refer.neongiantmoving.com',
  'https://crm.neongiantmoving.com',
  'https://crm3.neongiantmoving.com',
  'https://staging.neon-crm.pages.dev',
];

function corsHeaders(origin) {
  let allow = ALLOWED_ORIGINS[0];
  if (origin && ALLOWED_ORIGINS.includes(origin)) allow = origin;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Vary': 'Origin',
  };
}
function json(body, status, origin) {
  return new Response(JSON.stringify(body), {
    status: status || 200,
    headers: { 'Content-Type': 'application/json', ...corsHeaders(origin) },
  });
}

export async function onRequestOptions(context) {
  const origin = context.request.headers.get('Origin');
  return new Response(null, { status: 204, headers: corsHeaders(origin) });
}

export async function onRequestPost(context) {
  const { request, env } = context;
  const origin = request.headers.get('Origin');

  let body;
  try { body = await request.json(); }
  catch (_e) { return json({ ok: false, error: 'invalid JSON body' }, 400, origin); }

  const realtorEmail = (body.realtorEmail || '').trim();
  const realtorName = (body.realtorName || '').trim() || 'Referral Partner';
  const amount = Number(body.amount || 50);
  const leadId = body.leadId;
  const customerName = (body.customerName || '').trim();

  if (!realtorEmail || realtorEmail.indexOf('@') < 0) {
    return json({ ok: false, error: 'missing/invalid realtorEmail' }, 400, origin);
  }
  if (!(amount > 0)) {
    return json({ ok: false, error: 'invalid amount' }, 400, origin);
  }

  const apiKey = env.TREMENDOUS_API_KEY;
  if (!apiKey) {
    return json({
      ok: false,
      configured: false,
      error: 'TREMENDOUS_API_KEY not set. Add it in Cloudflare → Pages → neon-portal → Settings → Environment variables, then redeploy.',
    }, 200, origin);
  }

  // Test vs production. testMode in the request can force test even with a prod key.
  const envName = (env.TREMENDOUS_ENV || 'test').toLowerCase();
  const forceTest = body.testMode === true;
  const useTest = forceTest || envName !== 'production';
  const base = useTest
    ? 'https://testflight.tremendous.com/api/v2'
    : 'https://api.tremendous.com/api/v2';

  // Build the reward. If a campaign id is provided, recipient chooses their card.
  const reward = {
    value: { denomination: amount, currency_code: 'USD' },
    delivery: { method: 'EMAIL' },
    recipient: { name: realtorName, email: realtorEmail },
  };
  // Neon Giant branded campaign (recipient-choice + logo/messaging). Non-secret ID; override via env if needed.
  var _campaignId = env.TREMENDOUS_CAMPAIGN_ID || 'AC2SI8KAENBL';
  if (_campaignId) reward.campaign_id = _campaignId;

  // Tremendous requires a funding source on the order. Use the configured one,
  // otherwise auto-discover it (prefer a cash "balance" source, else the first).
  let fundingId = env.TREMENDOUS_FUNDING_ID || '';
  if (!fundingId) {
    try {
      const fres = await fetch(base + '/funding_sources', { headers: { 'Authorization': 'Bearer ' + apiKey, 'Accept': 'application/json' } });
      const fj = await fres.json();
      const srcs = (fj && fj.funding_sources) || [];
      const pick = srcs.find(function(s){ return s.method === 'balance'; }) || srcs[0];
      if (pick && pick.id) fundingId = pick.id;
    } catch (e) {}
  }
  const payment = {};
  if (fundingId) payment.funding_source_id = fundingId;

  const orderBody = {
    external_id: 'ngm-lead-' + (leadId != null ? leadId : Date.now()),
    payment: payment,
    reward: reward,
  };

  let resp, data;
  try {
    resp = await fetch(base + '/orders', {
      method: 'POST',
      headers: {
        'Authorization': 'Bearer ' + apiKey,
        'Content-Type': 'application/json',
        'Accept': 'application/json',
      },
      body: JSON.stringify(orderBody),
    });
    data = await resp.json();
  } catch (e) {
    return json({ ok: false, error: 'Tremendous request failed: ' + (e.message || e) }, 502, origin);
  }

  if (!resp.ok || data.errors) {
    return json({
      ok: false,
      error: 'Tremendous rejected the order',
      status: resp.status,
      details: data.errors || data,
      env: useTest ? 'test' : 'production',
    }, 200, origin);
  }

  // Pull ids out of the response shape
  const order = data.order || data;
  const rewards = (order && order.rewards) || [];
  const rewardId = rewards[0] && rewards[0].id;

  // Best-effort: log the payout to Supabase if configured (durable, shared record)
  try {
    if (env.SUPABASE_URL && env.SUPABASE_KEY) {
      await fetch(env.SUPABASE_URL + '/rest/v1/payouts', {
        method: 'POST',
        headers: {
          'apikey': env.SUPABASE_KEY,
          'Authorization': 'Bearer ' + env.SUPABASE_KEY,
          'Content-Type': 'application/json',
          'Prefer': 'return=minimal',
        },
        body: JSON.stringify({
          lead_id: leadId, realtor_name: realtorName, realtor_email: realtorEmail,
          customer_name: customerName, amount: amount,
          tremendous_order_id: order.id || null, tremendous_reward_id: rewardId || null,
          env: useTest ? 'test' : 'production', sent_at: new Date().toISOString(),
        }),
      });
    }
  } catch (_e) { /* table may not exist yet; non-fatal */ }

  return json({
    ok: true,
    env: useTest ? 'test' : 'production',
    orderId: order.id || null,
    rewardId: rewardId || null,
    message: (useTest ? '[TEST] ' : '') + '$' + amount + ' reward queued to ' + realtorEmail,
  }, 200, origin);
}
