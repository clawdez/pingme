'use strict';
// Email-required signup. "i'm in" asks for an email, sends a code through the
// send-email function (signup-send), verifies it (signup-verify), signs the
// browser in with the returned magiclink token_hash and only then reaches the
// name step — so every new profile hangs off a real, email-confirmed auth user.
// Anonymous sign-in stays behind FEATURES.anonSignup (default off).
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));
const byId = (win, id) => win.document.getElementById(id);
const plain = o => JSON.parse(JSON.stringify(o)); // jsdom-realm objects vs node assert prototypes

async function loadSettled(t) {
  const app = loadApp(t);
  await tick(350); // boot() with sb=null schedules showSetup at 300ms — let it fire before driving screens
  app.win.eval(`
    window.__fetch = []; window.__handlers = {}; window.__verifyOtp = []; window.__anon = 0; window.__db = [];
    window.__session = null; window.__profileRow = null; window.__confirmed = true;
    window.fetch = async (url, opts) => {
      const body = JSON.parse(opts.body);
      window.__fetch.push({ url, body, headers: opts.headers });
      const h = window.__handlers[body.action];
      const res = h ? (typeof h === 'function' ? h(body) : h) : { error: 'unknown action' };
      const status = res.__status || 200;
      return { ok: status < 400, status, json: async () => res };
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
      window.__db.push({ tbl, calls });
      const first = calls[0] && calls[0].m;
      if (tbl === 'profiles' && first === 'insert') return { data: Object.assign({}, calls[0].args[0], { email_verified: !!window.__confirmed }), error: null };
      if (tbl === 'profiles' && first === 'update') return { data: Object.assign({}, window.__profileRow || {}, calls[0].args[0]), error: null };
      if (calls.some(c => c.m === 'single')) return { data: tbl === 'profiles' ? window.__profileRow : null, error: null };
      return { data: [], error: null };
    };
    sb = {
      from: __from,
      rpc: () => Promise.resolve({ data: null, error: null }),
      auth: {
        getSession: async () => ({ data: { session: window.__session } }),
        onAuthStateChange: (cb) => { window.__authCb = cb; return { data: { subscription: { unsubscribe() {} } } }; },
        verifyOtp: async (args) => { window.__verifyOtp.push(args); return window.__verifyOtpResult || { data: { session: {} }, error: null }; },
        signInAnonymously: async () => { window.__anon++; return { data: { user: { id: 'anon-1' } }, error: null }; },
        refreshSession: async () => ({ data: {}, error: null }),
      },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      removeChannel() {}
    };
    bindAuthListener();
  `);
  return app;
}

/* ── entry points ── */

test('"i\'m in" opens the signup email screen and never signs in anonymously', async (t) => {
  const { win } = await loadSettled(t);
  assert.equal(win.eval('FEATURES.anonSignup'), false, 'anon signup is off by default');
  win.eval('showSetup()');
  byId(win, 's1-in').click();
  await tick();
  assert.ok(byId(win, 's-page-signup'), 'signup email page');
  assert.ok(byId(win, 'setup-signup-email'), 'email input');
  assert.ok(byId(win, 's-signup-go'), 'send-code button');
  assert.ok(!byId(win, 's-page-2'), 'name step is not reachable before verification');
  assert.equal(win.__anon, 0);
  byId(win, 's-signup-signin').click();
  assert.ok(byId(win, 's-page-email'), 'sign-in screen reachable from signup');
});

test('sign-in screen: "new here? create an account" opens signup, not the anonymous name step', async (t) => {
  const { win } = await loadSettled(t);
  win.eval('showSetupEmail()');
  byId(win, 's-email-new').click();
  assert.ok(byId(win, 's-page-signup'));
  assert.ok(!byId(win, 's-page-2'));
  assert.equal(win.__anon, 0);
});

test('FEATURES.anonSignup=true keeps the legacy anonymous path as an emergency fallback', async (t) => {
  const { win } = await loadSettled(t);
  win.eval('FEATURES.anonSignup = true; showSetup()');
  byId(win, 's1-in').click();
  assert.ok(byId(win, 's-page-2'), 'legacy: straight to the name step');
});

test('flag off: the name step without a user routes to signup instead of signInAnonymously', async (t) => {
  const { win } = await loadSettled(t);
  win.eval('showSetupScreen2(null, null, "")');
  byId(win, 'setup-name-2').value = 'ez';
  byId(win, 's2-rally').click();
  await tick();
  assert.equal(win.__anon, 0, 'signInAnonymously never called');
  assert.ok(byId(win, 's-page-signup'), 'redirected to the email step');
  assert.equal(win.__db.filter(c => c.tbl === 'profiles' && c.calls[0].m === 'insert').length, 0, 'no profile created');
});

/* ── signup: email step ── */

test('client validates the email before calling the function', async (t) => {
  const { win } = await loadSettled(t);
  win.eval('showSetupSignupEmail()');
  for (const bad of ['', 'nope', 'a@b', 'a b@c.com', '@c.com']) {
    byId(win, 'setup-signup-email').value = bad;
    byId(win, 's-signup-go').click();
    await tick();
    assert.equal(win.__fetch.length, 0, 'no request for ' + JSON.stringify(bad));
    assert.match(byId(win, 's-signup-err').textContent, /valid email/, 'inline error for ' + JSON.stringify(bad));
    assert.equal(byId(win, 's-signup-go').disabled, false, 'button usable again');
    assert.ok(byId(win, 's-page-signup'), 'still on the email step');
  }
});

test('already-registered email: error + a sign-in button that carries the email over', async (t) => {
  const { win } = await loadSettled(t);
  win.__handlers['signup-send'] = { ok: false, error: 'that email is already registered — sign in instead', code: 'already_registered' };
  win.eval('showSetupSignupEmail()');
  byId(win, 'setup-signup-email').value = 'taken@example.com';
  byId(win, 's-signup-go').click();
  await tick();
  assert.ok(byId(win, 's-page-signup'), 'stays on the signup screen');
  assert.ok(!byId(win, 'setup-otp'), 'no code screen');
  assert.match(byId(win, 's-signup-err').textContent, /already registered/);
  assert.equal(byId(win, 's-signup-go').disabled, false);
  const go = byId(win, 's-signup-signin-now');
  assert.ok(go, 'sign-in button offered inline');
  go.click();
  assert.ok(byId(win, 's-page-email'), 'sign-in screen');
  assert.equal(byId(win, 'setup-email').value, 'taken@example.com', 'email prefilled');
});

test('send failure (network) shows an inline error and re-enables the button', async (t) => {
  const { win } = await loadSettled(t);
  win.eval('window.fetch = async () => { throw new Error("boom"); }');
  win.eval('showSetupSignupEmail()');
  byId(win, 'setup-signup-email').value = 'ez@example.com';
  byId(win, 's-signup-go').click();
  await tick();
  assert.ok(byId(win, 's-page-signup'));
  assert.ok(byId(win, 's-signup-err').textContent.length > 0, 'error shown');
  assert.equal(byId(win, 's-signup-go').disabled, false);
});

/* ── signup: code step → session → name step ── */

test('happy path: email → signup-send → code → signup-verify → verifyOtp(magiclink) → name step → verified profile', async (t) => {
  const { win } = await loadSettled(t);
  win.__handlers['signup-send'] = { sent: true };
  win.__handlers['signup-verify'] = (b) => b.code === '123456'
    ? { verified: true, token_hash: 'th-1' }
    : { ok: false, error: 'invalid code (4 attempts left)' };
  win.eval('showSetupSignupEmail()');
  byId(win, 'setup-signup-email').value = '  Ez@Example.com ';
  byId(win, 's-signup-go').click();
  await tick();
  assert.equal(win.__fetch.length, 1);
  assert.match(win.__fetch[0].url, /\/functions\/v1\/send-email$/);
  assert.deepEqual(plain(win.__fetch[0].body), { action: 'signup-send', email: 'ez@example.com' }, 'normalised email');
  assert.ok(byId(win, 's-page-signup-otp'), 'code screen');
  assert.ok(byId(win, 's-page-signup-otp').textContent.includes('ez@example.com'), 'tells the user where the code went');

  // wrong code first
  byId(win, 'setup-otp').value = '000000';
  byId(win, 's-otp-go').click();
  await tick();
  assert.equal(win.__fetch.length, 2);
  assert.deepEqual(plain(win.__fetch[1].body), { action: 'signup-verify', email: 'ez@example.com', code: '000000' });
  assert.equal(win.__verifyOtp.length, 0, 'no client session attempt on a bad code');
  assert.match(byId(win, 's-otp-err').textContent, /invalid code/);
  assert.equal(byId(win, 's-otp-go').disabled, false, 'verify re-enabled');
  assert.ok(byId(win, 'setup-otp'), 'still on the code screen');

  // right code
  byId(win, 'setup-otp').value = '123456';
  byId(win, 's-otp-go').click();
  await tick();
  assert.deepEqual(plain(win.__verifyOtp), [{ token_hash: 'th-1', type: 'magiclink' }]);
  assert.equal(win.localStorage.getItem('pm_linked_email'), 'ez@example.com', 'device remembers the verified email');

  // supabase fires SIGNED_IN → app continues at the name step for a user with no profile yet
  await win.__authCb('SIGNED_IN', { user: { id: 'u-1', email: 'ez@example.com', user_metadata: {} }, access_token: 't' });
  await tick();
  assert.ok(byId(win, 's-page-2'), 'name step');
  assert.equal(byId(win, 'setup-name-2').value, 'ez', 'prefilled from the email');
  byId(win, 'setup-name-2').value = 'ezven';
  byId(win, 's2-rally').click();
  await tick(80);
  const ins = win.__db.find(c => c.tbl === 'profiles' && c.calls[0].m === 'insert');
  assert.ok(ins, 'profile inserted');
  assert.equal(ins.calls[0].args[0].id, 'u-1', 'profile id = auth user id');
  assert.equal(ins.calls[0].args[0].name, 'ezven');
  assert.equal(win.__anon, 0, 'never anonymous');
  assert.equal(win.eval('profile.id'), 'u-1');
  assert.equal(win.eval('profile.email_verified'), true, 'born verified (server-side trigger)');
  assert.ok(!byId(win, 's-page-2'), 'moved on past the name step');
});

test('expired code: error shown, "send a new code" requests a fresh one and stays on the code screen', async (t) => {
  const { win } = await loadSettled(t);
  win.__handlers['signup-send'] = { sent: true };
  win.__handlers['signup-verify'] = { ok: false, error: 'invalid or expired code' };
  win.eval('showSetupSignupEmail()');
  byId(win, 'setup-signup-email').value = 'ez@example.com';
  byId(win, 's-signup-go').click();
  await tick();
  byId(win, 'setup-otp').value = '123456';
  byId(win, 's-otp-go').click();
  await tick();
  assert.match(byId(win, 's-otp-err').textContent, /expired/);
  assert.equal(win.__verifyOtp.length, 0);
  byId(win, 's-otp-resend').click();
  await tick();
  assert.equal(win.__fetch.filter(f => f.body.action === 'signup-send').length, 2, 'fresh code requested');
  assert.ok(byId(win, 'setup-otp'), 'still on the code screen');
});

test('client session failure after a good code is surfaced and retryable', async (t) => {
  const { win } = await loadSettled(t);
  win.__handlers['signup-send'] = { sent: true };
  win.__handlers['signup-verify'] = { verified: true, token_hash: 'th-1' };
  win.eval('window.__verifyOtpResult = { data: { session: null }, error: { message: "token expired" } }');
  win.eval('showSetupSignupEmail()');
  byId(win, 'setup-signup-email').value = 'ez@example.com';
  byId(win, 's-signup-go').click();
  await tick();
  byId(win, 'setup-otp').value = '123456';
  byId(win, 's-otp-go').click();
  await tick();
  assert.equal(win.__verifyOtp.length, 1);
  assert.ok(byId(win, 's-otp-err').textContent.length > 0, 'error shown');
  assert.equal(byId(win, 's-otp-go').disabled, false);
});

/* ── sign-in nudge ── */

test('sign-in with an unknown email nudges toward creating an account (email carried over)', async (t) => {
  const { win } = await loadSettled(t);
  win.__handlers['signin-send'] = { ok: false, error: 'if that email exists, we sent a code' };
  win.eval('showSetupEmail()');
  const nudge = byId(win, 's-email-nudge');
  assert.ok(nudge, 'nudge slot exists');
  assert.equal(nudge.hidden, true, 'hidden until needed');
  byId(win, 'setup-email').value = 'nobody@example.com';
  byId(win, 's-email-go').click();
  await tick();
  assert.ok(byId(win, 's-page-email'), 'still on the sign-in screen');
  assert.ok(!byId(win, 'setup-otp'), 'no code screen for an unknown email');
  assert.equal(nudge.hidden, false, 'nudge visible');
  assert.match(nudge.textContent, /create an account/);
  byId(win, 's-email-nudge-go').click();
  assert.ok(byId(win, 's-page-signup'));
  assert.equal(byId(win, 'setup-signup-email').value, 'nobody@example.com');
});

/* ── existing accounts: link-email keeps working ── */

test('link-email sends the user session token, not the anon key (function requires a user JWT)', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`
    window.__session = { access_token: 'sess-tok', user: { id: 'me' } };
    profile = { id: 'me', name: 'ez', color: '#E8502A', email_verified: false };
    localStorage.removeItem('pm_linked_email');
  `);
  win.__handlers['send'] = { sent: true };
  win.__handlers['verify'] = { ok: false, error: 'invalid code (4 attempts left)' };
  win.eval('showLinkEmail()');
  byId(win, 'link-email-input').value = 'me@example.com';
  byId(win, 'link-email-go').click();
  await tick();
  assert.equal(win.__fetch.length, 1);
  assert.equal(win.__fetch[0].body.action, 'send');
  assert.equal(win.__fetch[0].headers.Authorization, 'Bearer sess-tok');
  byId(win, 'link-email-otp').value = '123456';
  byId(win, 'link-email-verify').click();
  await tick();
  assert.equal(win.__fetch[1].body.action, 'verify');
  assert.equal(win.__fetch[1].headers.Authorization, 'Bearer sess-tok');
});
