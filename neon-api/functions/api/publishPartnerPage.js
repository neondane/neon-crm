/** POST /api/publishPartnerPage — publish/update a realtor's partner landing page
 *  directly into WordPress (renders inside the live site theme automatically).
 *  Static content only (NO listings) — pushed once, nothing live to break.
 *
 *  Body: { opts: { slug, name, brokerage, role, headshot, phone, email, areas[], bio, offer[], referLink } }
 *        or { action:'unpublish', opts:{ slug } }
 *  Env: WP_BASE, WP_USER, WP_APP_PASSWORD
 *  Returns: { ok, url, pageId, action }
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
    ? '<img src="' + esc(o.headshot) + '" alt="' + esc(name) + '" style="width:160px;height:190px;object-fit:cover;border-radius:16px;box-shadow:0 14px 36px rgba(0,0,0,.18)">'
    : '<div style="width:160px;height:190px;border-radius:16px;background:linear-gradient(135deg,#FF1493,#22BFE7);display:flex;align-items:center;justify-content:center;color:#fff;font-size:52px;font-weight:800">' + esc(initials) + '</div>';

  var phoneBtn = o.phone
    ? '<a href="tel:' + esc(String(o.phone).replace(/[^0-9+]/g, '')) + '" style="background:linear-gradient(100deg,#FF1493,#22BFE7);color:#fff;font-weight:700;padding:12px 22px;border-radius:11px;text-decoration:none">Call ' + esc(first) + '</a>'
    : '';

  var offerBlock = offer.length
    ? '<div style="border:1.5px solid #f1d6ea;background:linear-gradient(180deg,#fff,#fef5fb);border-radius:16px;padding:22px 24px;margin:26px 0"><div style="font-weight:700;font-size:19px;margin-bottom:12px">' + esc(first) + '&#39;s clients get an exclusive Neon Giant offer</div><ul style="margin:0;padding:0;list-style:none;display:flex;flex-wrap:wrap;gap:10px 24px">'
      + offer.map(function (x) { return '<li style="font-weight:600;font-size:15px">&#10003; ' + esc(x) + '</li>'; }).join('')
      + '</ul></div>'
    : '';

  var bioBlock = o.bio
    ? '<div style="margin:24px 0"><h3 style="font-size:14px;letter-spacing:1px;text-transform:uppercase;color:#5b6075">About ' + esc(first) + '</h3><p style="font-size:16px;line-height:1.7;color:#3b3f55">' + esc(o.bio) + '</p></div>'
    : '';

  var areasBlock = areas.length
    ? '<div style="margin:24px 0"><h3 style="font-size:14px;letter-spacing:1px;text-transform:uppercase;color:#5b6075">Areas served</h3><div style="display:flex;flex-wrap:wrap;gap:8px;margin-top:10px">'
      + areas.map(function (a) { return '<span style="display:inline-block;padding:7px 14px;border-radius:999px;font-size:13px;font-weight:600;background:#eef1f8;border:1px solid #e4e6ef;color:#333">' + esc(a) + '</span>'; }).join('')
      + '</div></div>'
    : '';

  var areaLine = areas.length ? '<div style="margin-top:10px;font-weight:600">Serving ' + esc(areas.slice(0, 4).join(', ')) + '</div>' : '';

  return '<div style="max-width:920px;margin:0 auto;padding:8px 0 24px;color:#181a2c">'
    + '<div style="display:flex;flex-wrap:wrap;gap:26px;align-items:center;margin-bottom:8px">'
    + photo
    + '<div style="flex:1;min-width:240px">'
    + '<div style="font-size:12px;font-weight:800;letter-spacing:1px;text-transform:uppercase;color:#FF1493;margin-bottom:6px">Preferred Real Estate Partner</div>'
    + '<h2 style="font-size:34px;margin:0 0 4px">' + esc(name) + '</h2>'
    + '<div style="font-size:17px;color:#5b6075;font-weight:600">' + esc([o.role, o.brokerage].filter(Boolean).join(' · ')) + '</div>'
    + areaLine
    + '<div style="margin-top:18px;display:flex;gap:10px;flex-wrap:wrap">' + phoneBtn
    + '<a href="' + esc(refer) + '" style="background:#181a2c;color:#fff;font-weight:700;padding:12px 22px;border-radius:11px;text-decoration:none">Get a moving quote</a></div>'
    + '</div></div>'
    + offerBlock
    + bioBlock
    + areasBlock
    + '<div style="background:linear-gradient(100deg,#FF1493,#22BFE7);border-radius:18px;padding:34px;text-align:center;color:#fff;margin-top:30px">'
    + '<div style="font-size:24px;font-weight:800">Moving? ' + esc(first) + ' partners with Neon Giant.</div>'
    + '<p style="max-width:520px;margin:10px auto 18px;opacity:.95">A smooth, stress-free move with Neon Giant Moving &amp; Junk Removal — and ' + esc(first) + '&#39;s exclusive client offer.</p>'
    + '<a href="' + esc(refer) + '" style="background:#fff;color:#FF1493;font-weight:700;padding:13px 26px;border-radius:11px;text-decoration:none;display:inline-block">Get my free moving quote</a>'
    + '</div>'
    + '<p style="font-size:11.5px;color:#8a8fae;margin-top:22px;text-align:center">' + esc(name) + ' is an independent licensed real estate agent and a referral partner of Neon Giant Moving &amp; Junk Removal. Equal Housing Opportunity. Neon Giant Moving is not a real estate brokerage.</p>'
    + '</div>';
}

async function wp(env, path, method, body) {
  var auth = 'Basic ' + btoa(env.WP_USER + ':' + env.WP_APP_PASSWORD);
  var r = await fetch(env.WP_BASE.replace(/\/$/, '') + '/wp-json/wp/v2' + path, {
    method: method || 'GET',
    headers: { Authorization: auth, 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  var txt = await r.text();
  var json; try { json = JSON.parse(txt); } catch (e) { json = txt; }
  return { ok: r.ok, status: r.status, json: json };
}

async function ensureParent(env) {
  var found = await wp(env, '/pages?slug=partners&status=publish,draft', 'GET');
  if (found.ok && Array.isArray(found.json) && found.json[0]) return found.json[0].id;
  var made = await wp(env, '/pages', 'POST', { title: 'Partners', slug: 'partners', status: 'publish', content: '<p>Our trusted real estate partners.</p>' });
  return (made.ok && made.json && made.json.id) || 0;
}

const handler = endpoint(async function (ctx) {
  var env = ctx.env, body = ctx.body, reply = ctx.reply;
  if (!env.WP_BASE || !env.WP_USER || !env.WP_APP_PASSWORD) {
    return reply({ ok: false, error: 'wordpress_not_configured', note: 'Set WP_BASE, WP_USER, WP_APP_PASSWORD in the neon-api environment.' }, 503);
  }
  var o = (body && body.opts) || {};
  var slug = slugify(o.slug || o.name);
  if (!slug) return reply({ ok: false, error: 'missing_slug' }, 400);
  var action = body.action || 'publish';

  var existing = await wp(env, '/pages?slug=' + encodeURIComponent(slug) + '&status=publish,draft,private', 'GET');
  var page = (existing.ok && Array.isArray(existing.json) && existing.json[0]) || null;

  if (action === 'unpublish') {
    if (!page) return reply({ ok: true, action: 'noop', note: 'no page found' });
    var upd = await wp(env, '/pages/' + page.id, 'POST', { status: 'draft' });
    return reply({ ok: upd.ok, action: 'unpublished', pageId: page.id });
  }

  var parent = await ensureParent(env);
  var payload = {
    title: (o.name || 'Realtor') + ' — Realtor Partner | Neon Giant Moving',
    slug: slug,
    status: 'publish',
    parent: parent || undefined,
    content: pageHtml(o),
    excerpt: (o.name || 'Realtor') + (o.brokerage ? ' of ' + o.brokerage : '') + ' — a trusted Neon Giant Moving referral partner.',
  };

  var res = page ? await wp(env, '/pages/' + page.id, 'POST', payload) : await wp(env, '/pages', 'POST', payload);
  if (!res.ok) return reply({ ok: false, error: 'wp_rejected', status: res.status, message: (res.json && res.json.message) || String(res.json).slice(0, 200) }, 502);
  return reply({ ok: true, action: page ? 'updated' : 'created', pageId: res.json.id, url: res.json.link });
});

export const onRequestPost = handler;
export const onRequestOptions = function (ctx) { return preflight(ctx.request); };
