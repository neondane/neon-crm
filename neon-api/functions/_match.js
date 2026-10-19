/** _match.js : which CRM contact gets credit for a SmartMoving referral.
 *
 *  SmartMoving gives a free-text affiliate: "Kelli Lang", "Creekside", "Shane Servoss (Kelli Lang)",
 *  "Melissa (Creekside)", "Renee - Windermere Real Estate". Until Oct 19, 2026 we also matched on
 *  brokerage name, so "Renee - Windermere Real Estate" was credited to the first contact whose
 *  business was "Windermere" (Amy Malmkar). Rules now, in order:
 *    1. The whole text is a contact's name.
 *    2. The person part is a FULL name of a contact ("Shane Servoss (Kelli Lang)" -> Shane).
 *    3. The company / bracket part is a contact's name: a facility or team contact
 *       ("Melissa (Creekside)" -> Creekside, as before).
 *    4. A contact's full name appears inside the text.
 *    5. "First name - Company": exactly one contact with that first name at that company.
 *    6. No person part, and exactly one contact has that business ("StorQuest Self Storage").
 *  A brokerage shared by several agents never decides it. No match = saved as unmatched and
 *  Dane is alerted that the partner isn't in the CRM. Better no credit than the wrong person's.
 *  When the same person exists twice in the CRM, the one with the portal switched on wins.
 */
export const norm = (s) => String(s || '').toLowerCase().replace(/[^a-z0-9]/g, '');

function splitAffiliate(partner) {
  const raw = String(partner || '').trim();
  const br = raw.match(/^(.+?)\s*\((.+)\)\s*$/);
  if (br) return { person: br[1].trim(), company: br[2].trim(), whole: raw };
  const parts = raw.split(/\s+[-–—|@/]\s+|\s+at\s+|,\s+/i).map((x) => x.trim()).filter(Boolean);
  return { person: parts.length > 1 ? parts[0] : '', company: parts.length > 1 ? parts.slice(1).join(' ') : '', whole: raw };
}
const coKey = (s) => norm(String(s || '').replace(/\b(real estate|realty|group|team|inc|llc|the|of)\b/gi, ' ')).slice(0, 7);
function sameCompany(business, company) {
  const a = coKey(business), b = coKey(company);
  return !!(a && b && (a.startsWith(b) || b.startsWith(a)));
}
const fullName = (s) => /\S\s+\S/.test(String(s || '').trim());
// Same person entered twice: prefer the one with an active portal, then the oldest record.
function pick(arr) {
  if (!arr.length) return null;
  const names = new Set(arr.map((c) => norm(c.name)));
  if (names.size > 1) return null; // genuinely different people
  return arr.slice().sort((a, b) => (b.portalActivatedAt ? 1 : 0) - (a.portalActivatedAt ? 1 : 0) || (+a.id || 0) - (+b.id || 0))[0];
}

export function matchContact(partner, contacts) {
  const { person, company, whole } = splitAffiliate(partner);
  const t = norm(whole); if (!t) return null;
  const list = (contacts || []).filter((c) => c && norm(c.name));
  const byName = (s) => list.filter((c) => norm(c.name) === norm(s));
  let m;
  if ((m = pick(byName(whole)))) return m;                                           // 1
  if (person && fullName(person) && (m = pick(byName(person)))) return m;            // 2
  if (company && (m = pick(byName(company)))) return m;                              // 3
  const inside = list.filter((c) => fullName(c.name) && norm(c.name).length >= 7 && t.indexOf(norm(c.name)) >= 0);
  if ((m = pick(inside))) return m;                                                  // 4
  if (person && company && !fullName(person)) {                                       // 5
    const fn = norm(person);
    if ((m = pick(list.filter((c) => norm(String(c.name).trim().split(/\s+/)[0]) === fn && sameCompany(c.business, company))))) return m;
  }
  if (!person) {                                                                      // 6
    const biz = list.filter((c) => { const b = norm(c.business); return b.length > 4 && (b === t || b.startsWith(t) || t.startsWith(b)); });
    if (biz.length === 1) return biz[0];
  }
  return null;
}
