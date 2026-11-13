// Exercises the CRM top-bar search in a real browser with the database mocked.
// Run: NODE_PATH=/tmp/ppt/node_modules node tests/global-search.test.mjs
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { spawn } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
let puppeteer;
try { puppeteer = require('puppeteer-core'); }
catch { console.log('skip: puppeteer-core is not installed'); process.exit(0); }

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', 'v3');
const CHROME = process.env.CHROME || '/usr/local/bin/google-chrome';
const shots = process.env.SHOT_DIR || '/opt/cursor/artifacts';

const CONTACTS = [
  { id: 1, name: 'Ada Lovelace', business: 'Analytical Engines', type: 'Realtor', phone: '(360) 555-0101', email: 'ada@example.com', role: 'Agent', territory: 'Skagit', address: '12 Babbage St, Bellingham' },
  { id: 2, name: 'Grace Hopper', business: 'Navy Yard', type: 'Realtor', phone: '(360) 555-0199', email: 'grace@example.com', role: 'Agent', territory: 'Whatcom', address: '1 Compiler Ave, Bellingham', notes: 'Asked about maple street rates for a client.' },
  { id: 3, name: 'Bellingham Mini Storage', business: 'Bellingham Mini Storage', type: 'Self-Storage Facility', phone: '(360) 555-0144', email: 'desk@storage.example', role: 'Manager', territory: 'Whatcom', address: '500 Maple St, Bellingham' },
];
const ADAM = { id: 9, name: 'Adam West', business: 'Gotham Realty', type: 'Realtor', phone: '(360) 555-0177', email: 'adam@example.com', role: 'Agent', territory: 'Skagit', address: '9 Wayne St' };

function termOf(url) {
  const m = decodeURIComponent(url).match(/ilike\.\*([^*]*)\*/i);
  return (m ? m[1] : '').toLowerCase();
}
function limitOf(url) {
  const m = url.match(/[?&]limit=(\d+)/);
  return m ? +m[1] : 100;
}
function hit(row, q, fields) {
  return fields.some((f) => String(row[f] == null ? '' : row[f]).toLowerCase().includes(q));
}

const SMS = [
  { id: 101, contact_id: 1, direction: 'in', body: 'the maple unit is ready', from_number: '+13605550101', to_number: '+13605550000', created_at: '2026-11-02T15:00:00Z' },
  { id: 102, contact_id: 1, direction: 'out', body: 'maple boxes are on the truck', from_number: '+13605550000', to_number: '+13605550101', created_at: '2026-11-02T16:00:00Z' },
  { id: 103, contact_id: 3, direction: 'in', body: 'maple gate code is 1928', from_number: '+13605550144', to_number: '+13605550000', created_at: '2026-11-03T12:00:00Z' },
  { id: 104, contact_id: 2, direction: 'in', body: 'please hold the maple quote', from_number: '+13605550199', to_number: '+13605550000', created_at: '2026-11-03T13:00:00Z' },
  { id: 105, contact_id: 1, direction: 'in', body: 'maple invoice attached', from_number: '+13605550101', to_number: '+13605550000', created_at: '2026-11-04T12:00:00Z' },
  { id: 106, contact_id: 2, direction: 'out', body: 'sent the maple estimate', from_number: '+13605550000', to_number: '+13605550199', created_at: '2026-11-04T18:00:00Z' },
];

function searchBody(url) {
  const q = termOf(url);
  const lim = limitOf(url);
  const u = decodeURIComponent(url);
  if (u.includes('/sms_messages')) return SMS.filter((m) => hit(m, q, ['body', 'from_number', 'to_number'])).slice(0, lim);
  if (u.includes('/email_messages')) {
    return [{ id: 201, contact_id: 2, direction: 'in', subject: 'Referral for Maple', body: 'Customer is moving next week', from_email: 'grace@example.com', to_email: 'dane@example.com', created_at: '2026-11-01T12:00:00Z' }]
      .filter((m) => hit(m, q, ['subject', 'body', 'from_email', 'to_email'])).slice(0, lim);
  }
  if (u.includes('/referrals')) {
    return [{ id: 301, contactId: '1', contactName: 'Ada Lovelace', jobName: 'Maple Family Move', status: 'booked', date: '2026-10-20', amount: '2500', notes: 'third floor' }]
      .filter((m) => hit(m, q, ['jobName', 'contactName', 'notes', 'status'])).slice(0, lim);
  }
  if (u.includes('/portal_leads')) {
    return [{ id: 401, customerName: 'Sam Maple', realtorName: 'Ada Lovelace', realtorId: '1', status: 'new', moveDate: '2026-12-01', submittedAt: '2026-11-01', fromAddress: '9 Oak Rd', toAddress: '500 Maple St', customerPhone: '3605550188' }]
      .filter((m) => hit(m, q, ['customerName', 'realtorName', 'fromAddress', 'toAddress', 'customerPhone', 'notes'])).slice(0, lim);
  }
  if (u.includes('/visits')) {
    return [{ id: 501, contactId: '3', date: '2026-10-01', handler: 'Dane', notes: 'Dropped off boxes at the maple facility' }]
      .filter((m) => hit(m, q, ['notes'])).slice(0, lim);
  }
  if (u.includes('/followups')) {
    return [{ id: 601, contact_id: 2, due_date: '2026-11-20', note: 'Call about the maple quote', done: false }]
      .filter((m) => hit(m, q, ['note'])).slice(0, lim);
  }
  if (u.includes('/listing_seen')) {
    return [{ listing_key: 'lst-maple', address: '500 Maple St', city: 'Bellingham', price: 640000, agent_name: 'Grace Hopper', listed_date: '2026-11-01' }]
      .filter((m) => hit(m, q, ['address', 'city', 'agent_name'])).slice(0, lim);
  }
  if (u.includes('/contacts') && u.includes('notes.ilike')) {
    return CONTACTS.filter((c) => hit(c, q, ['notes'])).slice(0, lim);
  }
  if (u.includes('/contacts') && u.includes('name.ilike')) {
    const pool = CONTACTS.concat([ADAM]);
    return pool.filter((c) => hit(c, q, ['name', 'business', 'phone', 'email', 'address', 'role']) || String(c.phone || '').replace(/\D/g, '').includes(q.replace(/\D/g, ''))).slice(0, lim);
  }
  return [];
}

function route(url) {
  if (url.includes('/api/secure/dbSession')) return { ok: true, token: 'db-token', expiresAt: Date.now() + 3600000 };
  if (!url.includes('/rest/v1/')) return null;
  const u = decodeURIComponent(url);
  if (u.includes('ilike')) return searchBody(url);
  if (u.includes('/contacts?') && /id=eq\.(\d+)/.test(u)) {
    const id = +u.match(/id=eq\.(\d+)/)[1];
    return [CONTACTS.find((c) => c.id === id) || (ADAM.id === id ? ADAM : null)].filter(Boolean);
  }
  if (u.includes('/contacts?') && u.includes('select=id,name,business') && !u.includes('or=')) return CONTACTS;
  if (u.includes('/referrals?') && u.includes('contactId=eq.')) {
    return [{ id: 301, contactId: '1', contactName: 'Ada Lovelace', jobName: 'Maple Family Move', status: 'booked', date: '2026-10-20', amount: '2500' }];
  }
  return [];
}

function startServer() {
  const port = 8765;
  const child = spawn('python3', ['-m', 'http.server', String(port), '--bind', '127.0.0.1'], { cwd: ROOT, stdio: 'ignore' });
  return new Promise((resolve, reject) => {
    const started = Date.now();
    const ping = () => {
      fetch('http://127.0.0.1:' + port + '/').then((r) => {
        if (r.ok) resolve({ port, child });
        else if (Date.now() - started > 5000) reject(new Error('server status ' + r.status));
        else setTimeout(ping, 80);
      }).catch(() => {
        if (Date.now() - started > 5000) reject(new Error('server did not start'));
        else setTimeout(ping, 80);
      });
    };
    child.on('error', reject);
    ping();
  });
}

async function groups(page) {
  return page.evaluate(() => {
    const panel = document.getElementById('gsearch');
    if (!panel) return null;
    const out = {};
    let cur = '';
    panel.childNodes.forEach((node) => {
      if (!(node instanceof HTMLElement)) return;
      if (node.classList.contains('gsh')) { cur = node.querySelector('span') ? node.querySelector('span').textContent : node.textContent; out[cur] = []; return; }
      if (!cur) return;
      if (node.classList.contains('gsrow')) out[cur].push(node.querySelector('.t').textContent);
      if (node.classList.contains('gsall')) out[cur].push('SEE ALL');
    });
    return out;
  });
}

async function waitGroups(page) {
  await page.waitForFunction(() => {
    const p = document.getElementById('gsearch');
    return p && !/Searching messages/.test(p.textContent);
  }, { timeout: 8000 });
  return groups(page);
}

const errors = [];
const restAuth = [];
const CORS = {
  'access-control-allow-origin': '*',
  'access-control-allow-headers': '*',
  'access-control-allow-methods': 'GET,POST,PATCH,DELETE,OPTIONS',
};
function fulfill(req, body) {
  if (req.method() === 'OPTIONS') {
    req.respond({ status: 204, headers: CORS }).catch(() => {});
    return;
  }
  req.respond({ status: 200, contentType: 'application/json', headers: CORS, body: JSON.stringify(body) }).catch(() => {});
}
async function attach(page) {
  page.on('pageerror', (err) => errors.push(String(err)));
  await page.setRequestInterception(true);
  page.on('request', (req) => {
    const url = req.url();
    if (req.method() !== 'OPTIONS' && url.includes('/rest/v1/')) restAuth.push(req.headers().authorization || '');
    const body = route(url);
    if (body == null && req.method() !== 'OPTIONS') { req.continue().catch(() => {}); return; }
    fulfill(req, body || {});
  });
}

const server = await startServer();
const browser = await puppeteer.launch({
  executablePath: CHROME,
  headless: 'new',
  args: ['--no-sandbox', '--disable-dev-shm-usage'],
});
try {
  const page = await browser.newPage();
  page.setDefaultTimeout(8000);
  await page.setViewport({ width: 1400, height: 900 });
  await attach(page);

  await page.goto('http://127.0.0.1:' + server.port + '/?desktop=1', { waitUntil: 'domcontentloaded' });
  await page.waitForSelector('#view .crow2');

  const cleaned = await page.evaluate(() => ({
    term: gsTerm('  (360) 555-0101 *'),
    comma: gsTerm('oak, maple'),
    phone: gsMatch('(360) 555-0101', '555-0101', '5550101'),
  }));
  assert.equal(cleaned.term, '360 555-0101');
  assert.equal(cleaned.comma, 'oak maple');
  assert.equal(cleaned.phone, true);

  assert.equal(await page.$eval('#q', (el) => el.placeholder), 'Search everything');
  const listBefore = await page.$$eval('#view .crow2', (els) => els.length);
  assert.equal(listBefore, 3);

  await page.click('#q');
  await page.type('#q', 'maple');
  let g = await waitGroups(page);
  assert.ok(g.Contacts.includes('Bellingham Mini Storage'), 'address match is a contact: ' + JSON.stringify(g));
  assert.ok(g.Contacts.includes('Adam West') === false);
  assert.ok(g.Locations.some((t) => t.includes('500 Maple St')), 'location group: ' + JSON.stringify(g.Locations));
  assert.ok(g.Messages.includes('SEE ALL'), 'messages preview offers See all: ' + JSON.stringify(g.Messages));
  assert.ok(g.Messages.filter((t) => t !== 'SEE ALL').length <= 4);
  assert.ok(g['Referrals and jobs'].includes('Maple Family Move'), JSON.stringify(g['Referrals and jobs']));
  assert.ok(g['Referrals and jobs'].includes('Sam Maple'));
  assert.ok(g.Notes.includes('Grace Hopper'), 'note match: ' + JSON.stringify(g.Notes));
  assert.ok(g.Listings.includes('500 Maple St'), JSON.stringify(g.Listings));
  assert.equal(await page.$$eval('#view .crow2', (els) => els.length), listBefore, 'typing must not filter the current screen');
  assert.ok(!JSON.stringify(g).includes('\u2014'), 'search copy has an em dash');
  await page.screenshot({ path: path.join(shots, 'global-search-desktop.png') });

  const seeAll = await page.$('#gsearch .gsall');
  assert.ok(seeAll);
  await seeAll.click();
  await page.waitForFunction(() => {
    const rows = [...document.querySelectorAll('#gsearch .gsh')];
    const msg = rows.find((el) => el.textContent.trim() === 'Messages');
    if (!msg) return false;
    let n = 0; let node = msg.nextElementSibling;
    while (node && !node.classList.contains('gsh')) { if (node.classList.contains('gsrow')) n++; node = node.nextElementSibling; }
    return n >= 6;
  });

  await page.click('#q', { clickCount: 3 });
  await page.type('#q', '5550101');
  g = await waitGroups(page);
  assert.ok(g.Contacts.includes('Ada Lovelace'), 'digit phone match: ' + JSON.stringify(g.Contacts));

  await page.evaluate(() => go('calendar'));
  await page.waitForSelector('.cal');
  assert.equal(await page.$eval('#q', (el) => el.placeholder), 'Search everything');
  assert.equal(await page.$eval('#q', (el) => el.value), '');
  await page.click('#q');
  await page.type('#q', 'ada');
  g = await waitGroups(page);
  assert.deepEqual(g.Contacts.slice(0, 2), ['Ada Lovelace', 'Adam West']);
  assert.ok(await page.$('.cal'), 'calendar stays up behind the results');
  await page.keyboard.press('ArrowDown');
  await page.keyboard.press('Enter');
  await page.waitForFunction(() => /Adam West/.test(document.getElementById('view').innerText));
  await page.screenshot({ path: path.join(shots, 'global-search-opened.png') });

  await page.evaluate(() => go('calendar'));
  await page.waitForSelector('.cal');
  await page.click('#q');
  await page.type('#q', 'maple');
  await waitGroups(page);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#gsearch .gsrow')].find((el) => el.querySelector('.t').textContent === 'Maple Family Move');
    row.click();
  });
  await page.waitForFunction(() => /Maple Family Move/.test(document.getElementById('view').innerText));
  const tab = await page.$eval('.ptab.active', (el) => el.textContent);
  assert.match(tab, /Referrals/);

  await page.evaluate(() => go('contacts'));
  await page.waitForSelector('#view .crow2');
  await page.click('#q');
  await page.type('#q', 'maple');
  await waitGroups(page);
  await page.keyboard.press('Escape');
  assert.equal(await page.$('#gsearch'), null);
  assert.match(await page.$eval('#q', (el) => el.value), /maple/);
  await page.keyboard.press('Escape');
  assert.equal(await page.$eval('#q', (el) => el.value), '');

  await page.click('#q');
  await page.type('#q', 'maple');
  await waitGroups(page);
  await page.evaluate(() => {
    const row = [...document.querySelectorAll('#gsearch .gsrow')].find((el) => el.querySelector('.t').textContent === '500 Maple St');
    row.click();
  });
  await page.waitForFunction(() => /Listing Radar/.test(document.getElementById('view').innerText));
  assert.match(await page.$eval('#rfSearch', (el) => el.value), /500 Maple St/);

  const badAuth = restAuth.filter((h) => h && !h.includes('db-token'));
  assert.equal(badAuth.length, 0, 'database calls must use the signed-in login');

  const mobile = await browser.newPage();
  mobile.setDefaultTimeout(8000);
  await mobile.setViewport({ width: 390, height: 844, isMobile: true, hasTouch: true });
  await attach(mobile);
  await mobile.goto('http://127.0.0.1:' + server.port + '/', { waitUntil: 'domcontentloaded' });
  await mobile.waitForSelector('#mTopSearch');
  await mobile.click('#mTopSearch');
  await mobile.type('#mTopSearch', 'ada');
  await mobile.waitForFunction(() => {
    const p = document.getElementById('gsearch');
    return p && /Ada Lovelace/.test(p.innerText) && !/Searching messages/.test(p.innerText);
  });
  const box = await mobile.$eval('#gsearch', (el) => {
    const r = el.getBoundingClientRect();
    return { left: r.left, right: r.right, top: r.top, bottom: r.bottom, width: r.width };
  });
  assert.ok(box.left >= 0 && box.right <= 394, 'panel fits the phone: ' + JSON.stringify(box));
  assert.ok(box.top >= 40 && box.bottom <= 844, JSON.stringify(box));
  assert.ok(box.width > 300, JSON.stringify(box));
  await mobile.screenshot({ path: path.join(shots, 'global-search-mobile.png') });
  await mobile.evaluate(() => {
    const row = [...document.querySelectorAll('#gsearch .gsrow')].find((el) => el.querySelector('.t').textContent === 'Ada Lovelace');
    row.click();
  });
  await mobile.waitForSelector('#mSheet');
  assert.match(await mobile.$eval('#mSheet', (el) => el.innerText), /Ada Lovelace/);

  assert.deepEqual(errors, [], errors.join('\n'));
  console.log('global search ok');
} finally {
  await browser.close();
  server.child.kill();
}
