/**
 * /api/icalFetch.js — Fetch + parse a Google Calendar iCal URL into JSON
 *
 *   POST /api/icalFetch
 *     Body: { url: "https://calendar.google.com/calendar/ical/.../basic.ics" }
 *     Returns: { ok:true, events: [{ uid, summary, start, end, allDay, location, desc }] }
 *
 * Why server-side: CORS prevents direct browser fetch of Google iCal URLs.
 * Also keeps the URL token-ish (it's a "secret URL" but treating it as soft-secret).
 *
 * No env vars needed.
 */

const ALLOWED_ORIGINS = ['https://crm.neongiantmoving.com', 'https://refer.neongiantmoving.com'];

function corsHeaders(origin) {
  let allow = ALLOWED_ORIGINS[0];
  if (origin && ALLOWED_ORIGINS.includes(origin)) allow = origin;
  return {
    'Access-Control-Allow-Origin': allow,
    'Access-Control-Allow-Methods': 'POST, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type',
    'Vary': 'Origin',
  };
}
function json(body, status, origin) {
  return new Response(JSON.stringify(body), { status, headers: { 'Content-Type': 'application/json', 'Cache-Control': 'max-age=300', ...corsHeaders(origin) } });
}

// Minimal iCal VEVENT parser — handles the bits Google calendar emits
function parseIcal(text) {
  // Unfold lines (RFC 5545: lines that start with space or tab are continuations)
  const unfolded = text.replace(/\r\n[ \t]/g, '').replace(/\n[ \t]/g, '');
  const lines = unfolded.split(/\r?\n/);
  const events = [];
  let cur = null;
  for (const raw of lines) {
    if (raw === 'BEGIN:VEVENT') { cur = {}; continue; }
    if (raw === 'END:VEVENT') {
      if (cur && cur.start) events.push(cur);
      cur = null; continue;
    }
    if (!cur) continue;
    const idx = raw.indexOf(':');
    if (idx < 0) continue;
    const keyPart = raw.slice(0, idx);
    const value = raw.slice(idx + 1);
    const key = keyPart.split(';')[0].toUpperCase();
    if (key === 'UID') cur.uid = value;
    else if (key === 'SUMMARY') cur.summary = unescapeIcal(value);
    else if (key === 'DESCRIPTION') cur.desc = unescapeIcal(value);
    else if (key === 'LOCATION') cur.location = unescapeIcal(value);
    else if (key === 'DTSTART') {
      const parsed = parseIcalDate(keyPart, value);
      cur.start = parsed.iso; cur.allDay = parsed.allDay;
    }
    else if (key === 'DTEND') {
      const parsed = parseIcalDate(keyPart, value);
      cur.end = parsed.iso;
    }
    else if (key === 'STATUS') cur.status = value.toLowerCase();
    else if (key === 'RRULE') cur.rrule = value;  // recurring; not expanded — see below
  }
  return events;
}

function unescapeIcal(s) {
  return String(s || '').replace(/\\n/g, '\n').replace(/\\,/g, ',').replace(/\\;/g, ';').replace(/\\\\/g, '\\');
}

function parseIcalDate(keyPart, value) {
  // VALUE=DATE means all-day (YYYYMMDD)
  const allDay = /VALUE=DATE\b/i.test(keyPart);
  if (allDay && /^\d{8}$/.test(value)) {
    const y = +value.slice(0,4), m = +value.slice(4,6), d = +value.slice(6,8);
    return { iso: new Date(Date.UTC(y, m-1, d)).toISOString(), allDay: true };
  }
  // UTC: ...Z
  if (/^\d{8}T\d{6}Z$/.test(value)) {
    const y = +value.slice(0,4), m = +value.slice(4,6), d = +value.slice(6,8);
    const hh = +value.slice(9,11), mm = +value.slice(11,13), ss = +value.slice(13,15);
    return { iso: new Date(Date.UTC(y, m-1, d, hh, mm, ss)).toISOString(), allDay: false };
  }
  // TZID=...:YYYYMMDDTHHMMSS (treat as local-naive; Google uses Pacific for our use)
  if (/^\d{8}T\d{6}$/.test(value)) {
    const y = +value.slice(0,4), m = +value.slice(4,6), d = +value.slice(6,8);
    const hh = +value.slice(9,11), mm = +value.slice(11,13), ss = +value.slice(13,15);
    // Best-effort: treat as ET — actual TZ is in keyPart's TZID. For Skagit users we use America/Los_Angeles offset.
    return { iso: new Date(y, m-1, d, hh, mm, ss).toISOString(), allDay: false };
  }
  return { iso: null, allDay: allDay };
}

export async function onRequestOptions({ request }) {
  return new Response(null, { status: 204, headers: corsHeaders(request.headers.get('Origin')) });
}

export async function onRequestPost({ request, env }) {
  const origin = request.headers.get('Origin');
  let body;
  try { body = await request.json(); } catch (_) { return json({ ok: false, error: 'bad_json' }, 400, origin); }

  const url = String(body.url || '').trim();
  if (!url) return json({ ok: false, error: 'missing_url' }, 400, origin);
  // Safety: must be calendar.google.com or a known iCal host
  let host;
  try { host = new URL(url).host; } catch (_) { return json({ ok: false, error: 'invalid_url' }, 400, origin); }
  const allowedHosts = ['calendar.google.com', 'www.google.com'];
  if (!allowedHosts.includes(host)) {
    return json({ ok: false, error: 'unsupported_host', host, allowed: allowedHosts }, 400, origin);
  }

  let r, text;
  try {
    r = await fetch(url, { headers: { 'User-Agent': 'NeonGiantCRM/1.0' }, cf: { cacheTtl: 300 } });
    if (!r.ok) return json({ ok: false, error: 'fetch_failed', status: r.status }, 502, origin);
    text = await r.text();
  } catch (e) {
    return json({ ok: false, error: 'network_error', message: e.message }, 502, origin);
  }

  let events;
  try { events = parseIcal(text); }
  catch (e) { return json({ ok: false, error: 'parse_error', message: e.message }, 500, origin); }

  // Trim to past-30-days through next-90-days to keep payload small
  const cutoffPast = Date.now() - 30 * 86400000;
  const cutoffFuture = Date.now() + 90 * 86400000;
  const trimmed = events.filter(e => {
    const t = e.start ? new Date(e.start).getTime() : 0;
    return t >= cutoffPast && t <= cutoffFuture;
  }).map(e => ({
    uid: e.uid, summary: e.summary || '(untitled)',
    start: e.start, end: e.end, allDay: !!e.allDay,
    location: e.location || null, desc: (e.desc || '').slice(0, 200),
    source: 'google',
  }));

  return json({ ok: true, events: trimmed, totalReceived: events.length, returned: trimmed.length, fetchedAt: new Date().toISOString() }, 200, origin);
}
