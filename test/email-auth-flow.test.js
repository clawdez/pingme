'use strict';
// Isolated end-to-end browser flow for the email sign-in / recovery path.
// Drives the REAL app.js sign-in screens in jsdom against a stubbed backend
// that mirrors the send-email edge function's response contract (see
// test/deno/send-email-harness.ts for the server side). No live sends, no real
// provider, only synthetic @pingme.test addresses.
//
// Covers, in order:
//   1. email request        (enter email → send-me-a-code → code screen)
//   2. failed delivery       (provider down → inline error, no code screen)
//   3. resend                (request another code from the code screen)
//   4. wrong code            (invalid → error, no client session attempt)
//   5. expired code          (invalid-or-expired → error, still on code screen)
//   6. successful verify      (token_hash → verifyOtp(magiclink) → email cached)
//   7. same account reload    (returning session → straight into the app)
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const byId = (win, id) => win.document.getElementById(id);
const plain = o => JSON.parse(JSON.stringify(o));
const EMAIL = 'returning@pingme.test';

// In-memory backend mirroring the send-email contract. One synthetic verified
// user; a single live OTP row; deterministic code so tests can type it.
function installBackend(win, opts = {}) {
  win.eval(`
    window.__fetch = [];
    window.__otp = ${JSON.stringify(opts.code || '424242')};
    window.__sendFail = ${opts.sendFail ? 'true' : 'false'};
    window.__expired = ${opts.expired ? 'true' : 'false'};
    window.__verifyOtp = [];
    window.__session = null;
    window.__profileRow = ${opts.profileRow ? JSON.stringify(opts.profileRow) : 'null'};
    window.fetch = async (url, opts2) => {
      const body = JSON.parse(opts2.body);
      window.__fetch.push({ url, body, headers: opts2.headers });
      if (body.action === 'signin-send') {
        if (window.__sendFail) return { ok: false, status: 503, json: async () => ({ code: 'email_unavailable', error: 'email is temporarily unavailable — try again shortly' }) };
        return { ok: true, status: 200, json: async () => ({ sent: true, user_id: 'u-return' }) };
      }
      if (body.action === 'signin-verify') {
        if (window.__expired) return { ok: true, status: 200, json: async () => ({ ok: false, code: 'invalid', error: 'invalid or expired code' }) };
        if (body.code !== window.__otp) return { ok: true, status: 200, json: async () => ({ ok: false, code: 'invalid', error: 'invalid code (4 attempts left)' }) };
        return { ok: true, status: 200, json: async () => ({ verified: true, token_hash: 'th-return' }) };
      }
      return { ok: true, status: 200, json: async () => ({}) };
    };
    function __from(tbl) {
      const calls = [];
      const h = { get(_, k) {
        if (k === 'then' || k === 'catch' || k === 'finally') { const p = Promise.resolve(window.__fromResult(tbl, calls)); return p[k].bind(p); }
        return (...args) => { calls.push({ m: k, args }); return new Proxy({}, h); };
      } };
      return new Proxy({}, h);
    }
    window.__fromResult = (tbl, calls) => {
      if (calls.some(c => c.m === 'single')) return { data: tbl === 'profiles' ? window.__profileRow : null, error: null };
      return { data: [], error: null };
    };
    sb = {
      from: __from,
      rpc: () => Promise.resolve({ data: null, error: null }),
      auth: {
        getSession: async () => ({ data: { session: window.__session } }),
        onAuthStateChange: (cb) => { window.__authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
        verifyOtp: async (args) => { window.__verifyOtp.push(args); window.__session = { user: { id: 'u-return', email: ${JSON.stringify(EMAIL)} }, access_token: 't' }; return { data: { session: window.__session }, error: null }; },
        refreshSession: async () => ({ data: { session: window.__session }, error: null }),
        signInAnonymously: async () => ({ data: { user: null }, error: { message: 'disabled' } }),
      },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      removeChannel() {}
    };
    bindAuthListener();
  `);
}

async function loadSettled(t, opts) {
  const app = loadApp(t);
  await tick(350);
  installBackend(app.win, opts);
  return app;
}

test('email auth flow: request → fail → resend → wrong → expired → success → reload', async (t) => {
  const { win } = await loadSettled(t);

  // ── 1. email request ──────────────────────────────────────────────────────
  win.eval('showSetupEmail()');
  byId(win, 'setup-email').value = EMAIL;
  byId(win, 's-email-go').click();
  await tick();
  assert.equal(win.__fetch.length, 1, 'one send request');
  assert.deepEqual(plain(win.__fetch[0].body), { action: 'signin-send', email: EMAIL }, 'signin-send with the typed email');
  assert.ok(byId(win, 'setup-otp'), 'code screen shown after a successful send');
  assert.ok(win.document.body.textContent.includes(EMAIL), 'tells the user where the code went');

  // ── 4/5. wrong code, then expired code (still on the code screen) ──────────
  const otpErr = byId(win, 's-signin-otp-err');
  byId(win, 'setup-otp').value = '000000';
  byId(win, 's-otp-go').click();
  await tick();
  assert.match(otpErr.textContent, /invalid code/, 'wrong code surfaces an inline error');
  assert.equal(win.__verifyOtp.length, 0, 'no client session attempt on a bad code');
  assert.ok(byId(win, 'setup-otp'), 'still on the code screen after a wrong code');

  win.eval('window.__expired = true');
  byId(win, 'setup-otp').value = '999999';
  byId(win, 's-otp-go').click();
  await tick();
  assert.match(otpErr.textContent, /expired/, 'expired code surfaces an expiry error');
  assert.equal(win.__verifyOtp.length, 0, 'expired code never mints a client session');
  win.eval('window.__expired = false');

  // ── 3. resend (request another code) ──────────────────────────────────────
  win.eval('emailSendCooldowns.clear()');
  await tick(1100);
  const resend = byId(win, 's-otp-resend-signin');
  assert.equal(resend.disabled, false, 'resend re-enabled once the cooldown clears');
  resend.click();
  await tick();
  assert.equal(win.__fetch.filter(f => f.body.action === 'signin-send').length, 2, 'resend fires a fresh signin-send');
  assert.ok(byId(win, 'setup-otp'), 'resend keeps the user on the code screen');

  // ── 6. successful verification ────────────────────────────────────────────
  byId(win, 'setup-otp').value = '424242';
  byId(win, 's-otp-go').click();
  await tick();
  assert.deepEqual(plain(win.__verifyOtp), [{ token_hash: 'th-return', type: 'magiclink' }], 'exchanges the server token for a session');
  assert.equal(win.localStorage.getItem('pm_linked_email'), EMAIL, 'device remembers the verified email');

  // ── 7. same account reload (returning verified user) ──────────────────────
  // The verifyOtp above set __session; onAuthStateChange fires SIGNED_IN and,
  // with an onboarded profile row present, the app drops setup and goes home.
  win.eval(`window.__profileRow = { id: 'u-return', name: 'ez', status: 'off', color: '#E8502A', email_verified: true }`);
  await win.__authCb('SIGNED_IN', win.__session);
  await tick(60);
  assert.equal(win.eval('profile && profile.id'), 'u-return', 'returning profile loaded');
  assert.equal(win.eval("document.getElementById('setup-root').innerHTML"), '', 'setup screen cleared on return');
  assert.equal(win.document.getElementById('app').inert, false, 'app is interactive for the returning user');
});

test('email auth flow: failed delivery keeps the user on the email screen with an error', async (t) => {
  const { win } = await loadSettled(t, { sendFail: true });
  win.eval('showSetupEmail()');
  byId(win, 'setup-email').value = 'nobody@pingme.test';
  byId(win, 's-email-go').click();
  await tick();
  assert.ok(byId(win, 's-page-email'), 'stays on the email screen when delivery fails');
  assert.ok(!byId(win, 'setup-otp'), 'no code screen without a confirmed send');
  assert.match(byId(win, 's-email-err').textContent, /temporarily unavailable|try again/i, 'delivery failure is surfaced');
  assert.equal(byId(win, 's-email-go').disabled, false, 're-enabled so the user can retry');
  // The failed send must not have locked a 60s cooldown in.
  assert.equal(win.eval("emailSendCooldowns.has('nobody@pingme.test')"), false, 'failed delivery clears the cooldown');
});
