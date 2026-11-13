/** SmartMoving opportunity reads + the referral amount.
 *
 *  Field names below are the ones this repo already uses (estimatedTotal.finalTotal /
 *  subtotal, payments[].amount|total|value, jobs[].id) plus the public Open API shapes
 *  for IncludeCharges / IncludePayments. Where the live payload may differ, reads are
 *  defensive and the assumptions are called out in the PR.
 *
 *  Amount rule (moneyOf):
 *    - Per job, actual = sum of actualCharges[].totalCost, skipping tip and card-fee lines.
 *    - If any job has an actual, the invoice is the sum across jobs of (that job's actual,
 *      or that job's estimatedCharges when it has no actual yet).
 *    - Booked jobs keep estimatedTotal.finalTotal until payments, net of tips and card
 *      fees, cover that invoice. Completed (and any other stage) uses the invoice.
 *  Never used to send money. Callers must not fire payouts off an amount refresh.
 */
const SM_BASE = 'https://api-public.smartmoving.com/v1';

const TIP_FEE = /\b(tips?|gratuity|gratuities|card fees?|credit card fees?|cc fees?|processing fees?|convenience fees?|merchant fees?|card surcharge)\b/i;
const TIP_KEYS = ['tip', 'tipAmount', 'gratuity', 'gratuityAmount'];
const FEE_KEYS = ['creditCardFee', 'creditCardFeeAmount', 'cardFee', 'cardFeeAmount', 'processingFee', 'processingFeeAmount', 'convenienceFee', 'ccFee'];
const NESTS = ['gatewayPayment', 'gateway', 'creditCard', 'card', 'details'];

function num(v) {
  if (typeof v === 'number') return Number.isFinite(v) ? v : 0;
  if (v == null || v === '') return 0;
  const n = Number(String(v).replace(/[$,]/g, ''));
  return Number.isFinite(n) ? n : 0;
}

export function round2(n) {
  return Math.round((num(n) + Number.EPSILON) * 100) / 100;
}

function cents(n) {
  return Math.round((num(n) + Number.EPSILON) * 100);
}

export function moneyStr(n) {
  const r = round2(n);
  const s = r.toFixed(2);
  return s.replace(/\.00$/, '').replace(/(\.\d)0$/, '$1');
}

async function smFetch(key, path) {
  try {
    const r = await fetch(SM_BASE + path, { headers: { 'x-api-key': key, Accept: 'application/json' } });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, body: await r.json() };
  } catch (e) {
    return { ok: false, err: String((e && e.message) || e) };
  }
}

/** GET /api/opportunities/{id}?IncludeCharges=true&IncludePayments=true.
 *  If that 400s (flags not accepted on this account), retry the bare opportunity
 *  so a real opp id is not mistaken for a job id. */
export async function smOpp(key, id) {
  const path = '/api/opportunities/' + encodeURIComponent(id);
  const g = await smFetch(key, path + '?IncludeCharges=true&IncludePayments=true');
  if (g.ok || g.status !== 400) return g;
  return smFetch(key, path);
}

/** Opportunity, or the opportunity that owns this job id.
 *  A job id returns 400 from the opportunity route; we try /api/jobs/{id} and, if that
 *  doesn't yield an opportunity, flag it instead of treating the 400 as a hard failure. */
export async function loadOpp(key, id) {
  const g = await smOpp(key, id);
  if (g.ok) return { ok: true, opp: g.body, id: String((g.body && g.body.id) || id) };
  if (g.status !== 400) return { ok: false, status: g.status, err: g.err, flagged: false };
  const job = await smFetch(key, '/api/jobs/' + encodeURIComponent(id));
  const body = job.ok ? job.body : null;
  const pid = body && (body.opportunityId || body.opportunity_id || (body.opportunity && body.opportunity.id));
  if (pid && String(pid).toLowerCase() !== String(id).toLowerCase()) {
    const g2 = await smOpp(key, pid);
    if (g2.ok) return { ok: true, opp: g2.body, id: String((g2.body && g2.body.id) || pid), mappedFrom: String(id) };
  }
  return { ok: false, status: 400, flagged: true, skip: 'not-opportunity' };
}

export function ymd(d) {
  const s = String(d == null ? '' : d).trim();
  if (!s) return '';
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dt = new Date(s);
  return isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
}

function jobsOf(opp) {
  return (opp && Array.isArray(opp.jobs) ? opp.jobs : []).filter(Boolean);
}

function labelBlob(obj) {
  if (!obj || typeof obj !== 'object') return '';
  return [obj.name, obj.description, obj.editableDescription, obj.customPaymentDescription,
    obj.paymentCategory, obj.paymentType, obj.category, obj.chargeCategory, obj.chargeType, obj.type]
    .filter((v) => v != null && (typeof v === 'string' || typeof v === 'number'))
    .join(' ');
}

function isTipOrFee(obj) {
  return TIP_FEE.test(labelBlob(obj));
}

function chargeLines(value) {
  if (value == null) return [];
  if (Array.isArray(value)) return value.filter(Boolean);
  if (typeof value === 'number') return [];
  if (typeof value === 'object') {
    if (Array.isArray(value.charges)) return value.charges.filter(Boolean);
    if (Array.isArray(value.items)) return value.items.filter(Boolean);
    if ('totalCost' in value || 'subtotal' in value || 'amount' in value || 'finalTotal' in value) return [value];
  }
  return [];
}

function lineCost(c) {
  if (c == null) return 0;
  if (typeof c === 'number') return c;
  if (c.totalCost != null && c.totalCost !== '') return num(c.totalCost);
  if (c.subtotal != null && c.subtotal !== '') return num(c.subtotal);
  if (c.finalTotal != null && c.finalTotal !== '') return num(c.finalTotal);
  if (c.total != null && c.total !== '') return num(c.total);
  if (c.amount != null && c.amount !== '') return num(c.amount);
  return 0;
}

function billableSum(lines) {
  let sum = 0;
  let any = false;
  for (const c of lines) {
    if (isTipOrFee(c)) continue;
    any = true;
    sum += lineCost(c);
  }
  return { any, sum };
}

/** null when this job has no billable actual charges yet. */
function jobActual(job) {
  if (!job) return null;
  const raw = job.actualCharges != null ? job.actualCharges
    : (job.actuals != null ? job.actuals
      : (job.charges && job.charges.actual != null ? job.charges.actual : null));
  if (raw == null) return null;
  const lines = chargeLines(raw);
  if (!lines.length) return null;
  const { any, sum } = billableSum(lines);
  if (!any) return null;
  return sum;
}

function estimateAmount(job) {
  if (!job) return 0;
  const raw = job.estimatedCharges != null ? job.estimatedCharges
    : (job.charges && job.charges.estimated != null ? job.charges.estimated : null);
  if (typeof raw === 'number') return raw;
  const lines = chargeLines(raw);
  if (lines.length) {
    const { any, sum } = billableSum(lines);
    if (any) return sum;
  }
  if (raw && typeof raw === 'object' && !Array.isArray(raw)) {
    if (raw.finalTotal != null && raw.finalTotal !== '') return num(raw.finalTotal);
    if (raw.totalCost != null && raw.totalCost !== '') return num(raw.totalCost);
    if (raw.subtotal != null && raw.subtotal !== '') return num(raw.subtotal);
  }
  const et = job.estimatedTotal;
  if (typeof et === 'number') return et;
  if (et && typeof et === 'object') {
    if (et.finalTotal != null && et.finalTotal !== '') return num(et.finalTotal);
    return num(et.subtotal);
  }
  return num(job.estimatedAmount);
}

function opportunityEstimate(opp) {
  const et = opp && opp.estimatedTotal;
  if (et == null) return 0;
  if (typeof et === 'number') return et;
  if (et.finalTotal != null && et.finalTotal !== '') return num(et.finalTotal);
  return num(et.subtotal);
}

function firstNum(obj, keys) {
  if (!obj || typeof obj !== 'object') return 0;
  for (const k of keys) {
    if (obj[k] != null && obj[k] !== '' && typeof obj[k] !== 'object') {
      const n = num(obj[k]);
      if (n) return n;
    }
  }
  for (const nest of NESTS) {
    const v = obj[nest];
    if (!v || typeof v !== 'object' || Array.isArray(v)) continue;
    for (const k of keys) {
      if (v[k] != null && v[k] !== '' && typeof v[k] !== 'object') {
        const n = num(v[k]);
        if (n) return n;
      }
    }
  }
  return 0;
}

function feeWaived(p) {
  if (!p || typeof p !== 'object') return false;
  if (p.isCreditCardFeeWaived === true || p.creditCardFeeWaived === true) return true;
  const g = p.gatewayPayment || p.gateway;
  return !!(g && (g.isCreditCardFeeWaived === true || g.creditCardFeeWaived === true));
}

function paymentRows(opp) {
  if (!opp) return [];
  if (Array.isArray(opp.payments)) return opp.payments;
  if (Array.isArray(opp.opportunityPayments)) return opp.opportunityPayments;
  return [];
}

/** Payments net of tips and card fees. `amount` on a SmartMoving payment includes both. */
export function paymentsNet(opp) {
  let net = 0;
  for (const p of paymentRows(opp)) {
    if (!p) continue;
    const tip = Math.abs(firstNum(p, TIP_KEYS));
    const fee = feeWaived(p) ? 0 : Math.abs(firstNum(p, FEE_KEYS));
    const amount = num(p.amount != null ? p.amount : (p.total != null ? p.total : p.value));
    const refunded = Math.abs(firstNum(p, ['amountRefunded', 'refundedAmount', 'refundAmount']));
    if (isTipOrFee(p) && tip === 0 && fee === 0) continue;
    if (amount < 0) { net += amount; continue; }
    let line = amount - tip - fee;
    if (refunded > 0) line -= refunded;
    net += line;
  }
  return round2(net);
}

/** Referral amount for this opportunity at `stage` ('booked' is the paid-in-full gate). */
export function moneyOf(opp, stage) {
  const jobs = jobsOf(opp);
  const actuals = jobs.map(jobActual);
  const anyActual = actuals.some((a) => a != null);
  let fromJobs = 0;
  if (anyActual) {
    jobs.forEach((job, i) => { fromJobs += actuals[i] != null ? actuals[i] : estimateAmount(job); });
  }
  const estimate = opportunityEstimate(opp);
  const booked = String(stage || '').toLowerCase() === 'booked';
  if (booked) {
    if (anyActual && cents(fromJobs) > 0 && cents(paymentsNet(opp)) >= cents(fromJobs)) return round2(fromJobs);
    return round2(estimate);
  }
  if (anyActual) return round2(fromJobs);
  return round2(estimate);
}

function isSmBooked(opp) {
  const raw = opp && opp.status;
  const n = Number(raw);
  const text = String(raw == null ? '' : raw).trim();
  const numeric = text !== '' && Number.isFinite(n) && !/[a-z]/i.test(text);
  if (numeric) return n === 4;
  const blob = (String(opp.leadStatus || '') + ' ' + text + ' ' + String(opp.jobStatus || '')).toLowerCase();
  return /\bbooked\b/.test(blob);
}

/** Booked in SmartMoving, move date already passed, every job invoiced, paid in full.
 *  Callers must leave the CRM status alone (do not auto-mark completed). */
export function needsSmartMovingCloseOut(opp, today) {
  if (!opp || !isSmBooked(opp)) return false;
  const svc = ymd(opp.serviceDate);
  const day = ymd(today) || new Date().toISOString().slice(0, 10);
  if (!svc || svc >= day) return false;
  const jobs = jobsOf(opp);
  if (!jobs.length || !jobs.every((j) => jobActual(j) != null)) return false;
  const actual = moneyOf(opp, 'completed');
  if (!(actual > 0)) return false;
  return cents(paymentsNet(opp)) >= cents(actual);
}

export function oppNoteIds(opp, requestedId) {
  const ids = [];
  const add = (v) => {
    const s = String(v || '').trim();
    if (s && !ids.some((x) => x.toLowerCase() === s.toLowerCase())) ids.push(s);
  };
  add(requestedId);
  add(opp && opp.id);
  jobsOf(opp).forEach((j) => add(j.id));
  return ids;
}

export function uuidsInNotes(notes) {
  return String(notes || '').match(/[0-9a-f-]{36}/gi) || [];
}

export function notesContainId(notes, ids) {
  const blob = String(notes || '').toLowerCase();
  return (ids || []).some((id) => id && blob.indexOf(String(id).toLowerCase()) >= 0);
}

/** PostgREST filter: notes contain the opp id or any of its job ids. */
export function referralIdFilter(ids) {
  const uniq = [];
  (ids || []).forEach((id) => {
    const s = String(id || '').trim();
    if (s && !uniq.some((u) => u.toLowerCase() === s.toLowerCase())) uniq.push(s);
  });
  if (!uniq.length) return '';
  return 'or=(' + uniq.map((id) => 'notes.ilike.*' + encodeURIComponent(id) + '*').join(',') + ')';
}

export function sameMoney(a, b) {
  return cents(num(String(a == null ? '' : a).replace(/[$,\s]/g, ''))) === cents(num(b));
}

/** Fields to write when an existing referral should track the opportunity.
 *  jobName changes only while the row is still the placeholder (or blank). */
export function referralFieldPatch(row, { amount, date, jobName } = {}) {
  const patch = {};
  if (amount != null && !sameMoney(row && row.amount, amount)) patch.amount = moneyStr(amount);
  if (date) {
    const next = ymd(date) || String(date).slice(0, 10);
    const curRaw = row && row.date;
    const cur = ymd(curRaw) || String(curRaw || '').trim().slice(0, 10);
    if (next && cur !== next) patch.date = next;
  }
  const curName = String((row && row.jobName) || '').trim();
  const nextName = String(jobName || '').trim();
  const placeholder = !curName || curName.toLowerCase() === 'smartmoving job';
  if (placeholder && nextName && nextName.toLowerCase() !== 'smartmoving job' && curName !== nextName) {
    patch.jobName = nextName;
  }
  return patch;
}
