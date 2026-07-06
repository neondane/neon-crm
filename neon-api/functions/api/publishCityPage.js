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
  },

  'lynden-wa': {
    slug: 'lynden-wa',
    city: 'Lynden',
    county: 'Whatcom County',
    mapQuery: 'Lynden, WA',
    lat: 48.9465, lng: -122.4522,
    lead: 'Local, family-run moving and junk removal, from the historic Front Street windmill to the new builds out along the Guide. Big moves, bright attitude, zero stress.',
    introHeading: 'We know every corner of Lynden',
    intro: [
      'Lynden sits about 15 minutes northeast of Bellingham up the <b style="color:#f4f6f9">Guide Meridian (SR 539)</b>, close enough that our crews treat it as a short, efficient run rather than a long haul you end up paying for. Downtown is built on the old grid around <b style="color:#f4f6f9">Front Street and Grover</b>, where the Dutch storefronts and the windmill sit on tight blocks with limited parking, so local know-how matters on move day.',
      'We move every part of town: the older homes on the downtown grid near <b style="color:#f4f6f9">City Park and the Jim Kaemingk Trail</b>, the newer subdivisions filling in on the east and north sides past <b style="color:#f4f6f9">Bender and Depot Road</b>, and the dairy and berry acreage that rings the city out toward <b style="color:#f4f6f9">Berthusen Park, Northwood, and the Everson line</b>. On those farm parcels you get long gravel driveways, barns, and outbuildings, and we plan access and floor protection before the truck ever rolls.',
      'A lot of our Lynden moves are families upsizing into new construction, farm and ag families relocating around the season, and cross-border commuters, since the <b style="color:#f4f6f9">Lynden-Aldergrove border crossing</b> is only about five miles up the Guide. Fair week in August packs Front Street and the fairgrounds for the <b style="color:#f4f6f9">Northwest Washington Fair</b>, so we schedule around the crowds and closures to keep your move on time.'
    ],
    areas: ['Downtown & Front Street', 'Grover Street', 'City Park', 'Jim Kaemingk Trail', 'Bender Road', 'Depot Road', 'Berthusen', 'Northwood', 'Fairway', 'Guide Meridian corridor'],
    costFactors: [
      { t: 'How far we travel.', d: 'Lynden is a short run up the Guide from our Bellingham-Burlington base, so you are not paying for long drive time.' },
      { t: 'Home size.', d: 'Studio to five-bedroom farmhouse, how much there is to load is the biggest factor.' },
      { t: 'Access.', d: 'A long gravel driveway on the dairy acreage, or tight parking on the downtown grid near Front Street, can add shuttle or carry time.' },
      { t: 'Stairs & parking.', d: 'Older two-story homes downtown and limited street parking add handling time.' },
      { t: 'Packing.', d: 'Full-service packing vs. you-pack, plus materials.' },
      { t: 'Timing.', d: 'Fair week in August and month-end weekends book up first, flexible dates save money.' }
    ],
    faqs: [
      { q: 'Do you move the older homes on the downtown grid near Front Street?', a: 'Yes. Those blocks have tight parking and plenty of stairs, so we plan the truck size and carry path ahead of time. Tell us the address when you book.' },
      { q: 'Can you handle a farm or acreage move out toward Berthusen or the Everson line?', a: 'Absolutely. Long gravel driveways, barns, and outbuildings are routine for us, and we bring the right trucks and dollies for the ground.' },
      { q: 'We are only moving from Lynden to Bellingham, is that worth booking a crew?', a: 'Definitely. It is about a 15-minute run down the Guide, which keeps it one of the more affordable moves we do.' },
      { q: 'Do you work around the border and cross-border schedules?', a: 'We do. The Lynden-Aldergrove crossing is close, and we build the crew around your window, early starts and odd days included.' },
      { q: 'Can you also haul away junk when we move?', a: 'Yes. We will clear the garage, old furniture, or barn junk the same day as your move, moving and junk removal in one stop.' },
      { q: 'Can you schedule around Northwest Washington Fair week?', a: 'Yes, and we recommend it. Front Street and the fairgrounds get packed in August, so we plan routes and timing around the crowds.' }
    ],
    junkLine: 'From garage cleanouts near City Park to barn and remodel debris out on the acreage, our crews remove and dispose of whatever you are not taking, same visit, same bright crew. Moving and junk removal in one stop.',
    // TODO: drop in a REAL Lynden-area Google review + a REAL crew photo from a Lynden job.
    localReview: null,
    localPhoto: null,
    neighbors: [
      { name: 'Bellingham', slug: 'bellingham-wa' },
      { name: 'Ferndale', slug: 'ferndale-wa' },
      { name: 'Everson', slug: 'everson-wa' },
      { name: 'Nooksack', slug: 'nooksack-wa' },
      { name: 'Sumas', slug: 'sumas-wa' },
      { name: 'Blaine', slug: 'blaine-wa' }
    ]
  },

  'blaine-wa': {
    slug: 'blaine-wa',
    city: 'Blaine',
    county: 'Whatcom County',
    mapQuery: 'Blaine, WA',
    lat: 48.9937, lng: -122.7466,
    lead: 'Local, family-run moving and junk removal, from the Semiahmoo waterfront to the neighborhoods above Peace Portal. Big moves, bright attitude, zero stress.',
    introHeading: 'We know every corner of Blaine',
    intro: [
      'Blaine sits at the very top of I-5 where the freeway meets the Canadian border, wrapped around <b style="color:#f4f6f9">Drayton Harbor</b>. Our crews run straight up I-5 from the Bellingham-Burlington corridor, so a Blaine job is a short, efficient haul rather than the all-day trip the distance on a map might suggest. Being a true border town shapes move day here, from crossing traffic to the seasonal rhythm of the waterfront.',
      'We move every part of town: the older Victorian and cottage homes downtown near <b style="color:#f4f6f9">Peace Portal Drive and the Salishan neighborhood</b>, the marina-side condos and townhomes along <b style="color:#f4f6f9">Marine Drive and Blaine Harbor</b>, and the luxury waterfront homes out on <b style="color:#f4f6f9">Semiahmoo Spit</b>, where the gated resort roads and narrow spit lanes often mean we plan the carry and sometimes shuttle with a smaller truck. Inland along <b style="color:#f4f6f9">H Street and Boblett</b> you are into newer subdivisions and some acreage.',
      'A lot of our Blaine moves are cross-border relocations, seasonal and second-home owners on the water at Semiahmoo and nearby <b style="color:#f4f6f9">Birch Bay</b>, and retirees right-sizing into the condos near the harbor. Winter brings wind and salt air off the bay, so we pad, wrap, and protect against the weather, and we plan around <b style="color:#f4f6f9">Peace Arch crossing</b> traffic so your move stays on schedule.'
    ],
    areas: ['Downtown & Peace Portal', 'Marine Drive', 'Blaine Harbor', 'Semiahmoo Spit', 'Salishan', 'Drayton Harbor', 'H Street Road', 'Boblett', 'Birch Bay line', 'Peace Arch'],
    costFactors: [
      { t: 'How far we travel.', d: 'Blaine is a straight shot up I-5 from our base, so you are not paying for guesswork on drive time.' },
      { t: 'Home size.', d: 'Studio condo to waterfront estate, how much there is to load is the biggest factor.' },
      { t: 'Access.', d: 'Semiahmoo spit lanes, gated resort roads, or a marina-side condo with elevators and loading zones can add shuttle or carry time.' },
      { t: 'Stairs & parking.', d: 'Older downtown homes near Peace Portal and multi-level condos add handling time.' },
      { t: 'Packing.', d: 'Full-service packing vs. you-pack, plus materials.' },
      { t: 'Timing.', d: 'Summer and month-end weekends book up first, and cross-border moves need extra planning, so flexible dates save money.' }
    ],
    faqs: [
      { q: 'Do you move the waterfront homes out on Semiahmoo Spit?', a: 'Yes. The spit lanes and gated resort roads are tight, so we plan the carry and often bring a smaller shuttle truck. Give us the address when you book and we will scope access first.' },
      { q: 'Can you handle a condo move near Blaine Harbor or Marine Drive with elevators and loading zones?', a: 'Absolutely. Marina-side condos are routine for us, and we coordinate elevators, loading zones, and HOA move windows ahead of time.' },
      { q: 'We are doing a cross-border move through the Peace Arch, can you help?', a: 'We handle the Washington side of the move and plan around crossing traffic. For anything crossing into Canada we coordinate timing with you so nothing sits waiting at the border.' },
      { q: 'Do you move out to Birch Bay too?', a: 'Yes. Birch Bay is right next door, and we move the resort homes, mobile parks, and year-round houses there all the time.' },
      { q: 'Can you also haul away junk when we move?', a: 'Yes. We will clear the garage, old furniture, or yard and dock debris the same day as your move, moving and junk removal in one stop.' },
      { q: 'Do you move in winter when the wind and salt air come off the bay?', a: 'Year-round. We pad, wrap, and protect against the weather and keep move day on schedule.' }
    ],
    junkLine: 'From condo cleanouts near Blaine Harbor to yard and dock debris out toward Semiahmoo, our crews remove and dispose of whatever you are not taking, same visit, same bright crew. Moving and junk removal in one stop.',
    // TODO: drop in a REAL Blaine-area Google review + a REAL crew photo from a Blaine job.
    localReview: null,
    localPhoto: null,
    neighbors: [
      { name: 'Birch Bay', slug: 'birch-bay-wa' },
      { name: 'Custer', slug: 'custer-wa' },
      { name: 'Ferndale', slug: 'ferndale-wa' },
      { name: 'Lynden', slug: 'lynden-wa' },
      { name: 'Bellingham', slug: 'bellingham-wa' }
    ]
  },

  'anacortes-wa': {
    slug: 'anacortes-wa',
    city: 'Anacortes',
    county: 'Skagit County',
    mapQuery: 'Anacortes, WA',
    lat: 48.5126, lng: -122.6127,
    lead: 'Local, family-run moving and junk removal on Fidalgo Island, from the Cap Sante waterfront to Skyline and Old Town. Big moves, bright attitude, zero stress.',
    introHeading: 'We know every corner of Anacortes',
    intro: [
      'Anacortes sits out on the north end of <b style="color:#f4f6f9">Fidalgo Island</b>, reached by the <b style="color:#f4f6f9">SR 20 bridge over the Swinomish Channel</b>, so every move here has an island rhythm to it even though you never wait for a ferry to reach town. Neon Giant runs Anacortes constantly from our Skagit base, and knowing the bridge, the tight downtown blocks, and the waterfront access is what keeps an Anacortes move on schedule.',
      'We move every part of the island: the luxury waterfront homes and marina condos out on <b style="color:#f4f6f9">Cap Sante</b> and around Old Town, the view homes on <b style="color:#f4f6f9">Skyline and Rock Ridge</b> on the west side near Washington Park and the marinas, the historic places downtown off <b style="color:#f4f6f9">Commercial Avenue</b>, and the newer builds out toward <b style="color:#f4f6f9">March Point</b>. Waterfront and marina moves mean docks, ramps, tides, and sometimes a long carry, and we scope all of that before the truck rolls.',
      'A lot of our Anacortes moves are folks retiring or right-sizing to the water, boaters and second-home owners, and <b style="color:#f4f6f9">Marathon and HF Sinclair refinery</b> families relocating on shift schedules. Salt air and wind off Guemes Channel and Rosario Strait are part of the deal out here, so we pad, wrap, and protect against the weather year-round.'
    ],
    areas: ['Cap Sante', 'Old Town', 'Commercial Avenue', 'Skyline', 'Rock Ridge', 'Washington Park', 'March Point', 'Ship Harbor', 'Guemes Channel waterfront', 'Fidalgo Island'],
    costFactors: [
      { t: 'How far we travel.', d: 'Anacortes is a routine run from our Skagit base over the SR 20 bridge, so you are not paying for a long haul.' },
      { t: 'Home size.', d: 'Studio condo to waterfront estate, how much there is to load is the biggest factor.' },
      { t: 'Access.', d: 'Cap Sante and Skyline waterfront homes, marina docks, and tight Old Town streets can add ramp, dock, or carry time.' },
      { t: 'Stairs & parking.', d: 'Multi-level view homes and narrow downtown blocks off Commercial add handling time.' },
      { t: 'Packing.', d: 'Full-service packing vs. you-pack, plus materials.' },
      { t: 'Timing.', d: 'Summer and month-end weekends book up first, flexible dates save money.' }
    ],
    faqs: [
      { q: 'Do you move the waterfront and marina homes around Cap Sante?', a: 'Yes. Waterfront and dock access, ramps, and tides are routine for us, and we plan the carry and truck placement ahead of time. Give us the address when you book.' },
      { q: 'Can you handle a Skyline or Washington Park move on the west end of Fidalgo?', a: 'Absolutely. We move that side of the island all the time, including view homes with long driveways and multiple levels.' },
      { q: 'Do you work around Marathon and HF Sinclair refinery shift schedules at March Point?', a: 'We do. Early starts, weekends, and odd days are no problem, just tell us your window and we build the crew around it.' },
      { q: 'We are moving within Anacortes or over to Mount Vernon or Burlington, is that worth a crew?', a: 'Definitely. Short island-to-mainland hops over the bridge are some of the more affordable moves we do, same care, short drive.' },
      { q: 'Can you also haul away junk when we move?', a: 'Yes. We will clear the garage, old furniture, or dock and yard debris the same day as your move, moving and junk removal in one stop.' },
      { q: 'Do you move in winter with the wind and salt air off the channel?', a: 'Year-round. We pad, wrap, and protect against the weather and keep move day on schedule.' }
    ],
    junkLine: 'From garage cleanouts in Old Town to dock and yard debris out on Skyline, our crews remove and dispose of whatever you are not taking, same visit, same bright crew. Moving and junk removal in one stop.',
    localReview: null,
    localPhoto: null,
    neighbors: [
      { name: 'La Conner', slug: 'la-conner-wa' },
      { name: 'Mount Vernon', slug: 'mount-vernon-wa' },
      { name: 'Burlington', slug: 'burlington-wa' },
      { name: 'Sedro-Woolley', slug: 'sedro-woolley-wa' }
    ]
  },

  'orcas-island-wa': {
    slug: 'orcas-island-wa',
    city: 'Orcas Island',
    county: 'San Juan County',
    mapQuery: 'Orcas Island, WA',
    lat: 48.6968, lng: -122.9126,
    lead: 'Ferry-served moving and junk removal across Orcas Island, from the ferry landing to Eastsound, Deer Harbor, and Doe Bay. Big moves, bright attitude, zero stress.',
    introHeading: 'We know every corner of Orcas Island',
    intro: [
      'An Orcas Island move starts at the <b style="color:#f4f6f9">Anacortes ferry terminal</b>, and that is exactly where island know-how earns its keep. We book our truck onto a Washington State Ferries sailing ahead of time, since vehicle reservations for the San Juans go fast and release in waves two months, two weeks, and two days out, and we check the rig in at least 30 minutes early so nothing gets bumped. Getting the crew, the truck, and your belongings across on the same schedule is the whole game on Orcas, and we plan it down to the sailing.',
      'Once we roll off at <b style="color:#f4f6f9">Orcas Village</b>, the island opens up: the shops and homes around <b style="color:#f4f6f9">Eastsound</b> about eight miles north, the west-side waterfront out at <b style="color:#f4f6f9">Deer Harbor and West Sound</b>, the quiet south end near <b style="color:#f4f6f9">Olga and Rosario</b>, and the far east end at <b style="color:#f4f6f9">Doe Bay</b> below Moran State Park and Mount Constitution. The roads here wind, climb, and narrow, so we bring the right truck for the driveway and plan the carry before we ever leave the dock.',
      'A lot of our Orcas moves are folks settling into second homes and waterfront retirements, seasonal owners timing a move around the summer rush, and island families right-sizing. Because every trip on and off is a ferry, we pack tight, protect for the crossing, and often knock out the whole move in one well-planned run rather than nickel-and-diming you on repeat sailings.'
    ],
    areas: ['Orcas Village (ferry landing)', 'Eastsound', 'Deer Harbor', 'West Sound', 'Olga', 'Rosario', 'Doe Bay', 'Moran State Park area', 'Crow Valley', 'Obstruction Pass'],
    costFactors: [
      { t: 'The ferry.', d: 'A moving truck rides as an oversized vehicle on a reserved sailing, so ferry fare and timing are part of an island quote. We book it into the plan.' },
      { t: 'How far we travel.', d: 'We stage from our Skagit base and the Anacortes terminal, so we time the crew to the sailing, not just the clock.' },
      { t: 'Home size.', d: 'Studio to waterfront estate, how much there is to load drives the number.' },
      { t: 'Access.', d: 'Winding island roads, long private drives near Deer Harbor or Doe Bay, and waterfront carries add handling time.' },
      { t: 'Packing.', d: 'We often recommend full-service packing on island moves so everything travels safely in one trip.' },
      { t: 'Timing.', d: 'Summer sailings and reservations fill fast, so booking early saves money and stress.' }
    ],
    faqs: [
      { q: 'Do you really bring a truck over on the ferry to Orcas?', a: 'Yes. We reserve a Washington State Ferries sailing for the truck out of Anacortes, check in early, and bring the crew across with it. Island moves are a core part of what we do.' },
      { q: 'How do the ferry reservations work for a move?', a: 'We handle them. San Juan vehicle reservations release two months, two weeks, and two days before sailing, and we book the truck into a slot as soon as your date is set.' },
      { q: 'Can you reach the far ends like Deer Harbor, Doe Bay, or Olga?', a: 'Absolutely. We move the whole island, west side to east end, and we bring the right truck for the winding roads and long drives.' },
      { q: 'Is an island move a lot more expensive?', a: 'It costs more than a mainland move because of the ferry and the time, but we plan it as one efficient trip so you are not paying for repeat sailings.' },
      { q: 'Can you also haul away junk on Orcas?', a: 'Yes. We will clear out what you are not taking and handle disposal, so it never has to ride the ferry with you.' },
      { q: 'How far ahead should we book an Orcas move?', a: 'The earlier the better, especially in summer. Ferry slots and crews both fill up, so once you have a date, let us lock it in.' }
    ],
    junkLine: 'From an Eastsound garage cleanout to debris after a remodel out toward Doe Bay, our crews clear and dispose of whatever you are not taking, so it never has to ride the ferry with you. Moving and junk removal in one stop.',
    localReview: null,
    localPhoto: null,
    neighbors: [
      { name: 'San Juan Island', slug: 'san-juan-island-wa' },
      { name: 'Lopez Island', slug: 'lopez-island-wa' },
      { name: 'Anacortes', slug: 'anacortes-wa' }
    ]
  },

  'san-juan-island-wa': {
    slug: 'san-juan-island-wa',
    city: 'San Juan Island',
    county: 'San Juan County',
    mapQuery: 'Friday Harbor, WA',
    lat: 48.5343, lng: -123.0170,
    lead: 'Ferry-served moving and junk removal across San Juan Island, from Friday Harbor to Roche Harbor and Cattle Point. Big moves, bright attitude, zero stress.',
    introHeading: 'We know every corner of San Juan Island',
    intro: [
      'A San Juan Island move runs through the <b style="color:#f4f6f9">Anacortes ferry terminal</b> and lands at <b style="color:#f4f6f9">Friday Harbor</b>, the farthest of the main stops, so timing is everything. We reserve our truck onto a Washington State Ferries sailing ahead of time, since San Juan vehicle reservations release in waves and fill fast, and we check in at least 30 minutes early so the rig makes the boat. Coordinating the crew, the truck, and your belongings onto the same sailing is exactly the part island moves live or die on, and it is what we do.',
      'Friday Harbor is the island hub, walkable and busy right off the dock, and from there we reach the whole island: the resort and marina homes up at <b style="color:#f4f6f9">Roche Harbor</b> on the north end, the waterfront and farmland out toward <b style="color:#f4f6f9">Cattle Point and American Camp</b> on the south, the west-side homes near <b style="color:#f4f6f9">Lime Kiln and False Bay</b>, and everything on the lanes in between. Narrow roads and long private drives are the norm, so we scope access and bring the right truck before we leave the dock.',
      'Many of our San Juan moves are second-home and retirement moves on the water, seasonal owners working around the summer crush, and island families changing homes. Since every load crosses by ferry, we pack tight, protect for the crossing, and plan the move as one clean run instead of stringing you along over multiple sailings.'
    ],
    areas: ['Friday Harbor (ferry landing)', 'Roche Harbor', 'Cattle Point', 'American Camp', 'English Camp', 'Lime Kiln', 'False Bay', 'Turn Point', 'Sportsman Lake', 'Westside Road'],
    costFactors: [
      { t: 'The ferry.', d: 'A moving truck crosses as an oversized vehicle on a reserved Anacortes sailing to Friday Harbor, so ferry fare and timing are built into an island quote.' },
      { t: 'How far we travel.', d: 'We stage from our Skagit base and the Anacortes terminal and time the crew to the sailing.' },
      { t: 'Home size.', d: 'Studio to waterfront estate, how much there is to load drives the number.' },
      { t: 'Access.', d: 'Long private drives near Roche Harbor or Cattle Point and waterfront carries add handling time.' },
      { t: 'Packing.', d: 'We often recommend full-service packing so everything travels safely in one crossing.' },
      { t: 'Timing.', d: 'Summer sailings and reservations fill fast, so booking early saves money and stress.' }
    ],
    faqs: [
      { q: 'Do you bring a truck across to Friday Harbor?', a: 'Yes. We reserve a Washington State Ferries sailing for the truck out of Anacortes to Friday Harbor and bring the crew with it. San Juan Island moves are a core part of what we do.' },
      { q: 'Who handles the ferry reservations?', a: 'We do. Reservations release two months, two weeks, and two days before sailing, and we book the truck into a slot as soon as your date is set.' },
      { q: 'Can you reach Roche Harbor and the south end near Cattle Point?', a: 'Absolutely. We move the whole island, north end to south, and bring the right truck for the narrow roads and long drives.' },
      { q: 'Why does an island move cost more?', a: 'The ferry crossing and the extra time add cost versus a mainland move, but we plan one efficient trip so you are not paying for repeat sailings.' },
      { q: 'Can you haul junk away on San Juan Island?', a: 'Yes. We clear what you are not taking and handle disposal so it never has to ride the ferry back with you.' },
      { q: 'How early should we book?', a: 'As early as you can, especially in summer, when ferry slots and crews both fill up. Once you have a date, we lock it in.' }
    ],
    junkLine: 'From a Friday Harbor garage cleanout to remodel debris out toward Roche Harbor, our crews clear and dispose of whatever you are not taking, so it never rides the ferry with you. Moving and junk removal in one stop.',
    localReview: null,
    localPhoto: null,
    neighbors: [
      { name: 'Orcas Island', slug: 'orcas-island-wa' },
      { name: 'Lopez Island', slug: 'lopez-island-wa' },
      { name: 'Anacortes', slug: 'anacortes-wa' }
    ]
  },

  'lopez-island-wa': {
    slug: 'lopez-island-wa',
    city: 'Lopez Island',
    county: 'San Juan County',
    mapQuery: 'Lopez Island, WA',
    lat: 48.4815, lng: -122.8987,
    lead: 'Ferry-served moving and junk removal across Lopez Island, from the north-end ferry landing to Lopez Village and Fisherman Bay. Big moves, bright attitude, zero stress.',
    introHeading: 'We know every corner of Lopez Island',
    intro: [
      'A Lopez Island move begins at the <b style="color:#f4f6f9">Anacortes ferry terminal</b>, and Lopez is the first San Juan stop, about a 45-minute crossing. We reserve our truck onto a Washington State Ferries sailing ahead of time, because San Juan vehicle reservations release in waves and go quickly, and we check in at least 30 minutes early so the rig makes the boat. One thing to know: eastbound sailings off Lopez load first-come with no reservations, so the return leg takes planning too, and we build that into the schedule.',
      'The ferry lands at the far north end near <b style="color:#f4f6f9">Upright Head and Odlin Park</b>, and the island rolls out flat and open from there, which Lopez is loved for. Most of the activity is around <b style="color:#f4f6f9">Lopez Village</b> and <b style="color:#f4f6f9">Fisherman Bay</b> about four miles down, with farmland, shoreline homes, and long country lanes spreading south toward <b style="color:#f4f6f9">Mud Bay and Mackaye Harbor</b>. The flat roads make Lopez one of the more straightforward islands to move, once the truck is across.',
      'A lot of our Lopez moves are folks settling onto farmland and waterfront, retirees and second-home owners, and island families relocating within the island. Because every load rides the ferry, we pack tight, protect for the crossing, and plan the whole move as one efficient run.'
    ],
    areas: ['Ferry Landing & Upright Head', 'Odlin Park', 'Lopez Village', 'Fisherman Bay', 'Mud Bay', 'Mackaye Harbor', 'Richardson', 'Center Road', 'Port Stanley', 'Shark Reef'],
    costFactors: [
      { t: 'The ferry.', d: 'A moving truck crosses as an oversized vehicle on a reserved Anacortes sailing, and the eastbound return off Lopez is first-come, so ferry timing is part of an island quote.' },
      { t: 'How far we travel.', d: 'We stage from our Skagit base and the Anacortes terminal and time the crew to the sailing.' },
      { t: 'Home size.', d: 'Studio to waterfront estate, how much there is to load drives the number.' },
      { t: 'Access.', d: 'Long country lanes and farm or shoreline driveways can add carry time, though the flat roads on Lopez help.' },
      { t: 'Packing.', d: 'We often recommend full-service packing so everything travels safely in one crossing.' },
      { t: 'Timing.', d: 'Summer sailings and reservations fill fast, so booking early saves money and stress.' }
    ],
    faqs: [
      { q: 'Do you bring a truck over to Lopez on the ferry?', a: 'Yes. We reserve a Washington State Ferries sailing for the truck out of Anacortes to Lopez and bring the crew with it. Island moves are a core part of what we do.' },
      { q: 'How do ferry reservations work for a Lopez move?', a: 'We handle them. Westbound to Lopez we reserve a slot as soon as your date is set, and because eastbound off Lopez is first-come, we plan the return leg around the sailings too.' },
      { q: 'Can you reach the south end near Mackaye Harbor and Richardson?', a: 'Absolutely. We move the whole island, from the village down to the south end, and the flat roads make it one of the smoother islands once the truck is across.' },
      { q: 'Why does an island move cost more?', a: 'The ferry crossing and extra time add cost versus a mainland move, but Lopez is efficient once we are across, and we plan one clean trip.' },
      { q: 'Can you haul junk away on Lopez?', a: 'Yes. We clear what you are not taking and handle disposal so it never has to ride the ferry back with you.' },
      { q: 'How early should we book a Lopez move?', a: 'As early as possible, especially in summer, when ferry slots and crews fill up fast. Once you have a date, we lock it in.' }
    ],
    junkLine: 'From a Lopez Village garage cleanout to debris out toward Mud Bay, our crews clear and dispose of whatever you are not taking, so it never rides the ferry with you. Moving and junk removal in one stop.',
    localReview: null,
    localPhoto: null,
    neighbors: [
      { name: 'Orcas Island', slug: 'orcas-island-wa' },
      { name: 'San Juan Island', slug: 'san-juan-island-wa' },
      { name: 'Anacortes', slug: 'anacortes-wa' }
    ]
  }
};

export { cityPageHtml };
