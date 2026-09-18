'use strict';
// A11y regression: the link-email panel is injected into #me-wrap, which lives
// inside the profile card. Before the fix, Shift+Tab from the email input
// escaped backward into the profile chrome — including the sheet close control
// (.me-back) sitting visually behind the active panel. The panel now traps Tab
// so keyboard navigation stays on the visible screen.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const byId = (win, id) => win.document.getElementById(id);

async function setupLinkedProfile(t) {
  const app = loadApp(t);
  await tick(350);
  app.win.eval(`
    window.__fetch = []; window.__handlers = {};
    window.__session = { user: { id: 'u1' }, access_token: 'tok' };
    window.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      window.__fetch.push({ url, body, headers: opts.headers });
      const h = window.__handlers[body.action];
      const res = h ? (typeof h === 'function' ? h(body) : h) : {};
      const status = res.__status || 200;
      return { ok: status < 400, status, json: async () => res };
    };
    function __from() { const h = { get(_, k) {
      if (k === 'then' || k === 'catch' || k === 'finally') { const p = Promise.resolve({ data: null, error: null }); return p[k].bind(p); }
      return () => new Proxy({}, h); } }; return new Proxy({}, h); }
    sb = {
      from: __from,
      rpc: () => Promise.resolve({ data: null, error: null }),
      auth: {
        getSession: async () => ({ data: { session: window.__session } }),
        onAuthStateChange: (cb) => { window.__authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
        refreshSession: async () => ({ data: { session: window.__session }, error: null }),
      },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      removeChannel() {}
    };
    profile = { id: 'u1', name: 'tester', color: '#E8502A', email_verified: false };
    localStorage.removeItem('pm_linked_email');
    openSheet(document.getElementById('sheet-me'));
    bindAuthListener();
  `);
  return app;
}

function pressTab(win, el, shift) {
  const ev = new win.KeyboardEvent('keydown', { key: 'Tab', shiftKey: !!shift, bubbles: true, cancelable: true });
  el.dispatchEvent(ev);
  return ev;
}

test('sheet-me close control carries an accessible label', async (t) => {
  const { win } = await setupLinkedProfile(t);
  const back = win.document.querySelector('#sheet-me .me-back');
  assert.ok(back, '.me-back close control exists');
  assert.equal(back.getAttribute('aria-label'), 'close profile', 'close control is labeled for screen readers');
});

test('link-email panel: Shift+Tab from the email input does not escape to the sheet close control', async (t) => {
  const { win } = await setupLinkedProfile(t);
  win.eval('showLinkEmail()');
  await tick();
  const input = byId(win, 'link-email-input');
  const cancel = byId(win, 'link-email-cancel');
  const back = win.document.querySelector('#sheet-me .me-back');
  assert.ok(input && cancel && back, 'panel + input + cancel + close all present');

  input.focus();
  assert.equal(win.document.activeElement, input, 'email input is focused');

  const ev = pressTab(win, input, true); // Shift+Tab from the first field
  assert.equal(ev.defaultPrevented, true, 'Shift+Tab is intercepted, not allowed to leave the panel');
  assert.notEqual(win.document.activeElement, back, 'focus never lands on the hidden sheet close control');
  assert.equal(win.document.activeElement, cancel, 'focus wraps to the last control inside the panel');
});

test('link-email panel: exposes a labeled dialog for assistive tech', async (t) => {
  const { win } = await setupLinkedProfile(t);
  win.eval('showLinkEmail()');
  await tick();
  const panel = win.document.querySelector('#me-wrap .link-email-panel');
  assert.ok(panel, 'panel wrapper exists');
  assert.equal(panel.getAttribute('role'), 'dialog', 'panel is a dialog');
  assert.equal(panel.getAttribute('aria-modal'), 'true', 'panel is modal for keyboard/AT');
  assert.match(panel.getAttribute('aria-label'), /link your email/, 'panel is labeled');
});

test('link-email code screen: Tab from the last control wraps back into the panel', async (t) => {
  const { win } = await setupLinkedProfile(t);
  win.__handlers['send'] = { sent: true };
  win.eval('showLinkEmail()');
  await tick();
  byId(win, 'link-email-input').value = 'synthetic@pingme.test';
  byId(win, 'link-email-go').click();
  await tick(60);
  const otp = byId(win, 'link-email-otp');
  const done = byId(win, 'link-email-done');
  assert.ok(otp && done, 'code screen rendered inside the same panel');
  const back = win.document.querySelector('#sheet-me .me-back');

  done.focus();
  const ev = pressTab(win, done, false); // Tab forward from the last control
  assert.equal(ev.defaultPrevented, true, 'Tab is intercepted at the panel boundary');
  assert.notEqual(win.document.activeElement, back, 'focus does not leak to the sheet close control');
  assert.equal(win.document.activeElement, otp, 'focus wraps to the first control inside the panel');
});
