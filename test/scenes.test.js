'use strict';
// Scenes: place-anchored notification groups that replace "schools". Covers
// the data layer (list_scenes rpc), the onboarding "where do you play?" step
// (search / zip / popular / create), the browse sheet (your scenes · near you ·
// trending, per-scene mute, join / leave), roster scoping by membership, the
// "at [scene]" ping selector, share-link hints, settings copy and the rule
// that no user-facing copy says "school" any more.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { loadApp, ROOT } = require('./helpers');

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

async function loadSettled(t) {
  const app = loadApp(t);
  await tick();
  app.win.eval(`
    window.__rpc = [];
    window.__rpcResults = {};
    window.__inserts = [];
    function __chain(result) {
      const p = Promise.resolve(result);
      const h = { get(_, k) {
        if (k === 'then') return p.then.bind(p);
        if (k === 'catch') return p.catch.bind(p);
        return () => new Proxy({}, h);
      } };
      return new Proxy({}, h);
    }
    window.__chain = __chain;
    sb = {
      rpc: (name, args) => {
        window.__rpc.push({ name, args });
        const r = window.__rpcResults[name];
        return __chain(typeof r === 'function' ? r(args) : (r || { data: null, error: null }));
      },
      from: (tbl) => ({
        select: () => __chain({ data: [], error: null }),
        insert: (rows) => { window.__inserts.push({ tbl, rows }); return __chain({ data: null, error: null }); },
        update: () => ({ eq: () => ({ select: () => __chain({ data: [{ id: 'me' }], error: null }) }) })
      }),
      auth: { getSession: async () => ({ data: { session: null } }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      removeChannel() {}
    };
  `);
  return app;
}

const SCENE_ROWS = `[
  { id: 'u1', slug: 'ttu', display_name: 'Texas Tech University', activity: null, place_hint: null, zip: null, city: 'lubbock', region: 'tx', color: '#CC0000', pending: false, member_count: 34, joined: false, notifications_enabled: true, joined_at: null, pings_24h: 0, last_ping_at: null, near_rank: null },
  { id: 'u2', slug: 'zilker-park-pickleball', display_name: 'Zilker Park Pickleball', activity: 'pickleball', place_hint: 'Zilker Park', zip: '78704', city: 'austin', region: 'tx', color: '#E8502A', pending: false, member_count: 12, joined: false, notifications_enabled: true, joined_at: null, pings_24h: 3, last_ping_at: '2026-09-08T12:00:00Z', near_rank: null },
  { id: 'u3', slug: 'rice-courts', display_name: 'Rice Courts', activity: 'ping-pong', place_hint: null, zip: null, city: 'houston', region: 'tx', color: '#E8502A', pending: true, member_count: 1, joined: true, notifications_enabled: true, joined_at: '2026-09-07T12:00:00Z', pings_24h: 0, last_ping_at: null, near_rank: null }
]`;

function seedMe(win, extra = '') {
  win.eval(`
    profile = { id: 'me', name: 'ez', color: '#E8502A', school: null, home_city: null };
    roster = [{ id: 'me', name: 'ez', color: '#E8502A', status: 'off', school: null, updated_at: new Date().toISOString() }];
    friends = [];
    SCENES = ${SCENE_ROWS};
    sceneMemberIds = new Set();
    localStorage.removeItem('pm_scene_prompted');
    localStorage.removeItem('pm_zip');
    localStorage.removeItem('pm_last_scene');
    localStorage.removeItem('pm_browse_all');
    browseAllScenes = false;
    ${extra}
  `);
}

const rpcCalls = (win, name) => win.__rpc.filter(c => c.name === name);
const plain = o => JSON.parse(JSON.stringify(o));
const noSchoolCopy = (el, what) => assert.doesNotMatch(el.textContent, /school/i, what + ' must not say "school"');

/* ── data layer ── */

test('loadScenes: list_scenes rpc (with the stored zip) + my scene_members; approved rows in the picker, own pending row resolvable', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `SCENES = []; localStorage.setItem('pm_zip', '78704');`);
  win.__rpcResults.list_scenes = { data: JSON.parse(win.eval(`JSON.stringify(${SCENE_ROWS})`)), error: null };
  win.eval(`
    window.__select = null;
    const origFrom = sb.from;
    sb.from = (tbl) => tbl === 'scene_members'
      ? { select: (cols) => { window.__select = tbl + ':' + cols; return __chain({ data: [{ user_id: 'x1' }, { user_id: 'me' }], error: null }); } }
      : origFrom(tbl);
  `);
  await win.eval(`loadScenes()`);
  const calls = rpcCalls(win, 'list_scenes');
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(calls[0].args), { p_zip: '78704' });
  assert.match(win.__select, /^scene_members:.*user_id/);
  assert.deepEqual(plain(win.eval(`sceneList().map(s => s.slug)`)), ['ttu', 'zilker-park-pickleball'], 'approved only, biggest first');
  assert.equal(win.eval(`sceneName('rice-courts')`), 'Rice Courts', 'own pending scene resolves by name');
  assert.equal(win.eval(`scenePending('rice-courts')`), true);
  assert.equal(win.eval(`scenePending('ttu')`), false);
  assert.equal(win.eval(`sceneName('nope')`), 'nope', 'unknown slug falls back to the slug string');
  assert.deepEqual(plain(win.eval(`[...sceneMemberIds].sort()`)), ['me', 'x1']);
  assert.deepEqual(plain(win.eval(`mySceneSlugs()`)), ['rice-courts']);
});

test('loadScenes failure keeps the built-in fallback so onboarding still works', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `SCENES = [];`);
  win.__rpcResults.list_scenes = { data: null, error: { message: 'boom' } };
  await win.eval(`loadScenes()`);
  assert.deepEqual(plain(win.eval(`sceneList().map(s => s.slug)`)), plain(win.eval(`SCENES_BUILTIN.map(s => s.slug)`)));
});

/* ── onboarding: "where do you play?" ── */

test('onboarding step: search, popular list with member counts (pending never offered), create + skip, no "school" copy', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `window.__next = 0;`);
  win.eval(`showSetupScene(() => { window.__next++; })`);
  const page = win.document.getElementById('s-scene-page');
  assert.ok(page, 'scene step renders');
  assert.match(page.querySelector('h2').textContent, /where do you play\?/i);
  assert.ok(page.querySelector('#s-scene-search'), 'search / zip input');
  const opts = [...page.querySelectorAll('.scene-opt[data-slug]')];
  assert.deepEqual(opts.map(b => b.dataset.slug), ['ttu', 'zilker-park-pickleball'], 'popular first (member_count desc), pending hidden');
  assert.match(opts[0].querySelector('.scene-count').textContent, /34/);
  assert.match(opts[1].querySelector('.scene-meta').textContent, /pickleball/);
  assert.match(opts[1].querySelector('.scene-meta').textContent, /austin/);
  const create = page.querySelector('#s-scene-create');
  assert.ok(create, 'create-a-scene button');
  assert.match(create.textContent, /create a scene/i);
  assert.ok(page.querySelector('#s-scene-create-wrap').hidden || page.querySelector('#s-scene-create-wrap').style.display === 'none', 'form hidden until tapped');
  assert.match(page.querySelector('#s-scene-skip').textContent, /skip/i);
  noSchoolCopy(page, 'onboarding page');
});

test('?scene= hint highlights that scene first; legacy ?school= links still work', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`history.replaceState(null, '', '/?scene=Zilker-Park-Pickleball&ref=x'); localStorage.removeItem('pm_scene_hint');`);
  assert.equal(win.eval(`getSceneParam()`), 'zilker-park-pickleball');
  assert.equal(win.eval(`localStorage.getItem('pm_scene_hint')`), 'zilker-park-pickleball', 'hint survives the auth redirect');
  win.eval(`history.replaceState(null, '', '/');`);
  assert.equal(win.eval(`getSceneParam()`), 'zilker-park-pickleball', 'falls back to the stored hint');
  win.eval(`clearSceneParam();`);
  assert.equal(win.eval(`getSceneParam()`), null);
  win.eval(`history.replaceState(null, '', '/?school=TTU');`);
  assert.equal(win.eval(`getSceneParam()`), 'ttu', 'old share links keep working');
  win.eval(`clearSceneParam();`);
  seedMe(win);
  win.eval(`localStorage.setItem('pm_scene_hint', 'zilker-park-pickleball'); showSetupScene(() => {})`);
  const opts = [...win.document.querySelectorAll('#s-scene-page .scene-opt[data-slug]')];
  assert.equal(opts[0].dataset.slug, 'zilker-park-pickleball');
  assert.ok(opts[0].classList.contains('primary'));
});

test('pick joins via join_scene, mirrors the slug locally and continues; skip continues without an rpc', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `window.__next = 0;`);
  win.eval(`showSetupScene(() => { window.__next++; })`);
  const page = win.document.getElementById('s-scene-page');
  const btn = page.querySelector('.scene-opt[data-slug="zilker-park-pickleball"]');
  btn.click();
  assert.equal(btn.disabled, true, 'disabled while in flight');
  await tick();
  const c = rpcCalls(win, 'join_scene');
  assert.equal(c.length, 1);
  assert.deepEqual(plain(c[0].args), { p_slug: 'zilker-park-pickleball' });
  assert.equal(win.eval(`SCENES.find(s => s.slug === 'zilker-park-pickleball').joined`), true);
  assert.equal(win.eval(`profile.school`), 'zilker-park-pickleball', 'profiles.school mirror follows the latest join');
  assert.equal(win.eval(`roster.find(r => r.id === 'me').school`), 'zilker-park-pickleball');
  assert.equal(win.eval(`localStorage.getItem('pm_scene_prompted')`), '1');
  assert.match(win.document.getElementById('toast').textContent, /Zilker Park Pickleball/);
  assert.equal(win.__next, 1);

  win.eval(`showSetupScene(() => { window.__next++; })`);
  win.document.getElementById('s-scene-skip').click();
  await tick();
  assert.equal(win.__next, 2);
  assert.equal(rpcCalls(win, 'join_scene').length, 1, 'skip does not call join_scene');
  assert.equal(win.eval(`localStorage.getItem('pm_scene_prompted')`), '1');
});

test('join failure toasts the server message and does not mark the scene joined', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `window.__next = 0;`);
  win.__rpcResults.join_scene = { data: null, error: { message: 'unknown scene' } };
  win.eval(`showSetupScene(() => { window.__next++; })`);
  win.document.querySelector('#s-scene-page .scene-opt[data-slug="ttu"]').click();
  await tick();
  assert.match(win.document.getElementById('toast').textContent, /unknown scene/);
  assert.equal(win.eval(`SCENES.find(s => s.slug === 'ttu').joined`), false);
  assert.equal(win.__next, 0);
});

test('search filters by name / city; a 5-digit zip re-queries list_scenes near that zip and remembers it', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win);
  win.__rpcResults.list_scenes = (args) => ({ data: JSON.parse(win.eval(`JSON.stringify(${SCENE_ROWS})`)).map(s => ({ ...s, near_rank: s.slug === 'zilker-park-pickleball' ? 0 : 3 })), error: null });
  win.eval(`showSetupScene(() => {})`);
  const page = win.document.getElementById('s-scene-page');
  const inp = page.querySelector('#s-scene-search');
  const slugs = () => [...page.querySelectorAll('.scene-opt[data-slug]')].map(b => b.dataset.slug);
  inp.value = 'zilk';
  inp.dispatchEvent(new win.Event('input', { bubbles: true }));
  await tick();
  assert.deepEqual(slugs(), ['zilker-park-pickleball']);
  inp.value = 'lubbock';
  inp.dispatchEvent(new win.Event('input', { bubbles: true }));
  await tick();
  assert.deepEqual(slugs(), ['ttu'], 'city matches too');
  inp.value = 'zzz';
  inp.dispatchEvent(new win.Event('input', { bubbles: true }));
  await tick();
  assert.deepEqual(slugs(), []);
  assert.ok(page.querySelector('.scene-empty'), 'empty state nudges toward create');
  inp.value = '78704';
  inp.dispatchEvent(new win.Event('input', { bubbles: true }));
  await tick(400);
  const calls = rpcCalls(win, 'list_scenes');
  assert.equal(calls.length, 1, 'zip → one list_scenes call');
  assert.deepEqual(plain(calls[0].args), { p_zip: '78704' });
  assert.equal(win.eval(`localStorage.getItem('pm_zip')`), '78704');
  assert.deepEqual(slugs(), ['zilker-park-pickleball', 'ttu'], 'nearest first, everything else after');
  assert.match(page.querySelector('.scene-opt[data-slug="zilker-park-pickleball"] .scene-meta').textContent, /near you/i);
});

test('create a scene: client validation, create_scene rpc with trimmed fields, pending + joined locally, continues', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `window.__next = 0;`);
  win.__rpcResults.create_scene = { data: 'downtown-ymca', error: null };
  win.eval(`showSetupScene(() => { window.__next++; })`);
  const page = win.document.getElementById('s-scene-page');
  page.querySelector('#s-scene-create').click();
  const wrap = page.querySelector('#s-scene-create-wrap');
  assert.ok(!wrap.hidden && wrap.style.display !== 'none', 'form revealed');
  const name = page.querySelector('#s-scene-name');
  assert.equal(name.getAttribute('maxlength'), '80');
  assert.ok(page.querySelector('#s-scene-activity'), 'activity field');
  assert.ok(page.querySelector('#s-scene-place'), 'place hint field');
  assert.ok(page.querySelector('#s-scene-zip'), 'zip field');
  const err = page.querySelector('#s-scene-error');
  const submit = page.querySelector('#s-scene-submit');

  name.value = ' x ';
  submit.click();
  await tick();
  assert.equal(rpcCalls(win, 'create_scene').length, 0);
  assert.match(err.textContent, /2/);
  name.value = 'a'.repeat(81);
  submit.click();
  await tick();
  assert.equal(rpcCalls(win, 'create_scene').length, 0);
  assert.match(err.textContent, /80/);
  name.value = 'Downtown YMCA';
  page.querySelector('#s-scene-zip').value = '1234';
  submit.click();
  await tick();
  assert.equal(rpcCalls(win, 'create_scene').length, 0);
  assert.match(err.textContent, /zip/i);

  name.value = '  Downtown   YMCA ';
  page.querySelector('#s-scene-activity').value = ' Basketball ';
  page.querySelector('#s-scene-place').value = ' 5th & Lavaca ';
  page.querySelector('#s-scene-zip').value = ' 78701 ';
  submit.click();
  assert.equal(submit.disabled, true, 'disabled while in flight');
  await tick();
  const calls = rpcCalls(win, 'create_scene');
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(calls[0].args), { p_name: 'Downtown YMCA', p_activity: 'basketball', p_place_hint: '5th & Lavaca', p_zip: '78701' });
  const row = plain(win.eval(`SCENES.find(s => s.slug === 'downtown-ymca')`));
  assert.ok(row, 'injected locally');
  assert.equal(row.pending, true);
  assert.equal(row.joined, true);
  assert.equal(row.display_name, 'Downtown YMCA');
  assert.equal(row.member_count, 1);
  assert.equal(win.eval(`profile.school`), 'downtown-ymca');
  assert.match(win.document.getElementById('toast').textContent, /Downtown YMCA/);
  assert.match(win.document.getElementById('toast').textContent, /pending|3 members|approved/i);
  assert.equal(win.__next, 1);
  assert.equal(win.eval(`localStorage.getItem('pm_scene_prompted')`), '1');
});

test('blank optional fields are sent as null', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win);
  win.__rpcResults.create_scene = { data: 'the-sub', error: null };
  win.eval(`showSetupScene(() => {})`);
  const page = win.document.getElementById('s-scene-page');
  page.querySelector('#s-scene-create').click();
  page.querySelector('#s-scene-name').value = 'The Sub';
  page.querySelector('#s-scene-submit').click();
  await tick();
  assert.deepEqual(plain(rpcCalls(win, 'create_scene')[0].args), { p_name: 'The Sub', p_activity: null, p_place_hint: null, p_zip: null });
});

test('create errors stay inline (never thrown), retryable, escaped', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win);
  win.__rpcResults.create_scene = { data: null, error: { message: 'rate limit exceeded - try again tomorrow' } };
  win.eval(`openSceneSheet()`);
  const sheet = win.document.getElementById('sheet-scenes');
  sheet.querySelector('#s-scene-create').click();
  sheet.querySelector('#s-scene-name').value = 'Rice University';
  const submit = sheet.querySelector('#s-scene-submit');
  submit.click();
  await tick();
  assert.equal(rpcCalls(win, 'create_scene').length, 1);
  assert.match(sheet.querySelector('#s-scene-error').textContent, /rate limit/);
  assert.ok(sheet.classList.contains('open'), 'stays open');
  assert.equal(submit.disabled, false, 'retry possible');
  assert.equal(win.eval(`SCENES.some(s => s.slug === 'rice-university')`), false);

  win.__rpcResults.create_scene = () => { throw new Error('boom'); };
  submit.click();
  await tick();
  assert.match(sheet.querySelector('#s-scene-error').textContent, /boom/);
  assert.equal(submit.disabled, false);

  win.__rpcResults.create_scene = { data: null, error: { message: '<img src=x onerror="window.__pwned=1">' } };
  submit.click();
  await tick();
  assert.equal(sheet.querySelector('#s-scene-error img'), null);
  assert.equal(win.__pwned, undefined);
});

test('scene names from the server are escaped in the picker', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `SCENES[0].display_name = '<img src=x onerror="window.__pwned=1">';`);
  win.eval(`showSetupScene(() => {})`);
  assert.equal(win.document.querySelector('#s-scene-page img'), null);
  assert.equal(win.__pwned, undefined);
});

test('setupSceneStep: a valid ?scene= hint auto-joins and skips the page; unknown hint shows the page', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `window.__next = 0; localStorage.setItem('pm_scene_hint', 'ttu');`);
  await win.eval(`setupSceneStep(() => { window.__next++; })`);
  await tick();
  assert.deepEqual(plain(rpcCalls(win, 'join_scene')[0].args), { p_slug: 'ttu' });
  assert.equal(win.__next, 1);
  assert.equal(win.document.getElementById('s-scene-page'), null, 'page skipped');
  win.eval(`localStorage.setItem('pm_scene_hint', 'nope');`);
  await win.eval(`setupSceneStep(() => { window.__next++; })`);
  await tick();
  assert.ok(win.document.getElementById('s-scene-page'), 'falls back to the chooser');
  assert.equal(rpcCalls(win, 'join_scene').length, 1);
});

/* ── browse sheet: your scenes · near you · trending ── */

test('browse sheet: three sections, pending badge on my pending scene, join buttons only on scenes I am not in', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `SCENES[1].joined = true; SCENES[1].joined_at = '2026-09-08T00:00:00Z';`);
  win.eval(`openSceneSheet()`);
  const sheet = win.document.getElementById('sheet-scenes');
  assert.ok(sheet && sheet.classList.contains('open'));
  assert.match(sheet.querySelector('h3').textContent, /scenes/i);
  const mine = [...sheet.querySelectorAll('#sc-mine .scene-row')].map(r => r.dataset.slug);
  assert.deepEqual(mine, ['zilker-park-pickleball', 'rice-courts'], 'your scenes, most recent activity first');
  assert.ok(sheet.querySelector('#sc-mine .scene-row[data-slug="rice-courts"] .scene-pending-badge'), 'pending badge');
  assert.equal(sheet.querySelector('#sc-mine .scene-row[data-slug="zilker-park-pickleball"] .scene-pending-badge'), null);
  assert.ok(sheet.querySelector('#sc-mine .scene-row[data-slug="rice-courts"] .scene-mute'), 'per-scene mute toggle');
  assert.ok(sheet.querySelector('#sc-mine .scene-row[data-slug="rice-courts"] .scene-leave'), 'leave button');
  const near = [...sheet.querySelectorAll('#sc-near .scene-row')].map(r => r.dataset.slug);
  assert.deepEqual(near, ['ttu'], 'near you / popular excludes joined and pending');
  assert.ok(sheet.querySelector('#sc-near .scene-row[data-slug="ttu"] .scene-join'));
  assert.match(sheet.querySelector('#sc-near .scene-row[data-slug="ttu"]').textContent, /34/);
  const trending = [...sheet.querySelectorAll('#sc-trending .scene-row')].map(r => r.dataset.slug);
  assert.deepEqual(trending, ['zilker-park-pickleball'], 'pinged in the last 24h');
  assert.ok(sheet.querySelector('#s-scene-create'), 'create from the sheet too');
  noSchoolCopy(sheet, 'browse sheet');
});

test('per-scene mute calls set_scene_notifications and flips the toggle; failure reverts', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win);
  win.eval(`openSceneSheet()`);
  const sheet = win.document.getElementById('sheet-scenes');
  const tog = sheet.querySelector('#sc-mine .scene-row[data-slug="rice-courts"] .scene-mute');
  assert.ok(tog.classList.contains('on'), 'notifications on by default');
  tog.click();
  await tick();
  let c = rpcCalls(win, 'set_scene_notifications');
  assert.equal(c.length, 1);
  assert.deepEqual(plain(c[0].args), { p_slug: 'rice-courts', p_enabled: false });
  assert.equal(win.eval(`SCENES.find(s => s.slug === 'rice-courts').notifications_enabled`), false);
  assert.ok(!sheet.querySelector('#sc-mine .scene-row[data-slug="rice-courts"] .scene-mute').classList.contains('on'));

  win.__rpcResults.set_scene_notifications = { data: null, error: { message: 'not a member' } };
  sheet.querySelector('#sc-mine .scene-row[data-slug="rice-courts"] .scene-mute').click();
  await tick();
  c = rpcCalls(win, 'set_scene_notifications');
  assert.deepEqual(plain(c[1].args), { p_slug: 'rice-courts', p_enabled: true });
  assert.equal(win.eval(`SCENES.find(s => s.slug === 'rice-courts').notifications_enabled`), false, 'reverted on error');
  assert.match(win.document.getElementById('toast').textContent, /not a member/);
});

test('leave / join from the sheet call leave_scene / join_scene, move rows between sections and reload the roster', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `window.__roster = 0; loadRoster = async () => { window.__roster++; };`);
  win.eval(`openSceneSheet()`);
  const sheet = win.document.getElementById('sheet-scenes');
  sheet.querySelector('#sc-mine .scene-row[data-slug="rice-courts"] .scene-leave').click();
  await tick();
  assert.deepEqual(plain(rpcCalls(win, 'leave_scene')[0].args), { p_slug: 'rice-courts' });
  assert.equal(win.eval(`SCENES.find(s => s.slug === 'rice-courts').joined`), false);
  assert.equal(win.eval(`SCENES.find(s => s.slug === 'rice-courts').member_count`), 0);
  assert.equal(sheet.querySelector('#sc-mine .scene-row[data-slug="rice-courts"]'), null);
  assert.equal(win.eval(`profile.school`), null, 'mirror cleared when no scenes remain');
  assert.equal(win.__roster, 1);

  sheet.querySelector('#sc-near .scene-row[data-slug="ttu"] .scene-join').click();
  await tick();
  assert.deepEqual(plain(rpcCalls(win, 'join_scene')[0].args), { p_slug: 'ttu' });
  assert.ok(sheet.querySelector('#sc-mine .scene-row[data-slug="ttu"]'), 'moved into your scenes');
  assert.equal(sheet.querySelector('#sc-near .scene-row[data-slug="ttu"]'), null);
  assert.equal(win.eval(`SCENES.find(s => s.slug === 'ttu').member_count`), 35);
  assert.equal(win.eval(`profile.school`), 'ttu');
  assert.equal(win.__roster, 2);
});

test('the /scenes route (#scenes) opens the browse sheet on boot; nothing else does', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win);
  win.eval(`history.replaceState(null, '', '/#scenes'); handleSceneRoute();`);
  const sheet = win.document.getElementById('sheet-scenes');
  assert.ok(sheet && sheet.classList.contains('open'));
  sheet.querySelector('[data-dismiss]').click();
  assert.ok(!sheet.classList.contains('open'));
  win.eval(`history.replaceState(null, '', '/'); handleSceneRoute();`);
  assert.ok(!sheet.classList.contains('open'));
});

test('existing users with no scenes get a one-time, dismissable prompt; members never do', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `SCENES[2].joined = false;`);
  win.eval(`maybeShowSceneNudge()`);
  const sheet = win.document.getElementById('sheet-scenes');
  assert.ok(sheet && sheet.classList.contains('open'), 'nudge opens the scenes sheet');
  sheet.querySelector('[data-dismiss]').click();
  assert.ok(!sheet.classList.contains('open'));
  assert.equal(win.eval(`localStorage.getItem('pm_scene_prompted')`), '1');
  win.eval(`maybeShowSceneNudge()`);
  assert.ok(!sheet.classList.contains('open'), 'does not nag twice');
  win.eval(`SCENES[2].joined = true; localStorage.removeItem('pm_scene_prompted'); maybeShowSceneNudge()`);
  assert.ok(!sheet.classList.contains('open'), 'members are never prompted');
  win.eval(`SCENES = []; profile.school = 'ttu'; maybeShowSceneNudge()`);
  assert.ok(!sheet.classList.contains('open'), 'mirror column counts as membership before scenes load');
});

/* ── roster scope by membership ── */

function scopeRows() {
  return `[
    { id: 'me',  name: 'ez',   school: 'zilker-park-pickleball', home_city: 'austin', status: 'off' },
    { id: 'a',   name: 'a',    school: 'zilker-park-pickleball', home_city: 'waco',   status: 'off' },
    { id: 'm1',  name: 'm1',   school: 'ttu',                    home_city: 'dallas', status: 'off' },
    { id: 'b',   name: 'b',    school: null,                     home_city: 'austin', status: 'off' },
    { id: 'c',   name: 'c',    school: null,                     home_city: 'waco',   status: 'off' },
    { id: 'd',   name: 'd',    school: 'ttu',                    home_city: 'dallas', status: 'off' },
    { id: 'f2',  name: 'jake', school: 'ttu',                    home_city: 'dallas', status: 'off' }
  ]`;
}

test('roster keeps members of my scenes (mirror slug or membership id), city fallback for scene-less rows, always friends', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `
    profile.school = 'zilker-park-pickleball'; profile.home_city = 'austin';
    SCENES[1].joined = true;
    sceneMemberIds = new Set(['me', 'a', 'm1']);
    friends = [{ other_id: 'f2', name: 'jake', status: 'accepted', incoming: false }];
  `);
  const ids = win.eval(`scopeRoster(${scopeRows()}).map(r => r.id).sort()`);
  assert.deepEqual([...ids], ['a', 'b', 'f2', 'm1', 'me']);
});

test('without any scene the roster falls back to the city scope', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `profile.school = null; profile.home_city = 'austin'; SCENES[2].joined = false;`);
  const ids = win.eval(`scopeRoster(${scopeRows()}).map(r => r.id).sort()`);
  assert.deepEqual([...ids], ['b', 'me']);
});

test('scope pill: "my scenes" ↔ "everyone" toggle shows everyone and persists', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `profile.school = 'zilker-park-pickleball'; profile.home_city = 'austin'; SCENES[1].joined = true; rosterRaw = ${scopeRows()}; roster = scopeRoster(rosterRaw); renderHome();`);
  await tick(60);
  const btn = win.document.getElementById('scene-scope');
  assert.ok(btn, 'roster header scene scope toggle');
  assert.match(btn.textContent, /zilker park pickleball|my scenes/i);
  noSchoolCopy(btn, 'scope pill');
  btn.click();
  await tick();
  assert.equal(win.eval(`roster.length`), 7);
  assert.equal(win.eval(`localStorage.getItem('pm_browse_all')`), '1');
  assert.match(btn.textContent, /everyone/i);
  btn.click();
  assert.equal(win.eval(`roster.length`), 3);
});

/* ── ping "at [scene]" ── */

test('ping confirm shows a scene selector: joined scenes + "everyone", default = most recently active, choice remembered', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `SCENES[1].joined = true; SCENES[1].joined_at = '2026-09-01T00:00:00Z'; renderScenePicker();`);
  const picker = win.document.getElementById('scene-picker');
  assert.ok(picker, 'scene picker lives in the ping confirm modal');
  assert.ok(win.document.getElementById('sheet-ping-confirm').contains(picker));
  const chips = [...picker.querySelectorAll('.scene-chip')].map(c => c.dataset.slug);
  assert.deepEqual(chips, ['zilker-park-pickleball', 'rice-courts', ''], 'most recent activity first, then "everyone"');
  assert.ok(picker.querySelector('.scene-chip[data-slug="zilker-park-pickleball"]').classList.contains('active'), 'default = most recently active');
  assert.equal(win.eval(`selectedScene`), 'zilker-park-pickleball');
  picker.querySelector('.scene-chip[data-slug="rice-courts"]').click();
  assert.equal(win.eval(`selectedScene`), 'rice-courts');
  assert.equal(win.eval(`localStorage.getItem('pm_last_scene')`), 'rice-courts');
  win.eval(`renderScenePicker()`);
  assert.ok(picker.querySelector('.scene-chip[data-slug="rice-courts"]').classList.contains('active'), 'remembered');
  picker.querySelector('.scene-chip[data-slug=""]').click();
  assert.equal(win.eval(`selectedScene`), null);
  noSchoolCopy(picker, 'scene picker');
});

test('no scenes joined: picker is hidden and "down" falls back to the legacy open ping', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `SCENES[2].joined = false; localStorage.setItem('pm_push_force', '1'); lastPingTime = 0;
    roster.push({ id: 'p2', name: 'pat', color: '#000', status: 'off' }); renderScenePicker();`);
  const picker = win.document.getElementById('scene-picker');
  assert.equal(picker.querySelectorAll('.scene-chip').length, 0);
  assert.equal(picker.style.display, 'none');
  await win.eval(`fireStatusPings('down')`);
  assert.equal(rpcCalls(win, 'ping_scene').length, 0);
  const ins = win.__inserts.filter(i => i.tbl === 'pings');
  assert.equal(ins.length, 1, 'legacy pingEveryone insert');
  assert.equal(plain(ins[0].rows)[0].to_id, 'p2');
});

test('"down" / "playing" with a scene selected fire ping_scene with the right verb and never the legacy fan-out', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `SCENES[1].joined = true; localStorage.setItem('pm_push_force', '1'); lastPingTime = 0;
    roster.push({ id: 'p2', name: 'pat', color: '#000', status: 'off' });
    window.__push = 0; pushStatusChange = () => { window.__push++; };
    localStorage.setItem('pm_last_scene', 'zilker-park-pickleball'); renderScenePicker();`);
  win.__rpcResults.ping_scene = { data: 2, error: null };
  await win.eval(`fireStatusPings('down')`);
  let c = rpcCalls(win, 'ping_scene');
  assert.equal(c.length, 1);
  assert.equal(c[0].args.p_slug, 'zilker-park-pickleball');
  assert.equal(c[0].args.p_verb, 'is down to play');
  assert.match(c[0].args.p_msg, /ez/);
  assert.equal(win.__inserts.filter(i => i.tbl === 'pings').length, 0, 'no legacy insert');
  assert.match(win.document.getElementById('toast').textContent, /2/);
  assert.match(win.document.getElementById('toast').textContent, /Zilker Park Pickleball/);

  await win.eval(`fireStatusPings('playing')`);
  c = rpcCalls(win, 'ping_scene');
  assert.equal(c.length, 2);
  assert.equal(c[1].args.p_verb, 'is playing');
  assert.equal(win.__push, 0, 'legacy radius push not used when a scene is selected');

  win.__rpcResults.ping_scene = { data: 0, error: null };
  await win.eval(`fireStatusPings('playing')`);
  assert.match(win.document.getElementById('toast').textContent, /playing/i, 'throttled → quiet, no error');

  win.__rpcResults.ping_scene = { data: null, error: { message: 'join the scene first' } };
  await win.eval(`fireStatusPings('down')`);
  assert.match(win.document.getElementById('toast').textContent, /join the scene first/);
});

test('scene pings render in the notification list with the scene name', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `
    pings = [{ id: 'p1', from_id: 'x', to_id: 'me', verb: 'is playing', msg: 'pat is playing', unread: true, created_at: new Date().toISOString(), scene_id: 'u2', from: { name: 'pat', color: '#000' } }];
    renderMe(); renderNotis();
  `);
  const card = win.document.querySelector('.ping-card[data-id="p1"]');
  assert.ok(card);
  assert.match(card.textContent, /Zilker Park Pickleball/);
  assert.ok(card.querySelector('.pc-scene'));
});

/* ── settings + friends copy ── */

test('settings menu: "scenes" entry labels my scene (pending badge) or the count, and opens the browse sheet', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `profile.school = 'rice-courts'; renderMe();`);
  let item = win.document.getElementById('sr-scenes');
  assert.ok(item, 'settings menu scenes entry');
  assert.match(item.textContent, /^scenes/i);
  assert.match(item.textContent, /Rice Courts/);
  assert.ok(item.querySelector('.scene-pending-badge'));
  noSchoolCopy(item, 'settings entry');
  assert.equal(win.document.getElementById('sr-school'), null, 'old entry gone');

  win.eval(`SCENES[1].joined = true; renderMe();`);
  item = win.document.getElementById('sr-scenes');
  assert.match(item.textContent, /2 scenes/);
  assert.equal(item.querySelector('.scene-pending-badge'), null);

  win.eval(`SCENES.forEach(s => s.joined = false); profile.school = null; renderMe();`);
  item = win.document.getElementById('sr-scenes');
  assert.match(item.textContent, /none|find your scene/i);

  item.click();
  const sheet = win.document.getElementById('sheet-scenes');
  assert.ok(sheet && sheet.classList.contains('open'));
});

test('friends sheet: scope copy and row chip say scene, search still scoped by the mirrored slug', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `profile.school = 'ttu'; friends = [{ other_id: 'f1', name: 'bob', color: '#2544D6', school: 'zilker-park-pickleball', status: 'accepted', incoming: false }];`);
  win.__rpcResults.search_players = { data: [], error: null };
  win.eval(`openFriendsSheet('add');`);
  await tick();
  const scope = win.document.getElementById('fr-scope');
  assert.match(scope.textContent, /Texas Tech University/);
  assert.match(scope.textContent, /all scenes/i);
  noSchoolCopy(scope, 'friend search scope');
  const inp = win.document.getElementById('fr-search');
  inp.value = 'bo';
  inp.dispatchEvent(new win.Event('input', { bubbles: true }));
  await tick(400);
  assert.equal(rpcCalls(win, 'search_players')[0].args.p_school, 'ttu', 'rpc param name unchanged (DB alias)');
  win.eval(`openFriendsSheet('friends');`);
  await tick();
  const chip = win.document.querySelector('#fr-list .fr-row[data-id="f1"] .fr-scene');
  assert.ok(chip, 'scene chip on friend rows');
  assert.match(chip.textContent, /Zilker Park Pickleball/);
});

/* ── copy: "school" is gone from user-facing text ── */

test('index.html and style.css contain no "school"; app.js only keeps the data-layer column name', () => {
  for (const f of ['index.html', 'style.css', 'sw.js', 'manifest.json']) {
    assert.doesNotMatch(fs.readFileSync(path.join(ROOT, f), 'utf8'), /school/i, f);
  }
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '').replace(/(^|[^:])\/\/.*$/gm, '$1');
  // property access on the mirror column (profile.school, r.school) is data, not copy
  const literals = [...src.replace(/\.school\b/g, '.__col').matchAll(/'[^'\n]*school[^'\n]*'/gi)].map(m => m[0]);
  const allowed = new Set([
    "'school'",   // legacy ?school= share links + the profiles column
  ]);
  const offenders = literals.filter(l => !allowed.has(l) && !/home_city, school, updated_at/.test(l));
  assert.deepEqual(offenders, [], 'user-facing copy must say "scene"');
  assert.doesNotMatch(src, /\b(SCHOOLS|SCHOOLS_BUILTIN|browseAllSchools|schoolName|schoolList|schoolPending|schoolLabel|loadSchools|applySchool|openSchoolSheet|showSetupSchool|setupSchoolStep|maybeShowSchoolNudge|renderSchoolChooser|renderSchoolScope|toggleSchoolScope|getSchoolParam|clearSchoolParam|submitSchoolSuggestion|schoolOpt)\b/, 'old identifiers renamed');
  assert.doesNotMatch(src, /'(set_school|suggest_school|approve_school)'/, 'client calls the scene RPCs, not the aliases');
  assert.doesNotMatch(src, /from\('schools'\)/, 'client reads scenes, not schools');
});

test('court-* game-surface identifiers are untouched', () => {
  const src = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  for (const id of ['court-wrap', 'court-timer', 'court-svg', 'court-g', 'court-eyebrow', 'court-labels']) {
    assert.ok(html.includes(id) || src.includes(id), id + ' still present');
  }
  assert.doesNotMatch(src, /scene-wrap|scene-timer|scene-svg/, 'no court → scene rename');
});
