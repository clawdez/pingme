'use strict';
const fs = require('node:fs');
const path = require('node:path');
const { JSDOM } = require('jsdom');

const ROOT = path.join(__dirname, '..');

// Loads index.html into jsdom and injects app.js as a real <script> element.
// Running it as a classic script (not eval) puts its top-level let/const
// bindings in the global lexical environment, so tests can read and write them
// (roster, profile, VENUES, ...) through later `win.eval(...)` calls.
// External scripts (supabase CDN etc.) are not fetched — app.js guards for that.
// Pass the node:test context `t` so the window (and app.js's setInterval
// timers, which otherwise keep the process alive) is torn down after the test.
function loadApp(t) {
  const html = fs.readFileSync(path.join(ROOT, 'index.html'), 'utf8');
  const dom = new JSDOM(html, {
    url: 'http://localhost/',
    runScripts: 'dangerously',
    pretendToBeVisual: true,
  });
  const win = dom.window;
  // minimal shims app.js touches at load time
  win.navigator.vibrate = () => {};
  const appSrc = fs.readFileSync(path.join(ROOT, 'app.js'), 'utf8');
  const script = win.document.createElement('script');
  script.textContent = appSrc;
  win.document.body.appendChild(script);
  if (t) t.after(() => win.close());
  return { dom, win };
}

module.exports = { loadApp, ROOT };
