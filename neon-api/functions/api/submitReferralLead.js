/** POST /api/submitReferralLead — a realtor (or direct visitor) submits a customer referral.
 *  Writes the lead to Supabase portal_leads, pushes it into SmartMoving, emails the team.
 *  Body: { realtorId?, customer:{ name, phone, email?, fromAddress?, toAddress?, moveDate?, moveSize?, notes? } }
 *  Returns { ok, leadId, smartmoving }
 *  Env: SUPABASE_URL, SUPABASE_KEY, SMARTMOVING_API_KEY, SMARTMOVING_CLIENT_ID, SMARTMOVING_BRANCH_ID?,
 *       RESEND_API_KEY?, EMAIL_FROM?, TEAM_EMAIL? */
import { endpoint, preflight, sb } from '../_shared.js';

function zip(a) { const m = String(a || '').match(/\b(\d{5})\b/); return m ? m[1] : ''; }

async function pushToSmartMoving(env, lead, realtor) {
  if (!env.SMARTMOVING_API_KEY || !env.SMARTMOVING_CLIENT_ID) return { ok: false, error: 'smartmoving_not_configured' };
  const noteLines = [];
  if (lead.notes) noteLines.push(lead.notes);
  noteLines.push('Referred by (Realtor Affiliate): ' + (realtor.name || 'Unknown'));
  if (realtor.email) noteLines.push('Realtor email: ' + realtor.email);
  if (realtor.business) noteLines.push('Realtor brokerage: ' + realtor.business);
  if (lead.fromAddress) noteLines.push('From: ' + lead.fromAddress);
  if (lead.toAddress) noteLines.push('To: ' + lead.toAddress);
  if (lead.moveSize) noteLines.push('Move size: ' + lead.moveSize);
  noteLines.push('Submitted via Neon Giant referral portal.');

  const payload = {
    clientId: env.SMARTMOVING_CLIENT_ID,
    fullName: String(lead.name),
    phoneNumber: String(lead.phone || ''),
    serviceType: /junk/i.test(lead.moveSize || '') ? 'Junk Removal' : 'Moving',
    notes: noteLines.join('\n'),
    leadSource: 'Neon Giant Referral Portal',
    referralSource: 'Portal - Affiliate',
  };
  if (lead.email) payload.email = String(lead.email);
  if (lead.moveDate) payload.moveDate = String(lead.moveDate);
  if (env.SMARTMOVING_BRANCH_ID) payload.branchId = env.SMARTMOVING_BRANCH_ID;
  const oz = zip(lead.fromAddress); if (oz) payload.originZip = oz;
  const dz = zip(lead.toAddress); if (dz) payload.destinationZip = dz;

  try {
    const r = await fetch('https://api-public.smartmoving.com/v1/api/premium/leads', {
      method: 'POST',
      headers: { 'x-api-key': env.SMARTMOVING_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify(payload),
    });
    const txt = await r.text();
    let j = {}; try { j = JSON.parse(txt); } catch (_) {}
    if (r.ok) return { ok: true, smJobId: j.leadId || j.id || null };
    return { ok: false, error: 'smartmoving_' + r.status, body: txt.slice(0, 200) };
  } catch (e) { return { ok: false, error: 'smartmoving_network_error', message: e.message }; }
}

async function emailTeam(env, lead, realtor, sourceTag) {
  if (!env.RESEND_API_KEY || !env.EMAIL_FROM) return;
  const to = env.TEAM_EMAIL || 'dane@neongiantmoving.com';
  const rows = [
    ['SM Lead Source', sourceTag + '  (paste this exactly)'],
    ['Customer phone', lead.phone || '—'],
    ['Customer email', lead.email || '—'],
    ['Move date', lead.moveDate || '—'],
    ['Move size', lead.moveSize || '—'],
    ['From', lead.fromAddress || '—'],
    ['To', lead.toAddress || '—'],
    ['Notes', lead.notes || '—'],
  ].map((r) => `<tr><td style="padding:6px 10px;color:#888">${r[0]}</td><td style="padding:6px 10px"><b>${r[1]}</b></td></tr>`).join('');
  const html = `<div style="font-family:Arial,sans-serif;max-width:600px"><h2>New portal referral: ${lead.name}</h2>`
    + `<p>Referred by <b>${realtor.name}</b>${realtor.business ? ' (' + realtor.business + ')' : ''}</p>`
    + `<table style="border-collapse:collapse">${rows}</table></div>`;
  try {
    await fetch('https://api.resend.com/emails', {
      method: 'POST',
      headers: { Authorization: 'Bearer ' + env.RESEND_API_KEY, 'Content-Type': 'application/json' },
      body: JSON.stringify({ from: env.EMAIL_FROM, to, subject: `New referral from ${realtor.name} — ${lead.name}`, html }),
    });
  } catch (_) {}
}

const handler = endpoint(async ({ env, body, reply }) => {
  const c = body.customer || {};
  if (!c.name || !c.phone) return reply({ ok: false, error: 'name_and_phone_required' }, 400);

  const db = sb(env);
  let realtor = { id: 0, name: 'Direct', email: '', business: '' };
  if (body.realtorId) {
    try {
      const rows = await db.select(`contacts?id=eq.${encodeURIComponent(body.realtorId)}&select=id,name,business,email&limit=1`);
      if (rows && rows[0]) realtor = rows[0];
    } catch (_) {}
  }
  const sourceTag = 'Portal - ' + (realtor.name || 'Direct');
  const lead = { name: c.name, phone: c.phone, email: c.email, fromAddress: c.fromAddress, toAddress: c.toAddress, moveDate: c.moveDate, moveSize: c.moveSize, notes: c.notes };

  // 1) DURABLE FIRST — record the lead before anything that can fail, so a
  //    referral is NEVER lost even if SmartMoving (or this function) errors out.
  //    moveDate is a date column: send null (not '') when empty to avoid insert errors.
  let inserted = null;
  try {
    inserted = await db.insert('portal_leads', {
      customerName: c.name, customerPhone: c.phone, customerEmail: c.email || '',
      realtorId: realtor.id, realtorName: realtor.name, realtorEmail: realtor.email || '',
      fromAddress: c.fromAddress || '', toAddress: c.toAddress || '', moveDate: c.moveDate || null,
      moveSize: c.moveSize || '', notes: c.notes || '', sourceTag, status: 'new',
      smJobId: '', submittedAt: new Date().toISOString(),
    });
  } catch (e) {
    return reply({ ok: false, error: 'db_insert_failed', message: e.message }, 500);
  }
  const leadId = inserted && inserted[0] ? inserted[0].id : null;

  // 2) Push into SmartMoving.
  const sm = await pushToSmartMoving(env, lead, realtor);

  // 3) Reconcile the saved row with the REAL SmartMoving result — never a silent
  //    success. On success, stamp the smJobId; on failure leave smJobId empty and
  //    annotate the note so the failure is visible and the lead is recoverable.
  if (leadId != null) {
    try {
      if (sm && sm.ok && sm.smJobId) {
        await db.update('portal_leads', `id=eq.${leadId}`, { smJobId: String(sm.smJobId) });
      } else if (!sm || !sm.ok) {
        const why = (sm && sm.error) || 'unknown';
        const flagged = ((c.notes || '').trim() + `\n[SMARTMOVING PUSH FAILED: ${why} — needs manual push]`).trim();
        await db.update('portal_leads', `id=eq.${leadId}`, { notes: flagged });
      }
    } catch (_) { /* best-effort; the row already exists and is recoverable */ }
  }

  // 4) Team notification (best-effort; no-op until Resend is configured).
  await emailTeam(env, lead, realtor, sourceTag);

  // 5) Respond truthfully. The lead is durably saved either way; smartmoving.ok
  //    tells the caller whether it actually reached SmartMoving (queued if not).
  return reply({ ok: true, leadId, smartmoving: sm });
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
