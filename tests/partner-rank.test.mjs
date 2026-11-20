import assert from 'node:assert/strict';
import fs from 'node:fs';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const {
  rankReferringPartners,
  isTestReferral,
  isPartnerReferral,
  isLeadSourceName,
  periodStart,
} = require('../v3/partnerRank.js');

const TODAY = '2026-11-20';
const contacts = [
  { id: 1, name: 'Kelli Lang', email: 'team@kellilang.com', type: 'Realtor' },
  { id: 2, name: 'Hot Tubs NW', business: 'Hot Tubs NW', email: '' },
  { id: 3, name: 'Affinity', email: 'office@affinity.example' },
  { id: 4, name: 'Dane Test', email: 'dane@neongiantmoving.com' },
  { id: 5, name: 'Adam Baldwin', email: 'adam@example.com' },
  { id: 6, name: 'Import', email: '' },
];

function rank(refs, extra) {
  return rankReferringPartners(Object.assign({
    refs: refs,
    contacts: contacts,
    today: TODAY,
    period: '12m',
    limit: 6,
  }, extra || {}));
}

assert.equal(periodStart('12m', TODAY), '2025-12-01');
assert.equal(periodStart('ytd', TODAY), '2026-01-01');
assert.equal(periodStart('all', TODAY), '');

assert.equal(isLeadSourceName('Import'), false);
assert.equal(isLeadSourceName('UHaul Mount Vernon'), false);
assert.equal(isLeadSourceName('Google'), true);
assert.equal(isLeadSourceName('Dane Test'), true);
assert.equal(isLeadSourceName('Portal - PASCALTEST'), true);
assert.equal(isLeadSourceName('capi-verify-test'), true);

assert.equal(isTestReferral({ status: 'test', jobName: 'Real Customer' }), true);
assert.equal(isTestReferral({ status: 'completed', jobName: 'Dane Test' }), true);
assert.equal(isTestReferral({ status: 'completed', jobName: 'Patricia Hoover', test: true }), true);
assert.equal(isTestReferral({ status: 'completed', jobName: 'Patricia Hoover', is_test: 'yes' }), true);
assert.equal(isTestReferral({ status: 'completed', jobName: 'Patricia Hoover', flaggedTest: 1 }), true);
assert.equal(isTestReferral({ status: 'completed', jobName: 'Patricia Hoover', notes: 'flagged test — ignore' }), true);
assert.equal(isTestReferral({ status: 'completed', jobName: 'ZZ TEST move', notes: '' }), true);
assert.equal(isTestReferral({ status: 'completed', jobName: 'Patricia Hoover' }), false);

// Sort, displayed total, and bar all use completed + booked through today.
// A partner with less completed cash but more earned (completed + past booked) ranks first.
const out = rank([
  { contactId: '1', contactName: 'Kelli Lang', status: 'completed', date: '2026-06-01', amount: '100', jobName: 'A' },
  { contactId: '2', contactName: 'Hot Tubs NW', status: 'completed', date: '2026-05-01', amount: '40', jobName: 'B' },
  { contactId: '2', contactName: 'Hot Tubs NW', status: 'booked', date: '2026-11-01', amount: '80', jobName: 'C' },
  { contactId: '2', contactName: 'Hot Tubs NW', status: 'booked', date: '2026-12-12', amount: '50', jobName: 'Future' },
  { contactId: '2', contactName: 'Hot Tubs NW', status: 'referred', date: '2026-04-01', amount: '999', jobName: 'Open' },
  { contactId: '2', contactName: 'Hot Tubs NW', status: 'lost', date: '2026-03-01', amount: '999', jobName: 'Lost' },
  { contactId: '2', contactName: 'Hot Tubs NW', status: 'duplicate', date: '2026-03-02', amount: '999', jobName: 'Dup' },
  { contactId: '2', contactName: 'Hot Tubs NW', status: 'cancelled', date: '2026-03-03', amount: '999', jobName: 'Cancel' },
  { contactId: '2', contactName: 'Hot Tubs NW', status: 'completed', date: '2026-02-01', amount: '500', jobName: 'Dane Test' },
  { contactId: '2', contactName: 'Hot Tubs NW', status: 'completed', date: '2026-02-02', amount: '500', test: true, jobName: 'Flagged' },
  { contactId: '', contactName: 'Import', status: 'completed', date: '2026-08-01', amount: '5000', jobName: 'Jennifer' },
  { contactId: '', contactName: 'UHaul Mount Vernon', status: 'booked', date: '2026-11-01', amount: '4000', jobName: 'Ottosen' },
  { contactId: '9', contactName: 'Mystery Source', status: 'completed', date: '2026-07-01', amount: '8000', jobName: 'No contact row' },
  { contactId: '4', contactName: 'Dane Test', status: 'completed', date: '2026-07-01', amount: '9000', jobName: 'Staff' },
  { contactId: '1', contactName: 'Kelli Lang', status: 'completed', date: '2024-01-01', amount: '99999', jobName: 'Old' },
]);

assert.deepEqual(out.partners.map((p) => p.name), ['Hot Tubs NW', 'Kelli Lang']);
const hot = out.partners[0];
const kelli = out.partners[1];
assert.equal(hot.earned, 120);
assert.equal(hot.completed, 40);
assert.equal(hot.booked, 80);
assert.equal(hot.upcoming, 50);
assert.equal(hot.jobs, 3);
assert.equal(kelli.earned, 100);
assert.equal(kelli.jobs, 1);
assert.equal(hot.bar, 100);
assert.ok(Math.abs(kelli.bar - (kelli.earned / hot.earned * 100)) < 1e-9);
assert.equal(out.max, hot.earned);
assert.equal(out.since, '2025-12-01');

// Booked on today counts. Booked after today is upcoming and still a job.
const edge = rank([
  { contactId: '3', contactName: 'Affinity', status: 'completed', date: '2026-11-20', amount: 10, jobName: 'Done' },
  { contactId: '3', contactName: 'Affinity', status: 'booked', date: '2026-11-20', amount: 5, jobName: 'Today' },
  { contactId: '3', contactName: 'Affinity', status: 'booked', date: '2026-11-21', amount: 7, jobName: 'Tomorrow' },
  { contactId: '3', contactName: 'Affinity', status: 'booked', date: '', amount: 9, jobName: 'No date' },
  { contactId: '5', contactName: 'Adam Baldwin', status: 'booked', date: '2026-12-01', amount: 40, jobName: 'Only upcoming' },
]);
assert.equal(edge.partners.length, 1);
assert.equal(edge.partners[0].name, 'Affinity');
assert.equal(edge.partners[0].earned, 15);
assert.equal(edge.partners[0].upcoming, 7);
assert.equal(edge.partners[0].jobs, 3);

// A lead source that is not a contact never becomes a partner, even with a past booked job.
assert.equal(isPartnerReferral(
  { contactId: '', contactName: 'Import', status: 'booked', date: '2026-11-01', amount: '100' },
  null
), false);
assert.equal(isPartnerReferral(
  { contactId: '6', contactName: 'Google Ads', status: 'completed', date: '2026-11-01', amount: '100', jobName: 'X' },
  contacts[5]
), false);
assert.equal(isPartnerReferral(
  { contactId: '2', contactName: 'Hot Tubs NW', status: 'completed', date: '2026-02-01', amount: '500', jobName: 'Dane Test' },
  contacts[1]
), true);

// Both dashboards render the card from this ranker, with the same earned value on the bar.
const desktop = fs.readFileSync(new URL('../v3/index.html', import.meta.url), 'utf8');
const phone = fs.readFileSync(new URL('../v3/app/index.html', import.meta.url), 'utf8');
assert.match(desktop, /src="partnerRank\.js"/);
assert.match(phone, /src="\.\.\/partnerRank\.js"/);
assert.match(desktop, /PartnerRank\.rankReferringPartners\(/);
assert.match(phone, /PartnerRank\.rankReferringPartners\(/);
assert.match(desktop, /kfmt\(a\.earned\)/);
assert.match(phone, /kfmt\(a\.earned\)/);
assert.match(desktop, /a\.bar\.toFixed\(1\)/);
assert.match(phone, /a\.bar\.toFixed\(1\)/);
assert.match(desktop, /upcoming '/);
assert.match(phone, /upcoming '/);
const chart = desktop.slice(desktop.indexOf('function chartTopPartners'), desktop.indexOf('function chartPipeline'));
assert.match(chart, /rankReferringPartners/);
assert.doesNotMatch(chart, /dxSortP|a\.comp\s*\+\s*a\.book/);
const phoneCard = phone.slice(phone.indexOf('// top partners'), phone.indexOf("statTile('pipe'"));
assert.match(phoneCard, /rankReferringPartners/);
assert.doesNotMatch(phoneCard, /b\.n - a\.n|a\.n \/ topMax/);

// Payout gate is untouched by this change.
const payout = fs.readFileSync(new URL('../neon-api/functions/_payoutGate.js', import.meta.url), 'utf8');
assert.match(payout, /export function payoutAlertDecision/);
