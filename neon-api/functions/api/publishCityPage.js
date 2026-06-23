/** POST /api/publishCityPage — publish/update a local "movers in {city}" SEO landing page
 *  into WordPress, mirroring publishPartnerPage.js. Self-contained inline-styled HTML posted
 *  to our trusted WP endpoint (neon/v1/city-page) with the shared X-Neon-Key header, so GoDaddy
 *  can't strip auth and kses won't mangle our markup. Pages live at /movers/{slug}.
 *
 *  THE ONE RULE: each page must pass the "delete-the-city-name" test — remove the city name and
 *  the page must STILL be obviously about that specific town. That is enforced by DATA, not code:
 *  every page is driven by a per-city object (intro paragraphs, neighborhoods, cost factors, FAQs,
 *  a real local review/photo). Generic boilerplate = doorway spam = de-indexed. Don't ship a city
 *  with empty/duplicated local fields.
 *
 *  Body: { city:{...per-city data...}, status?:'draft'|'publish' }
 *        or { action:'unpublish'|'delete'|'status', city:{ slug } }
 *  Env: WP_BASE, NEON_WP_KEY
 *  Returns: { ok, url, id, status, action }
 */
import { endpoint, preflight } from '../_shared.js';

/* ----------------------------------------------------------------- helpers */
function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').split('"').join('&quot;');
}
function js(s) { return JSON.stringify(String(s == null ? '' : s)); }
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}
function citySlug(c) {
  // Always end in -wa for a clean, consistent /movers/{city}-wa/ pattern.
  var base = slugify(c.slug || c.city);
  return /-wa$/.test(base) ? base : base + '-wa';
}

/* --------------------------------------------------- brand + shared content */
var NG = {
  PINK: '#FF2FA0', CYAN: '#2BC6FF', INK: '#05070a', PANEL: '#0f1318', PANEL2: '#161b22',
  LINE: '#222933', TXT: '#c4cad3', DIM: '#8b929c', WHITE: '#f4f6f9',
  GRAD: 'linear-gradient(266deg,#2BC6FF -1%,#FF2FA0 100%)',
  SANS: "'DM Sans',-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif",
  HEAD: "'Ubuntu','DM Sans',-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif",
  PHONE_DISPLAY: '(360) 588-4700',
  PHONE_TEL: '+13605884700',
  BASE: 'https://neongiantmoving.com',
  // Real Neon Giant Google reviews (company-wide). The per-city `localReview` is shown
  // separately and should be a genuine review from THAT town.
  REVIEWS: [
    { text: 'Absolutely incredible service. This crew was able to pivot at a moment’s notice and do whatever it took to get the job done. Professionalism and good attitudes the whole way through.', by: 'William R.' },
    { text: 'The moving service was truly superior! Staff were very professional, polite and friendly. I will definitely use them again and would recommend them highly to friends and family.', by: 'Bruce K.' },
    { text: 'The crew called me before they arrived, right on time. They assessed the situation and developed a plan to move the heavy piano. Very efficient and professional. I would gladly use them again.', by: 'Sandra P.' }
  ],
  // Default six service cards (same line-up as iHaul-style pages, in our voice).
  SERVICES: [
    { t: 'Local moving', d: 'Apartments, houses, and acreage anywhere in {CITY} and across {COUNTY}.' },
    { t: 'Washington long-distance', d: 'Moving {CITY} to Seattle, Spokane, or anywhere in-state? We handle the whole haul.' },
    { t: 'Packing & materials', d: 'Full or partial packing, plus boxes, tape, and wrap delivered to your door.' },
    { t: 'Junk removal', d: 'Clearing out before or after the move? We haul it away the same day.' },
    { t: 'Specialty items', d: 'Pianos, gun safes, hot tubs, pool tables, and shop equipment moved with care.' },
    { t: 'Labor-only loading', d: 'Got the truck or container? Book our crew to load, unload, or rearrange.' }
  ]
};

/* ----------------------------------------------------------- page generator */
function cityPageHtml(c) {
  var P = NG;
  var city = c.city || '';
  var county = c.county || 'Whatcom County';
  var slug = citySlug(c);
  var url = P.BASE + '/movers/' + slug + '/';
  var hubUrl = c.hubUrl || (P.BASE + '/movers/' + slugify(county) + '-wa/');
  var quote = P.BASE + '/quote?utm_source=seo&utm_medium=citypage&utm_campaign=' + slug;
  var quoteJunk = P.BASE + '/quote?utm_source=seo&utm_medium=citypage&utm_campaign=' + slugify(city) + '-junk';
  var fill = function (s) { return String(s || '').split('{CITY}').join(city).split('{COUNTY}').join(county); };

  var sec = 'padding:54px 28px;max-width:1000px;margin:0 auto';
  var kicker = 'font-family:' + P.HEAD + ';font-weight:700;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:' + P.CYAN;
  var h2 = 'font-family:' + P.HEAD + ';font-weight:700;color:' + P.WHITE + ';font-size:30px;letter-spacing:-.5px;margin:6px 0 0';
  var h2sm = h2 + ';font-size:24px';
  var card = 'background:' + P.PANEL + ';border:1px solid ' + P.LINE + ';border-radius:18px;padding:26px';
  var chip = 'display:inline-block;background:' + P.PANEL2 + ';border:1px solid ' + P.LINE + ';border-radius:50px;padding:9px 17px;font-weight:500;font-size:14px;color:' + P.WHITE + ';margin:5px 8px 0 0';
  var pill = function (href, label, grad) {
    var base = 'display:inline-block;font-family:' + P.HEAD + ';font-weight:600;font-size:15px;padding:15px 28px;border-radius:50px;text-decoration:none;margin:6px 8px 0 0;';
    var style = grad ? (base + 'background:' + P.GRAD + ';color:#fff;box-shadow:0 0 28px rgba(255,47,160,.5)') : (base + 'background:' + P.PANEL2 + ';color:' + P.WHITE + ';border:1px solid ' + P.LINE);
    return '<a class="ngp" href="' + esc(href) + '" style="' + style + '">' + esc(label) + '</a>';
  };

  // --- data-driven sections (the anti-doorway substance) --------------------
  var intro = (c.intro || []).filter(Boolean).map(function (p) {
    return '<p style="font-size:16.5px;line-height:1.85;color:' + P.TXT + ';margin-top:14px">' + p + '</p>'; // p may carry safe <b> emphasis
  }).join('');

  var services = (c.services || P.SERVICES).map(function (s) {
    return '<div class="ngm" style="background:' + P.PANEL2 + ';border:1px solid ' + P.LINE + ';border-radius:14px;padding:22px"><b style="display:block;color:' + P.WHITE + ';font-family:' + P.HEAD + ';font-size:17px">' + esc(fill(s.t)) + '</b><span style="display:block;color:' + P.DIM + ';font-size:14px;margin-top:7px;line-height:1.6">' + esc(fill(s.d)) + '</span></div>';
  }).join('');

  var areaChips = (c.areas || []).filter(Boolean).map(function (a) {
    return '<span class="ngchip" style="' + chip + '">' + esc(a) + '</span>';
  }).join('');

  var costRows = (c.costFactors || []).map(function (x) {
    return '<div style="color:' + P.TXT + ';font-size:15px;line-height:1.6"><b style="color:' + P.WHITE + '">' + esc(x.t) + '</b> ' + esc(x.d) + '</div>';
  }).join('');

  var faqRows = (c.faqs || []).map(function (q) {
    return '<details style="border-top:1px solid ' + P.LINE + ';padding:16px 0"><summary style="cursor:pointer;font-family:' + P.HEAD + ';font-weight:500;font-size:16.5px;color:' + P.WHITE + ';list-style:none">' + esc(q.q) + '</summary><p style="color:' + P.DIM + ';font-size:15px;margin-top:10px;line-height:1.7">' + esc(q.a) + '</p></details>';
  }).join('');

  var neighbors = (c.neighbors || []).map(function (n) {
    return '<a class="nbr" href="' + esc(P.BASE + '/movers/' + slugify(n.slug || n.name) + (/-wa$/.test(slugify(n.slug || n.name)) ? '' : '-wa') + '/') + '" style="display:inline-block;font-family:' + P.HEAD + ';font-weight:500;font-size:14px;color:' + P.WHITE + ';background:' + P.PANEL2 + ';border:1px solid ' + P.LINE + ';padding:10px 18px;border-radius:50px;margin:6px 8px 0 0;text-decoration:none">' + esc(n.name) + ' movers</a>';
  }).join('') + '<a class="nbr" href="' + esc(hubUrl) + '" style="display:inline-block;font-family:' + P.HEAD + ';font-weight:600;font-size:14px;color:' + P.CYAN + ';background:' + P.PANEL2 + ';border:1px solid rgba(43,198,255,.4);padding:10px 18px;border-radius:50px;margin:6px 8px 0 0;text-decoration:none">All ' + esc(county) + ' &#8594;</a>';

  var companyReviews = (c.reviews || P.REVIEWS).map(function (r) {
    return '<div class="ngc" style="' + card + ';width:330px;flex:none"><div style="color:#FFB02E;letter-spacing:2px">&#9733;&#9733;&#9733;&#9733;&#9733;</div><p style="font-size:15px;color:' + P.WHITE + ';line-height:1.6;margin:10px 0 0">' + esc(r.text) + '</p><div style="margin-top:14px;font-family:' + P.HEAD + ';font-weight:500;color:' + P.DIM + ';font-size:13px">' + esc(r.by) + ' &middot; 5-star Google review</div></div>';
  }).join('');

  // Local proof: a genuine area review + a real local job photo (strongest "this is real" signal).
  var localReviewCard = c.localReview
    ? '<div class="ngc" style="' + card + '"><div style="color:#FFB02E;font-size:15px;letter-spacing:2px">&#9733;&#9733;&#9733;&#9733;&#9733;</div><p style="font-size:16px;color:' + P.WHITE + ';line-height:1.7;margin:12px 0 0">' + esc(c.localReview.text) + '</p><div style="margin-top:14px;font-family:' + P.HEAD + ';font-weight:500;color:' + P.DIM + ';font-size:13px">' + esc(c.localReview.by || (city + ' customer')) + ' &middot; 5-star Google review</div></div>'
    : '';
  var localPhoto = c.localPhoto
    ? '<img src="' + esc(c.localPhoto) + '" alt="Neon Giant Moving crew on a ' + esc(city) + ', WA job" style="width:100%;height:100%;min-height:200px;object-fit:cover;border-radius:18px;border:1px solid ' + P.LINE + '">'
    : '';
  var localProof = (localReviewCard || localPhoto)
    ? '<div class="sec" style="' + sec + '"><div style="' + kicker + '">From a recent ' + esc(city) + ' move</div><h2 style="' + h2sm + '">Real crews, real local jobs</h2><div class="grid2" style="display:grid;grid-template-columns:1.2fr 1fr;gap:18px;margin-top:18px;align-items:stretch">' + localReviewCard + localPhoto + '</div></div>'
    : '';

  // --- schema: MovingCompany (LocalBusiness) + BreadcrumbList ---------------
  // NO self-applied AggregateRating. NO FAQPage (Google retired FAQ rich results in 2026).
  var areaServed = [city].concat(c.neighbors ? c.neighbors.map(function (n) { return n.name; }) : []);
  var ldBiz = {
    '@context': 'https://schema.org', '@type': 'MovingCompany',
    name: 'Neon Giant Moving & Junk Removal', url: url, telephone: '+1-360-588-4700',
    priceRange: '$$', image: c.logo || (P.BASE + '/wp-content/uploads/neon-giant-logo.png'),
    address: {
      '@type': 'PostalAddress',
      streetAddress: c.hqStreet || '[HQ street address to confirm]',
      addressLocality: c.hqLocality || 'Bellingham', addressRegion: 'WA',
      postalCode: c.hqZip || '', addressCountry: 'US'
    },
    areaServed: areaServed.map(function (a) { return { '@type': 'City', name: a + ', WA' }; })
      .concat([{ '@type': 'AdministrativeArea', name: county + ', WA' }]),
    openingHours: c.hours || 'Mo-Sa 07:00-19:00'
  };
  if (c.lat && c.lng) ldBiz.geo = { '@type': 'GeoCoordinates', latitude: c.lat, longitude: c.lng };
  var ldCrumbs = {
    '@context': 'https://schema.org', '@type': 'BreadcrumbList', itemListElement: [
      { '@type': 'ListItem', position: 1, name: 'Home', item: P.BASE + '/' },
      { '@type': 'ListItem', position: 2, name: county + ' Movers', item: hubUrl },
      { '@type': 'ListItem', position: 3, name: city + ' Movers', item: url }
    ]
  };

  // Theme break-out + hover/anim CSS + mobile rules (same approach as partner page).
  var fixCss = '<style>.page-hero-area{display:none!important}.tg-page-area{padding-top:0!important;padding-bottom:0!important}.tg-page-area .container,.tg-page-area .row,.tg-page-area [class*=col-]{max-width:100%!important;padding-left:0!important;padding-right:0!important;margin:0!important}'
    + '#ngCity details summary::-webkit-details-marker{display:none}'
    + '#ngCity .ngc{transition:transform .5s cubic-bezier(.16,.68,.28,1),box-shadow .5s,border-color .45s}#ngCity .ngc:hover{transform:translateY(-9px) scale(1.012);box-shadow:0 28px 72px rgba(0,0,0,.55);border-color:rgba(43,198,255,.5)}'
    + '#ngCity .ngp{transition:transform .35s,box-shadow .35s,filter .35s}#ngCity .ngp:hover{transform:translateY(-3px) scale(1.04);filter:brightness(1.08)}'
    + '#ngCity .ngm{transition:transform .45s ease,border-color .45s,box-shadow .45s}#ngCity .ngm:hover{transform:translateY(-5px);border-color:rgba(43,198,255,.5);box-shadow:0 14px 36px rgba(0,0,0,.4)}'
    + '#ngCity .ngchip,#ngCity .nbr{transition:transform .35s ease,border-color .35s,color .35s}#ngCity .ngchip:hover,#ngCity .nbr:hover{transform:translateY(-3px);border-color:' + P.CYAN + ';color:#fff}'
    + '#ngCity details:hover summary{color:' + P.CYAN + '}#ngCity .crumb a{color:' + P.DIM + ';text-decoration:none}#ngCity .crumb a:hover{color:' + P.CYAN + '}'
    + '@keyframes ngscroll{from{transform:translateX(0)}to{transform:translateX(-50%)}}#ngCity .ngmq{animation:ngscroll 48s linear infinite}#ngCity .ngmqwrap:hover .ngmq{animation-play-state:paused}'
    + '@media(max-width:760px){#ngCity h1{font-size:34px!important}#ngCity .grid2,#ngCity .grid3{grid-template-columns:1fr!important}#ngCity .sec{padding:38px 20px!important}#ngCity .hero{padding:96px 20px 52px!important}}'
    + '</style>';

  // Reveal-on-scroll (bulletproof: always resolves to visible; never pre-hides via CSS).
  var animScript = "<script>(function(){var r=document.getElementById('ngCity');if(!r||typeof r.animate!=='function'||!('IntersectionObserver' in window))return;var secs=[].slice.call(r.querySelectorAll('.sec,.band'));function rev(s,i){try{var dx=(i%2?70:-70);s.animate([{opacity:0,transform:'translate('+dx+'px,42px)'},{opacity:1,transform:'none'}],{duration:1200,easing:'cubic-bezier(.16,.68,.28,1)',fill:'backwards'});}catch(e){}}var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){var i=secs.indexOf(e.target);rev(e.target,i<0?0:i);io.unobserve(e.target);}});},{threshold:.04,rootMargin:'0px 0px -50px 0px'});secs.forEach(function(s){io.observe(s);});})();</script>";

  return fixCss
    + '<div id="ngCity" style="background:' + P.INK + ';color:' + P.TXT + ';font-family:' + P.SANS + ';line-height:1.65;margin:0;width:100vw;max-width:100vw;margin-left:calc(50% - 50vw);overflow:hidden">'
    // HERO
    + '<div class="hero" style="position:relative;overflow:hidden;border-bottom:1px solid ' + P.LINE + ';background:radial-gradient(105% 80% at 34% 42%,rgba(255,47,160,.40),rgba(255,47,160,0) 56%),radial-gradient(90% 90% at 100% 100%,rgba(43,198,255,.18),transparent 60%),#120814;padding:120px 28px 64px">'
    + '<div style="position:relative;z-index:2;max-width:1000px;margin:0 auto">'
    + '<div class="crumb" style="font-size:13px;color:' + P.DIM + ';margin-bottom:18px"><a href="' + esc(P.BASE) + '/">Home</a> &#8250; <a href="' + esc(hubUrl) + '">' + esc(county) + ' Movers</a> &#8250; <span style="color:' + P.WHITE + '">' + esc(city) + '</span></div>'
    + '<span style="display:inline-block;background:rgba(43,198,255,.1);border:1px solid rgba(43,198,255,.4);color:' + P.CYAN + ';font-family:' + P.HEAD + ';font-weight:500;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;padding:7px 15px;border-radius:50px">' + esc(county) + ' &middot; Washington</span>'
    + '<h1 style="font-family:' + P.HEAD + ';font-weight:700;color:' + P.WHITE + ';font-size:50px;letter-spacing:-1px;margin:16px 0 10px;text-shadow:0 0 36px rgba(255,47,160,.28)">Movers in ' + esc(city) + ', WA</h1>'
    + '<p style="font-size:19px;color:' + P.WHITE + ';max-width:640px;margin:0">' + esc(c.lead || ('Local, family-run moving and junk removal across ' + city + '. Big moves, bright attitude, zero stress.')) + '</p>'
    + '<div style="margin-top:24px">' + pill(quote, 'Get my free ' + city + ' quote', true) + pill('tel:' + P.PHONE_TEL, 'Call ' + P.PHONE_DISPLAY, false) + '</div>'
    + '<div style="margin-top:20px;color:' + P.DIM + ';font-weight:500;font-size:14px"><span style="color:#FFB02E">&#9733;&#9733;&#9733;&#9733;&#9733;</span> Rated 4.9 from 400+ Google reviews &nbsp;&middot;&nbsp; Licensed &amp; insured &nbsp;&middot;&nbsp; Locally owned in ' + esc(county) + '</div>'
    + '</div></div>'
    // LOCAL INTRO
    + '<div class="sec" style="' + sec + '"><div style="' + kicker + '">Your ' + esc(city) + ' moving crew</div><h2 style="' + h2 + '">' + esc(c.introHeading || ('We know every corner of ' + city)) + '</h2>' + intro + '</div>'
    // SERVICES
    + '<div class="sec" style="padding:0 28px 20px;max-width:1000px;margin:0 auto"><div style="' + kicker + '">What we do in ' + esc(city) + '</div><h2 style="' + h2 + '">Moving &amp; junk removal services</h2><div class="grid3" style="display:grid;grid-template-columns:1fr 1fr 1fr;gap:16px;margin-top:22px">' + services + '</div></div>'
    // NEIGHBORHOODS
    + (areaChips ? '<div class="sec" style="padding:34px 28px;max-width:1000px;margin:0 auto"><div style="' + kicker + '">Areas we serve</div><h2 style="' + h2sm + '">' + esc(city) + ' neighborhoods &amp; areas</h2><div style="margin-top:14px">' + areaChips + '</div></div>' : '')
    // COST FACTORS
    + (costRows ? '<div class="sec" style="padding:34px 28px;max-width:1000px;margin:0 auto"><div style="' + card + '"><div style="' + kicker + '">No surprises</div><h2 style="' + h2sm + '">What affects the cost of a ' + esc(city) + ' move</h2><p style="color:' + P.DIM + ';font-size:14px;margin-top:8px">Every move is quoted for free. Here’s what moves the number up or down locally:</p><div class="grid2" style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:18px">' + costRows + '</div></div></div>' : '')
    // LOCAL PROOF
    + localProof
    // REVIEWS MARQUEE
    + '<div class="band" style="padding:40px 0"><div style="max-width:1000px;margin:0 auto;padding:0 28px"><div style="' + kicker + '">Reviews</div><h2 style="' + h2sm + '">Rated 4.9 from 400+ Google reviews <span style="color:#FFB02E">&#9733;&#9733;&#9733;&#9733;&#9733;</span></h2><div style="color:' + P.DIM + ';margin-top:8px">Real reviews from Neon Giant Moving &amp; Junk Removal customers across ' + esc(county) + '.</div></div><div class="ngmqwrap" style="overflow:hidden;margin-top:22px"><div class="ngmq" style="display:flex;gap:18px;width:max-content;padding:6px 28px">' + companyReviews + companyReviews + '</div></div></div>'
    // JUNK REMOVAL CROSS-SELL
    + '<div class="band" style="border-top:1px solid ' + P.LINE + ';border-bottom:1px solid ' + P.LINE + ';background:linear-gradient(90deg,rgba(255,47,160,.06),rgba(43,198,255,.06));padding:46px 28px;text-align:center"><div style="max-width:820px;margin:0 auto"><div style="' + kicker + '">One crew, two jobs</div><h2 style="' + h2sm + ';font-size:26px">Moving out of ' + esc(city) + '? We’ll haul the junk, too.</h2><p style="color:' + P.TXT + ';font-size:16px;margin:14px auto 0;max-width:620px;line-height:1.7">' + esc(c.junkLine || ('From garage cleanouts to debris after a remodel, our crews remove and dispose of whatever you’re not taking — same visit, same bright crew. Moving and junk removal in one stop.')) + '</p>' + pill(quoteJunk, 'Get a junk removal quote', false) + '</div></div>'
    // FAQ (visible only)
    + (faqRows ? '<div class="sec" style="padding:48px 28px;max-width:1000px;margin:0 auto"><div style="' + kicker + '">Common questions</div><h2 style="' + h2sm + '">Moving in ' + esc(city) + ' — FAQ</h2><div class="ngc" style="' + card + ';padding:6px 26px;margin-top:16px">' + faqRows + '</div></div>' : '')
    // MAP
    + '<div class="sec" style="padding:0 28px 48px;max-width:1000px;margin:0 auto"><div style="' + kicker + '">Service area</div><h2 style="' + h2sm + ';margin-bottom:14px">Proudly serving ' + esc(city) + ' &amp; all of ' + esc(county) + '</h2><div style="border:1px solid ' + P.LINE + ';border-radius:18px;overflow:hidden;line-height:0"><iframe title="Map of ' + esc(city) + ', WA" src="https://www.google.com/maps?q=' + encodeURIComponent((c.mapQuery || (city + ', WA'))) + '&output=embed" width="100%" height="340" style="border:0;display:block" loading="lazy" referrerpolicy="no-referrer-when-downgrade"></iframe></div></div>'
    // NEARBY (silo)
    + ((c.neighbors && c.neighbors.length) ? '<div class="sec" style="padding:0 28px 48px;max-width:1000px;margin:0 auto"><div style="' + kicker + '">Nearby</div><h2 style="' + h2sm + '">Other ' + esc(county) + ' towns we move</h2><div style="margin-top:14px">' + neighbors + '</div></div>' : '')
    // FINAL CTA
    + '<div class="sec" style="padding:0 28px 54px;max-width:1000px;margin:0 auto"><div style="background:radial-gradient(circle at 30% 0%,rgba(255,47,160,.22),transparent 55%),radial-gradient(circle at 80% 100%,rgba(43,198,255,.2),transparent 55%),' + P.PANEL + ';border:1px solid ' + P.LINE + ';border-radius:18px;text-align:center;padding:52px 28px"><h2 style="' + h2 + '">Ready for a bright move in ' + esc(city) + '?</h2><p style="max-width:560px;margin:14px auto 24px;color:' + P.TXT + ';font-size:17px">Big moves, bright attitude, zero stress. Get a free, no-pressure quote from a crew that already knows your town.</p>' + pill(quote, 'Get my free ' + city + ' quote', true) + pill('tel:' + P.PHONE_TEL, 'Call ' + P.PHONE_DISPLAY, false) + '</div></div>'
    // FOOTER / NAP
    + '<div style="border-top:1px solid ' + P.LINE + ';background:#04060a;padding:34px 28px;text-align:center"><div style="font-family:' + P.HEAD + ';color:' + P.WHITE + ';font-weight:500;font-size:16px">Neon Giant Moving &amp; Junk Removal</div><div style="color:' + P.DIM + ';font-size:14px;margin-top:8px">Serving ' + esc(city) + ' &amp; all of ' + esc(county) + ', WA &nbsp;&middot;&nbsp; <a href="tel:' + P.PHONE_TEL + '" style="color:' + P.CYAN + ';text-decoration:none">' + P.PHONE_DISPLAY + '</a></div><div style="color:#5e656f;font-size:12px;margin-top:6px">' + esc(c.napLine || '[HQ street address to confirm] &middot; Licensed & insured &middot; WUTC permit #HG-XXXXX') + '</div></div>'
    // SCHEMA
    + '<script type="application/ld+json">' + JSON.stringify(ldBiz) + '</script><script type="application/ld+json">' + JSON.stringify(ldCrumbs) + '</script>'
    + '</div>' + animScript;
}

/* ------------------------------------------------------------- WP transport */
async function ngWp(env, payload) {
  var r = await fetch(env.WP_BASE.replace(/\/$/, '') + '/wp-json/neon/v1/city-page', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Neon-Key': env.NEON_WP_KEY },
    body: JSON.stringify(payload),
  });
  var txt = await r.text();
  var json; try { json = JSON.parse(txt); } catch (e) { json = txt; }
  return { ok: r.ok, status: r.status, json: json };
}

/* ----------------------------------------------------------------- handler */
const handler = endpoint(async function (ctx) {
  var env = ctx.env, body = ctx.body, reply = ctx.reply;
  if (!env.WP_BASE || !env.NEON_WP_KEY) {
    return reply({ ok: false, error: 'wordpress_not_configured', note: 'Set WP_BASE and NEON_WP_KEY, and install the neon/v1/city-page snippet.' }, 503);
  }
  var c = (body && body.city) || {};
  var slug = citySlug(c);
  if (!slug || slug === '-wa') return reply({ ok: false, error: 'missing_city' }, 400);
  var action = body.action || 'publish';

  if (action === 'status') {
    var purl = env.WP_BASE.replace(/\/$/, '') + '/movers/' + slug + '/';
    var live = false, code = 0;
    try { var sr = await fetch(purl, { method: 'GET', redirect: 'manual' }); code = sr.status; live = (code >= 200 && code < 300); } catch (e) {}
    return reply({ ok: true, action: 'status', slug: slug, live: live, code: code, url: purl });
  }

  if (action === 'unpublish' || action === 'delete') {
    var del = await ngWp(env, { slug: slug, action: action });
    return reply(del.ok ? del.json : { ok: false, error: 'wp_rejected', status: del.status, message: del.json }, del.ok ? 200 : 502);
  }

  // Guardrail: refuse to publish a thin/doorway page. Genuine local substance is required.
  var missing = [];
  if (!(c.intro && c.intro.join(' ').replace(/<[^>]+>/g, '').length > 350)) missing.push('intro (3 local paragraphs)');
  if (!(c.areas && c.areas.length >= 4)) missing.push('areas (4+ neighborhoods)');
  if (!(c.faqs && c.faqs.length >= 3)) missing.push('faqs (3+ local)');
  if (!(c.costFactors && c.costFactors.length >= 3)) missing.push('costFactors (3+)');
  if (missing.length) {
    return reply({ ok: false, error: 'thin_content_blocked', note: 'Add genuine local content before publishing — passes the delete-the-city-name test.', missing: missing }, 422);
  }

  var city = c.city || '';
  var county = c.county || 'Whatcom County';
  var seoTitle = 'Movers in ' + city + ', WA | Neon Giant Moving & Junk Removal';
  var seoDesc = 'Local ' + city + ', WA movers. Family-run moving and junk removal across ' + city + ' and ' + county + ' — licensed, insured, and minutes away. Get a free quote.';

  var res = await ngWp(env, {
    slug: slug,
    title: seoTitle,
    content: cityPageHtml(c),
    excerpt: seoDesc,
    status: (body.status === 'publish') ? 'publish' : 'draft',
    seo_title: seoTitle,
    seo_description: seoDesc,
    // card fields for the /movers hub directory
    card_city: city,
    card_county: county,
    card_blurb: c.lead || '',
  });

  if (!res.ok || !res.json || res.json.ok === false) {
    return reply({ ok: false, error: 'wp_rejected', status: res.status, message: (res.json && (res.json.error || res.json.message)) || res.json }, 502);
  }
  return reply({ ok: true, action: res.json.action, id: res.json.id, status: res.json.status, url: res.json.url });
});

export const onRequestPost = handler;
export const onRequestOptions = function (ctx) { return preflight(ctx.request); };

/* ============================================================================
 * CITY DATA — the per-city objects that drive each page. THIS is where the
 * anti-doorway substance lives. Ferndale is the approved prototype; add Lynden
 * and Blaine the same way (genuine local detail, never boilerplate).
 * ==========================================================================*/
export const CITY_DATA = {
  'ferndale-wa': {
    slug: 'ferndale-wa',
    city: 'Ferndale',
    county: 'Whatcom County',
    mapQuery: 'Ferndale, WA',
    lat: 48.8465, lng: -122.5912,
    lead: 'Local, family-run moving and junk removal — from the Mountain View subdivisions to the Sandy Point canals. Big moves, bright attitude, zero stress.',
    introHeading: 'We know every corner of Ferndale',
    intro: [
      'Ferndale sits right on the Nooksack River where <b style="color:#f4f6f9">I-5 exits 262 and 263</b> drop you into town — and that mix of quick highway access and tucked-away neighborhoods is exactly why local know-how matters on move day. Neon Giant is based minutes south in the Bellingham–Burlington corridor, so a Ferndale job is a short, efficient haul for our crews, not a half-day road trip you end up paying for.',
      'We move every part of town: the newer subdivisions climbing the hill around <b style="color:#f4f6f9">Mountain View</b> and Vista Drive, the older riverfront homes near <b style="color:#f4f6f9">Pioneer Park</b> and the Centennial Riverwalk downtown, and the canal-front houses out at <b style="color:#f4f6f9">Sandy Point Shores</b>, where narrow lanes and tight turns sometimes mean we shuttle your belongings with a smaller truck. Head west toward <b style="color:#f4f6f9">Lake Terrell, Slater Road, and the Lummi area</b> and you’re into acreage, long gravel driveways, barns, and outbuildings — we plan access and floor protection for those before the truck ever rolls.',
      'A lot of our Ferndale moves are families upsizing into new construction, <b style="color:#f4f6f9">Cherry Point</b> and refinery workers relocating on shift-friendly schedules, and folks making the ten-minute hop to or from Bellingham. Winter here brings the cold Fraser outflow winds and the odd ice day funneling down the Nooksack valley, so we pad, wrap, and protect floors and doorways no matter the season.'
    ],
    areas: ['Downtown & Riverwalk', 'Mountain View', 'Vista', 'Sandy Point Shores', 'Lake Terrell', 'Slater Road', 'Cherry Point', 'Lummi area', 'Pioneer Park', 'Malloy & Enterprise'],
    costFactors: [
      { t: 'How far we travel.', d: 'Ferndale is a short hop from our Bellingham–Burlington base, so you’re not paying for long drive time.' },
      { t: 'Home size.', d: 'Studio to five-bedroom — how much there is to load is the biggest factor.' },
      { t: 'Access.', d: 'Sandy Point’s narrow canal lanes or a long rural driveway off Slater or Lake Terrell Road may need a shuttle or extra carry time.' },
      { t: 'Stairs & parking.', d: 'Tight downtown parking near the Riverwalk and multi-level homes add handling time.' },
      { t: 'Packing.', d: 'Full-service packing vs. you-pack, plus materials.' },
      { t: 'Timing.', d: 'Summer and month-end weekends book up first — flexible dates save money.' }
    ],
    faqs: [
      { q: 'Do you move homes out at Sandy Point Shores?', a: 'Yes. The canal-front lanes out there are tight, so we’ll often bring a smaller shuttle truck and plan the carry ahead of time. Tell us the address when you book and we’ll scope access first.' },
      { q: 'Can you handle a rural move off Slater Road, Lake Terrell, or near the Lummi Reservation?', a: 'Absolutely — acreage, long gravel driveways, barns, and outbuildings are routine for us. We bring the right truck and dollies for the ground conditions.' },
      { q: 'We’re only moving from Ferndale to Bellingham — is that worth booking a crew?', a: 'Definitely. It’s about a ten-minute hop, which keeps it one of the most affordable moves we do — same care, short drive time.' },
      { q: 'Do you work around Cherry Point and refinery shift schedules?', a: 'We do. Early starts, weekends, and odd days are no problem — just tell us your window and we’ll build the crew around it.' },
      { q: 'Can you also haul away junk when we move?', a: 'Yes. We’ll clear the garage, old furniture, or yard debris the same day as your move — moving and junk removal in one stop.' },
      { q: 'Do you move during winter when the Fraser outflow winds and ice hit?', a: 'Year-round. We pad, wrap, and protect for the weather and keep an eye on the rural roads on icy days so your move stays on schedule.' }
    ],
    junkLine: 'From garage cleanouts off Mountain View to debris after a remodel near the Riverwalk, our crews remove and dispose of whatever you’re not taking — same visit, same bright crew. Moving and junk removal in one stop.',
    // TODO: drop in a REAL Ferndale-area Google review + a REAL crew photo from a Ferndale job.
    localReview: null,
    localPhoto: null,
    neighbors: [
      { name: 'Bellingham', slug: 'bellingham-wa' },
      { name: 'Lynden', slug: 'lynden-wa' },
      { name: 'Blaine', slug: 'blaine-wa' },
      { name: 'Birch Bay', slug: 'birch-bay-wa' },
      { name: 'Custer', slug: 'custer-wa' },
      { name: 'Everson', slug: 'everson-wa' }
    ]
  }
};

export { cityPageHtml };
