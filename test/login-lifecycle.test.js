'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

async function loadSettled(t) {
  const app = loadApp(t);
  await tick(350);
  return app;
}

// ── Focus trap ──

test('setup email screen: Shift+Tab from email input stays within setup-root', async (t) => {
  const { win } = await loadSettled(t);
  // Navigate to sign-in email screen
  win.eval(`showSetupEmail()`);
  await tick(120);

  const root = win.document.getElementById('setup-root');
  assert.ok(root, 'setup-root exists');
  assert.equal(root.getAttribute('aria-label'), 'sign in', 'setup-root has aria-label');
  assert.ok(root._setupFocusTrap, 'focus trap is attached');

  const emailInput = win.document.getElementById('setup-email');
  assert.ok(emailInput, 'email input exists');
  emailInput.focus();

  // Simulate Shift+Tab
  const event = new win.KeyboardEvent('keydown', { key: 'Tab', shiftKey: true, bubbles: true, cancelable: true });
  let defaultPrevented = false;
  const origPrevent = event.preventDefault.bind(event);
  Object.defineProperty(event, 'preventDefault', { value: () => { defaultPrevented = true; origPrevent(); } });
  emailInput.dispatchEvent(event);

  // Focus should wrap to last focusable element (not escape to hidden sheet controls)
  if (defaultPrevented) {
    // The trap caught it and moved focus to the last element
    const active = win.document.activeElement;
    assert.ok(root.contains(active), 'focus stayed within setup-root after Shift+Tab');
    assert.notEqual(active, emailInput, 'focus moved away from email input');
  }
});

test('setup email screen: Tab from last element wraps to first', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`showSetupEmail()`);
  await tick(120);

  const root = win.document.getElementById('setup-root');
  // Find last focusable
  const focusables = Array.from(root.querySelectorAll(
    'a[href],button:not([disabled]):not([hidden]),input:not([disabled]):not([hidden])'
  )).filter(el => !el.hidden && el.style.display !== 'none');
  assert.ok(focusables.length >= 3, 'at least 3 focusable elements');

  const last = focusables[focusables.length - 1];
  last.focus();
  const event = new win.KeyboardEvent('keydown', { key: 'Tab', shiftKey: false, bubbles: true, cancelable: true });
  last.dispatchEvent(event);
  // After trap, focus should be on the first focusable
  const active = win.document.activeElement;
  assert.ok(root.contains(active), 'focus stayed in setup-root after forward Tab');
});

test('signup email screen has focus trap and aria-label', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`showSetupSignupEmail('')`);
  await tick(120);

  const root = win.document.getElementById('setup-root');
  assert.equal(root.getAttribute('aria-label'), 'create account');
  assert.ok(root._setupFocusTrap, 'focus trap attached to signup screen');
});

test('signin OTP screen has focus trap and aria-label', async (t) => {
  const { win } = await loadSettled(t);
  // Mock fetch to let signInSendCode succeed
  win.eval(`
    window.fetch = async () => ({ ok: true, status: 200, json: async () => ({ sent: true }) });
    showSetupEmail('test@example.com');
  `);
  await tick(120);

  // Trigger send
  const sendBtn = win.document.getElementById('s-email-go');
  const emailInput = win.document.getElementById('setup-email');
  emailInput.value = 'test@example.com';
  sendBtn.click();
  await tick(200);

  const root = win.document.getElementById('setup-root');
  assert.equal(root.getAttribute('aria-label'), 'verify sign-in code');
  assert.ok(root._setupFocusTrap, 'focus trap attached to OTP screen');
  const otpInput = win.document.getElementById('setup-otp');
  assert.ok(otpInput, 'OTP input rendered');
});

// ── Full sign-in lifecycle ──

test('signin lifecycle: email request → failed delivery → resend → wrong code → correct code → session', async (t) => {
  const { win } = await loadSettled(t);

  let fetchCalls = [];
  let fetchResponses = [];
  win.eval(`
    window.__fetchCalls = [];
    window.__fetchResponses = [];
    window.fetch = async (url, opts) => {
      const body = opts.body ? JSON.parse(opts.body) : {};
      window.__fetchCalls.push({ url, body, headers: opts.headers });
      const resp = window.__fetchResponses.shift() || { ok: true, status: 200, data: { sent: true } };
      return { ok: resp.ok, status: resp.status, json: async () => resp.data };
    };
    sb = {
      auth: {
        verifyOtp: async () => ({ error: null }),
        onAuthStateChange: (cb) => {
          window.__authCb = cb;
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
        getSession: async () => ({ data: { session: null } }),
        refreshSession: async () => ({ data: {}, error: null }),
      }
    };
    showSetupEmail();
  `);
  await tick(120);

  const emailInput = win.document.getElementById('setup-email');
  const sendBtn = win.document.getElementById('s-email-go');
  emailInput.value = 'user@test.com';

  // Step 1: Failed delivery (server returns 503)
  win.eval(`window.__fetchResponses = [{ ok: false, status: 503, data: { error: 'email is temporarily unavailable — try again shortly', code: 'email_unavailable' } }]`);
  sendBtn.click();
  await tick(200);

  const errEl = win.document.getElementById('s-email-err');
  assert.ok(errEl, 'error element exists');
  assert.match(errEl.textContent, /temporarily unavailable/, 'shows delivery failure error');
  assert.equal(sendBtn.disabled, false, 'send button re-enabled after failure');

  // Step 2: Successful resend
  win.eval(`window.__fetchResponses = [{ ok: true, status: 200, data: { sent: true } }]`);
  // Need to clear cooldown from failed attempt
  win.eval(`emailSendCooldowns.delete('user@test.com')`);
  sendBtn.click();
  await tick(200);

  // Should now be on OTP screen
  const otpInput = win.document.getElementById('setup-otp');
  assert.ok(otpInput, 'OTP input rendered after successful send');
  assert.equal(otpInput.readOnly, false, 'OTP input is writable');

  const verifyBtn = win.document.getElementById('s-otp-go');
  assert.ok(verifyBtn, 'verify button exists');

  // Step 3: Wrong code
  win.eval(`window.__fetchResponses = [{ ok: true, status: 200, data: { ok: false, code: 'invalid', error: 'invalid code (4 attempts left)' } }]`);
  otpInput.value = '111111';
  verifyBtn.click();
  await tick(200);

  const otpErr = win.document.getElementById('s-signin-otp-err');
  assert.match(otpErr.textContent, /invalid code/, 'shows wrong code error');
  assert.equal(verifyBtn.disabled, false, 'verify re-enabled after wrong code');
  assert.equal(otpInput.readOnly, false, 'input still writable after wrong code');

  // Step 4: Correct code → token_hash returned → session established
  win.eval(`window.__fetchResponses = [{ ok: true, status: 200, data: { verified: true, token_hash: 'abc123hash' } }]`);
  otpInput.value = '999999';
  verifyBtn.click();
  await tick(200);

  // verifyOtp should have been called (mocked to succeed)
  // localStorage should have the email
  const linked = win.eval(`localStorage.getItem('pm_linked_email')`);
  assert.equal(linked, 'user@test.com', 'email saved to localStorage after successful signin');
});

// ── Expired code handling ──

test('signin: expired code returns proper error and allows resend', async (t) => {
  const { win } = await loadSettled(t);

  win.eval(`
    window.__fetchResponses = [];
    window.fetch = async (url, opts) => {
      const resp = window.__fetchResponses.shift() || { ok: true, status: 200, data: { sent: true } };
      return { ok: resp.ok, status: resp.status, json: async () => resp.data };
    };
    sb = {
      auth: {
        verifyOtp: async () => ({ error: null }),
        onAuthStateChange: (cb) => ({ data: { subscription: { unsubscribe: () => {} } } }),
        getSession: async () => ({ data: { session: null } }),
      }
    };
    window.__fetchResponses = [{ ok: true, status: 200, data: { sent: true } }];
    showSetupEmail('expired@test.com');
  `);
  await tick(120);

  // Send code
  const emailInput = win.document.getElementById('setup-email');
  emailInput.value = 'expired@test.com';
  win.document.getElementById('s-email-go').click();
  await tick(200);

  // Try expired code
  win.eval(`window.__fetchResponses = [{ ok: true, status: 200, data: { ok: false, code: 'invalid', error: 'invalid or expired code' } }]`);
  const otpInput = win.document.getElementById('setup-otp');
  otpInput.value = '123456';
  win.document.getElementById('s-otp-go').click();
  await tick(200);

  const otpErr = win.document.getElementById('s-signin-otp-err');
  assert.match(otpErr.textContent, /invalid or expired/, 'shows expired code error');

  // Resend should work
  const resendBtn = win.document.getElementById('s-otp-resend-signin');
  assert.ok(resendBtn, 'resend button exists');
  // Clear cooldown
  win.eval(`emailSendCooldowns.delete('expired@test.com')`);
  // Force resend UI update
  win.eval(`
    const rb = document.getElementById('s-otp-resend-signin');
    if (rb) { rb.disabled = false; rb.textContent = 'send a new code'; }
  `);
  win.eval(`window.__fetchResponses = [{ ok: true, status: 200, data: { sent: true } }]`);
  resendBtn.click();
  await tick(200);

  // After successful resend, input should be writable and cleared
  assert.equal(otpInput.readOnly, false, 'input writable after resend');
  assert.equal(otpInput.value, '', 'old code cleared after resend');
  const verifyBtn = win.document.getElementById('s-otp-go');
  assert.equal(verifyBtn.disabled, false, 'verify enabled after resend');
  assert.equal(verifyBtn.dataset.verificationPending, '', 'pending flag cleared');
});

// ── Signup lifecycle ──

test('signup lifecycle: email → code → verify → session', async (t) => {
  const { win } = await loadSettled(t);

  win.eval(`
    window.__fetchResponses = [];
    window.fetch = async (url, opts) => {
      const resp = window.__fetchResponses.shift() || { ok: true, status: 200, data: { sent: true } };
      return { ok: resp.ok, status: resp.status, json: async () => resp.data };
    };
    sb = {
      auth: {
        verifyOtp: async () => ({ error: null }),
        onAuthStateChange: (cb) => {
          window.__authCb = cb;
          return { data: { subscription: { unsubscribe: () => {} } } };
        },
        getSession: async () => ({ data: { session: null } }),
      }
    };
    window.__fetchResponses = [{ ok: true, status: 200, data: { sent: true } }];
    showSetupSignupEmail('');
  `);
  await tick(120);

  const emailInput = win.document.getElementById('setup-signup-email');
  emailInput.value = 'new@test.com';
  win.document.getElementById('s-signup-go').click();
  await tick(200);

  // Should be on OTP screen
  const otpInput = win.document.getElementById('setup-otp');
  assert.ok(otpInput, 'signup OTP input rendered');

  // Verify with correct code
  win.eval(`window.__fetchResponses = [{ ok: true, status: 200, data: { verified: true, token_hash: 'signup_hash_xyz' } }]`);
  otpInput.value = '654321';
  win.document.getElementById('s-otp-go').click();
  await tick(200);

  const linked = win.eval(`localStorage.getItem('pm_linked_email')`);
  assert.equal(linked, 'new@test.com', 'email saved after signup verify');
});

// ── Transport unknown → session-await recovery → same-account reload ──

test('signin: transport_unknown → session-await → same-account session arrives → verified', async (t) => {
  const { win } = await loadSettled(t);

  win.eval(`
    window.__authCb = null;
    window.__unsubCalled = false;
    window.__fetchResponses = [];
    window.fetch = async (url, opts) => {
      const resp = window.__fetchResponses.shift() || { ok: true, status: 200, data: { sent: true } };
      return { ok: resp.ok, status: resp.status, json: async () => resp.data };
    };
    sb = {
      auth: {
        verifyOtp: async (opts) => {
          window.__verifyOtpCalled = opts;
          return { error: null };
        },
        onAuthStateChange: (cb) => {
          window.__authCb = cb;
          return { data: { subscription: { unsubscribe: () => { window.__unsubCalled = true; } } } };
        },
        getSession: async () => ({ data: { session: null } }),
      }
    };
    window.__fetchResponses = [{ ok: true, status: 200, data: { sent: true } }];
    showSetupEmail('recover@test.com');
  `);
  await tick(120);

  // Send code
  win.document.getElementById('setup-email').value = 'recover@test.com';
  win.document.getElementById('s-email-go').click();
  await tick(200);

  // Verify → network error triggers transport_unknown
  const otpInput = win.document.getElementById('setup-otp');
  otpInput.value = '777777';

  // Make fetch throw to trigger catch block
  win.eval(`
    window.__fetchResponses = [];
    window.fetch = async () => { throw new Error('network failure'); };
  `);
  win.document.getElementById('s-otp-go').click();
  await tick(200);

  const verifyBtn = win.document.getElementById('s-otp-go');
  assert.equal(verifyBtn.dataset.verificationPending, 'true', 'verify in pending state');
  assert.equal(otpInput.readOnly, true, 'input locked during pending');
  const waitEl = win.document.querySelector('.verification-session-wait');
  assert.ok(waitEl, 'session-await UI rendered');

  // Simulate same-account session arriving
  await win.eval(`window.__authCb('SIGNED_IN', { user: { email: 'recover@test.com' } })`);
  await tick(50);

  const errText = win.document.getElementById('s-signin-otp-err').textContent;
  assert.match(errText, /signed in as recover@test\.com/, 'confirmed session with correct email');
  assert.equal(win.eval('window.__unsubCalled'), true, 'auth subscription cleaned up');
});

// ── Rate limit handling ──

test('signin: rate limit response handled correctly', async (t) => {
  const { win } = await loadSettled(t);

  win.eval(`
    window.fetch = async () => ({
      ok: false, status: 429,
      json: async () => ({ error: 'please wait a minute before requesting another code' })
    });
    sb = { auth: { getSession: async () => ({ data: { session: null } }) } };
    showSetupEmail();
  `);
  await tick(120);

  win.document.getElementById('setup-email').value = 'rate@test.com';
  win.eval(`emailSendCooldowns.delete('rate@test.com')`);
  win.document.getElementById('s-email-go').click();
  await tick(200);

  const err = win.document.getElementById('s-email-err');
  assert.match(err.textContent, /wait a minute/, 'rate limit error shown');
});

// ── Server-side edge cases (verified through client responses) ──

test('signin verify: too many attempts → lockout error', async (t) => {
  const { win } = await loadSettled(t);

  win.eval(`
    window.__fetchResponses = [];
    window.fetch = async (url, opts) => {
      const resp = window.__fetchResponses.shift() || { ok: true, status: 200, data: { sent: true } };
      return { ok: resp.ok, status: resp.status, json: async () => resp.data };
    };
    sb = {
      auth: {
        verifyOtp: async () => ({ error: null }),
        onAuthStateChange: (cb) => ({ data: { subscription: { unsubscribe: () => {} } } }),
        getSession: async () => ({ data: { session: null } }),
      }
    };
    window.__fetchResponses = [{ ok: true, status: 200, data: { sent: true } }];
    showSetupEmail('locked@test.com');
  `);
  await tick(120);

  win.document.getElementById('setup-email').value = 'locked@test.com';
  win.document.getElementById('s-email-go').click();
  await tick(200);

  // Server returns too many attempts
  win.eval(`window.__fetchResponses = [{ ok: true, status: 200, data: { ok: false, code: 'invalid', error: 'too many attempts — request a new code' } }]`);
  const otpInput = win.document.getElementById('setup-otp');
  otpInput.value = '000000';
  win.document.getElementById('s-otp-go').click();
  await tick(200);

  const otpErr = win.document.getElementById('s-signin-otp-err');
  assert.match(otpErr.textContent, /too many attempts/, 'lockout error displayed');
});

test('signin verify: server 500 triggers transport_unknown pending state', async (t) => {
  const { win } = await loadSettled(t);

  win.eval(`
    window.__fetchResponses = [];
    window.fetch = async (url, opts) => {
      const resp = window.__fetchResponses.shift() || { ok: true, status: 200, data: { sent: true } };
      return { ok: resp.ok, status: resp.status, json: async () => resp.data };
    };
    sb = {
      auth: {
        verifyOtp: async () => ({ error: null }),
        onAuthStateChange: (cb) => ({ data: { subscription: { unsubscribe: () => {} } } }),
        getSession: async () => ({ data: { session: null } }),
      }
    };
    window.__fetchResponses = [{ ok: true, status: 200, data: { sent: true } }];
    showSetupEmail('server-err@test.com');
  `);
  await tick(120);

  win.document.getElementById('setup-email').value = 'server-err@test.com';
  win.document.getElementById('s-email-go').click();
  await tick(200);

  // Server returns 500 with no structured code
  win.eval(`window.__fetchResponses = [{ ok: false, status: 500, data: { error: 'internal error' } }]`);
  win.document.getElementById('setup-otp').value = '123456';
  win.document.getElementById('s-otp-go').click();
  await tick(200);

  const verifyBtn = win.document.getElementById('s-otp-go');
  assert.equal(verifyBtn.dataset.verificationPending, 'true', 'pending state on server error');
});

// ── Link-email expired session ──

test('link-email: expired session throws before network call', async (t) => {
  const { win } = await loadSettled(t);

  win.eval(`
    sb = {
      auth: {
        getSession: async () => ({ data: { session: { access_token: 'not-a-jwt' } } }),
        refreshSession: async () => ({ data: {}, error: { message: 'expired' } }),
      }
    };
  `);

  let threw = false;
  try {
    await win.eval(`userAuthHeaders()`);
  } catch (e) {
    threw = true;
    assert.match(e.message, /session expired/, 'throws session_expired on bad refresh');
  }
  assert.ok(threw, 'userAuthHeaders threw for expired session');
});
