/** GET /api/reviewTrack?c=<contactId>&p=<phone>&a=<askId> — log the click, then 302 to Google.
 *  Env: GOOGLE_REVIEW_URL (the real Google review link), SUPABASE_URL, SUPABASE_KEY */
const DEFAULT_REVIEW_URL = 'https://g.page/r/CYourGoogleReviewID/review';

async function supa(env, path, init) {
  return fetch(env.SUPABASE_URL + '/rest/v1/' + path, {
    ...init,
    headers: { apikey: env.SUPABASE_KEY, Authorization: 'Bearer ' + env.SUPABASE_KEY, 'Content-Type': 'application/json', ...((init || {}).headers || {}) },
  });
}

export async function onRequestGet({ request, env }) {
  const url = new URL(request.url);
  const contactId = url.searchParams.get('c');
  const phone = url.searchParams.get('p');
  const askId = url.searchParams.get('a');
  const dest = env.GOOGLE_REVIEW_URL || DEFAULT_REVIEW_URL;

  if (env.SUPABASE_URL && env.SUPABASE_KEY) {
    const now = new Date().toISOString();
    const ua = request.headers.get('User-Agent') || null;
    if (askId) {
      supa(env, `review_asks?id=eq.${askId}`, { method: 'PATCH', body: JSON.stringify({ clicked_at: now, user_agent: ua }) }).catch(() => {});
    } else {
      supa(env, 'review_clicks', { method: 'POST', headers: { Prefer: 'return=minimal' }, body: JSON.stringify({ contact_id: contactId ? parseInt(contactId, 10) : null, phone: phone || null, clicked_at: now, user_agent: ua, referer: request.headers.get('Referer') || null }) }).catch(() => {});
    }
  }
  return new Response(null, { status: 302, headers: { Location: dest, 'Cache-Control': 'no-store' } });
}
