'use strict';
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
    const __mockJwtPayload = btoa(JSON.stringify({ sub: 'u1', exp: Math.floor(Date.now()/1000) + 3600 }));
    window.__session = { user: { id: 'u1' }, access_token: 'eyJ0eXAiOiJKV1QiLCJhbGciOiJIUzI1NiJ9.' + __mockJwtPayload + '.fake' };
    window.__profileRow = { id: 'u1', name: 'tester', email_verified: false };
    window.__confirmed = false;
    window.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      window.__fetch.push({ url, body, headers: opts.headers });
      const h = window.__handlers[body.action];
      if (!h) return { ok: true, status: 200, json: async () => ({}) };
      if (typeof h === 'function') {
        const res = h(body);
        if (res && typeof res.then === 'function') {
          const resolved = await res;
          const status = resolved.__status || 200;
          return { ok: status < 400, status, json: async () => resolved };
        }
        const status = res.__status || 200;
        return { ok: status < 400, status, json: async () => res };
      }
      const status = h.__status || 200;
      return { ok: status < 400, status, json: async () => h };
    };
    function __from(tbl) {
      const calls = [];
      const h = { get(_, k) {
        if (k === 'then' || k === 'catch' || k === 'finally') {
          const p = Promise.resolve(window.__fromResult(tbl, calls));
          return p[k].bind(p);
        }
        return (...args) => { calls.push({ m: k, args }); return new Proxy({}, h); };
      } };
      return new Proxy({}, h);
    }
    window.__fromResult = (tbl, calls) => {
      const first = calls[0] && calls[0].m;
      if (tbl === 'profiles' && first === 'update') return { data: Object.assign({}, window.__profileRow, calls[0].args[0]), error: null };
      if (calls.some(c => c.m === 'single')) return { data: tbl === 'profiles' ? window.__profileRow : null, error: null };
      return { data: [], error: null };
    };
    sb = {
      from: __from,
      rpc: () => Promise.resolve({ data: null, error: null }),
      auth: {
        getSession: async () => ({ data: { session: window.__session } }),
        onAuthStateChange: (cb) => { window.__authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
        refreshSession: async () => ({ data: {}, error: null }),
      },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      removeChannel() {}
    };
    profile = window.__profileRow;
    bindAuthListener();
  `);
  return app;
}

/* ── Operation identity: send A, leave, reopen, send B, late A ── */

test('link-email: send A, reopen, send B — late A response does not create OTP screen', async (t) => {
  const { win } = await setupLinkedProfile(t);

  // Set up deferred sends keyed by email
  win.eval(`
    window.__pending = {};
    window.__handlers['send'] = (body) => {
      let res;
      const p = new Promise(r => { res = r; });
      window.__pending[body.email] = res;
      return p;
    };
    showLinkEmail();
  `);
  await tick();

  // Send A
  const inputA = byId(win, 'link-email-input');
  assert.ok(inputA, 'email input present for A');
  inputA.value = 'a@test.com';
  byId(win, 'link-email-go').click();
  await tick(50);

  // Close and reopen (new gen + new sendOpId)
  win.eval(`
    showLinkEmail();
  `);
  await tick();

  // Send B
  const inputB = byId(win, 'link-email-input');
  assert.ok(inputB, 'email input present for B');
  inputB.value = 'b@test.com';
  byId(win, 'link-email-go').click();
  await tick(50);

  // Resolve late A — must be discarded
  win.eval(`window.__pending['a@test.com']({ success: true });`);
  await tick(100);

  // Should still be on send screen for B (or send-in-progress), not OTP
  assert.equal(byId(win, 'link-email-otp'), null, 'late A did not create OTP screen');

  // Now resolve B — should transition to OTP
  win.eval(`window.__pending['b@test.com']({ success: true });`);
  await tick(100);
  assert.ok(byId(win, 'link-email-otp'), 'B response creates OTP screen');
});

test('link-email: verify A, reopen+send+verify B — late verify A does not write pm_linked_email', async (t) => {
  const { win } = await setupLinkedProfile(t);

  // Flow A: send + verify with deferred verify
  win.eval(`
    window.__pending = {};
    window.__handlers['send'] = { success: true };
    window.__handlers['verify'] = (body) => {
      let res;
      const p = new Promise(r => { res = r; });
      window.__pending['verify_' + body.email] = res;
      return p;
    };
    showLinkEmail();
  `);
  await tick();
  byId(win, 'link-email-input').value = 'a@test.com';
  byId(win, 'link-email-go').click();
  await tick(100);
  assert.ok(byId(win, 'link-email-otp'), 'A reaches OTP');
  byId(win, 'link-email-otp').value = '111111';
  byId(win, 'link-email-verify').click();
  await tick(50);

  // Close A flow, reopen with B
  win.eval(`showLinkEmail();`);
  await tick();
  byId(win, 'link-email-input').value = 'b@test.com';
  byId(win, 'link-email-go').click();
  await tick(100);
  assert.ok(byId(win, 'link-email-otp'), 'B reaches OTP');
  byId(win, 'link-email-otp').value = '222222';
  byId(win, 'link-email-verify').click();
  await tick(50);

  // Resolve late A verify — must be discarded
  win.localStorage.removeItem('pm_linked_email');
  win.eval(`window.__pending['verify_a@test.com']({ verified: true });`);
  await tick(100);
  assert.equal(win.localStorage.getItem('pm_linked_email'), null, 'late A verify did not write cache');

  // Resolve B verify — should succeed
  win.eval(`window.__pending['verify_b@test.com']({ verified: true });`);
  await tick(100);
  assert.equal(win.localStorage.getItem('pm_linked_email'), 'b@test.com', 'B verify wrote correct email');
});

/* ── Delayed close: keyboard blocked immediately by inert ── */

test('closeSheet sets inert synchronously — keyboard blocked before CSS transition', async (t) => {
  const { win } = await setupLinkedProfile(t);
  const elo = win.document.getElementById('sheet-elo');
  assert.ok(elo, 'sheet-elo exists');

  // Open the sheet
  win.eval("openSheet(document.getElementById('sheet-elo'))");
  assert.equal(elo.inert, false, 'open: inert removed');
  assert.ok(elo.classList.contains('open'), 'open: has open class');

  // Close — inert must be set SYNCHRONOUSLY, not after transition
  win.eval("closeSheet(document.getElementById('sheet-elo'))");
  // Check inert immediately — no tick/await
  assert.equal(elo.inert, true, 'close: inert set synchronously');
  assert.ok(!elo.classList.contains('open'), 'close: open class removed');
});

test('handleDismiss sets inert synchronously on sheet-wrap', async (t) => {
  const { win } = await setupLinkedProfile(t);
  const me = win.document.getElementById('sheet-me');
  assert.ok(me, 'sheet-me exists');

  win.eval("openSheet(document.getElementById('sheet-me'))");
  assert.equal(me.inert, false, 'open: inert removed');

  // Simulate dismiss click on scrim
  const scrim = me.querySelector('[data-dismiss]');
  assert.ok(scrim, 'scrim dismiss target exists');
  scrim.click();
  // Check inert immediately — no await
  assert.equal(me.inert, true, 'dismiss: inert set synchronously');
});

/* ── Same-screen send race (no reopen): two sends with different emails ── */

test('link-email: same-screen second send supersedes first — late first discarded', async (t) => {
  const { win } = await setupLinkedProfile(t);

  win.eval(`
    window.__pending = {};
    window.__handlers['send'] = (body) => {
      let res;
      const p = new Promise(r => { res = r; });
      window.__pending[body.email] = res;
      return p;
    };
    showLinkEmail();
  `);
  await tick();

  // Send for email A
  byId(win, 'link-email-input').value = 'first@test.com';
  byId(win, 'link-email-go').click();
  await tick(50);

  // User navigates back within same flow (go-back button), re-enters with email B
  // This calls showLinkEmail again which increments gen + sendOpId
  win.eval(`showLinkEmail();`);
  await tick();
  byId(win, 'link-email-input').value = 'second@test.com';
  byId(win, 'link-email-go').click();
  await tick(50);

  // Late A resolves — must not create OTP
  win.eval(`window.__pending['first@test.com']({ success: true });`);
  await tick(100);
  assert.equal(byId(win, 'link-email-otp'), null, 'late first send did not transition to OTP');

  // B resolves — should create OTP
  win.eval(`window.__pending['second@test.com']({ success: true });`);
  await tick(100);
  assert.ok(byId(win, 'link-email-otp'), 'second send transitions to OTP');
});
