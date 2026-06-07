/** GET/POST /api/getRealtorPortalView — personalized realtor portal data.
 *  Body: { slug }  (slug ends with "-<contactId>", e.g. "dianne-sager-57")
 *  Returns { ok, realtor:{...}, totals:{...}, leads:[...] } — all from Supabase.
 *  Env: SUPABASE_URL, SUPABASE_KEY */
import { endpoint, preflight, sb } from '../_shared.js';

const handler = endpoint(async ({ env, body, reply }) => {
  const slug = String(body.slug || '').toLowerCase().trim();
  if (!slug) return reply({ ok: false, error: 'no_slug' }, 400);
  const tail = slug.match(/-(\d+)$/);
  const id = tail ? +tail[1] : null;
  if (!id) return reply({ ok: false, error: 'bad_slug' }, 400);

  const db = sb(env);
  const contacts = await db.select(`contacts?id=eq.${id}&select=id,name,business,type,profilePic,cardImage,portalActivatedAt&limit=1`);
  const realtor = contacts && contacts[0];
  if (!realtor || !/realtor/i.test(realtor.type || '')) return reply({ ok: false, error: 'realtor_not_found' }, 404);

  const activatedAt = realtor.portalActivatedAt ? new Date(realtor.portalActivatedAt) : null;
  let leads = [];
  try {
    leads = await db.select(`portal_leads?realtorId=eq.${id}&select=id,customerName,moveSize,moveDate,status,submittedAt&order=submittedAt.desc`);
  } catch (_) { leads = []; }

  // Hide pre-activation and lost leads from the realtor's view.
  leads = (leads || []).filter((l) => {
    if (String(l.status || '').toLowerCase() === 'lost') return false;
    if (activatedAt && l.submittedAt && new Date(l.submittedAt) < activatedAt) return false;
    return true;
  });

  const totals = leads.reduce((a, l) => {
    a.total++;
    const s = String(l.status || '').toLowerCase();
    if (s === 'booked') a.booked++;
    else if (s === 'completed') { a.completed++; a.earnedPaid += 50; }
    if (s === 'booked' || s === 'completed') a.earnedPending += 50;
    return a;
  }, { total: 0, booked: 0, completed: 0, earnedPaid: 0, earnedPending: 0 });
  totals.earnedPending -= totals.earnedPaid;

  return reply({
    ok: true,
    realtor: {
      id: realtor.id,
      firstName: String(realtor.name || '').split(' ')[0],
      name: realtor.name,
      business: realtor.business || '',
      headshot: realtor.profilePic || realtor.cardImage || '',
      activated: !!activatedAt,
      activatedAt: activatedAt ? activatedAt.toISOString() : null,
    },
    totals,
    leads: leads.map((l) => ({ id: l.id, customerName: l.customerName, moveSize: l.moveSize, moveDate: l.moveDate, status: l.status || 'new', submittedAt: l.submittedAt })),
  });
});

export const onRequestPost = handler;
export const onRequestGet = handler;
export const onRequestOptions = ({ request }) => preflight(request);
