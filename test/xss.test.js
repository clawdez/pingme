'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

// Venue names are user-contributed (add_venue RPC) and flow back to every
// client via profiles.venue and the venues table. They must never be
// interpolated into innerHTML unescaped.
const EVIL_VENUE = '<img src=x onerror="window.__pwned=1">';

function seedRosterWithEvilVenue(win) {
  win.eval(`
    roster = [{
      id: 'attacker', name: 'mallory', color: '#000', status: 'playing',
      venue: ${JSON.stringify(EVIL_VENUE)},
      started_at: new Date().toISOString(), duration: 90,
      updated_at: new Date().toISOString()
    }];
    renderRoster();
  `);
}

test('roster bubble does not inject venue name as HTML', (t) => {
  const { win } = loadApp(t);
  seedRosterWithEvilVenue(win);
  const list = win.document.getElementById('list-playing');
  assert.equal(list.querySelector('img'), null,
    'venue name was parsed as an HTML element inside the roster bubble');
  assert.match(list.textContent, /<img/, 'venue name should render as text');
});

test('player sheet context line does not inject venue name as HTML', (t) => {
  const { win } = loadApp(t);
  seedRosterWithEvilVenue(win);
  win.eval(`openRaiderSheet(roster[0]);`);
  const modal = win.document.querySelector('#sheet-raider .modal-center');
  assert.equal(modal.querySelector('img'), null,
    'venue name was parsed as an HTML element inside the player sheet');
});

test('own profile status line does not inject venue name as HTML', (t) => {
  const { win } = loadApp(t);
  win.eval(`
    profile = { id: 'me', name: 'ez', color: '#000' };
    roster = [{
      id: 'me', name: 'ez', color: '#000', status: 'playing',
      venue: ${JSON.stringify(EVIL_VENUE)},
      started_at: new Date().toISOString(), duration: 90
    }];
    renderMe();
  `);
  const statusEl = win.document.getElementById('me-status-line');
  assert.equal(statusEl.querySelector('img'), null,
    'venue name was parsed as an HTML element in the profile status line');
});

test('live court timer does not inject venue name as HTML', (t) => {
  const { win } = loadApp(t);
  win.eval(`
    profile = { id: 'me', name: 'ez', color: '#000' };
    VENUES = [{ id: 'v1', name: ${JSON.stringify(EVIL_VENUE)}, desc: '', type: 'public', city: '' }];
    selectedVenue = 'v1';
    roster = [{ id: 'me', name: 'ez', color: '#000', status: 'playing',
      started_at: new Date().toISOString() }];
    homeState = 'playing';
    renderLiveZone();
  `);
  const timer = win.document.getElementById('court-timer');
  assert.equal(timer.querySelector('img'), null,
    'venue name was parsed as an HTML element in the court timer');
});

test('roster bubble initials from a hostile name are not raw HTML', (t) => {
  const { win } = loadApp(t);
  win.eval(`
    roster = [{ id: 'u1', name: '<b>bold', color: '#000', status: 'down',
      venue: null, started_at: new Date().toISOString(), duration: 60,
      updated_at: new Date().toISOString() }];
    renderRoster();
  `);
  // Unescaped initials ('<B') open a bogus tag that swallows the rest of the
  // bubble markup, so the name node disappears entirely.
  const name = win.document.querySelector('#list-down .rbub-name');
  assert.ok(name, 'bubble name should survive a hostile initial character');
  assert.match(name.textContent, /bold/);
});
