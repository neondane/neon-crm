/**
 * /api/payoutHistory.js — Read-only list of payouts actually sent via Tremendous.
 * GET /api/payoutHistory  → { ok, payouts:[{orderId,date,status,name,email,amount}] }
 * Uses the Tremendous key from the Pages env (server-side; never exposed).
 */
const ALLOWED_ORIGINS = ['https://refer.neongiantmoving.com', 'https://crm.neongiantmoving.com', 'https://crm3.neongiantmoving.com',
];
function cors(o){ let a = ALLOWED_ORIGINS[0]; if (o && ALLOWED_ORIGINS.includes(o)) a = o;
  return { 'Access-Control-Allow-Origin': a, 'Access-Control-Allow-Methods': 'GET, OPTIONS', 'Access-Control-Allow-Headers': 'Content-Type', 'Vary': 'Origin' }; }
function j(body, status, o){ return new Response(JSON.stringify(body), { status: status||200, headers: { 'Content-Type':'application/json', ...cors(o) } }); }

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: cors(request.headers.get('Origin')) });
}

export async function onRequestGet({ request, env }) {
  const origin = request.headers.get('Origin');
  // light gate: only serve to our own apps (this returns partner PII)
  const ref = request.headers.get('Referer') || '';
  const ok = ALLOWED_ORIGINS.includes(origin) || /neongiantmoving\.com/.test(ref);
  if (!ok) return j({ ok:false, error:'forbidden', payouts:[] }, 403, origin);

  if (!env.TREMENDOUS_API_KEY) return j({ ok:false, error:'not_configured', payouts:[] }, 200, origin);
  const envName = (env.TREMENDOUS_ENV || 'test').toLowerCase();
  const base = envName === 'production' ? 'https://api.tremendous.com/api/v2' : 'https://testflight.tremendous.com/api/v2';

  let data;
  try {
    const r = await fetch(base + '/orders?limit=100', { headers: { 'Authorization': 'Bearer ' + env.TREMENDOUS_API_KEY, 'Accept': 'application/json' } });
    data = await r.json();
    if (!r.ok) return j({ ok:false, error:'tremendous_'+r.status, details:data, payouts:[] }, 200, origin);
  } catch (e) { return j({ ok:false, error:String(e.message||e), payouts:[] }, 200, origin); }

  const orders = (data && data.orders) || [];
  const payouts = [];
  orders.forEach(function(o){
    const rs = (o && o.rewards) || [];
    rs.forEach(function(rw){
      payouts.push({
        orderId: o.id,
        date: o.created_at || null,
        status: (rw.delivery && rw.delivery.status) || o.status || '',
        name: (rw.recipient && rw.recipient.name) || '',
        email: (rw.recipient && rw.recipient.email) || '',
        amount: (rw.value && rw.value.denomination) || null,
      });
    });
  });
  payouts.sort(function(a,b){ return new Date(b.date||0) - new Date(a.date||0); });
  return j({ ok:true, count: payouts.length, payouts: payouts.slice(0,100) }, 200, origin);
}
