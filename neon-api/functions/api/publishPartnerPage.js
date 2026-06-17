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
function slugify(s) {
  return String(s || '').toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '');
}

function pageHtml(o) {
  var name = o.name || '';
  var first = String(name).trim().split(/\s+/)[0] || 'your agent';
  var areas = (o.areas || []).filter(Boolean);
  var offer = (o.offer || []).filter(Boolean);
  var refer = o.referLink || 'https://neongiantmoving.com/quote';
  var initials = String(name || '?').split(/\s+/).map(function (w) { return w[0]; }).join('').slice(0, 2).toUpperCase();

  var photo = o.headshot
    ? '<img src="' + esc(o.headshot) + '" alt="' + esc(name) + '" style="width:160px;height:160px;object-fit:cover;border-radius:50%;box-shadow:0 14px 36px rgba(0,0,0,.18)">'
    : '<div style="width:160px;height:160px;border-radius:50%;background:linear-gradient(135deg,#FF2FA0,#2BC6FF);display:flex;align-items:center;justify-content:center;color:#fff;font-size:52px;font-weight:800">' + esc(initials) + '</div>';

  var phoneBtn = o.phone
    ? '<a href="tel:' + esc(String(o.phone).replace(/[^0-9+]/g, '')) + '" style="background:linear-gradient(100deg,#2BC6FF,#FF2FA0);color:#fff;font-weight:700;padding:13px 26px;border-radius:50px;text-decoration:none;display:inline-block">Call ' + esc(first) + '</a>'
    : '';

  var offerBlock = offer.length
    ? '<div style="border:1px solid #f1d6ea;background:#fff5fa;border-radius:18px;padding:24px;margin:26px 0"><div style="font-weight:700;font-size:20px;color:#181a2c;margin-bottom:14px">' + esc(first) + '&#39;s clients get an exclusive Neon Giant offer</div><ul style="margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:12px 26px">'
      + offer.map(function (x) { return '<li style="font-weight:600;font-size:15px;color:#181a2c">&#10003; ' + esc(x) + '</li>'; }).join('')
      + '</ul></div>'
    : '';

  var bioBlock = o.bio
    ? '<div style="margin:24px 0"><h2 style="font-size:22px">About ' + esc(first) + '</h2><p style="font-size:16px;line-height:1.8">' + esc(o.bio) + '</p></div>'
    : '';

  var areasBlock = areas.length
    ? '<div style="margin:24px 0"><h2 style="font-size:22px">Areas served</h2><div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">'
      + areas.map(function (a) { return '<span style="display:inline-block;padding:8px 16px;border-radius:50px;font-size:14px;font-weight:600;background:#eef1f8;border:1px solid #e4e6ef;color:#333">' + esc(a) + '</span>'; }).join('')
      + '</div></div>'
    : '';

  var areaLine = areas.length ? '<div style="margin-top:10px;font-weight:600">Serving ' + esc(areas.slice(0, 4).join(', ')) + '</div>' : '';
  var seoCity = areas.length ? esc(areas[0]) : '';
  var seoPara = '<div style="background:#f7f8fa;border-radius:16px;padding:26px;margin-top:28px"><h2 style="font-size:21px">' + esc(name) + ', Realtor' + (seoCity ? ' in ' + seoCity : '') + '</h2><p style="font-size:15.5px;line-height:1.8;margin-top:10px">If you are searching for ' + esc(name) + ', Realtor' + (seoCity ? ' in ' + seoCity : '') + ', you have found ' + (first ? esc(first) : 'them') + '. ' + esc(name) + ' is a trusted agent' + (o.brokerage ? ' with ' + esc(o.brokerage) : '') + ', and a referral partner of Neon Giant Moving &amp; Junk Removal. Every ' + esc(name) + ' client gets ' + (offer.length ? esc(offer.join(', ')) : 'an exclusive moving offer') + '.</p></div>';

  return '<div style="max-width:920px;margin:0 auto;padding:8px 0 24px;color:#181a2c">'
    + '<div style="display:flex;flex-wrap:wrap;gap:26px;align-items:center;margin-bottom:8px">'
    + photo
    + '<div style="flex:1;min-width:240px">'
    + '<div style="font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#E43B94;margin-bottom:6px">Preferred Real Estate Partner</div>'
    + '<h1 style="font-size:34px;margin:0 0 4px">' + esc(name) + (seoCity ? ', ' + seoCity + ' Realtor' : '') + '</h1>'
    + '<div style="font-size:17px;color:#5b6075;font-weight:600">' + esc([o.role, o.brokerage].filter(Boolean).join(' &middot; ')) + '</div>'
    + areaLine
    + '<div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap">' + phoneBtn
    + '<a href="' + esc(refer) + '" style="background:#181a2c;color:#fff;font-weight:700;padding:13px 26px;border-radius:50px;text-decoration:none;display:inline-block">Get a moving quote</a></div>'
    + '</div></div>'
    + offerBlock + bioBlock + areasBlock + seoPara
    + '<div style="background:linear-gradient(100deg,#FF2FA0,#2BC6FF);border-radius:18px;padding:34px;text-align:center;color:#fff;margin-top:30px">'
    + '<div style="font-size:24px;font-weight:800">Moving? ' + esc(first) + ' partners with Neon Giant.</div>'
    + '<p style="max-width:520px;margin:10px auto 18px;opacity:.95">Big moves, bright attitude, zero stress, plus ' + esc(first) + '&#39;s exclusive client offer.</p>'
    + '<a href="' + esc(refer) + '" style="background:#fff;color:#E43B94;font-weight:700;padding:13px 28px;border-radius:50px;text-decoration:none;display:inline-block">Get my free moving quote</a>'
    + '</div>'
    + '<p style="font-size:11.5px;color:#8a8fae;margin-top:22px;text-align:center">' + esc(name) + ' is an independent licensed real estate agent and a referral partner of Neon Giant Moving &amp; Junk Removal. Equal Housing Opportunity. Neon Giant Moving is not a real estate brokerage.</p>'
    + '</div>';
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
  });

  if (!res.ok || !res.json || res.json.ok === false) {
    return reply({ ok: false, error: 'wp_rejected', status: res.status, message: (res.json && (res.json.error || res.json.message)) || res.json }, 502);
  }
  return reply({ ok: true, action: res.json.action, id: res.json.id, status: res.json.status, url: res.json.url });
});

export const onRequestPost = handler;
export const onRequestOptions = function (ctx) { return preflight(ctx.request); };
