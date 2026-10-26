import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

function gate(path) {
  const src = fs.readFileSync(path, 'utf8');
  const start = src.indexOf('// PARTNER_GATE_START');
  const end = src.indexOf('// PARTNER_GATE_END');
  assert.ok(start >= 0 && end > start, 'missing partner gate in ' + path);
  return src.slice(start, end);
}

const portalGate = gate(new URL('../portal/functions/api/[[path]].js', import.meta.url));
const apiGate = gate(new URL('../neon-api/functions/api/getRealtorPortalView.js', import.meta.url));
assert.equal(portalGate, apiGate, 'portal and neon-api partner gates drifted');

const context = {};
vm.createContext(context);
vm.runInContext(portalGate + '\nthis.isPartner = isPartner;', context);
const { isPartner } = context;

const allow = [
  'Realtor',
  'Team Leader / Managing Broker',
  'Self-Storage Facility',
  'Assisted Living',
  'Senior Living',
  'Assisted Living / Senior Care',
  'Apartment Complex',
  'Property Management',
  'Other',
  'Referral Partner',
  'Affiliate',
];
for (const type of allow) {
  assert.equal(isPartner({ id: 1, type }), true, type + ' should be allowed');
}

const block = ['Customer', 'Vendor', 'Crew', 'Employee', 'Home Services', 'U-Haul Dealer', 'Lead', '', '   '];
for (const type of block) {
  assert.equal(isPartner({ id: 1, type }), false, JSON.stringify(type) + ' should be blocked');
}
assert.equal(isPartner(null), false);
assert.equal(isPartner({ id: null, type: 'Realtor' }), false);
assert.equal(isPartner({ type: 'Self-Storage Facility' }), false);

console.log('partner access tests passed');
