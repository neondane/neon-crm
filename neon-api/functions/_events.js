/** _events.js : THE list of things Neon CRM can alert about. Every channel (phone push,
 *  desktop, text-me SMS, in-app list) reads from here, so one event = one alert.
 *  defaults: what a person gets until they change it in the app's Alerts tab.
 *  urgent: breaks through quiet hours and is sent high priority.
 */
export const EVENTS = [
  { key: 'text_in',        group: 'Messages',  label: 'Texts from realtors and customers', desc: 'Someone texts the business line (360) 588-5228.', defaults: { push: true,  desktop: true, sms: false } },
  { key: 'email_in',       group: 'Messages',  label: 'Email replies',                     desc: 'Someone replies to an email sent from the CRM.', defaults: { push: true,  desktop: true, sms: false } },
  { key: 'opt_out',        group: 'Messages',  label: 'Someone texted STOP',               desc: 'They asked not to be texted again.',           defaults: { push: true,  desktop: true, sms: false } },
  { key: 'referral_new',   group: 'Leads',     label: 'New partner referral',              desc: 'A partner sends a client, through their portal or straight into SmartMoving.', defaults: { push: true,  desktop: true, sms: false } },
  { key: 'lead_website',   group: 'Leads',     label: 'New website quote request',         desc: 'Someone fills out the quote form on neongiantmoving.com.', defaults: { push: true, desktop: true, sms: false } },
  { key: 'lead_facebook',  group: 'Leads',     label: 'New Facebook lead',                 desc: 'A Facebook or Instagram lead form comes in.',  defaults: { push: true,  desktop: true, sms: false } },
  { key: 'partner_apply',  group: 'Leads',     label: 'New partner application',           desc: 'A realtor applies on the /partners page.',     defaults: { push: true,  desktop: true, sms: false } },
  { key: 'referral_stuck', group: 'Problems',  label: "Referral didn't reach SmartMoving", desc: 'It is saved and retrying. If it fails 6 times, enter it by hand.', urgent: true, defaults: { push: true, desktop: true, sms: false } },
  { key: 'job_booked',     group: 'Jobs',      label: 'Partner referral booked',           desc: 'A job a realtor referred moves to Booked in SmartMoving.', defaults: { push: true, desktop: true, sms: false } },
  { key: 'job_completed',  group: 'Jobs',      label: 'Job completed, payout due',         desc: 'A referred job is completed, so the realtor has a payout coming.', defaults: { push: true, desktop: true, sms: false } },
  { key: 'followup_due',   group: 'Reminders', label: 'Follow-up or reminder due',         desc: 'A follow-up you set on a contact comes due.',  defaults: { push: true,  desktop: true, sms: false } },
  { key: 'birthday',       group: 'Reminders', label: 'Partner birthday',                  desc: 'At 8 AM on a partner’s birthday.',        defaults: { push: true,  desktop: true, sms: false } },
  { key: 'partner_listed', group: 'Reminders', label: 'A partner just listed a home',      desc: 'From the morning Listing Radar sweep.',        defaults: { push: false, desktop: true, sms: false } },
];
export const EVENT_BY_KEY = Object.fromEntries(EVENTS.map((e) => [e.key, e]));
export const CHANNELS = ['push', 'desktop', 'sms'];

/** A person's effective switch for one event + channel. prefs.channels = { text_in: { push:false }, ... } */
export function wants(prefs, eventKey, channel) {
  if (eventKey === 'test') return true;
  const ev = EVENT_BY_KEY[eventKey]; if (!ev) return false;
  const mine = prefs && prefs.channels && prefs.channels[eventKey];
  if (mine && typeof mine[channel] === 'boolean') return mine[channel];
  return !!ev.defaults[channel];
}
export const isUrgent = (eventKey) => !!(EVENT_BY_KEY[eventKey] && EVENT_BY_KEY[eventKey].urgent);
