'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

// Wait for jsdom's window 'load' → boot() to bail (sb is null), then install
// a recording sb mock whose rpc() resolves from window.__rpcResults by name.
async function loadSettled(t) {
  const app = loadApp(t);
  await tick();
  app.win.eval(`
    window.__rpc = [];
    window.__rpcResults = {};
    function __chain(result) {
      const p = Promise.resolve(result);
      const h = { get(_, k) {
        if (k === 'then') return p.then.bind(p);
        if (k === 'catch') return p.catch.bind(p);
        return () => new Proxy({}, h);
      } };
      return new Proxy({}, h);
    }
    sb = {
      rpc: (name, args) => {
        window.__rpc.push({ name, args });
        const r = window.__rpcResults[name];
        return __chain(typeof r === 'function' ? r(args) : (r || { data: null, error: null }));
      },
      from: () => __chain({ data: [], error: null }),
      auth: { getSession: async () => ({ data: { session: null } }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      removeChannel() {}
    };
  `);
  return app;
}

function seedMe(win, extra = '') {
  win.eval(`
    profile = { id: 'me', name: 'ez', color: '#E8502A', school: 'ttu', home_city: 'lubbock' };
    roster = [{ id: 'me', name: 'ez', color: '#E8502A', status: 'off', school: 'ttu', updated_at: new Date().toISOString() }];
    friends = [
      { other_id: 'f1', name: 'bob',   color: '#2544D6', school: 'ttu', status: 'accepted', incoming: false },
      { other_id: 'f2', name: 'jake',  color: '#000000', school: 'ut',  status: 'accepted', incoming: false },
      { other_id: 'r1', name: 'maria', color: '#000000', school: 'ttu', status: 'pending',  incoming: true },
      { other_id: 'o1', name: 'sam',   color: '#000000', school: 'ttu', status: 'pending',  incoming: false }
    ];
    lastPingTime = 0;
    SCENES = []; sceneMemberIds = new Set();
    ${extra}
  `);
}

const rpcCalls = (win, name) => win.__rpc.filter(c => c.name === name);
// rpc args are created in the jsdom realm; strip their prototype for deep-equal
const plain = o => JSON.parse(JSON.stringify(o));

/* ── entry point ── */

test('profile settings menu has a friends entry that opens the friends sheet', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, 'renderMe();');
  const item = win.document.getElementById('sr-friends');
  assert.ok(item, 'settings dropdown should list "friends" next to "invite a friend"');
  assert.match(item.textContent, /friends/i);
  item.click();
  await tick();
  const sheet = win.document.getElementById('sheet-friends');
  assert.ok(sheet && sheet.classList.contains('open'), 'friends sheet should open');
  assert.equal(rpcCalls(win, 'list_friendships').length, 1, 'opening the sheet refreshes the friend list');
});

/* ── friends list + group ping ── */

test('friends tab lists accepted friends only; requests tab lists incoming with accept/decline', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win);
  win.eval(`openFriendsSheet('friends');`);
  await tick();
  const rows = [...win.document.querySelectorAll('#fr-list .fr-row')];
  assert.deepEqual(rows.map(r => r.dataset.id).sort(), ['f1', 'f2'], 'accepted friends across scenes');
  assert.match(rows[0].textContent, /bob|jake/);

  win.document.getElementById('fr-tab-requests').click();
  await tick();
  const incoming = win.document.querySelector('#fr-requests .fr-row[data-id="r1"]');
  assert.ok(incoming, 'incoming request row');
  assert.ok(incoming.querySelector('.fr-accept'), 'accept button');
  assert.ok(incoming.querySelector('.fr-decline'), 'decline button');
  const outgoing = win.document.querySelector('#fr-requests .fr-row[data-id="o1"]');
  assert.ok(outgoing, 'outgoing pending row is shown');
  assert.match(outgoing.textContent, /sent/i, 'outgoing shows as sent, no accept button');
  assert.equal(outgoing.querySelector('.fr-accept'), null);
});

test('selecting several friends and pinging sends one batch rpc with the default line', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win);
  win.__rpcResults.ping_friends = { data: 2, error: null };
  win.eval(`openFriendsSheet('friends');`);
  await tick();
  win.document.querySelector('#fr-list .fr-row[data-id="f1"]').click();
  win.document.querySelector('#fr-list .fr-row[data-id="f2"]').click();
  const btn = win.document.getElementById('fr-ping');
  assert.match(btn.textContent, /2/, 'button reflects selection count');
  btn.click();
  await tick();
  const calls = rpcCalls(win, 'ping_friends');
  assert.equal(calls.length, 1, 'exactly one batch insert');
  assert.deepEqual([...calls[0].args.p_to].sort(), ['f1', 'f2']);
  assert.equal(calls[0].args.p_msg, 'hey i want to play');
  assert.match(btn.textContent, /sent/i);
});

test('a custom line is passed through; tapping a selected friend deselects', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win);
  win.__rpcResults.ping_friends = { data: 1, error: null };
  win.eval(`openFriendsSheet('friends');`);
  await tick();
  const f1 = () => win.document.querySelector('#fr-list .fr-row[data-id="f1"]');
  f1().click(); f1().click(); // list re-renders on each tap
  win.document.querySelector('#fr-list .fr-row[data-id="f2"]').click();
  win.document.getElementById('fr-line').value = '  table 3, come thru ';
  win.document.getElementById('fr-ping').click();
  await tick();
  const call = rpcCalls(win, 'ping_friends')[0];
  assert.deepEqual(plain(call.args.p_to), ['f2']);
  assert.equal(call.args.p_msg, 'table 3, come thru');
});

test('ping with nobody selected does nothing; failed rpc surfaces an error and stays retryable', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win);
  win.eval(`openFriendsSheet('friends');`);
  await tick();
  const btn = win.document.getElementById('fr-ping');
  btn.click();
  await tick();
  assert.equal(rpcCalls(win, 'ping_friends').length, 0, 'no rpc without a selection');

  win.__rpcResults.ping_friends = { data: null, error: { message: 'network down' } };
  win.document.querySelector('#fr-list .fr-row[data-id="f1"]').click();
  btn.click();
  await tick();
  assert.equal(rpcCalls(win, 'ping_friends').length, 1);
  assert.match(win.document.getElementById('toast').textContent, /fail|down/i);
  assert.ok(!/sent/i.test(btn.textContent), 'must not claim sent on failure');
  assert.equal(btn.disabled, false, 'retry stays possible');
});

/* ── requests ── */

test('accept and decline call respond_friend_request and refresh the list', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win);
  win.eval(`openFriendsSheet('requests');`);
  await tick();
  win.document.querySelector('#fr-requests .fr-row[data-id="r1"] .fr-accept').click();
  await tick();
  const acc = rpcCalls(win, 'respond_friend_request');
  assert.equal(acc.length, 1);
  assert.deepEqual(plain(acc[0].args), { p_from: 'r1', p_accept: true });
  assert.ok(rpcCalls(win, 'list_friendships').length >= 2, 'list refreshed after responding');

  seedMe(win);
  win.eval(`openFriendsSheet('requests');`);
  await tick();
  win.document.querySelector('#fr-requests .fr-row[data-id="r1"] .fr-decline').click();
  await tick();
  const dec = rpcCalls(win, 'respond_friend_request').pop();
  assert.deepEqual(plain(dec.args), { p_from: 'r1', p_accept: false });
});

/* ── add friend / search ── */

test('add tab searches by name scoped to my scene and sends a request', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win);
  win.__rpcResults.search_players = { data: [
    { id: 'p9', name: 'bobby', color: '#000', school: 'ttu' },
    { id: 'me', name: 'ez', color: '#000', school: 'ttu' } // defensive: never offer self
  ], error: null };
  win.__rpcResults.send_friend_request = { data: 'pending', error: null };
  win.eval(`openFriendsSheet('add');`);
  await tick();
  const inp = win.document.getElementById('fr-search');
  inp.value = 'bo';
  inp.dispatchEvent(new win.Event('input', { bubbles: true }));
  await tick(400);
  const s = rpcCalls(win, 'search_players');
  assert.equal(s.length, 1, 'debounced to one search');
  assert.equal(s[0].args.p_q, 'bo');
  assert.equal(s[0].args.p_school, 'ttu', 'scoped to my scene by default (rpc param name is the DB alias)');
  const res = [...win.document.querySelectorAll('#fr-results .fr-row')];
  assert.deepEqual(res.map(r => r.dataset.id), ['p9']);
  assert.match(res[0].textContent, /bobby/);
  res[0].querySelector('.fr-add').click();
  await tick();
  const req = rpcCalls(win, 'send_friend_request');
  assert.equal(req.length, 1);
  assert.deepEqual(plain(req[0].args), { p_target: 'p9' });
  assert.match(win.document.querySelector('#fr-results .fr-row[data-id="p9"]').textContent, /sent|pending/i);
});

test('"all scenes" toggle widens the search scope', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win);
  win.__rpcResults.search_players = { data: [], error: null };
  win.eval(`openFriendsSheet('add');`);
  await tick();
  win.document.getElementById('fr-scope').click();
  const inp = win.document.getElementById('fr-search');
  inp.value = 'jake';
  inp.dispatchEvent(new win.Event('input', { bubbles: true }));
  await tick(400);
  assert.equal(rpcCalls(win, 'search_players').pop().args.p_school, null);
});

test('search results and friend names are escaped', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `friends[0].name = '<img src=x onerror="window.__pwned=1">';`);
  win.eval(`openFriendsSheet('friends');`);
  await tick();
  assert.equal(win.document.querySelector('#fr-list img'), null);
  assert.equal(win.__pwned, undefined);
});

/* ── "I'm playing" broadcast ── */

test('broadcast toggle fans out once per hour via broadcast_playing', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win);
  win.__rpcResults.broadcast_playing = { data: 2, error: null };
  win.eval(`localStorage.removeItem('pm_bcast_friends'); localStorage.removeItem('pm_bcast_last');`);
  await win.eval(`maybeBroadcastPlaying()`);
  assert.equal(rpcCalls(win, 'broadcast_playing').length, 0, 'off by default');

  win.eval(`openFriendsSheet('friends');`);
  await tick();
  win.document.getElementById('fr-bcast').click();
  assert.equal(win.eval(`localStorage.getItem('pm_bcast_friends')`), '1', 'toggle persists');
  assert.ok(win.document.querySelector('#fr-bcast .tog-switch').classList.contains('on'));

  await win.eval(`maybeBroadcastPlaying()`);
  assert.equal(rpcCalls(win, 'broadcast_playing').length, 1);
  await win.eval(`maybeBroadcastPlaying()`);
  assert.equal(rpcCalls(win, 'broadcast_playing').length, 1, 'duplicate within the hour is suppressed client-side');

  win.eval(`localStorage.setItem('pm_bcast_last', String(Date.now() - 61 * 60000));`);
  await win.eval(`maybeBroadcastPlaying()`);
  assert.equal(rpcCalls(win, 'broadcast_playing').length, 2, 'fires again after the window');
});

test('going "playing" triggers the friend broadcast hook', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `
    window.__bcast = 0;
    maybeBroadcastPlaying = async () => { window.__bcast++; };
    localStorage.setItem('pm_push_off', '1');
    sb.from = () => __chain({ data: [{ id: 'me' }], error: null });
  `);
  await win.eval(`setMyStatus('playing')`);
  await tick();
  assert.equal(win.__bcast, 1, 'setMyStatus(playing) should call maybeBroadcastPlaying');
  await win.eval(`setMyStatus('off')`);
  await tick();
  assert.equal(win.__bcast, 1, 'only on playing');
});

/* ── scene scoping ── */

function scopeRows() {
  return `[
    { id: 'me',  name: 'ez',   school: 'ttu', home_city: 'lubbock', status: 'off' },
    { id: 'a',   name: 'a',    school: 'ttu', home_city: 'austin',  status: 'off' },
    { id: 'b',   name: 'b',    school: null,  home_city: 'lubbock', status: 'off' },
    { id: 'c',   name: 'c',    school: null,  home_city: 'austin',  status: 'off' },
    { id: 'd',   name: 'd',    school: 'ut',  home_city: 'austin',  status: 'off' },
    { id: 'f2',  name: 'jake', school: 'ut',  home_city: 'austin',  status: 'off' }
  ]`;
}

test('roster prefers my scene (mirror slug), falls back to city for scene-less rows, always keeps friends', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `localStorage.removeItem('pm_browse_all'); browseAllScenes = false;`);
  const ids = win.eval(`scopeRoster(${scopeRows()}).map(r => r.id).sort()`);
  assert.deepEqual([...ids], ['a', 'b', 'f2', 'me']);
});

test('without a scene the roster falls back to the existing city scope', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `profile.school = null; friends = []; browseAllScenes = false;`);
  const ids = win.eval(`scopeRoster(${scopeRows()}).map(r => r.id).sort()`);
  assert.deepEqual([...ids], ['b', 'me']);
});

test('"everyone" toggle shows everyone and persists', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `browseAllScenes = false; rosterRaw = ${scopeRows()}; roster = scopeRoster(rosterRaw); renderHome();`);
  await tick(60); // renderHome runs on the next animation frame
  const btn = win.document.getElementById('scene-scope');
  assert.ok(btn, 'roster header needs a scene scope toggle');
  assert.match(btn.textContent, /texas tech|ttu|my scenes/i, 'shows the current scene');
  btn.click();
  await tick();
  assert.equal(win.eval(`roster.length`), 6);
  assert.equal(win.eval(`localStorage.getItem('pm_browse_all')`), '1');
  assert.match(btn.textContent, /everyone/i);
  btn.click();
  assert.equal(win.eval(`roster.length`), 4);
});

test('?scene=ttu on the landing url is captured as the signup default (legacy ?school= too)', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`history.replaceState(null, '', '/?scene=TTU&ref=x'); localStorage.removeItem('pm_scene_hint');`);
  assert.equal(win.eval(`getSceneParam()`), 'ttu');
  assert.equal(win.eval(`localStorage.getItem('pm_scene_hint')`), 'ttu', 'hint survives the auth redirect');
  win.eval(`history.replaceState(null, '', '/');`);
  assert.equal(win.eval(`getSceneParam()`), 'ttu', 'falls back to the stored hint');
  win.eval(`clearSceneParam(); history.replaceState(null, '', '/?school=ut-austin');`);
  assert.equal(win.eval(`getSceneParam()`), 'ut-austin', 'old ?school= share links still land');
});

test('onboarding scene step: hinted scene highlighted, pick joins via rpc, skip continues', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `profile.school = null; window.__next = 0; localStorage.setItem('pm_scene_hint', 'ttu');
    SCENES = [{ id: 'u1', slug: 'ttu', display_name: 'Texas Tech University', color: '#CC0000', pending: false, member_count: 3, joined: false },
              { id: 'u2', slug: 'ut', display_name: 'UT Austin', color: '#BF5700', pending: false, member_count: 9, joined: false }];`);
  win.eval(`showSetupScene(() => { window.__next++; })`);
  const page = win.document.getElementById('s-scene-page');
  assert.ok(page, 'scene step renders');
  const ttu = page.querySelector('.scene-opt[data-slug="ttu"]');
  assert.ok(ttu && ttu.classList.contains('primary'), 'hinted scene is the highlighted default');
  assert.ok(page.querySelector('#s-scene-create'), '"create a scene" button');
  assert.ok(page.querySelector('#s-scene-skip'), 'skip');
  assert.ok(page.querySelector('.scene-opt[data-slug="ut"]'), 'other scenes shown inline');

  ttu.click();
  await tick();
  const c = rpcCalls(win, 'join_scene');
  assert.equal(c.length, 1);
  assert.deepEqual(plain(c[0].args), { p_slug: 'ttu' });
  assert.equal(win.eval(`profile.school`), 'ttu');
  assert.equal(win.__next, 1, 'continues to the next step');

  win.eval(`profile.school = null; showSetupScene(() => { window.__next++; })`);
  win.document.getElementById('s-scene-skip').click();
  await tick();
  assert.equal(win.__next, 2);
  assert.equal(rpcCalls(win, 'join_scene').length, 1, 'skip does not call join_scene');
});

test('existing users without a scene get a one-time, dismissable prompt', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `profile.school = null; localStorage.removeItem('pm_scene_prompted');`);
  win.eval(`maybeShowSceneNudge()`);
  const sheet = win.document.getElementById('sheet-scenes');
  assert.ok(sheet && sheet.classList.contains('open'), 'nudge sheet opens');
  sheet.querySelector('[data-dismiss]').click();
  assert.ok(!sheet.classList.contains('open'));
  assert.equal(win.eval(`localStorage.getItem('pm_scene_prompted')`), '1');
  win.eval(`maybeShowSceneNudge()`);
  assert.ok(!sheet.classList.contains('open'), 'does not nag twice');

  win.eval(`profile.school = 'ttu'; localStorage.removeItem('pm_scene_prompted'); maybeShowSceneNudge()`);
  assert.ok(!sheet.classList.contains('open'), 'users in a scene are never prompted');
});

/* ── friends bypass the city/radius push filter ── */

test('status push reaches accepted friends outside my radius', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `
    localStorage.setItem('pm_push_force', '1');
    window.__pushed = [];
    sendPushNotification = async (toId) => { window.__pushed.push(toId); };
    userLoc = { lat: 33.58, lng: -101.87 }; // lubbock
    VENUES = [];
    roster = [
      { id: 'me', name: 'ez', status: 'off' },
      { id: 'near', name: 'near', status: 'off', last_lat: 33.58, last_lng: -101.88, notify_radius_km: 80 },
      { id: 'far',  name: 'far',  status: 'off', last_lat: 30.27, last_lng: -97.74,  notify_radius_km: 80 },
      { id: 'f2',   name: 'jake', status: 'off', last_lat: 30.27, last_lng: -97.74,  notify_radius_km: 80 }
    ];
    pushStatusChange('ez is playing');
  `);
  await tick(300);
  assert.deepEqual([...win.__pushed].sort(), ['f2', 'near'], 'friend f2 is far away but still pushed');
});
