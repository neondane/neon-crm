import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const src = fs.readFileSync(new URL('../neon-api/functions/_smopp.js', import.meta.url), 'utf8')
  .replace(/^export /gm, '');
const context = { console, fetch };
vm.createContext(context);
vm.runInContext(src + '\nthis.moneyOf = moneyOf;\nthis.paymentsNet = paymentsNet;\nthis.needsSmartMovingCloseOut = needsSmartMovingCloseOut;\nthis.referralFieldPatch = referralFieldPatch;\nthis.uuidsInNotes = uuidsInNotes;', context);
const { moneyOf, paymentsNet, needsSmartMovingCloseOut, referralFieldPatch, uuidsInNotes } = context;
const plain = (v) => JSON.parse(JSON.stringify(v));

// 1. Single job, estimate only — no actuals, so the opportunity estimate wins
//    (not the pre-tax charge line).
const estimateOnly = {
  estimatedTotal: { subtotal: 3000, finalTotal: 3300 },
  jobs: [{ id: 'j1', estimatedCharges: [{ name: 'Moving Labor', totalCost: 3000 }], actualCharges: [] }],
};
assert.equal(moneyOf(estimateOnly, 'referred'), 3300);
assert.equal(moneyOf(estimateOnly, 'booked'), 3300);

// 2. Multi-day move: job 1 has an invoice, job 2 is still on its estimate.
const multi = {
  estimatedTotal: { finalTotal: 3300 },
  jobs: [
    { id: 'j1', actualCharges: [{ name: 'Moving Labor', totalCost: 20000 }], estimatedCharges: [{ name: 'Moving Labor', totalCost: 3300 }] },
    { id: 'j2', actualCharges: [], estimatedCharges: [{ name: 'Moving Labor', totalCost: 9193.67 }] },
  ],
};
assert.equal(moneyOf(multi, 'completed'), 29193.67);

// 3. Booked, actuals exist, but not paid in full → keep the estimate.
const bookedOpen = {
  estimatedTotal: { finalTotal: 3300 },
  payments: [{ amount: 500 }],
  jobs: [{ id: 'j1', actualCharges: [{ name: 'Moving Labor', totalCost: 10000 }] }],
};
assert.equal(moneyOf(bookedOpen, 'booked'), 3300);
assert.equal(moneyOf(bookedOpen, 'completed'), 10000);

// 4. Booked and paid in full → use the invoice, not the estimate.
const bookedPaid = {
  estimatedTotal: { finalTotal: 3300 },
  payments: [{ amount: 10350, tipAmount: 300, creditCardFeeAmount: 50 }],
  jobs: [{ id: 'j1', actualCharges: [{ name: 'Moving Labor', totalCost: 10000 }] }],
};
assert.equal(paymentsNet(bookedPaid), 10000);
assert.equal(moneyOf(bookedPaid, 'booked'), 10000);

// 5. Tips and card fees are not part of the referral amount, on the invoice or the payment.
const withTips = {
  estimatedTotal: { finalTotal: 3300 },
  payments: [{ amount: 1235, tipAmount: 200, creditCardFeeAmount: 35 }],
  jobs: [{
    id: 'j1',
    actualCharges: [
      { name: 'Moving Labor', totalCost: 1000 },
      { name: 'Tip', totalCost: 200 },
      { name: 'Credit Card Fee', totalCost: 35 },
    ],
  }],
};
assert.equal(moneyOf(withTips, 'completed'), 1000);
assert.equal(moneyOf(withTips, 'booked'), 1000);

// A tip sitting inside the payment must not make a short payment look paid in full.
const tipInflated = {
  estimatedTotal: { finalTotal: 3300 },
  payments: [{ amount: 1100, gatewayPayment: { tip: 200 } }],
  jobs: [{ id: 'j1', actualCharges: [{ name: 'Moving Labor', totalCost: 1000 }] }],
};
assert.equal(paymentsNet(tipInflated), 900);
assert.equal(moneyOf(tipInflated, 'booked'), 3300);

// Placeholder name and stale amount/date refresh; a real customer name is left alone.
assert.deepEqual(
  plain(referralFieldPatch(
    { amount: '3300', date: '2026-01-02', jobName: 'SmartMoving job' },
    { amount: 29193.67, date: '2026-06-01', jobName: 'Ada Lovelace' },
  )),
  { amount: '29193.67', date: '2026-06-01', jobName: 'Ada Lovelace' },
);
assert.deepEqual(
  plain(referralFieldPatch(
    { amount: '1000.00', date: '2026-06-01', jobName: 'Ada Lovelace' },
    { amount: 1000, date: '2026-06-01', jobName: 'Someone Else' },
  )),
  {},
);

const legacy = 'SmartMoving Sync: 11111111-1111-4111-8111-111111111111, 22222222-2222-4222-8222-222222222222';
assert.deepEqual(plain(uuidsInNotes(legacy)), [
  '11111111-1111-4111-8111-111111111111',
  '22222222-2222-4222-8222-222222222222',
]);

const closeOut = {
  status: 4,
  serviceDate: 20261101,
  estimatedTotal: { finalTotal: 3300 },
  payments: [{ amount: 10000 }],
  jobs: [
    { actualCharges: [{ name: 'Moving Labor', totalCost: 6000 }] },
    { actualCharges: [{ name: 'Moving Labor', totalCost: 4000 }] },
  ],
};
assert.equal(needsSmartMovingCloseOut(closeOut, '2026-11-13'), true);
assert.equal(moneyOf(closeOut, 'booked'), 10000);
// Not paid in full → not a close-out, and the booked amount stays the estimate.
closeOut.payments = [{ amount: 500, tipAmount: 100 }];
assert.equal(needsSmartMovingCloseOut(closeOut, '2026-11-13'), false);
assert.equal(moneyOf(closeOut, 'booked'), 3300);

console.log('smopp moneyOf tests passed');
