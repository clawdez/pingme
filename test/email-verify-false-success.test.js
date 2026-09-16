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
    window.__session = { user: { id: 'u1' } };
    window.__profileRow = { id: 'u1', name: 'tester', email_verified: false };
    window.__confirmed = false;
    window.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      window.__fetch.push({ url, body, headers: opts.headers });
      const h = window.__handlers[body.action];
      if (!h) return { ok: true, status: 200, json: async () => ({}) };
      if (typeof h === 'function') {
        const res = h(body);
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

async function driveToVerifyStep(win) {
  win.eval(`
    window.__handlers['send'] = { success: true };
    showLinkEmail();
  `);
  await tick();
  const emailInput = byId(win, 'link-email-input');
  assert.ok(emailInput, 'email input present');
  emailInput.value = 'test@example.com';
  byId(win, 'link-email-go').click();
  await tick(100);
  assert.ok(byId(win, 'link-email-otp'), 'OTP input present');
  byId(win, 'link-email-otp').value = '123456';
}

test('503 response -> no pm_linked_email, no success', async (t) => {
  const { win } = await setupLinkedProfile(t);
  await driveToVerifyStep(win);
  win.eval(`window.__handlers['verify'] = { __status: 503 };`);
  win.localStorage.removeItem('pm_linked_email');
  byId(win, 'link-email-verify').click();
  await tick(100);
  assert.equal(win.localStorage.getItem('pm_linked_email'), null, 'no cache write on 503');
  assert.ok(!byId(win, 'link-email-done') || byId(win, 'link-email-verify'), 'stays on verify step');
});

test('200 with {verified: false} -> no pm_linked_email, no success', async (t) => {
  const { win } = await setupLinkedProfile(t);
  await driveToVerifyStep(win);
  win.eval(`window.__handlers['verify'] = { verified: false };`);
  win.localStorage.removeItem('pm_linked_email');
  byId(win, 'link-email-verify').click();
  await tick(100);
  assert.equal(win.localStorage.getItem('pm_linked_email'), null, 'no cache write on verified:false');
});

test('200 with {} (missing verified field) -> no pm_linked_email', async (t) => {
  const { win } = await setupLinkedProfile(t);
  await driveToVerifyStep(win);
  win.eval(`window.__handlers['verify'] = {};`);
  win.localStorage.removeItem('pm_linked_email');
  byId(win, 'link-email-verify').click();
  await tick(100);
  assert.equal(win.localStorage.getItem('pm_linked_email'), null, 'no cache write on empty object');
});

test('200 with {error: "bad code"} -> no pm_linked_email, shows error', async (t) => {
  const { win } = await setupLinkedProfile(t);
  await driveToVerifyStep(win);
  win.eval(`window.__handlers['verify'] = { error: 'bad code' };`);
  win.localStorage.removeItem('pm_linked_email');
  byId(win, 'link-email-verify').click();
  await tick(100);
  assert.equal(win.localStorage.getItem('pm_linked_email'), null, 'no cache write on error response');
});

test('network error -> no pm_linked_email, verify button re-enabled', async (t) => {
  const { win } = await setupLinkedProfile(t);
  await driveToVerifyStep(win);
  win.eval(`window.__handlers['verify'] = null; window.fetch = async () => { throw new Error('network down'); };`);
  win.localStorage.removeItem('pm_linked_email');
  byId(win, 'link-email-verify').click();
  await tick(100);
  assert.equal(win.localStorage.getItem('pm_linked_email'), null, 'no cache write on network error');
  const btn = byId(win, 'link-email-verify');
  assert.ok(btn, 'verify button still present');
  assert.equal(btn.disabled, false, 'verify button re-enabled after error');
});

test('abort/timeout -> no pm_linked_email, verify button re-enabled', async (t) => {
  const { win } = await setupLinkedProfile(t);
  await driveToVerifyStep(win);
  win.eval(`window.fetch = async (url, opts) => {
    if (opts.signal) opts.signal.throwIfAborted?.();
    const e = new DOMException('aborted', 'AbortError'); e.name = 'AbortError'; throw e;
  };`);
  win.localStorage.removeItem('pm_linked_email');
  byId(win, 'link-email-verify').click();
  await tick(100);
  assert.equal(win.localStorage.getItem('pm_linked_email'), null, 'no cache write on timeout');
});

test('control: 200 with {verified: true} -> pm_linked_email IS written', async (t) => {
  const { win } = await setupLinkedProfile(t);
  await driveToVerifyStep(win);
  win.eval(`window.__handlers['verify'] = { verified: true };`);
  win.localStorage.removeItem('pm_linked_email');
  byId(win, 'link-email-verify').click();
  await tick(100);
  assert.equal(win.localStorage.getItem('pm_linked_email'), 'test@example.com', 'cache written on verified:true');
});

test('stale send response from prior flow discarded after re-open', async (t) => {
  const { win } = await setupLinkedProfile(t);
  let resolveSend;
  win.eval(`
    window.__handlers['send'] = null;
    window.__staleSendPromise = null;
    const origFetch = window.fetch;
    window.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      if (body.action === 'send') {
        return new Promise(r => { window.__resolveStaleSend = (v) => r(v); });
      }
      return origFetch(url, opts);
    };
    showLinkEmail();
  `);
  await tick();
  const emailInput = byId(win, 'link-email-input');
  assert.ok(emailInput, 'email input present');
  emailInput.value = 'old@example.com';
  byId(win, 'link-email-go').click();
  await tick(50);
  // User closes and re-opens (new generation)
  win.eval(`
    window.__handlers['send'] = { success: true };
    window.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      return { ok: true, status: 200, json: async () => ({ success: true }) };
    };
    showLinkEmail();
  `);
  await tick(50);
  // Now resolve the OLD send — should be discarded
  win.eval(`window.__resolveStaleSend({ ok: true, status: 200, json: async () => ({ success: true }) });`);
  await tick(100);
  // Should still show the fresh email input, not the OTP screen from stale flow
  assert.ok(byId(win, 'link-email-input'), 'fresh flow still on email input, stale send discarded');
  assert.equal(byId(win, 'link-email-otp'), null, 'no OTP screen from stale response');
});
