'use strict';
// Visual artifact for the scenes UI (onboarding step, browse sheet, ping
// confirm with the "ping who?" chips). Serves the repo statically, blocks the
// Supabase CDN/API so nothing live is touched, seeds the same mock state the
// jsdom tests use, and writes PNGs to test/artifacts/ (not committed).
//   node test/scenes-screenshot.js
const http = require('node:http');
const fs = require('node:fs');
const path = require('node:path');
const { chromium } = require('playwright');

const ROOT = path.join(__dirname, '..');
const OUT = path.join(__dirname, 'artifacts');
const TYPES = { '.html': 'text/html', '.js': 'text/javascript', '.css': 'text/css', '.svg': 'image/svg+xml', '.png': 'image/png', '.json': 'application/json' };

const SCENES = [
  { id: 'u1', slug: 'ttu', display_name: 'Texas Tech University', activity: null, place_hint: null, zip: null, city: 'lubbock', region: 'tx', color: '#CC0000', pending: false, member_count: 34, joined: false, notifications_enabled: true, joined_at: null, pings_24h: 0, last_ping_at: null, near_rank: 3 },
  { id: 'u2', slug: 'zilker-park-pickleball', display_name: 'Zilker Park Pickleball', activity: 'pickleball', place_hint: 'Zilker Park', zip: '78704', city: 'austin', region: 'tx', color: '#E8502A', pending: false, member_count: 12, joined: true, notifications_enabled: true, joined_at: '2026-09-01T12:00:00Z', pings_24h: 3, last_ping_at: '2026-09-08T12:00:00Z', near_rank: 0 },
  { id: 'u4', slug: 'ut-rec-center', display_name: 'UT Rec Center', activity: 'basketball', place_hint: null, zip: '78712', city: 'austin', region: 'tx', color: '#BF5700', pending: false, member_count: 21, joined: false, notifications_enabled: true, joined_at: null, pings_24h: 1, last_ping_at: '2026-09-08T09:00:00Z', near_rank: 1 },
  { id: 'u5', slug: 'downtown-ymca', display_name: 'Downtown YMCA', activity: 'ping-pong', place_hint: null, zip: '78701', city: 'austin', region: 'tx', color: '#2544D6', pending: false, member_count: 8, joined: false, notifications_enabled: true, joined_at: null, pings_24h: 0, last_ping_at: null, near_rank: 1 },
  { id: 'u3', slug: 'rice-courts', display_name: 'Rice Courts', activity: 'ping-pong', place_hint: null, zip: null, city: 'houston', region: 'tx', color: '#154734', pending: true, member_count: 1, joined: true, notifications_enabled: false, joined_at: '2026-09-07T12:00:00Z', pings_24h: 0, last_ping_at: null, near_rank: 3 }
];

function serve() {
  const server = http.createServer((req, res) => {
    let f = decodeURIComponent(req.url.split('?')[0].split('#')[0]);
    if (f === '/') f = '/index.html';
    const fp = path.join(ROOT, f);
    if (!fp.startsWith(ROOT)) { res.writeHead(403); res.end(); return; }
    fs.readFile(fp, (err, data) => {
      if (err) { res.writeHead(404); res.end(); return; }
      res.writeHead(200, { 'content-type': TYPES[path.extname(fp)] || 'application/octet-stream' });
      res.end(data);
    });
  });
  return new Promise(resolve => server.listen(0, '127.0.0.1', () => resolve(server)));
}

(async () => {
  fs.mkdirSync(OUT, { recursive: true });
  const server = await serve();
  const base = 'http://127.0.0.1:' + server.address().port;
  const browser = await chromium.launch();
  const page = await browser.newPage({ viewport: { width: 390, height: 844 }, deviceScaleFactor: 2 });
  await page.route('**/*', route => {
    const u = route.request().url();
    if (u.startsWith(base) || /fonts\.googleapis|fonts\.gstatic/.test(u)) return route.continue();
    return route.abort(); // supabase-js CDN + API: never touch anything live
  });
  await page.goto(base + '/', { waitUntil: 'load' });
  await page.waitForTimeout(800); // boot() bails without sb, shows the setup screen

  await page.evaluate((rows) => {
    localStorage.setItem('pm_zip', '78704');
    localStorage.removeItem('pm_last_scene');
    function chain(result) {
      const p = Promise.resolve(result);
      const h = { get(_, k) { if (k === 'then') return p.then.bind(p); if (k === 'catch') return p.catch.bind(p); return () => new Proxy({}, h); } };
      return new Proxy({}, h);
    }
    window.sb = {
      rpc: () => chain({ data: null, error: null }),
      from: () => ({ select: () => chain({ data: [], error: null }), insert: () => chain({ data: null, error: null }), update: () => ({ eq: () => ({ select: () => chain({ data: [{ id: 'me' }], error: null }) }) }) }),
      auth: { getSession: async () => ({ data: { session: null } }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }), removeChannel() {}
    };
    sb = window.sb;
    profile = { id: 'me', name: 'ez', color: '#E8502A', school: 'zilker-park-pickleball', home_city: 'austin', status: 'off' };
    roster = [{ id: 'me', name: 'ez', color: '#E8502A', status: 'off', school: 'zilker-park-pickleball', updated_at: new Date().toISOString() }];
    friends = [];
    SCENES = rows;
    document.getElementById('setup-root').innerHTML = '';
  }, SCENES);

  // 1) onboarding: "where do you play?"
  await page.evaluate(() => { showSetupScene(() => {}); });
  await page.waitForTimeout(300);
  await page.screenshot({ path: path.join(OUT, 'scenes-1-onboarding.png') });
  await page.evaluate(() => { document.getElementById('s-scene-create').click(); document.getElementById('s-scene-name').value = 'Mueller Lake Park Courts'; document.getElementById('s-scene-activity').value = 'pickleball'; document.getElementById('s-scene-zip').value = '78723'; });
  await page.waitForTimeout(200);
  await page.screenshot({ path: path.join(OUT, 'scenes-2-create-form.png') });

  // 2) browse sheet: your scenes · trending · near you
  await page.evaluate(() => { document.getElementById('setup-root').innerHTML = ''; renderHome(); openSceneSheet(); });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'scenes-3-browse-sheet.png') });

  // 3) ping confirm with the "ping who?" chips + roster scope pill
  await page.evaluate(() => {
    document.getElementById('sheet-scenes').classList.remove('open');
    VENUES = VENUES.length ? VENUES : [{ id: 'v1', name: 'Zilker courts', city: 'austin' }];
    homeState = 'down';
    renderVenuePicker(); renderScenePicker();
    document.getElementById('sheet-ping-confirm').classList.add('open');
  });
  await page.waitForTimeout(400);
  await page.screenshot({ path: path.join(OUT, 'scenes-4-ping-confirm.png') });

  await browser.close();
  server.close();
  console.log('wrote ' + fs.readdirSync(OUT).filter(f => f.startsWith('scenes-')).join(', ') + ' → ' + OUT);
})().catch(e => { console.error(e); process.exit(1); });
