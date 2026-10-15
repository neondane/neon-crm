/** neon-api/functions/api/_middleware.js : runs before every /api/* endpoint.
 *
 *  Phase 2: the endpoints listed in LOCKED used to answer anyone on the internet. They spend
 *  money (Anthropic, Google, RentCast), publish to the website (WordPress) or read private
 *  business data (SmartMoving, Tremendous). They now need an API key with 'write' scope:
 *    - the CRM and phone app reach them through /api/secure/<name> on crm/crm3, which checks the
 *      Cloudflare login and adds the server-held key (the browser never sees a key),
 *    - the database scheduler sends its own key (scanAgentListings, reconcileSmartMoving).
 *  Everything NOT listed keeps its own rules: public forms (websiteLead, partnerApply, places*),
 *  review links, job tracking, webhooks with their own secrets, and endpoints that already
 *  call authKey themselves.
 */
import { authKey } from '../_apikeys.js';

export const LOCKED = new Set([
  // AI (Anthropic bill)
  'parseContact', 'improveNotes', 'suggestComments', 'researchAgent', 'checkListings', 'discoverNewLeads', 'generateDayPlan',
  // website publishing (WordPress)
  'publishPartnerPage', 'publishCityPage',
  // paid data / maps
  'rentcast', 'geocode', 'resolvePlace', 'scanAgentListings',
  // private business data
  'tremendousAudit', 'smJob', 'smFindReferral', 'reconcileSmartMoving', 'getRealtorPortalView',
  // duplicate of the portal's referral path (the real one is refer.neongiantmoving.com)
  'submitReferralLead',
]);

export async function onRequest(context) {
  const { request, env, next } = context;
  if (request.method === 'OPTIONS') return next();
  const name = new URL(request.url).pathname.replace(/^\/api\/?/, '').split('/')[0];
  if (!LOCKED.has(name)) return next();
  const k = await authKey(env, request, 'write');
  if (!k.ok) {
    return new Response(JSON.stringify({ ok: false, error: k.error, message: 'This needs a CRM login.' }), {
      status: k.status || 401,
      headers: { 'Content-Type': 'application/json', 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' },
    });
  }
  return next();
}
