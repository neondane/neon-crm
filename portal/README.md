# Neon Giant Moving — Realtor Referral Portal

The public-facing portal hosted at **refer.neongiantmoving.com**. Realtors land here from a personal link that includes their slug-id (e.g. `?r=jane-smith-49`); the page reads their referral history, shows earnings, and lets them submit new customers.

## How it fits together

```
Realtor browser
    │  HTTPS
    ▼
refer.neongiantmoving.com (Cloudflare Pages)
  /                  → index.html (lands here without ?r=; redirects to /portal.html?r=… if r present)
  /portal.html       → dashboard (stats, history, refer-someone-new CTA, share link)
  /refer.html        → submit a customer form
  /api/<action>      → Cloudflare Pages Function → Apps Script
                          │  server-to-server fetch — no CORS, no workspace redirect
                          ▼
                  script.google.com/macros/s/.../exec  (Apps Script backend, unchanged)
                          │
                          ▼
                  Google Sheets (leads, contacts) + SmartMoving API
```

## Why a Cloudflare Pages Function proxy

Apps Script's `/macros/s/.../exec` URL redirects anonymous browsers to `/a/macros/neongiantmoving.com/s/.../exec`, which is workspace-restricted and returns "Page Not Found" for anyone not signed into the workspace. That breaks both reading the dashboard and submitting the form for any realtor.

Cloudflare Pages Functions run inside Cloudflare's edge — server-to-server with Apps Script. They have no Google cookies, so the redirect doesn't kick in. The proxy re-emits CORS headers for the browser, so the portal pages can call the same API origin (`/api/…`) without cross-origin headaches.

This is also future-proof: the Apps Script URL can change, we add observability, we add rate-limiting — all without touching the static pages.

## Authentication

Slug-based URLs are the credential. `?r=jane-smith-49` resolves to a specific realtor in the backend. The slug embeds the realtor's database ID, so it's not guessable from the name alone, and the data shown (referral history, earnings status) is not sensitive financial info.

Lost leads are filtered out before the portal sees them — realtors only see Booked / Completed / Contacted statuses. The Apps Script endpoint `getRealtorPortalView` applies that filter.

## File map

| Path                                | Purpose                                                              |
| ----------------------------------- | -------------------------------------------------------------------- |
| `index.html`                        | Landing — redirects to portal if `?r=` set, else minimal info card.  |
| `portal.html`                       | Realtor dashboard — stats, recent referrals, share-your-link, CTA.   |
| `refer.html`                        | Submit-a-customer form. Returns to portal on success.                |
| `functions/api/[[path]].js`         | Pages Function. Forwards `/api/<action>` to Apps Script with CORS.   |
| `_headers`                          | Cache + security headers (X-Frame-Options, no-store on /api, etc.).  |
| `_redirects`                        | Friendly URL aliases (`/portal` → `/portal.html`, etc.).             |
| `logo.png`                          | Brand mark used in header and favicon.                               |

## Apps Script endpoints used

The backend (project ID `1US5Tkl3LXnYESd6Lm3SgYjvTD7ON27mdOBxc9jdEbhU-IKdLoOi71BvQ`) exposes:

| Action                  | Method | Payload                                  | Returns                                  |
| ----------------------- | ------ | ---------------------------------------- | ---------------------------------------- |
| `getRealtorBySlug`      | POST   | `{ slug }`                               | `{ ok, realtor: { id, name, firstName, email, portalActivatedAt } }` |
| `getRealtorPortalView`  | POST   | `{ slug }` or `{ realtorId }`            | `{ ok, realtor, leads[], totals }`       |
| `submitReferralLead`    | POST   | `{ realtorId, customer: { name, phone, … } }` | `{ ok, leadId, sourceTag, smJobId }`   |

For the proxy to reach Apps Script, the deployment must be set to **Execute as: Me, Who has access: Anyone** (otherwise the workspace login redirect blocks the anonymous proxy fetch).

## Deploy

1. Cloudflare Pages project is wired to `neondane/neon-crm` repo, root directory `/portal/`.
2. Pushes to `main` auto-deploy. Preview deploys for PRs.
3. Custom domain: `refer.neongiantmoving.com` → CNAME at GoDaddy → `<project>.pages.dev`.
4. Cloudflare auto-provisions HTTPS via SSL-for-SaaS / SNI passthrough.

## Local testing

Static pages render fine from `file://`. The `/api/*` calls won't work without running Wrangler dev (which simulates Pages Functions locally). For a quick end-to-end test, just push to a preview branch and use the `*.pages.dev` URL.
