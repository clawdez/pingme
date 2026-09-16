'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

test('logged-out boot: #app is inert after boot fires', async (t) => {
  const { win } = loadApp(t);
  await tick(100);
  const app = win.document.getElementById('app');
  assert.equal(app.getAttribute('aria-hidden'), 'true',
    '#app must have aria-hidden after boot');
  assert.ok(app.inert || app.hasAttribute('inert'),
    '#app must be inert after boot');
});

test('logged-out boot: #app stays inert through onboarding', async (t) => {
  const { win } = loadApp(t);
  await tick(350);
  const app = win.document.getElementById('app');
  assert.ok(app.inert || app.hasAttribute('inert'),
    '#app must remain inert during onboarding');
  const setup = win.document.getElementById('setup-root');
  assert.ok(setup.innerHTML.length > 0, 'setup-root must have content');
});

test('all sheets have inert attribute in HTML', async (t) => {
  const { win } = loadApp(t);
  const sheets = win.document.querySelectorAll('.sheet-wrap');
  assert.ok(sheets.length >= 9, 'expected at least 9 sheet-wrap elements');
  for (const s of sheets) {
    assert.ok(s.hasAttribute('inert'), `${s.id} must have inert attribute when closed`);
  }
});

test('openSheet removes inert, closeSheet restores it', async (t) => {
  const { win } = loadApp(t);
  await tick(350);
  const elo = win.document.getElementById('sheet-elo');
  assert.ok(elo.hasAttribute('inert'), 'sheet-elo starts inert');
  win.eval("openSheet(document.getElementById('sheet-elo'))");
  assert.equal(elo.inert, false, 'openSheet must remove inert');
  assert.ok(elo.classList.contains('open'));
  win.eval("closeSheet(document.getElementById('sheet-elo'))");
  assert.equal(elo.inert, true, 'closeSheet must restore inert');
  assert.ok(!elo.classList.contains('open'));
});
