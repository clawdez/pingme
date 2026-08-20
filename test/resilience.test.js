'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

// jsdom fires window 'load' (→ boot()) shortly after script injection. Wait it
// out while sb is still null so boot bails, THEN install the sb mock — the
// mocks only cover the surface the handlers under test actually touch.
async function loadSettled(t) {
  const app = require('./helpers').loadApp(t);
  await tick();
  return app;
}

function seedTarget(win) {
  win.eval(`
    profile = { id: 'me', name: 'ez', color: '#000' };
    roster = [{ id: 'u1', name: 'bob', color: '#000', status: 'off',
      updated_at: new Date().toISOString() }];
    lastPingTime = 0;
  `);
}

test('failed ping insert does not pretend success', async (t) => {
  const { win } = await loadSettled(t);
  seedTarget(win);
  win.eval(`
    window.__inserts = 0;
    sb = { rpc: async () => ({ data: null, error: null }),
      from: () => ({ insert: async () => { window.__inserts++;
      return { error: { message: 'network down' } }; } }) };
    openRaiderSheet(roster[0]);
  `);
  const btn = win.document.getElementById('rs-ping-btn');
  btn.click();
  await tick();
  assert.equal(win.__inserts, 1, 'one insert attempt expected');
  assert.ok(!/sent!/.test(btn.textContent),
    'button must not claim "sent!" when the insert failed');
  assert.equal(btn.disabled, false, 'button should be usable again for retry');

  // A failed send must not burn the 10s cooldown — retry works immediately.
  btn.click();
  await tick();
  assert.equal(win.__inserts, 2, 'retry after failure should reach the server');
});

test('successful ping insert still shows sent state', async (t) => {
  const { win } = await loadSettled(t);
  seedTarget(win);
  win.eval(`
    sb = { rpc: async () => ({ data: null, error: null }),
      from: () => ({ insert: async () => ({ error: null }) }) };
    openRaiderSheet(roster[0]);
  `);
  const btn = win.document.getElementById('rs-ping-btn');
  btn.click();
  await tick();
  assert.match(btn.textContent, /sent!/);
});

function seedPing(win, sbExpr) {
  win.eval(`
    profile = { id: 'me', name: 'ez', color: '#000' };
    pings = [{ id: 'p1', from_id: 'u1', to_id: 'me', verb: 'wants to play',
      msg: 'bob pinged you!', unread: true,
      created_at: new Date().toISOString(),
      from: { name: 'bob', color: '#000' } }];
    sb = ${sbExpr};
    renderNotis();
  `);
}

test('failed ping-action update does not mark the ping as handled', async (t) => {
  const { win } = await loadSettled(t);
  seedPing(win, `{ from: () => ({ update: () => ({
    eq: async () => ({ error: { message: 'boom' } }) }) }) }`);
  const btn = win.document.querySelector('#me-ping-list .pa-btn[data-action="maybe"]');
  assert.ok(btn, 'action button should render');
  btn.click();
  await tick();
  const p = win.eval('pings[0]');
  assert.equal(p.unread, true, 'ping must stay unread when the server write failed');
  assert.ok(!p.action_taken, 'action_taken must not be set when the server write failed');
  assert.ok(win.document.querySelector('#me-ping-list .pa-btn[data-action="maybe"]'),
    'action buttons should still be available for retry');
});

test('successful ping-action update marks the ping as handled', async (t) => {
  const { win } = await loadSettled(t);
  seedPing(win, `{ from: () => ({ update: () => ({
    eq: async () => ({ error: null }) }) }) }`);
  const btn = win.document.querySelector('#me-ping-list .pa-btn[data-action="maybe"]');
  btn.click();
  await tick();
  const p = win.eval('pings[0]');
  assert.equal(p.unread, false);
  assert.equal(p.action_taken, 'maybe');
});
