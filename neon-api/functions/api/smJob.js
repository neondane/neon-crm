/** POST /api/smJob — { oppId } → live job + CREW details from SmartMoving,
 *  for the CRM job/move detail (open item #76). There is no `crews` table —
 *  crew is always read live from SmartMoving and never stored.
 *
 *  Sources: GET /api/opportunities/<id> (jobs[]), then GET /api/jobs/<jobId>
 *  for each job when the inline job data has no crew. Field names vary by
 *  account/version, so crew extraction is defensive across known shapes.
 *
 *  Replies 200 always (ok:false + error on problems). Never echoes the key.
 *  Env: SMARTMOVING_API_KEY */
import { endpoint, preflight } from '../_shared.js';

const SM_BASE = 'https://api-public.smartmoving.com/v1';

async function smGet(key, path) {
  try {
    const r = await fetch(SM_BASE + path, { headers: { 'x-api-key': key, Accept: 'application/json' } });
    if (!r.ok) return { ok: false, status: r.status };
    return { ok: true, body: await r.json() };
  } catch (e) { return { ok: false, err: String((e && e.message) || e) }; }
}

function nameOf(v) {
  if (!v) return '';
  if (typeof v === 'string') return v.trim();
  if (typeof v === 'object') {
    const n = v.name || v.fullName || v.displayName ||
      (((v.firstName || '') + ' ' + (v.lastName || '')).trim());
    if (n) return String(n).trim();
    if (v.user) return nameOf(v.user);
    if (v.crewMember) return nameOf(v.crewMember);
    if (v.employee) return nameOf(v.employee);
  }
  return '';
}
function crewNames(j) {
  if (!j || typeof j !== 'object') return [];
  const out = [];
  const push = (v) => { const n = nameOf(v); if (n) out.push(n); };
  ['crew', 'crewMembers', 'assignedCrew', 'crewAssignments', 'assignments',
    'laborers', 'movers', 'assignedUsers', 'workers'].forEach((k) => {
    const v = j[k];
    if (Array.isArray(v)) v.forEach(push);
    else if (v) push(v);
  });
  push(j.crewLead); push(j.foreman); push(j.driver);
  // de-dupe, keep order
  const seen = {}; const uniq = [];
  out.forEach((n) => { const k = n.toLowerCase(); if (!seen[k]) { seen[k] = 1; uniq.push(n); } });
  return uniq;
}

const handler = endpoint(async ({ env, body, reply }) => {
  try {
    const oppId = String((body && (body.oppId || body.id || body['opportunity-id'])) || '').trim();
    if (!oppId) return reply({ ok: false, error: 'missing_opp_id' });
    const key = env.SMARTMOVING_API_KEY;
    if (!key) return reply({ ok: false, error: 'sm_not_configured' });

    // The id we hold may be an opportunity id OR (older rows) a job id.
    let opp = null;
    let g = await smGet(key, '/api/opportunities/' + encodeURIComponent(oppId));
    if (g.ok) opp = g.body;
    else {
      const gj = await smGet(key, '/api/jobs/' + encodeURIComponent(oppId));
      if (gj.ok && gj.body) {
        const pid = gj.body.opportunityId || gj.body.opportunity_id || (gj.body.opportunity && gj.body.opportunity.id);
        if (pid) { const g2 = await smGet(key, '/api/opportunities/' + encodeURIComponent(pid)); if (g2.ok) opp = g2.body; }
        if (!opp) {
          const crew = crewNames(gj.body);
          return reply({ ok: true, oppId, customer: nameOf(gj.body.customer), jobs: [{ id: oppId, crew }], crew });
        }
      }
    }
    if (!opp) return reply({ ok: false, oppId, error: 'not_found', status: g.status || g.err });

    const jobsIn = Array.isArray(opp.jobs) ? opp.jobs.slice(0, 5) : [];
    const jobs = [];
    for (const j of jobsIn) {
      if (!j) continue;
      let crew = crewNames(j);
      let detail = j;
      if (!crew.length && j.id) {
        const gd = await smGet(key, '/api/jobs/' + encodeURIComponent(j.id));
        if (gd.ok && gd.body) { detail = gd.body; crew = crewNames(gd.body); }
      }
      jobs.push({
        id: j.id || null,
        jobNumber: detail.jobNumber || j.jobNumber || null,
        date: detail.jobDate || detail.serviceDate || j.jobDate || null,
        status: detail.jobStatus || detail.status || j.jobStatus || j.status || null,
        type: detail.type || detail.jobType || null,
        crew,
      });
    }
    const all = []; const seen = {};
    jobs.forEach((j) => (j.crew || []).forEach((n) => { const k = n.toLowerCase(); if (!seen[k]) { seen[k] = 1; all.push(n); } }));
    return reply({
      ok: true, oppId,
      customer: nameOf(opp.customer) || null,
      serviceDate: opp.serviceDate || null,
      status: opp.status || null,
      leadStatus: opp.leadStatus || null,
      jobs, crew: all,
    });
  } catch (e) {
    return reply({ ok: false, error: 'smjob_error', message: String((e && e.message) || e) });
  }
});

export const onRequestPost = handler;
export const onRequestGet = handler;
export const onRequestOptions = ({ request }) => preflight(request);
