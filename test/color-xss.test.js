'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

// profiles.color comes straight from the DB and any client can write an
// arbitrary string to their own row via the anon key. It is interpolated
// into style="background:..." attributes — a value containing `">` breaks
// out of the attribute and injects live HTML into every other user's app.
const EVIL_COLOR = '#fff"><img src=x onerror="window.__pwned=1">';

test('roster bubble avatar does not let a hostile color inject HTML', (t) => {
  const { win } = loadApp(t);
  win.eval(`
    roster = [{ id: 'u1', name: 'mallory', color: ${JSON.stringify(EVIL_COLOR)},
      status: 'down', venue: null, started_at: new Date().toISOString(),
      duration: 60, updated_at: new Date().toISOString() }];
    renderRoster();
  `);
  const list = win.document.getElementById('list-down');
  assert.equal(list.querySelector('img'), null,
    'profile color broke out of the style attribute in the roster bubble');
});

test('leaderboard avatar does not let a hostile color inject HTML', (t) => {
  const { win } = loadApp(t);
  win.eval(`
    roster = [{ id: 'u1', name: 'mallory', color: ${JSON.stringify(EVIL_COLOR)},
      status: 'off', play_count: 5, updated_at: new Date().toISOString() }];
    renderLeaderboardList();
  `);
  const list = win.document.getElementById('lb-list');
  assert.equal(list.querySelector('img'), null,
    'profile color broke out of the style attribute in the leaderboard row');
});

test('player sheet avatar does not let a hostile color inject HTML', (t) => {
  const { win } = loadApp(t);
  win.eval(`
    roster = [{ id: 'u1', name: 'mallory', color: ${JSON.stringify(EVIL_COLOR)},
      status: 'off', updated_at: new Date().toISOString() }];
    openRaiderSheet(roster[0]);
  `);
  const modal = win.document.querySelector('#sheet-raider .modal-center');
  assert.equal(modal.querySelector('img'), null,
    'profile color broke out of the style attribute in the player sheet');
});

test('ping card avatar does not let a hostile sender color inject HTML', (t) => {
  const { win } = loadApp(t);
  win.eval(`
    profile = { id: 'me', name: 'ez', color: '#000' };
    pings = [{ id: 'p1', from_id: 'u1', to_id: 'me', verb: 'wants to play',
      msg: 'mallory pinged you!', unread: true,
      created_at: new Date().toISOString(),
      from: { name: 'mallory', color: ${JSON.stringify(EVIL_COLOR)} } }];
    renderNotis();
  `);
  const list = win.document.getElementById('me-ping-list');
  assert.equal(list.querySelector('img'), null,
    'sender color broke out of the style attribute in the ping card');
});

test('a normal palette color still renders as the avatar background', (t) => {
  const { win } = loadApp(t);
  win.eval(`
    roster = [{ id: 'u1', name: 'bob', color: '#E8B84A',
      status: 'down', venue: null, started_at: new Date().toISOString(),
      duration: 60, updated_at: new Date().toISOString() }];
    renderRoster();
  `);
  const av = win.document.querySelector('#list-down .rbub-av');
  assert.ok(av, 'roster bubble avatar should render');
  assert.match(av.getAttribute('style') || '', /#E8B84A/i,
    'legit hex color should pass through untouched');
});
