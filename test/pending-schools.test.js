'use strict';
// "Other → type your school": the school chooser grows a bottom row that lets
// a user type an unlisted school. Submitting calls suggest_school, which
// creates a pending row and groups the caller under it immediately.
const { test } = require('node:test');
const assert = require('node:assert/strict');
const { loadApp } = require('./helpers');

const tick = (ms = 30) => new Promise(r => setTimeout(r, ms));

async function loadSettled(t) {
  const app = loadApp(t);
  await tick();
  app.win.eval(`
    window.__rpc = [];
    window.__rpcResults = {};
    function __chain(result) {
      const p = Promise.resolve(result);
      const h = { get(_, k) {
        if (k === 'then') return p.then.bind(p);
        if (k === 'catch') return p.catch.bind(p);
        return () => new Proxy({}, h);
      } };
      return new Proxy({}, h);
    }
    sb = {
      rpc: (name, args) => {
        window.__rpc.push({ name, args });
        const r = window.__rpcResults[name];
        return __chain(typeof r === 'function' ? r(args) : (r || { data: null, error: null }));
      },
      from: () => __chain({ data: [], error: null }),
      auth: { getSession: async () => ({ data: { session: null } }) },
      channel: () => ({ on() { return this; }, subscribe() { return this; } }),
      removeChannel() {}
    };
  `);
  return app;
}

const SCHOOL_ROWS = `[
  { slug: 'baylor', display_name: 'Baylor University', color: '#154734', default_city: 'waco', pending: false },
  { slug: 'rice-university', display_name: 'Rice University', color: '#E8502A', default_city: null, pending: true },
  { slug: 'ttu', display_name: 'Texas Tech University', color: '#CC0000', default_city: 'lubbock', pending: false }
]`;

function seedMe(win, extra = '') {
  win.eval(`
    profile = { id: 'me', name: 'ez', color: '#E8502A', school: null, home_city: null };
    roster = [{ id: 'me', name: 'ez', color: '#E8502A', status: 'off', school: null, updated_at: new Date().toISOString() }];
    friends = [];
    SCHOOLS = ${SCHOOL_ROWS};
    localStorage.removeItem('pm_school_prompted');
    ${extra}
  `);
}

const rpcCalls = (win, name) => win.__rpc.filter(c => c.name === name);
const plain = o => JSON.parse(JSON.stringify(o));

/* ── data layer ── */

test('loadSchools requests pending and keeps approved rows in the picker, own pending row resolvable by name', async (t) => {
  const { win } = await loadSettled(t);
  win.eval(`
    window.__select = null;
    sb.from = (tbl) => ({ select: (cols) => { window.__select = tbl + ':' + cols; return { order: () => Promise.resolve({ data: ${SCHOOL_ROWS}, error: null }) }; } });
    SCHOOLS = [];
  `);
  await win.eval(`loadSchools()`);
  assert.match(win.__select, /^schools:.*\bpending\b/, 'select must include pending');
  assert.deepEqual(plain(win.eval(`schoolList().map(s => s.slug)`)), ['baylor', 'ttu'], 'picker lists approved only');
  assert.equal(win.eval(`schoolName('rice-university')`), 'Rice University', 'own pending school resolves');
  assert.equal(win.eval(`schoolPending('rice-university')`), true);
  assert.equal(win.eval(`schoolPending('ttu')`), false);
  assert.equal(win.eval(`schoolName('some-other-pending')`), 'some-other-pending', 'unknown slug falls back to the slug string');
});

/* ── chooser UI ── */

test('"other school…" reveal ends with a "type it" row that expands into an input', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `window.__next = 0;`);
  win.eval(`showSetupSchool(() => { window.__next++; })`);
  const page = win.document.getElementById('s-school-page');
  const list = page.querySelector('#s-school-list');
  assert.ok(list, 'school list');
  assert.equal(list.style.display, 'none', 'hidden until "other school…"');
  page.querySelector('#s-school-other').click();
  assert.notEqual(list.style.display, 'none');
  const opts = [...list.querySelectorAll('.school-opt[data-slug]')].map(b => b.dataset.slug);
  assert.deepEqual(opts, ['baylor'], 'seeded non-primary schools listed, pending ones never offered');
  const row = list.lastElementChild;
  assert.ok(row && row.classList.contains('school-suggest-row'), 'type-your-own row is the last thing in the list');
  const typeBtn = row.querySelector('#s-school-type');
  assert.ok(typeBtn && typeBtn.classList.contains('school-type-your-own'));
  assert.match(typeBtn.textContent, /type it/i);
  const wrap = row.querySelector('#s-school-input-wrap');
  assert.equal(wrap.style.display, 'none', 'input hidden until tapped');
  typeBtn.click();
  assert.notEqual(wrap.style.display, 'none', 'input revealed');
  const input = wrap.querySelector('#s-school-input');
  assert.ok(input && input.getAttribute('maxlength') === '80');
  assert.ok(wrap.querySelector('#s-school-submit'), 'submit button');
  assert.ok(wrap.querySelector('.school-suggest-hint'), 'hint copy');
  assert.ok(wrap.querySelector('.school-suggest-error'), 'inline error slot');
});

test('client-side length validation shows an inline error and never calls the rpc', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win);
  win.eval(`showSetupSchool(() => {})`);
  const page = win.document.getElementById('s-school-page');
  page.querySelector('#s-school-other').click();
  page.querySelector('#s-school-type').click();
  const input = page.querySelector('#s-school-input');
  const err = page.querySelector('.school-suggest-error');
  input.value = ' x ';
  page.querySelector('#s-school-submit').click();
  await tick();
  assert.equal(rpcCalls(win, 'suggest_school').length, 0);
  assert.match(err.textContent, /2/, 'says at least 2 characters');
  input.value = 'a'.repeat(81);
  page.querySelector('#s-school-submit').click();
  await tick();
  assert.equal(rpcCalls(win, 'suggest_school').length, 0);
  assert.match(err.textContent, /80/);
});

test('onboarding: submitting a school calls suggest_school, groups me under it (pending) and continues', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `window.__next = 0; SCHOOLS = SCHOOLS.filter(s => !s.pending);`);
  win.__rpcResults.suggest_school = { data: 'rice-university', error: null };
  win.eval(`showSetupSchool(() => { window.__next++; })`);
  const page = win.document.getElementById('s-school-page');
  page.querySelector('#s-school-other').click();
  page.querySelector('#s-school-type').click();
  page.querySelector('#s-school-input').value = '  Rice University ';
  const submit = page.querySelector('#s-school-submit');
  submit.click();
  assert.equal(submit.disabled, true, 'disabled while in flight');
  await tick();
  const calls = rpcCalls(win, 'suggest_school');
  assert.equal(calls.length, 1);
  assert.deepEqual(plain(calls[0].args), { p_name: 'Rice University' }, 'trimmed name sent');
  assert.equal(win.eval(`profile.school`), 'rice-university');
  assert.equal(win.eval(`schoolName('rice-university')`), 'Rice University', 'injected locally so the me-panel can label it');
  assert.equal(win.eval(`schoolPending('rice-university')`), true);
  assert.equal(win.eval(`roster.find(r => r.id === 'me').school`), 'rice-university');
  assert.match(win.document.getElementById('toast').textContent, /Rice University/);
  assert.match(win.document.getElementById('toast').textContent, /pending/i);
  assert.equal(win.__next, 1, 'onboarding continues');
  assert.equal(win.eval(`localStorage.getItem('pm_school_prompted')`), '1');
  assert.equal(rpcCalls(win, 'set_school').length, 0, 'suggest_school assigns server-side; no extra set_school');
});

test('change-school sheet: Enter submits, sheet closes and roster reloads on success', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `window.__roster = 0; loadRoster = async () => { window.__roster++; };`);
  win.__rpcResults.suggest_school = { data: 'rice-university', error: null };
  win.eval(`openSchoolSheet()`);
  const sheet = win.document.getElementById('sheet-school');
  assert.ok(sheet.classList.contains('open'));
  sheet.querySelector('#s-school-other').click();
  sheet.querySelector('#s-school-type').click();
  const input = sheet.querySelector('#s-school-input');
  input.value = 'Rice University';
  input.dispatchEvent(new win.KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
  await tick();
  assert.equal(rpcCalls(win, 'suggest_school').length, 1, 'Enter submits');
  assert.ok(!sheet.classList.contains('open'), 'sheet closes');
  assert.equal(win.__roster, 1, 'roster reloaded');
  assert.equal(win.eval(`profile.school`), 'rice-university');
});

test('server error is shown inline (not thrown), the sheet stays open and submit is retryable', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win);
  win.__rpcResults.suggest_school = { data: null, error: { message: 'rate limit exceeded — try again tomorrow' } };
  win.eval(`openSchoolSheet()`);
  const sheet = win.document.getElementById('sheet-school');
  sheet.querySelector('#s-school-other').click();
  sheet.querySelector('#s-school-type').click();
  sheet.querySelector('#s-school-input').value = 'Rice University';
  const submit = sheet.querySelector('#s-school-submit');
  submit.click();
  await tick();
  assert.equal(rpcCalls(win, 'suggest_school').length, 1);
  assert.match(sheet.querySelector('.school-suggest-error').textContent, /rate limit/);
  assert.ok(sheet.classList.contains('open'), 'stays open');
  assert.equal(submit.disabled, false, 'retry possible');
  assert.equal(win.eval(`profile.school`), null, 'school unchanged');
  assert.equal(win.eval(`SCHOOLS.some(s => s.slug === 'rice-university')`), true, 'seed row already present, untouched');

  win.__rpcResults.suggest_school = () => { throw new Error('boom'); };
  submit.click();
  await tick();
  assert.match(sheet.querySelector('.school-suggest-error').textContent, /boom/, 'thrown errors are caught and shown');
  assert.equal(submit.disabled, false);
});

test('inline error text is escaped', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win);
  win.__rpcResults.suggest_school = { data: null, error: { message: '<img src=x onerror="window.__pwned=1">' } };
  win.eval(`openSchoolSheet()`);
  const sheet = win.document.getElementById('sheet-school');
  sheet.querySelector('#s-school-other').click();
  sheet.querySelector('#s-school-type').click();
  sheet.querySelector('#s-school-input').value = 'Rice University';
  sheet.querySelector('#s-school-submit').click();
  await tick();
  assert.equal(sheet.querySelector('.school-suggest-error img'), null);
  assert.equal(win.__pwned, undefined);
});

/* ── me panel badge ── */

test('settings menu labels a pending school with a dim "pending" badge; approved schools have none', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `profile.school = 'rice-university'; renderMe();`);
  let item = win.document.getElementById('sr-school');
  assert.ok(item, 'settings menu school entry');
  assert.match(item.textContent, /Rice University/);
  const badge = item.querySelector('.school-pending-badge');
  assert.ok(badge, 'pending badge element');
  assert.match(badge.textContent, /pending/i);

  win.eval(`profile.school = 'ttu'; renderMe();`);
  item = win.document.getElementById('sr-school');
  assert.match(item.textContent, /Texas Tech/);
  assert.equal(item.querySelector('.school-pending-badge'), null, 'no badge for approved schools');
});

test('roster scope pill shows the pending school name (not the raw slug)', async (t) => {
  const { win } = await loadSettled(t);
  seedMe(win, `profile.school = 'rice-university'; browseAllSchools = false; renderSchoolScope();`);
  const btn = win.document.getElementById('school-scope');
  assert.ok(btn);
  assert.match(btn.textContent, /Rice University/);
});
