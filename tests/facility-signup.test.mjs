import assert from 'node:assert/strict';
import fs from 'node:fs';
import vm from 'node:vm';

const code = fs.readFileSync(new URL('../portal/facility-signup.js', import.meta.url), 'utf8');
const context = { URLSearchParams, console };
vm.createContext(context);
vm.runInContext(code, context);

const {
  ngFacilityFromLocation,
  ngSignupPayload,
  ngCobrandForLocation,
  ngCobrandHeadline,
  ngCobrandIntro,
  NG_FACILITIES,
  NG_FACILITY_BRANDS,
  NG_COBRAND_TRUST,
  NG_COBRAND_OFFER,
  NG_COBRAND_SERVICES,
} = context;

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

const known = Object.entries(NG_FACILITIES);

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
assert.equal(blankNote.get('message'), 'Facility: CubeSmart Self Storage\nFacility tag: cubesmart-bellingham\nRole: Manager\nSource: flyer');
assert.equal(blankNote.get('facility_name'), 'CubeSmart Self Storage');

const html = fs.readFileSync(new URL('../portal/index.html', import.meta.url), 'utf8');
const slugLine = html.match(/ng-cobrand-slugs:([a-z0-9- ]+)/);
assert.ok(slugLine, 'index.html lists co-brand slugs');
assert.deepEqual(
  slugLine[1].trim().split(/\s+/).sort(),
  Object.keys(NG_FACILITY_BRANDS).sort(),
);

const cobrandHtml = html.slice(html.indexOf('id="cobrand"'), html.indexOf('id="signup"'));
assert.match(cobrandHtml, /Full-service moving, truck included\. Licensed, insured, DOT compliant and UTC compliant\. Nearly 500 Google reviews\./);
assert.match(cobrandHtml, /You earn \$50 on a completed move over \$1,000\. Your tenant gets \$50 off\./);
assert.match(cobrandHtml, /Hot tub moves/);
assert.match(cobrandHtml, /src="\/logo\.jpg"/);
assert.doesNotMatch(cobrandHtml, /bonded|—|–/i);
assert.equal(NG_COBRAND_TRUST, 'Full-service moving, truck included. Licensed, insured, DOT compliant and UTC compliant. Nearly 500 Google reviews.');
assert.equal(NG_COBRAND_OFFER, 'You earn $50 on a completed move over $1,000. Your tenant gets $50 off.');
assert.equal([].join.call(NG_COBRAND_SERVICES, '|'), 'Moving|Junk removal|Hot tub moves|Packing|Storage moves');
assert.doesNotMatch(NG_COBRAND_TRUST + NG_COBRAND_OFFER + ngCobrandIntro('StorQuest'), /bonded|—|–/i);

assert.equal(Object.keys(NG_FACILITY_BRANDS).length, 17);
for (const [slug, brand] of Object.entries(NG_FACILITY_BRANDS)) {
  assert.equal(NG_FACILITIES[slug], brand.name, slug);
  const view = ngCobrandForLocation('?utm_source=' + slug + '&utm_medium=flyer');
  assert.equal(view.slug, slug);
  assert.equal(view.name, brand.name);
  assert.equal(view.city, brand.city);
  assert.equal(view.headline, 'Neon Giant x ' + brand.name + ': refer a tenant, earn $50');
  assert.equal(view.beside, !!brand.beside);
  if (brand.logo) {
    assert.equal(view.logo, brand.logo);
    assert.equal(fs.existsSync(new URL('../portal' + brand.logo, import.meta.url)), true, brand.logo);
  } else {
    assert.ok(brand.wordmark, slug);
    assert.equal(view.logo, '');
  }
}

const advanced = ngCobrandForLocation('?facility=advanced-heated-self-storage');
assert.equal(advanced.wordmark, '#E8672A');
assert.equal(advanced.logo, '');
const discovery = ngCobrandForLocation('?utm_source=discovery-park-heated-storage&utm_medium=flyer');
assert.equal(discovery.wordmark, '#1F6F8B');
const aztec = ngCobrandForLocation('?utm_source=aztec-self-storage&utm_medium=flyer');
assert.equal(aztec.beside, true);
assert.equal(aztec.logo, '/facilities/aztec-icon.jpeg');
assert.ok(aztec.wordmark);
const storquest = ngCobrandForLocation('?utm_source=StorQuest-Bellingham&utm_medium=flyer');
assert.equal(storquest.name, 'StorQuest');
assert.equal(storquest.logo, '/facilities/storquest.svg');

assert.equal(ngCobrandForLocation(''), null);
assert.equal(ngCobrandForLocation('?utm_medium=flyer'), null);
assert.equal(ngCobrandForLocation('?utm_source=brand-new-storage'), null);
assert.equal(ngCobrandForLocation('?utm_source=ferndale-self-storage'), null);
assert.equal(ngFacilityFromLocation('?utm_source=ferndale-self-storage').name, 'Ferndale Self Storage');
assert.equal(ngCobrandHeadline('Save On Storage'), 'Neon Giant x Save On Storage: refer a tenant, earn $50');

console.log('facility signup payload tests passed');
