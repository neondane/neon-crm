/** POST /api/partnerApply — a realtor applies to the Neon Giant Preferred Partner program
 *  from the public /partners page. Emails the team and creates a CRM contact (best-effort).
 *  Body: { name, brokerage?, email?, phone?, areas?, about?, website?, hp? }
 *        hp = honeypot (must be empty; bots fill it).
 *  Returns { ok }
 *  Env: RESEND_API_KEY, EMAIL_FROM, SUPABASE_URL, SUPABASE_KEY,
 *       PARTNER_NOTIFY? (comma-separated recipients) | TEAM_EMAIL? */
import { endpoint, preflight, sb, toE164 } from '../_shared.js';

function esc(s) {
  return String(s == null ? '' : s).replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').split('"').join('&quot;');
}

function recipients(env) {
  var raw = env.PARTNER_NOTIFY || env.TEAM_EMAIL || 'dane@neongiantmoving.com';
  return String(raw).split(',').map(function (s) { return s.trim(); }).filter(Boolean);
}

async function notifyTeam(env, a) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return false;
  var rows = [
    ['Name', a.name],
    ['Brokerage', a.brokerage || '—'],
    ['Email', a.email || '—'],
    ['Phone', a.phone || '—'],
    ['Areas served', a.areas || '—'],
    ['About', a.about || '—'],
    ['Website', a.website || '—'],
  ].map(function (r) {
    return '<tr><td style="padding:7px 12px;color:#888;vertical-align:top">' + esc(r[0]) + '</td><td style="padding:7px 12px"><b>' + esc(r[1]) + '</b></td></tr>';
  }).join('');
  var html = '<div style="font-family:Arial,sans-serif;max-width:600px">'
    + '<h2 style="margin:0 0 6px">New Preferred Partner application</h2>'
    + '<p style="color:#666;margin:0 0 14px">' + esc(a.name) + (a.brokerage ? ' &middot; ' + esc(a.brokerage) : '') + ' applied from the /partners page.</p>'
    + '<table style="border-collapse:collapse;border:1px solid #eee">' + rows + '</table>'
    + '<p style="color:#999;font-size:12px;margin-top:14px">Added to the CRM as a Partner applicant. Reach out to set up their partner page.</p></div>';
  try {
    var r = await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to: recipients(env), subject: 'New Preferred Partner application — ' + a.name, html: html }),
    });
    return r.ok;
  } catch (e) { return false; }
}

async function addContact(env, a) {
  try {
    var noteParts = ['Preferred Partner APPLICATION (via /partners page).'];
    if (a.areas) noteParts.push('Areas served: ' + a.areas);
    if (a.about) noteParts.push('About: ' + a.about);
    if (a.website) noteParts.push('Website: ' + a.website);
    var row = {
      name: a.name,
      business: a.brokerage || '',
      email: a.email || '',
      phone: toE164(a.phone) || a.phone || '',
      type: 'Realtor',
      notes: noteParts.join('\n'),
    };
    await sb(env).insert('contacts', row, { returning: 'minimal' });
    return true;
  } catch (e) { return false; }
}

const handler = endpoint(async ({ env, body, reply }) => {
  // Honeypot — silently accept and drop bot submissions.
  if (body.hp) return reply({ ok: true });

  var a = {
    name: String(body.name || '').trim().slice(0, 120),
    brokerage: String(body.brokerage || '').trim().slice(0, 160),
    email: String(body.email || '').trim().slice(0, 160),
    phone: String(body.phone || '').trim().slice(0, 40),
    areas: String(body.areas || '').trim().slice(0, 240),
    about: String(body.about || '').trim().slice(0, 1000),
    website: String(body.website || '').trim().slice(0, 200),
  };
  if (!a.name) return reply({ ok: false, error: 'name_required' }, 400);
  if (!a.email && !a.phone) return reply({ ok: false, error: 'contact_required' }, 400);
  if (a.email && !/^\S+@\S+\.\S+$/.test(a.email)) return reply({ ok: false, error: 'invalid_email' }, 400);

  var emailed = await notifyTeam(env, a);
  var saved = await addContact(env, a);
  // Success for the applicant as long as we at least notified the team or saved the lead.
  if (!emailed && !saved) return reply({ ok: false, error: 'submit_failed' }, 502);
  return reply({ ok: true });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
