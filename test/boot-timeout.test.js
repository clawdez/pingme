'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');
const { ROOT } = require('./helpers');

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

// A supabase-js stand-in whose calls hang while window.__sbHang is set. The
// query builder is a thenable proxy so any select/order/limit chain works.
const MOCK_SB = `
  function __chain(result) {
    const p = new Promise(res => { if (!window.__sbHang) res(result); });
    const h = { get(_, k) {
      if (k === 'then') return p.then.bind(p);
      if (k === 'catch') return p.catch.bind(p);
      return () => new Proxy({}, h);
    } };
    return new Proxy({}, h);
  }
  window.__authListeners = 0;
  window.__mkSb = () => ({
    auth: {
      getSession: () => window.__sbHang ? new Promise(() => {}) : Promise.resolve({ data: { session: null } }),
      refreshSession: () => Promise.resolve({ data: { session: null } }),
      onAuthStateChange: () => { window.__authListeners++; return { data: { subscription: { unsubscribe() {} } } }; }
    },
    from: () => __chain({ data: [], error: null }),
    rpc: () => __chain({ data: null, error: null }),
    channel: () => ({ on() { return this; }, subscribe() { return this; } }),
    removeChannel() {}
  });
`;

// Boots index.html + app.js the way a browser would (supabase global present
// before app.js runs) so the real window 'load' → boot() path is exercised.
function loadWithHungSupabase(t, { timeoutMs = 80 } = {}) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, { url: 'http://localhost/', runScripts: 'dangerously', pretendToBeVisual: true });
  const win = dom.window;
  const errors = [];
  win.console.error = (...a) => errors.push(a.map(String).join(' '));
  win.navigator.vibrate = () => {};
  win.eval(MOCK_SB);
  win.__sbHang = true;
  win.PINGME_BOOT_TIMEOUT_MS = timeoutMs;
  win.supabase = { createClient: () => win.__mkSb() };
  const script = win.document.createElement('script');
  script.textContent = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  win.document.body.appendChild(script);
  if (t) t.after(() => win.close());
  return { win, errors };
}

test('hung supabase at boot lands on the offline/retry screen instead of spinning', async (t) => {
  const { win, errors } = loadWithHungSupabase(t);
  await tick(250);
  const off = win.document.getElementById('boot-offline');
  assert.ok(off, 'offline screen should render after the boot timeout');
  assert.match(off.textContent, /offline/i);
  assert.ok(win.document.getElementById('boot-retry'), 'offline screen needs a retry button');
  const splash = win.document.getElementById('splash');
  assert.ok(!splash || splash.style.opacity === '0', 'splash spinner must be hidden');
  await tick(400);
  assert.equal(win.document.getElementById('setup-root').innerHTML, '',
    'setup/sign-in flow must not pop over the offline screen');
  assert.deepEqual(errors, [], 'no console errors during a timed-out boot');
});

test('retry button re-runs the boot chain and clears the offline screen', async (t) => {
  const { win, errors } = loadWithHungSupabase(t);
  await tick(250);
  assert.ok(win.document.getElementById('boot-offline'));

  win.__sbHang = false; // backend is back
  win.document.getElementById('boot-retry').click();
  await tick(450);
  assert.equal(win.document.getElementById('boot-offline'), null, 'offline screen should be gone');
  assert.ok(Array.isArray(win.eval('roster')), 'roster loaded');
  assert.equal(win.__authListeners, 1, 'auth listener must be bound once across retries');
  assert.notEqual(win.document.getElementById('setup-root').innerHTML, '',
    'normal signed-out boot should resume (sign-in prompt shows)');
  assert.deepEqual(errors, []);
});

test('retry while still offline shows the offline screen again', async (t) => {
  const { win } = loadWithHungSupabase(t);
  await tick(250);
  win.document.getElementById('boot-retry').click();
  await tick(60);
  assert.ok(!win.document.getElementById('boot-offline') || win.document.getElementById('boot-retry').disabled,
    'retry should show progress (screen removed or button disabled) while re-booting');
  await tick(250);
  assert.ok(win.document.getElementById('boot-offline'), 'still offline → offline screen returns');
});
