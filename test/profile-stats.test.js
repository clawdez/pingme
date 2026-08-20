'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

function seedSignedInUser(win) {
  win.eval(`
    profile = { id: 'me', name: 'ez', color: '#E8502A', elo: 1240, play_count: 4 };
    roster = [
      { id: 'me', name: 'ez', color: '#E8502A', status: 'off', elo: 1240,
        wins: 3, losses: 1, play_count: 4, referral_count: 2,
        updated_at: new Date().toISOString() },
      { id: 'p2', name: 'jake', color: '#2544D6', status: 'off', elo: 1180,
        wins: 1, losses: 3, play_count: 9, referral_count: 5,
        updated_at: new Date().toISOString() }
    ];
    renderMe();
  `);
}

test('tapping the elo stat opens a populated elo sheet', (t) => {
  const { win } = loadApp(t);
  seedSignedInUser(win);
  win.document.getElementById('stat-elo').dispatchEvent(
    new win.Event('click', { bubbles: true }));
  const sheet = win.document.getElementById('sheet-elo');
  assert.ok(sheet.classList.contains('open'),
    'elo sheet should open when the stat is tapped');
  assert.match(win.document.getElementById('elo-big').textContent, /1240/,
    'elo sheet should show my elo');
  assert.notEqual(win.document.getElementById('elo-tier').textContent.trim(), '',
    'elo sheet should show a tier label');
});

test('tapping the rank stat opens a rankings sheet with rows', (t) => {
  const { win } = loadApp(t);
  seedSignedInUser(win);
  win.document.getElementById('stat-rank').dispatchEvent(
    new win.Event('click', { bubbles: true }));
  const sheet = win.document.getElementById('sheet-rank');
  assert.ok(sheet.classList.contains('open'), 'rankings sheet should open');
  const rows = win.document.querySelectorAll('#lb-list .lb-row');
  assert.ok(rows.length >= 2,
    'rankings list should contain the seeded players, got ' + rows.length);
});

test('rankings sheet has a container for my invite codes', (t) => {
  const { win } = loadApp(t);
  seedSignedInUser(win);
  win.document.getElementById('stat-rank').dispatchEvent(
    new win.Event('click', { bubbles: true }));
  assert.ok(win.document.getElementById('my-codes'),
    '#my-codes container should exist so invite codes can render');
});
