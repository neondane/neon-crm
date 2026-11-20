/* Shared ranking for the Top Referring Partners card (desktop + phone).
   Earned total, sort order, and bar width all use the same dollars:
   completed + booked whose move date is today or earlier.
   Future booked dollars are upcoming, not earned.
   Job count is completed + booked only.
   Lost, duplicate, cancelled, and test rows are left out.
   A row counts only when it is linked to a real contact, not a lead source. */
(function (root, factory) {
  var api = factory();
  if (typeof module === 'object' && module.exports) module.exports = api;
  root.PartnerRank = api;
})(typeof globalThis !== 'undefined' ? globalThis : this, function () {
  var NOT_PARTNER = /^(something else|other|unknown.*|affiliate|realtors?( referral)?|real estate( agency)?|referral|word of mouth|friend.*|direct mail.*|mailer|employee.*|portal - (affiliate|.*test)|.*\btest\b.*|.*debug.*|.*campaign.*|.*\bfb\b.*|snoball.*|capi-.*)$/i;
  var GENERIC = /google|yelp|website|online|bing|facebook|instagram|social|chat ?gpt|openai|claude|repeat customer|past customer/i;
  var SKIP_STATUS = { duplicate: 1, lost: 1, test: 1, cancelled: 1, canceled: 1 };
  var TEST_FLAG_KEYS = ['test', 'isTest', 'is_test', 'testFlag', 'test_flag', 'flaggedTest', 'flagged_test'];

  function normStatus(r) {
    var s = String(r && r.status || '').trim().toLowerCase();
    if (s === 'new' || s === 'contacted') return 'referred';
    if (s === 'canceled') return 'cancelled';
    return s;
  }

  function moveDate(r) {
    return String(r && r.date || '').slice(0, 10);
  }

  function amount(r) {
    var n = +(r && r.amount);
    return isFinite(n) ? n : 0;
  }

  function isLeadSourceName(name) {
    var n = String(name || '').trim();
    if (!n) return false;
    if (/^portal\b/i.test(n)) return true;
    if (NOT_PARTNER.test(n)) return true;
    if (GENERIC.test(n)) return true;
    return false;
  }

  function truthyTestFlag(v) {
    if (v === true || v === 1) return true;
    var s = String(v == null ? '' : v).trim().toLowerCase();
    return s === '1' || s === 'true' || s === 'yes' || s === 'y' || s === 'test';
  }

  function isTestReferral(r) {
    if (!r) return false;
    if (normStatus(r) === 'test') return true;
    var i;
    for (i = 0; i < TEST_FLAG_KEYS.length; i++) {
      if (truthyTestFlag(r[TEST_FLAG_KEYS[i]])) return true;
    }
    if (truthyTestFlag(r.flag) || truthyTestFlag(r.flags)) return true;
    if (/\btest\b/i.test(String(r.jobName || ''))) return true;
    if (/\b(flagged\s+test|test\s+job|zz\s*test)\b/i.test(String(r.notes || ''))) return true;
    return false;
  }

  function isPartnerReferral(r, contact) {
    if (!r || !contact || contact.id == null || String(contact.id) === '') return false;
    var id = String(r.contactId == null ? '' : r.contactId).trim();
    if (!id || String(contact.id) !== id) return false;
    if (/@neongiantmoving\.com$/i.test(String(contact.email || ''))) return false;
    if (isLeadSourceName(r.contactName)) return false;
    if (isLeadSourceName(contact.name)) return false;
    var who = String(contact.name || '').trim();
    var biz = String(contact.business || '').trim();
    if (!who && !biz) return false;
    if (!who && isLeadSourceName(biz)) return false;
    return true;
  }

  function periodStart(period, today) {
    var day = String(today || '').slice(0, 10);
    if (!period || period === 'all') return '';
    var p = day.split('-');
    var y = +p[0], m = +p[1];
    if (!y || !m) return '';
    if (period === 'ytd') return y + '-01-01';
    var d = new Date(Date.UTC(y, m - 1 - 11, 1));
    return d.getUTCFullYear() + '-' + String(d.getUTCMonth() + 1).padStart(2, '0') + '-01';
  }

  function rankReferringPartners(opts) {
    opts = opts || {};
    var refs = opts.refs || [];
    var contacts = opts.contacts || [];
    var today = String(opts.today || new Date().toISOString()).slice(0, 10);
    var period = opts.period == null ? '12m' : opts.period;
    var since = opts.since != null ? String(opts.since) : periodStart(period, today);
    var limit = opts.limit == null ? 6 : opts.limit;
    var nameOf = opts.nameOf || function (c) {
      return String((c && (c.name || c.business)) || '').trim() || 'Partner';
    };
    var byId = {};
    contacts.forEach(function (c) {
      if (c && c.id != null && String(c.id) !== '') byId[String(c.id)] = c;
    });
    var groups = {};
    refs.forEach(function (r) {
      if (!r) return;
      var st = normStatus(r);
      if (SKIP_STATUS[st] || isTestReferral(r)) return;
      if (st !== 'completed' && st !== 'booked') return;
      var id = String(r.contactId == null ? '' : r.contactId).trim();
      var contact = id ? byId[id] : null;
      if (!isPartnerReferral(r, contact)) return;
      var d = moveDate(r);
      if (since && (!d || d < since)) return;
      var g = groups[id] || (groups[id] = {
        key: 'c' + id,
        id: contact.id,
        name: nameOf(contact),
        earned: 0,
        jobs: 0,
        upcoming: 0,
        completed: 0,
        booked: 0
      });
      g.jobs += 1;
      var amt = amount(r);
      if (st === 'completed') {
        g.earned += amt;
        g.completed += amt;
      } else if (d && d <= today) {
        g.earned += amt;
        g.booked += amt;
      } else {
        g.upcoming += amt;
      }
    });
    var partners = Object.keys(groups).map(function (k) { return groups[k]; }).filter(function (g) {
      return g.earned > 0;
    });
    partners.sort(function (a, b) {
      return b.earned - a.earned || b.jobs - a.jobs || String(a.name).localeCompare(String(b.name));
    });
    if (limit > 0) partners = partners.slice(0, limit);
    var max = 0;
    partners.forEach(function (p) { if (p.earned > max) max = p.earned; });
    partners.forEach(function (p) { p.bar = max > 0 ? (p.earned / max * 100) : 0; });
    return { partners: partners, max: max, today: today, since: since };
  }

  return {
    normStatus: normStatus,
    isLeadSourceName: isLeadSourceName,
    isTestReferral: isTestReferral,
    isPartnerReferral: isPartnerReferral,
    periodStart: periodStart,
    rankReferringPartners: rankReferringPartners
  };
});
