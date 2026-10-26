import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../portal/facility-signup.js', import.meta.url), 'utf8');
const context = { URLSearchParams, console };
vm.createContext(context);
vm.runInContext(code, context);

const { ngFacilityFromLocation, ngSignupPayload, NG_FACILITIES } = context;

function form(values) {
  return {
    elements: new Proxy(values, {
      get(target, key) {
        if (key in target) return { value: target[key] };
        return undefined;
      },
    }),
  };
}

const known = [
  ['advanced-heated-self-storage', 'Advanced Heated Self Storage'],
  ['discovery-park-heated-storage', 'Discovery Park Heated Storage'],
  ['ferndale-self-storage', 'Ferndale Self Storage'],
  ['glacier-west-self-storage', 'Glacier West Self Storage'],
  ['pacific-self-storage-bellingham', 'Pacific Self Storage Bellingham'],
  ['pacific-self-storage-ferndale', 'Pacific Self Storage Ferndale'],
  ['public-storage-bellingham', 'Public Storage Bellingham'],
  ['storage-court-bellingham', 'Storage Court Bellingham'],
  ['storehouse-mini-storage', 'Storehouse Mini Storage'],
  ['storquest-bellingham', 'StorQuest Bellingham'],
  ['sunset-park-self-storage', 'Sunset Park Self Storage'],
  ['sedro-woolley-mini-storage', 'Sedro-Woolley Mini Storage'],
  ['skagit-self-storage', 'Skagit Self Storage'],
  ['urban-storage-on-bennett', 'Urban Storage on Bennett'],
  ['alger-mini-storage', 'Alger Mini Storage'],
  ['pantec-mini-storage', 'Pantec Mini Storage'],
  ['cubesmart-bellingham', 'CubeSmart Bellingham'],
  ['lynden-heated-self-storage', 'Lynden Heated Self Storage'],
  ['birch-bay-storage', 'Birch Bay Storage'],
];

for (const [slug, name] of known) {
  assert.equal(NG_FACILITIES[slug], name, slug);
  const fromUtm = ngFacilityFromLocation('?utm_source=' + slug + '&utm_medium=flyer');
  const fromFacility = ngFacilityFromLocation('?facility=' + slug);
  assert.equal(fromUtm.slug, slug);
  assert.equal(fromUtm.name, name);
  assert.equal(fromFacility.slug, slug);
  assert.equal(fromFacility.name, name);
}

assert.equal(ngFacilityFromLocation(''), null);
assert.equal(ngFacilityFromLocation('?utm_medium=flyer'), null);
const unknown = ngFacilityFromLocation('?utm_source=brand-new-storage');
assert.equal(unknown.slug, 'brand-new-storage');
assert.equal(unknown.name, 'Brand New Storage');
const spaced = ngFacilityFromLocation('?facility=Some_New_Place');
assert.equal(spaced.slug, 'some-new-place');
assert.equal(spaced.name, 'Some New Place');
// Explicit facility wins when both are present.
assert.equal(
  ngFacilityFromLocation('?facility=pantec-mini-storage&utm_source=other-place').name,
  'Pantec Mini Storage',
);

const plain = ngSignupPayload(form({
  name: 'Ada',
  brokerage: 'Windermere',
  email: 'ada@example.com',
  phone: '3605550100',
  message: 'North county',
  company_website: '',
}), '');
assert.deepEqual([...plain.keys()], ['name', 'brokerage', 'email', 'phone', 'message', 'company_website']);
assert.equal(plain.get('message'), 'North county');
assert.equal(plain.get('brokerage'), 'Windermere');
assert.equal(plain.get('source'), null);

const flyer = ngSignupPayload(form({
  name: 'Sam',
  brokerage: 'Discovery Park Heated Storage',
  email: 'sam@example.com',
  phone: '3605550199',
  message: 'I work weekends',
  company_website: '',
  role: 'Front desk',
}), '?utm_source=discovery-park-heated-storage&utm_medium=flyer');
assert.equal(flyer.get('facility_tag'), 'discovery-park-heated-storage');
assert.equal(flyer.get('facility_name'), 'Discovery Park Heated Storage');
assert.equal(flyer.get('role'), 'Front desk');
assert.equal(flyer.get('source'), 'flyer');
assert.equal(flyer.get('name'), 'Sam');
assert.equal(flyer.get('brokerage'), 'Discovery Park Heated Storage');
assert.match(flyer.get('message'), /^I work weekends\n\nFacility: Discovery Park Heated Storage\nFacility tag: discovery-park-heated-storage\nRole: Front desk\nSource: flyer$/);

const blankNote = ngSignupPayload(form({
  name: 'Sam',
  brokerage: 'CubeSmart Bellingham',
  email: 'sam@example.com',
  phone: '',
  message: '   ',
  company_website: '',
  role: 'Manager',
}), '?facility=cubesmart-bellingham');
assert.equal(blankNote.get('message'), 'Facility: CubeSmart Bellingham\nFacility tag: cubesmart-bellingham\nRole: Manager\nSource: flyer');
assert.equal(blankNote.get('facility_name'), 'CubeSmart Bellingham');

console.log('facility signup payload tests passed');
