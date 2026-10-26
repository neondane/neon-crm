// Facility staff signup for printed QR sheets:
//   https://refer.neongiantmoving.com/?utm_source=<facility-slug>&utm_medium=flyer
//   also accepts ?facility=<slug>
// Recognized slugs (the sheets) get a co-branded landing. Any other slug still
// prefills the form, and a missing slug leaves the generic page alone.
// Wordmark colors: Advanced and Discovery use the sheet manifest hex.
// Storage Solutions had no hex (purple wordmark). Aztec is an icon plus a teal name.

var NG_FACILITY_BRANDS = {
  'advanced-heated-self-storage': { name: 'Advanced Heated Self Storage', city: 'Bellingham', wordmark: '#E8672A' },
  'aztec-self-storage': { name: 'Aztec Self Storage', city: 'Burlington', logo: '/facilities/aztec-icon.jpeg', wordmark: '#0E8C8C', beside: true },
  'burlington-freeway-storage': { name: 'Burlington Freeway Storage', city: 'Burlington', logo: '/facilities/burlington-freeway.webp' },
  'college-way-self-storage': { name: 'College Way Self Storage', city: 'Mount Vernon', logo: '/facilities/collegeway.jpg' },
  'cubesmart-bellingham': { name: 'CubeSmart Self Storage', city: 'Bellingham', logo: '/facilities/cubesmart.svg' },
  'discovery-park-heated-storage': { name: 'Discovery Park Heated Storage', city: 'Bellingham', wordmark: '#1F6F8B' },
  'northwest-heated-mini-storage': { name: 'Northwest Heated Mini Storage', city: 'Bellingham', logo: '/facilities/nwheated.png' },
  'pacific-self-storage-bellingham': { name: 'Pacific Self Storage', city: 'Bellingham', logo: '/facilities/pacific-bellingham.jpg' },
  'pantec-mini-storage': { name: 'Pantec Mini Storage', city: 'Bellingham', logo: '/facilities/pantec.jpg' },
  'public-storage-bellingham': { name: 'Public Storage', city: 'Bellingham', logo: '/facilities/public-storage.svg' },
  'save-on-storage': { name: 'Save On Storage', city: 'Mount Vernon', logo: '/facilities/saveon.svg' },
  'storage-court-bellingham': { name: 'Storage Court', city: 'Bellingham', logo: '/facilities/storage-court.png' },
  'storage-solutions-bellingham': { name: 'Storage Solutions', city: 'Bellingham', wordmark: '#5E35B1' },
  'storehouse-mini-storage': { name: 'Storehouse Mini Storage', city: 'Bellingham', logo: '/facilities/storehouse.png' },
  'storquest-bellingham': { name: 'StorQuest', city: 'Bellingham', logo: '/facilities/storquest.svg' },
  'sunset-storage-bellingham': { name: 'Sunset Storage', city: 'Bellingham', logo: '/facilities/sunset.png' },
  'urban-storage-on-bennett': { name: 'Urban Storage on Bennett', city: 'Bellingham', logo: '/facilities/urban.png' }
};

var NG_COBRAND_TRUST = 'Full-service moving, truck included. Licensed, insured, DOT compliant and UTC compliant. Nearly 500 Google reviews.';
var NG_COBRAND_OFFER = 'You earn $50 on a completed move over $1,000. Your tenant gets $50 off.';
var NG_COBRAND_SERVICES = ['Moving', 'Junk removal', 'Hot tub moves', 'Packing', 'Storage moves'];

var NG_FACILITIES = {
  'advanced-heated-self-storage': 'Advanced Heated Self Storage',
  'aztec-self-storage': 'Aztec Self Storage',
  'burlington-freeway-storage': 'Burlington Freeway Storage',
  'college-way-self-storage': 'College Way Self Storage',
  'cubesmart-bellingham': 'CubeSmart Self Storage',
  'discovery-park-heated-storage': 'Discovery Park Heated Storage',
  'northwest-heated-mini-storage': 'Northwest Heated Mini Storage',
  'pacific-self-storage-bellingham': 'Pacific Self Storage',
  'pantec-mini-storage': 'Pantec Mini Storage',
  'public-storage-bellingham': 'Public Storage',
  'save-on-storage': 'Save On Storage',
  'storage-court-bellingham': 'Storage Court',
  'storage-solutions-bellingham': 'Storage Solutions',
  'storehouse-mini-storage': 'Storehouse Mini Storage',
  'storquest-bellingham': 'StorQuest',
  'sunset-storage-bellingham': 'Sunset Storage',
  'urban-storage-on-bennett': 'Urban Storage on Bennett',
  // Older slugs that are not on the printed sheets. Prefill only, no co-brand.
  'ferndale-self-storage': 'Ferndale Self Storage',
  'glacier-west-self-storage': 'Glacier West Self Storage',
  'pacific-self-storage-ferndale': 'Pacific Self Storage Ferndale',
  'sunset-park-self-storage': 'Sunset Park Self Storage',
  'sedro-woolley-mini-storage': 'Sedro-Woolley Mini Storage',
  'skagit-self-storage': 'Skagit Self Storage',
  'alger-mini-storage': 'Alger Mini Storage',
  'lynden-heated-self-storage': 'Lynden Heated Self Storage',
  'birch-bay-storage': 'Birch Bay Storage'
};

function ngTitleCaseSlug(slug) {
  return String(slug || '').split('-').filter(Boolean).map(function (word) {
    return word.charAt(0).toUpperCase() + word.slice(1);
  }).join(' ');
}

function ngFacilitySlug(raw) {
  return String(raw || '').trim().toLowerCase().replace(/[^a-z0-9-]+/g, '-').replace(/-+/g, '-').replace(/^-|-$/g, '');
}

function ngCobrandHeadline(name) {
  return 'Neon Giant x ' + name + ': refer a tenant, earn $50';
}

function ngCobrandIntro(name) {
  return 'Sign up as staff at ' + name + '. We\'ll send your referral link so you can refer a tenant, track the move, and see when you get paid.';
}

// Prefer an explicit ?facility= slug, then the QR utm_source.
function ngFacilityFromLocation(search) {
  var q = new URLSearchParams(search || '');
  var slug = ngFacilitySlug(q.get('facility') || q.get('utm_source') || '');
  if (!slug) return null;
  return { slug: slug, name: NG_FACILITIES[slug] || ngTitleCaseSlug(slug) };
}

function ngCobrandForLocation(search) {
  var fac = ngFacilityFromLocation(search);
  if (!fac || !NG_FACILITY_BRANDS[fac.slug]) return null;
  var brand = NG_FACILITY_BRANDS[fac.slug];
  return {
    slug: fac.slug,
    name: brand.name,
    city: brand.city || '',
    logo: brand.logo || '',
    wordmark: brand.wordmark || '',
    beside: !!brand.beside,
    headline: ngCobrandHeadline(brand.name)
  };
}

function ngSignupPayload(form, search) {
  var data = new URLSearchParams();
  ['name', 'brokerage', 'email', 'phone', 'message', 'company_website'].forEach(function (key) {
    var el = form.elements[key];
    if (el) data.append(key, el.value);
  });
  var fac = ngFacilityFromLocation(search);
  if (!fac) return data;
  var roleEl = form.elements.role;
  var role = roleEl ? String(roleEl.value || '').trim() : '';
  data.set('facility_tag', fac.slug);
  data.set('facility_name', fac.name);
  data.set('role', role);
  data.set('source', 'flyer');
  var typed = String((form.elements.message && form.elements.message.value) || '').trim();
  var note = 'Facility: ' + fac.name + '\nFacility tag: ' + fac.slug + '\nRole: ' + role + '\nSource: flyer';
  data.set('message', typed ? typed + '\n\n' + note : note);
  return data;
}

function ngApplyFacilitySignup(doc) {
  var fac = ngFacilityFromLocation((doc.defaultView && doc.defaultView.location && doc.defaultView.location.search) || '');
  if (!fac) return null;
  var form = doc.querySelector('form.signup-card');
  if (!form) return null;
  if (!doc.getElementById('signupFacility')) {
    var banner = doc.createElement('p');
    banner.className = 'signup-facility';
    banner.id = 'signupFacility';
    banner.textContent = 'Signing up as staff at ' + fac.name;
    var intro = form.querySelector('.signup-intro');
    if (intro) form.insertBefore(banner, intro);
    else form.insertBefore(banner, form.firstChild);
  }
  var brokerage = form.elements.brokerage;
  if (brokerage && !String(brokerage.value || '').trim()) brokerage.value = fac.name;
  if (!form.elements.role) {
    var wrap = doc.createElement('div');
    wrap.className = 'signup-role';
    wrap.innerHTML = '<label class="signup-label" for="signupRole">Your role</label>'
      + '<select id="signupRole" name="role" required>'
      + '<option value="" selected disabled>Your role</option>'
      + '<option value="Manager">Manager</option>'
      + '<option value="Assistant manager">Assistant manager</option>'
      + '<option value="Front desk">Front desk</option>'
      + '<option value="Other">Other</option>'
      + '</select>';
    var notes = form.querySelector('textarea[name="message"]');
    if (notes) form.insertBefore(wrap, notes);
    else form.appendChild(wrap);
  }
  return fac;
}

function ngWordmarkEl(doc, name, color) {
  var wm = doc.createElement('span');
  wm.className = 'cobrand-wordmark';
  wm.style.color = color || '#16324F';
  wm.textContent = name;
  return wm;
}

function ngFillFacilityMark(slot, view) {
  var doc = slot.ownerDocument;
  slot.textContent = '';
  slot.classList.remove('beside', 'is-wordmark');
  if (view.logo && view.beside) {
    var icon = doc.createElement('img');
    icon.src = view.logo;
    icon.alt = '';
    icon.decoding = 'async';
    slot.classList.add('beside');
    slot.appendChild(icon);
    slot.appendChild(ngWordmarkEl(doc, view.name, view.wordmark));
    return;
  }
  if (view.logo) {
    var img = doc.createElement('img');
    img.src = view.logo;
    img.alt = view.name;
    img.decoding = 'async';
    img.addEventListener('error', function () {
      slot.textContent = '';
      slot.classList.add('is-wordmark');
      slot.appendChild(ngWordmarkEl(doc, view.name, view.wordmark || '#16324F'));
    });
    slot.appendChild(img);
    return;
  }
  slot.classList.add('is-wordmark');
  slot.appendChild(ngWordmarkEl(doc, view.name, view.wordmark));
}

function ngSetCobrandHeadline(el, name) {
  var doc = el.ownerDocument;
  el.textContent = '';
  el.appendChild(doc.createTextNode('Neon Giant x '));
  var span = doc.createElement('span');
  span.className = 'fac';
  span.textContent = name;
  el.appendChild(span);
  el.appendChild(doc.createTextNode(': refer a tenant, earn $50'));
}

function ngApplyCobrand(doc) {
  var view = ngCobrandForLocation((doc.defaultView && doc.defaultView.location && doc.defaultView.location.search) || '');
  if (!view) return null;
  if (doc.documentElement) doc.documentElement.classList.add('is-cobrand');
  var root = doc.getElementById('cobrand');
  if (root && root.getAttribute('data-ready') !== '1') {
    var headline = doc.getElementById('cobrandHeadline');
    if (headline) ngSetCobrandHeadline(headline, view.name);
    var city = doc.getElementById('cobrandCity');
    if (city) city.textContent = view.city;
    var slot = doc.getElementById('cobrandFacilityMark');
    if (slot) ngFillFacilityMark(slot, view);
    var lock = doc.getElementById('cobrandLockup');
    if (lock) lock.setAttribute('aria-label', view.name + ' and Neon Giant');
    if (typeof doc.title === 'string') doc.title = view.headline;
    root.setAttribute('data-ready', '1');
  }
  var intro = doc.querySelector('.signup-intro');
  if (intro && intro.getAttribute('data-cobrand') !== '1') {
    intro.textContent = ngCobrandIntro(view.name);
    intro.setAttribute('data-cobrand', '1');
  }
  var notes = doc.querySelector('textarea[name="message"]');
  if (notes && notes.getAttribute('data-cobrand') !== '1') {
    notes.setAttribute('placeholder', 'Anything we should know? (optional)');
    notes.setAttribute('data-cobrand', '1');
  }
  var eyebrow = doc.querySelector('#signup .eyebrow');
  if (eyebrow) eyebrow.textContent = 'Facility staff';
  var heading = doc.querySelector('#signup h2');
  if (heading) heading.textContent = 'Get your referral link';
  return view;
}

function ngBootFacilityPage() {
  if (typeof document === 'undefined' || !document.querySelector) return;
  function pass() {
    ngApplyCobrand(document);
    ngApplyFacilitySignup(document);
  }
  pass();
  if (!document.querySelector('form.signup-card')) document.addEventListener('DOMContentLoaded', pass);
}

ngBootFacilityPage();
