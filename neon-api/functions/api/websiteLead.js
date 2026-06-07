/** POST /api/websiteLead — public "Get a Quote" form -> SmartMoving Lead Provider API.
 *  Body: { firstName, lastName, phone|phoneNumber, email, serviceType?, moveSize?, moveDate?,
 *          originAddress?, destinationAddress?, notes?, referralSource?, utm*?, gclid?, company?(honeypot) }
 *  Env: SMARTMOVING_PROVIDER_KEY (has fallback), SM_LEAD_BRANCH_ID? */
import { endpoint, preflight } from '../_shared.js';

const handler = endpoint(async ({ env, body, reply }) => {
  const providerKey = env.SMARTMOVING_PROVIDER_KEY || 'd18a311b-7df6-4483-90a7-b3d201630cea';
  const b = body || {};
  if (b.company) return reply({ ok: true, skipped: 'bot' }); // honeypot

  const firstName = String(b.firstName || '').trim();
  const lastName = String(b.lastName || '').trim();
  const phone = String(b.phone || b.phoneNumber || '').trim();
  const email = String(b.email || '').trim();
  if (!firstName || !lastName || (!phone && !email))
    return reply({ ok: false, error: 'First name, last name, and a phone or email are required.' }, 400);

  let url = 'https://api.smartmoving.com/api/leads/from-provider/v2?providerKey=' + encodeURIComponent(providerKey);
  if (env.SM_LEAD_BRANCH_ID) url += '&branchId=' + encodeURIComponent(env.SM_LEAD_BRANCH_ID);

  const originFull = String(b.originAddress || b.origin || b.originZip || '').trim();
  const destFull = String(b.destinationAddress || b.destination || b.destinationZip || '').trim();
  const payload = {
    firstName, lastName, phoneNumber: phone, email,
    userOptIn: (b.userOptIn === 'true' || b.userOptIn === true) ? 'true' : 'false',
    serviceType: String(b.serviceType || '').trim(),
    moveSize: String(b.moveSize || '').trim(),
    moveDate: String(b.moveDate || '').replace(/-/g, ''),
    notes: String(b.notes || '').trim(),
    utmSource: String(b.utmSource || '').trim(), utmMedium: String(b.utmMedium || '').trim(),
    utmCampaign: String(b.utmCampaign || '').trim(), utmContent: String(b.utmContent || '').trim(),
    utmKeyword: String(b.utmKeyword || '').trim(), utmAdGroup: String(b.utmAdGroup || '').trim(),
    gclid: String(b.gclid || '').trim(),
  };
  if (originFull) payload.originAddressFull = originFull;
  if (destFull) payload.destinationAddressFull = destFull;
  if (b.referralSource) payload.referralSource = String(b.referralSource).trim();

  let res, txt;
  try {
    res = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(payload) });
    txt = await res.text();
  } catch (e) {
    return reply({ ok: false, error: 'Could not reach SmartMoving: ' + (e && e.message) }, 502);
  }
  if (res.ok) return reply({ ok: true });
  if (res.status === 400 && /already/i.test(txt || '')) return reply({ ok: true, duplicate: true });
  return reply({ ok: false, status: res.status, error: (txt || '').slice(0, 300) }, 502);
});

export const onRequestPost = handler;
export const onRequestOptions = ({ request }) => preflight(request);
