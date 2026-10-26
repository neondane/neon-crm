// Facility staff signup for printed QR sheets:
//   https://refer.neongiantmoving.com/?utm_source=<facility-slug>&utm_medium=flyer
//   also accepts ?facility=<slug>
// No flyer build script lives in this repo. These are the slugs on the sheets.
// An unknown slug is title-cased so a new facility still prefills.

var NG_FACILITIES = {
  'advanced-heated-self-storage': 'Advanced Heated Self Storage',
  'discovery-park-heated-storage': 'Discovery Park Heated Storage',
  'ferndale-self-storage': 'Ferndale Self Storage',
  'glacier-west-self-storage': 'Glacier West Self Storage',
  'pacific-self-storage-bellingham': 'Pacific Self Storage Bellingham',
  'pacific-self-storage-ferndale': 'Pacific Self Storage Ferndale',
  'public-storage-bellingham': 'Public Storage Bellingham',
  'storage-court-bellingham': 'Storage Court Bellingham',
  'storehouse-mini-storage': 'Storehouse Mini Storage',
  'storquest-bellingham': 'StorQuest Bellingham',
  'sunset-park-self-storage': 'Sunset Park Self Storage',
  'sedro-woolley-mini-storage': 'Sedro-Woolley Mini Storage',
  'skagit-self-storage': 'Skagit Self Storage',
  'urban-storage-on-bennett': 'Urban Storage on Bennett',
  'alger-mini-storage': 'Alger Mini Storage',
  'pantec-mini-storage': 'Pantec Mini Storage',
  'cubesmart-bellingham': 'CubeSmart Bellingham',
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

// Prefer an explicit ?facility= slug, then the QR utm_source.
function ngFacilityFromLocation(search) {
  var q = new URLSearchParams(search || '');
  var slug = ngFacilitySlug(q.get('facility') || q.get('utm_source') || '');
  if (!slug) return null;
  return { slug: slug, name: NG_FACILITIES[slug] || ngTitleCaseSlug(slug) };
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

if (typeof document !== 'undefined' && document.querySelector) {
  ngApplyFacilitySignup(document);
}
