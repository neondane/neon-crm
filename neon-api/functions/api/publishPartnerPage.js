/** POST /api/publishPartnerPage — publish/update a realtor's partner landing page into
 *  WordPress via our own custom endpoint (neon/v1/partner-page), authenticated by a shared
 *  secret header (X-Neon-Key). This avoids GoDaddy stripping the Authorization header that
 *  breaks WordPress Application Passwords. Static content only (NO listings).
 *
 *  Body: { opts:{ slug,name,brokerage,role,headshot,phone,email,areas[],bio,offer[],referLink }, status?:'draft'|'publish' }
 *        or { action:'unpublish'|'delete', opts:{ slug } }
 *  Env: WP_BASE, NEON_WP_KEY
 *  Returns: { ok, url, id, status, action }
 */
import { endpoint, preflight } from '../_shared.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').split('"').join('&quot;');
}
function js(s) { return JSON.stringify(String(s == null ? '' : s)); }
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function pageHtml(o) {
  // Approved dark / neon / Bigfoot design, rendered with INLINE styles so it survives
  // WordPress (the snippet disables kses for our trusted endpoint). No external CSS/JS.
  var PINK = '#FF2FA0', CYAN = '#2BC6FF', INK = '#05070a', PANEL = '#0f1318', PANEL2 = '#161b22', LINE = '#222933', TXT = '#c4cad3', DIM = '#8b929c', WHITE = '#f4f6f9';
  var GRAD = 'linear-gradient(266deg,#2BC6FF -1%,#FF2FA0 100%)';
  var SANS = "'DM Sans',-apple-system,Segoe UI,Roboto,Helvetica,Arial,sans-serif";
  var HEAD = "'Ubuntu'," + SANS;

  var name = o.name || '';
  var first = String(name).trim().split(/\s+/)[0] || 'your agent';
  var areas = (o.areas || []).filter(Boolean);
  var offer = (o.offer || []).filter(Boolean);
  if (!offer.length) offer = ['$50 off your move (4-hour minimum)', 'Free moving materials, up to a $100 value', 'Giant Guard Move Protection included', 'Priority scheduling around your closing'];
  var reviews = (o.reviews && o.reviews.length) ? o.reviews : [
    { text: 'Absolutely incredible service. This crew pivoted at a moment’s notice and did whatever it took to get the job done. Professionalism and good attitudes the whole way through.', by: 'William R. · 5-star Google review' },
    { text: 'The moving service was truly superior. Staff were very professional, polite, and friendly. I will definitely use them again and recommend them highly to friends and family.', by: 'Bruce K. · 5-star Google review' }
  ];
  var refer = o.referLink || 'https://neongiantmoving.com/quote';
  var city = areas.length ? areas[0] : '';
  var initials = String(name || '?').split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();
  var phoneClean = String(o.phone || '').replace(/[^0-9+]/g, '');

  var ring = o.headshot
    ? '<div style="position:relative;width:208px;height:208px;flex:none;margin:0 auto"><div style="position:absolute;inset:-5px;border-radius:50%;background:' + GRAD + ';filter:blur(8px);opacity:.9"></div><img src="' + esc(o.headshot) + '" alt="' + esc(name) + ', REALTOR' + (o.brokerage ? ' with ' + esc(o.brokerage) : '') + '" style="position:relative;width:208px;height:208px;border-radius:50%;object-fit:cover;border:3px solid ' + INK + '"></div>'
    : '<div style="width:208px;height:208px;border-radius:50%;background:' + GRAD + ';display:flex;align-items:center;justify-content:center;color:#fff;font-size:74px;font-weight:700;font-family:' + HEAD + ';margin:0 auto">' + esc(initials) + '</div>';

  var pill = function (href, label, grad) {
    var base = 'display:inline-block;font-family:' + HEAD + ';font-weight:600;font-size:15px;padding:14px 26px;border-radius:50px;text-decoration:none;margin:6px 8px 0 0;';
    var style = grad ? (base + 'background:' + GRAD + ';color:#fff;box-shadow:0 0 28px rgba(255,47,160,.5)') : (base + 'background:transparent;color:' + WHITE + ';border:1.5px solid rgba(255,255,255,.28)');
    return '<a href="' + esc(href) + '" style="' + style + '">' + label + '</a>';
  };
  var callBtn = o.phone ? pill('tel:' + phoneClean, 'Call ' + esc(first), true) : '';
  var emailBtn = o.email ? pill('mailto:' + esc(o.email), 'Email', false) : '';
  var quoteBtn = pill(refer, 'Claim your $50 offer', !o.phone);

  // Socials + website (render only the ones filled in the CRM)
  function socIcon(href, lbl, svg) { return '<a href="' + esc(href) + '" target="_blank" rel="noopener" aria-label="' + lbl + '" style="display:inline-flex;align-items:center;justify-content:center;width:42px;height:42px;border-radius:50%;border:1px solid ' + LINE + ';color:' + WHITE + ';margin:0 9px 0 0">' + svg + '</a>'; }
  var SVG_FB = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M14 9h3V6h-3c-1.66 0-3 1.34-3 3v2H8v3h3v7h3v-7h2.5l.5-3H14V9c0-.55.45-1 1-1z"/></svg>';
  var SVG_IG = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><rect x="3" y="3" width="18" height="18" rx="5"/><circle cx="12" cy="12" r="4"/><circle cx="17.3" cy="6.7" r="1.1" fill="currentColor" stroke="none"/></svg>';
  var SVG_IN = '<svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor"><path d="M6.94 8.5v9H4v-9h2.94zM5.47 7A1.74 1.74 0 1 1 5.47 3.5 1.74 1.74 0 0 1 5.47 7zM9 8.5h2.82v1.23h.04c.4-.72 1.36-1.48 2.8-1.48 3 0 3.55 1.97 3.55 4.53v4.72H15.3v-4.18c0-1 0-2.28-1.39-2.28-1.39 0-1.6 1.09-1.6 2.21v4.25H9.4v-9z"/></svg>';
  var SVG_WEB = '<svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2"><circle cx="12" cy="12" r="9"/><path d="M3 12h18M12 3c2.5 2.6 2.5 15.4 0 18M12 3c-2.5 2.6-2.5 15.4 0 18"/></svg>';
  var socialBar = '';
  [['Facebook', o.facebook, SVG_FB], ['Instagram', o.instagram, SVG_IG], ['LinkedIn', o.linkedin, SVG_IN], ['Website', o.website, SVG_WEB]].forEach(function (s) { if (s[1]) socialBar += socIcon(s[1], s[0], s[2]); });
  socialBar = socialBar ? '<div style="margin-top:18px">' + socialBar + '</div>' : '';
  var websiteRow = o.website ? '<a href="' + esc(o.website) + '" target="_blank" rel="noopener" style="display:block;padding:12px 0;border-top:1px solid ' + LINE + ';color:' + CYAN + ';font-weight:600;text-decoration:none">Visit ' + esc(first) + '&#39;s website &#8599;</a>' : '';

  // Visible FAQ about the agent + the offer
  var faqRows = [
    ['Who is ' + name + '?', name + ' is a ' + (city ? city + ' ' : '') + 'REALTOR' + (o.brokerage ? ' with ' + o.brokerage : '') + ', working with buyers, sellers, and investors' + (areas.length ? ' across ' + areas.slice(0, 4).join(', ') : '') + '.'],
    ['How do ' + first + '’s clients save on their move?', 'Book through Neon Giant as a ' + name + ' client and you automatically get ' + offer.join(', ') + '. No codes needed.'],
    ['What areas does ' + first + ' serve?', (areas.length ? areas.join(', ') + '.' : 'The Whatcom and Skagit County area.')],
    ['How do I claim the offer?', 'Tap any "Claim your offer" button on this page for a free quote. Mention ' + first + ' and the offer is applied automatically.']
  ];
  var faqHtml = faqRows.map(function (q) { return '<details style="border-top:1px solid ' + LINE + ';padding:16px 0"><summary style="cursor:pointer;font-family:' + HEAD + ';font-weight:500;font-size:16.5px;color:' + WHITE + ';list-style:none">' + esc(q[0]) + '</summary><p style="color:' + DIM + ';font-size:15px;margin-top:10px;line-height:1.7">' + esc(q[1]) + '</p></details>'; }).join('');
  var faqSection = '<div style="' + sec + ';padding-top:0"><div style="' + kicker + '">Common questions</div><h2 style="' + h2 + ';font-size:24px">Got questions?</h2><div style="margin-top:16px">' + faqHtml + '</div></div>';

  // Scroll-in animation. SAFE: sections default to fully visible; the script opts them
  // into the reveal, so if WordPress ever strips the script the page is still readable.
  var animScript = "<script>(function(){var r=document.getElementById('ngLanding');if(!r||!('IntersectionObserver' in window))return;var secs=[].slice.call(r.children);var io=new IntersectionObserver(function(es){es.forEach(function(e){if(e.isIntersecting){e.target.classList.add('in');io.unobserve(e.target);}});},{threshold:.06,rootMargin:'0px 0px -40px 0px'});secs.forEach(function(s){var vis=s.getBoundingClientRect().top<(window.innerHeight*0.92);s.classList.add('ngrv');if(vis){requestAnimationFrame(function(){s.classList.add('in');});}else{io.observe(s);}});})();</script>";

  var sec = 'padding:54px 28px;max-width:1000px;margin:0 auto';
  var kicker = 'font-family:' + HEAD + ';font-weight:700;font-size:12px;letter-spacing:2px;text-transform:uppercase;color:' + CYAN;
  var h2 = 'font-family:' + HEAD + ';font-weight:700;color:' + WHITE + ';font-size:30px;letter-spacing:-.5px;margin:6px 0 0';
  var card = 'background:' + PANEL + ';border:1px solid ' + LINE + ';border-radius:18px;padding:26px';
  var chip = 'display:inline-block;background:' + PANEL2 + ';border:1px solid ' + LINE + ';border-radius:50px;padding:9px 17px;font-weight:500;font-size:14px;color:' + WHITE + ';margin:5px 8px 0 0';

  var offerCards = offer.map(function (x) {
    return '<div style="display:flex;gap:13px;align-items:flex-start;background:' + PANEL2 + ';border:1px solid ' + LINE + ';border-radius:14px;padding:16px"><span style="width:30px;height:30px;flex:none;border-radius:8px;background:' + GRAD + ';display:flex;align-items:center;justify-content:center;color:#fff;font-weight:700">&#10003;</span><div style="font-weight:500;color:' + WHITE + ';font-size:15px">' + esc(x) + '</div></div>';
  }).join('');

  var areaChips = areas.length ? areas.map(function (a) { return '<span style="' + chip + '">' + esc(a) + '</span>'; }).join('') : '';
  var quoteCards = reviews.map(function (r) {
    return '<div style="' + card + '"><div style="font-family:' + HEAD + ';font-weight:700;font-size:40px;line-height:.5;color:' + CYAN + '">&#8220;</div><p style="font-size:16px;color:' + WHITE + ';line-height:1.6;margin:8px 0 0">' + esc(r.text) + '</p><div style="margin-top:14px;font-family:' + HEAD + ';font-weight:500;color:' + DIM + ';font-size:13.5px">' + esc(r.by) + '</div></div>';
  }).join('');

  var bio = o.bio ? esc(o.bio) : (esc(name) + ' helps ' + (city ? esc(city) + ' ' : '') + 'families buy and sell with confidence' + (o.brokerage ? ' at ' + esc(o.brokerage) : '') + ', and sends clients to Neon Giant so move day stays bright.');
  var roleLine = esc([o.role || 'REALTOR', o.brokerage].filter(Boolean).join(' · '));

  var ld1 = '{"@context":"https://schema.org","@type":"RealEstateAgent","name":' + js(name) + (o.brokerage ? ',"worksFor":{"@type":"Organization","name":' + js(o.brokerage) + '}' : '') + (areas.length ? ',"areaServed":[' + areas.map(function (a) { return js(a + ', WA'); }).join(',') + ']' : '') + (o.phone ? ',"telephone":' + js(phoneClean) : '') + ',"memberOf":{"@type":"Organization","name":"Neon Giant Moving & Junk Removal"}}';
  var ld2 = '{"@context":"https://schema.org","@type":"FAQPage","mainEntity":[{"@type":"Question","name":' + js('Who is ' + name + '?') + ',"acceptedAnswer":{"@type":"Answer","text":' + js(name + ' is a ' + (city ? city + ' ' : '') + 'REALTOR' + (o.brokerage ? ' with ' + o.brokerage : '') + '.') + '}},{"@type":"Question","name":' + js(first + ' client savings') + ',"acceptedAnswer":{"@type":"Answer","text":' + js(first + ' clients get ' + offer.join(', ') + ' with Neon Giant Moving.') + '}}]}';

  // Break out of the theme's content column to full width, and kill the theme's huge
  // page-area padding so our hero starts right under the site header.
  var fixCss = '<style>.page-hero-area{display:none!important}.tg-page-area{padding-top:0!important;padding-bottom:0!important}.tg-page-area .container,.tg-page-area .row,.tg-page-area [class*=col-]{max-width:100%!important;padding-left:0!important;padding-right:0!important;margin:0!important}#ngLanding .ngrv{opacity:0;transform:translateY(42px);transition:opacity .9s ease,transform 1.2s cubic-bezier(.16,.68,.28,1)}#ngLanding .ngrv.in{opacity:1;transform:none}#ngLanding details summary::-webkit-details-marker{display:none}</style>';
  return fixCss + '<div id="ngLanding" style="background:' + INK + ';color:' + TXT + ';font-family:' + SANS + ';line-height:1.65;margin:0;width:100vw;max-width:100vw;margin-left:calc(50% - 50vw);overflow:hidden">'
    + '<div style="position:relative;overflow:hidden;border-bottom:1px solid ' + LINE + ';background:radial-gradient(105% 80% at 34% 42%,rgba(255,47,160,.40),rgba(255,47,160,0) 56%),radial-gradient(90% 90% at 100% 100%,rgba(43,198,255,.18),transparent 60%),#120814">'
    + (o.bigfoot ? '<img src="' + esc(o.bigfoot) + '" alt="" aria-hidden="true" style="position:absolute;right:-30px;bottom:-20px;width:380px;max-width:42%;opacity:.16">' : '')
    + '<div style="position:relative;z-index:2;display:flex;flex-wrap:wrap;gap:40px;align-items:center;justify-content:center;max-width:1000px;margin:0 auto;padding:64px 28px">'
    + ring
    + '<div style="flex:1;min-width:280px">'
    + '<span style="display:inline-block;background:rgba(43,198,255,.1);border:1px solid rgba(43,198,255,.4);color:' + CYAN + ';font-family:' + HEAD + ';font-weight:500;font-size:12px;letter-spacing:1.5px;text-transform:uppercase;padding:7px 15px;border-radius:50px">Preferred Real Estate Partner</span>'
    + '<h1 style="font-family:' + HEAD + ';font-weight:700;color:' + WHITE + ';font-size:48px;letter-spacing:-1px;margin:16px 0 8px;text-shadow:0 0 36px rgba(255,47,160,.28)">' + esc(name) + (city ? ', ' + esc(city) + ' Realtor' : '') + '</h1>'
    + '<div style="font-family:' + HEAD + ';font-weight:500;font-size:19px;color:' + WHITE + '">' + roleLine + '</div>'
    + (areas.length ? '<div style="margin-top:10px;color:' + DIM + ';font-weight:500">Serving ' + esc(areas.slice(0, 5).join(', ')) + '</div>' : '')
    + '<div style="margin-top:24px">' + callBtn + emailBtn + quoteBtn + '</div>'
    + socialBar
    + '</div></div></div>'
    + '<div style="background:linear-gradient(90deg,rgba(255,47,160,.12),rgba(43,198,255,.12));border-bottom:1px solid ' + LINE + ';text-align:center;padding:16px 24px;font-family:' + HEAD + ';font-weight:500;color:' + WHITE + '">' + esc(first) + '&#39;s clients get <b style="color:' + PINK + '">$50 off your move</b> plus free materials and Giant Guard Move Protection.</div>'
    + '<div style="' + sec + '"><div style="' + kicker + '">The client offer</div><h2 style="' + h2 + '">Move for less, and stress-free</h2>'
    + '<div style="' + card + ';margin-top:22px;position:relative;overflow:hidden"><div style="font-family:' + HEAD + ';font-weight:700;font-size:42px;line-height:1;color:' + WHITE + ';text-shadow:0 0 30px rgba(255,47,160,.55)"><span style="color:' + PINK + '">$50 off</span> your move</div>'
    + '<div style="color:' + DIM + ';font-size:13px;margin-top:6px">4-hour minimum. Applied automatically as a ' + esc(first) + ' client.</div>'
    + '<div style="display:grid;grid-template-columns:1fr 1fr;gap:14px;margin-top:22px">' + offerCards + '</div></div></div>'
    + '<div style="' + sec + ';padding-top:0;display:grid;grid-template-columns:1.5fr 1fr;gap:24px">'
    + '<div style="' + card + '"><div style="' + kicker + '">About</div><h2 style="' + h2 + ';font-size:24px">About ' + esc(name) + '</h2><p style="font-size:16px;line-height:1.85;color:' + TXT + ';margin-top:12px">' + bio + '</p></div>'
    + '<div style="' + card + '"><div style="' + kicker + '">Contact</div><h2 style="' + h2 + ';font-size:24px">Reach ' + esc(first) + '</h2>'
    + (o.phone ? '<div style="padding:12px 0;border-top:1px solid ' + LINE + ';margin-top:10px;color:' + WHITE + ';font-weight:500">' + esc(o.phone) + '</div>' : '')
    + (o.email ? '<div style="padding:12px 0;border-top:1px solid ' + LINE + ';color:' + WHITE + ';font-weight:500;word-break:break-all">' + esc(o.email) + '</div>' : '')
    + (o.brokerage ? '<div style="padding:12px 0;border-top:1px solid ' + LINE + ';color:' + WHITE + ';font-weight:500">' + esc(o.brokerage) + '</div>' : '')
    + websiteRow
    + '<div style="margin-top:14px">' + (o.email ? pill('mailto:' + esc(o.email), 'Message ' + esc(first), true) : pill(refer, 'Get a quote', true)) + '</div></div></div>'
    + (areaChips ? '<div style="' + sec + ';padding-top:0"><div style="' + kicker + '">Areas served</div><h2 style="' + h2 + ';font-size:24px">Where ' + esc(first) + ' works</h2><div style="margin-top:14px">' + areaChips + '</div></div>' : '')
    + '<div style="' + sec + ';padding-top:0"><div style="' + kicker + '">Reviews</div><h2 style="' + h2 + ';font-size:24px">Rated 5.0 across 400+ moves <span style="color:#FFB02E">&#9733;&#9733;&#9733;&#9733;&#9733;</span></h2><div style="color:' + DIM + ';margin-top:8px">Real Google reviews from Neon Giant Moving customers.</div><div style="display:grid;grid-template-columns:1fr 1fr;gap:18px;margin-top:22px">' + quoteCards + '</div></div>'
    + '<div style="' + sec + ';padding-top:0"><div style="' + card + '"><h2 style="' + h2 + ';font-size:23px">' + esc(name) + ', REALTOR' + (city ? ' in ' + esc(city) : '') + '</h2><p style="color:' + TXT + ';font-size:15.5px;line-height:1.85;margin-top:12px">If you are searching for <b style="color:' + WHITE + '">' + esc(name) + ', Realtor' + (city ? ' in ' + esc(city) : '') + '</b>, you have found ' + esc(first) + '. ' + esc(name) + ' is a trusted agent' + (o.brokerage ? ' with <b style="color:' + WHITE + '">' + esc(o.brokerage) + '</b>' : '') + ' and a referral partner of <b style="color:' + WHITE + '">Neon Giant Moving &amp; Junk Removal</b>. Every ' + esc(name) + ' client automatically gets ' + esc(offer.join(', ')) + '.</p></div></div>'
    + faqSection
    + '<div style="' + sec + ';padding-top:0"><div style="' + card + ';text-align:center;padding:52px 28px;background:radial-gradient(circle at 30% 0%,rgba(255,47,160,.22),transparent 55%),radial-gradient(circle at 80% 100%,rgba(43,198,255,.2),transparent 55%),' + PANEL + '"><h2 style="' + h2 + ';font-size:32px">Ready to move? Let&#39;s make it a bright one.</h2><p style="max-width:560px;margin:14px auto 24px;color:' + TXT + ';font-size:17px">Big moves, bright attitude, zero stress. Mention ' + esc(first) + ' and your $50 offer is applied automatically.</p>' + pill(refer, 'Claim your $50 moving offer', true) + '</div></div>'
    + '<div style="border-top:1px solid ' + LINE + ';background:#04060a;padding:34px 28px;text-align:center"><div style="font-family:' + HEAD + ';color:' + WHITE + ';font-weight:500">' + esc(name) + (o.brokerage ? ', ' + esc(o.brokerage) : '') + '</div><div style="font-size:11.5px;color:#5e656f;max-width:620px;margin:10px auto 0;line-height:1.5">' + esc(name) + ' is an independent licensed real estate agent and a referral partner of Neon Giant Moving and Junk Removal. Equal Housing Opportunity. Neon Giant Moving is not a real estate brokerage.</div></div>'
    + '<script type="application/ld+json">' + ld1 + '</script><script type="application/ld+json">' + ld2 + '</script>'
    + '</div>' + animScript;
}

async function ngWp(env, payload) {
  var r = await fetch(env.WP_BASE.replace(/\/$/, '') + '/wp-json/neon/v1/partner-page', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', 'X-Neon-Key': env.NEON_WP_KEY },
    body: JSON.stringify(payload),
  });
  var txt = await r.text();
  var json; try { json = JSON.parse(txt); } catch (e) { json = txt; }
  return { ok: r.ok, status: r.status, json: json };
}

const handler = endpoint(async function (ctx) {
  var env = ctx.env, body = ctx.body, reply = ctx.reply;
  if (!env.WP_BASE || !env.NEON_WP_KEY) {
    return reply({ ok: false, error: 'wordpress_not_configured', note: 'Set WP_BASE and NEON_WP_KEY in neon-api, and install the Code Snippet.' }, 503);
  }
  var o = (body && body.opts) || {};
  var slug = slugify(o.slug || o.name);
  if (!slug) return reply({ ok: false, error: 'missing_slug' }, 400);
  var action = body.action || 'publish';

  if (action === 'unpublish' || action === 'delete') {
    var del = await ngWp(env, { slug: slug, action: action });
    return reply(del.ok ? del.json : { ok: false, error: 'wp_rejected', status: del.status, message: del.json }, del.ok ? 200 : 502);
  }

  var areas = (o.areas || []).filter(Boolean);
  var city = areas.length ? areas[0] : '';
  var offer = (o.offer || []).filter(Boolean);
  var seoTitle = (o.name || 'Realtor') + (city ? ', ' + city + ' Realtor' : '') + ' | Neon Giant Moving Partner';
  var seoDesc = (o.name || 'This agent') + ' is a ' + (city ? city + ' ' : '') + 'REALTOR' + (o.brokerage ? ' with ' + o.brokerage : '') + '. Clients get ' + (offer.length ? offer.join(', ') : 'an exclusive moving offer') + ' with Neon Giant Moving.';

  var res = await ngWp(env, {
    slug: slug,
    title: seoTitle,
    content: pageHtml(o),
    excerpt: seoDesc,
    status: (body.status === 'publish') ? 'publish' : 'draft',
    seo_title: seoTitle,
    seo_description: seoDesc,
    // card fields for the /partners hub directory
    card_name: o.name || '',
    card_brokerage: o.brokerage || '',
    card_headshot: o.headshot || '',
    card_city: city,
  });

  if (!res.ok || !res.json || res.json.ok === false) {
    return reply({ ok: false, error: 'wp_rejected', status: res.status, message: (res.json && (res.json.error || res.json.message)) || res.json }, 502);
  }
  return reply({ ok: true, action: res.json.action, id: res.json.id, status: res.json.status, url: res.json.url });
});

export const onRequestPost = handler;
export const onRequestOptions = function (ctx) { return preflight(ctx.request); };
