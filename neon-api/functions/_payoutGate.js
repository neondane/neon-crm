/** Payout-alert gate.
 *
 *  Decides whether a SmartMoving completion should buzz the team that a partner
 *  payout is due. It never creates, queues, skips, or pays a payout — callers
 *  only use it to allow or suppress the job_completed alert.
 *
 *  ok only when the move date is present and falls on today or within the last
 *  PAYOUT_ALERT_DAYS, the amount is over zero, the partner is a real outside
 *  partner, and the referral is not already skipped or paid.
 *  Anything else, including a lookup error, fails closed (no alert).
 */
export const PAYOUT_ALERT_DAYS = 14;
export const HISTORICAL_PAYOUT_NOTE = 'historical, not paid out (completed more than 14 days after the move; no payout alert)';

const INTERNAL_PARTNER = /^(dane\b|neon giant|internal\b|self\b|employee)/i;
const INTERNAL_EMAIL = '@neongiantmoving.com';

function payoutDay(value) {
  if (value == null || value === '') return '';
  if (value instanceof Date) return Number.isNaN(value.getTime()) ? '' : value.toISOString().slice(0, 10);
  if (typeof value === 'number' && Number.isFinite(value)) {
    const s = String(Math.trunc(value));
    if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  }
  const s = String(value).trim();
  if (/^\d{8}$/.test(s)) return s.slice(0, 4) + '-' + s.slice(4, 6) + '-' + s.slice(6, 8);
  if (/^\d{4}-\d{2}-\d{2}/.test(s)) return s.slice(0, 10);
  const dt = new Date(s);
  return Number.isNaN(dt.getTime()) ? '' : dt.toISOString().slice(0, 10);
}

function shiftDay(ymd, days) {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd || '');
  if (!m) return '';
  const dt = new Date(Date.UTC(+m[1], +m[2] - 1, +m[3]));
  dt.setUTCDate(dt.getUTCDate() + days);
  return dt.toISOString().slice(0, 10);
}

function money(amount) {
  if (typeof amount === 'number') return Number.isFinite(amount) ? amount : NaN;
  if (amount == null || String(amount).trim() === '') return NaN;
  const n = Number(String(amount).replace(/[$,\s]/g, ''));
  return Number.isFinite(n) ? n : NaN;
}

/** Pure decision. info = { date, amount, partner, contactEmail, skipped, paid }. */
export function payoutAlertDecision(info, now) {
  const i = info || {};
  const today = payoutDay(now == null ? new Date() : now);
  const date = payoutDay(i.date);
  if (!date || !today) return { ok: false, reason: 'no_date' };
  const oldest = shiftDay(today, -PAYOUT_ALERT_DAYS);
  if (!oldest || date < oldest) return { ok: false, reason: 'too_old' };
  if (date > today) return { ok: false, reason: 'future' };
  if (!(money(i.amount) > 0)) return { ok: false, reason: 'amount' };
  const partner = String(i.partner == null ? '' : i.partner).trim();
  if (!partner) return { ok: false, reason: 'no_partner' };
  if (INTERNAL_PARTNER.test(partner)) return { ok: false, reason: 'internal' };
  const email = String(i.contactEmail == null ? '' : i.contactEmail).trim().toLowerCase();
  if (email.endsWith(INTERNAL_EMAIL)) return { ok: false, reason: 'internal_email' };
  if (i.skipped) return { ok: false, reason: 'skipped' };
  if (i.paid) return { ok: false, reason: 'paid' };
  return { ok: true };
}

/** True when the move is more than PAYOUT_ALERT_DAYS before today. Missing dates are not historical. */
export function isHistoricalMove(date, now) {
  const today = payoutDay(now == null ? new Date() : now);
  const move = payoutDay(date);
  const oldest = today ? shiftDay(today, -PAYOUT_ALERT_DAYS) : '';
  return !!(move && oldest && move < oldest);
}

export function appendHistoricalNote(notes, serviceDate, now) {
  const base = notes == null ? '' : String(notes);
  if (!isHistoricalMove(serviceDate, now)) return base;
  if (base.includes(HISTORICAL_PAYOUT_NOTE)) return base;
  return base + (base ? ' | ' : '') + HISTORICAL_PAYOUT_NOTE;
}

function ledgerKeys(info) {
  const keys = [];
  const add = (key) => { if (key && !keys.includes(key)) keys.push(key); };
  if (info.referralId != null && String(info.referralId) !== '') add('manual:' + info.referralId);
  if (info.leadId != null && String(info.leadId) !== '') add('portal:' + info.leadId);
  return keys;
}

/** Look up the contact email (contacts) and skip/paid state (payout_skips, paid_referrals), then decide.
 *  Referral keys are manual:<id>. Portal-lead keys are portal:<id>. Fail closed on any lookup error. */
export async function payoutAlertLookup(db, info, now) {
  const i = info || {};
  try {
    if (!db || typeof db.select !== 'function') return { ok: false, reason: 'lookup_failed' };
    let contactEmail = '';
    const contactId = i.contactId == null ? '' : String(i.contactId).trim();
    if (contactId) {
      const rows = await db.select('contacts?id=eq.' + encodeURIComponent(contactId) + '&select=email&limit=1');
      if (!Array.isArray(rows)) return { ok: false, reason: 'lookup_failed' };
      contactEmail = (rows[0] && rows[0].email) || '';
    }
    let skipped = false;
    let paid = false;
    for (const key of ledgerKeys(i)) {
      const q = encodeURIComponent(key);
      const skips = await db.select('payout_skips?key=eq.' + q + '&select=key&limit=1');
      const paids = await db.select('paid_referrals?key=eq.' + q + '&select=key&limit=1');
      if (!Array.isArray(skips) || !Array.isArray(paids)) return { ok: false, reason: 'lookup_failed' };
      if (skips.length) skipped = true;
      if (paids.length) paid = true;
    }
    return payoutAlertDecision({
      date: i.date, amount: i.amount, partner: i.partner, contactEmail, skipped, paid,
    }, now);
  } catch (_) {
    return { ok: false, reason: 'lookup_failed' };
  }
}
