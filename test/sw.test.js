'use strict';
const { test } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const vm = require('node:vm');

// Loads sw.js into a bare service-worker-ish sandbox and returns the
// registered event listeners plus a spy on cache.put.
function loadSw() {
  const listeners = {};
  const putCalls = [];
  const cacheStub = {
    put: (req, res) => {
      putCalls.push({ url: req.url, method: req.method, status: res.status });
      // Real Cache.put rejects for non-GET requests.
      if (req.method !== 'GET') return Promise.reject(new TypeError('Request method is not GET'));
      return Promise.resolve();
    },
    addAll: () => Promise.resolve(),
    match: () => Promise.resolve(undefined),
  };
  const sandbox = {
    self: {
      addEventListener: (type, fn) => { listeners[type] = fn; },
      skipWaiting: () => {},
      registration: { showNotification: () => {} },
      location: { origin: 'http://localhost' },
    },
    caches: {
      open: () => Promise.resolve(cacheStub),
      keys: () => Promise.resolve([]),
      delete: () => Promise.resolve(true),
      match: () => Promise.resolve(undefined),
    },
    fetch: (req) => Promise.resolve(sandbox.__nextResponse),
    clients: { claim: () => {}, matchAll: () => Promise.resolve([]), openWindow: () => Promise.resolve() },
    console,
  };
  sandbox.__nextResponse = { ok: true, status: 200, clone() { return this; } };
  vm.createContext(sandbox);
  const src = fs.readFileSync(path.join(__dirname, '..', 'sw.js'), 'utf8');
  vm.runInContext(src, sandbox);
  return { listeners, putCalls, sandbox };
}

async function dispatchFetch(listeners, request) {
  let responded = null;
  const event = {
    request,
    respondWith: (p) => { responded = Promise.resolve(p); },
    waitUntil: () => {},
  };
  listeners.fetch(event);
  if (responded) await responded;
  // let the fire-and-forget caches.open().then(...) chain settle
  await new Promise(r => setImmediate(r));
  await new Promise(r => setImmediate(r));
  return responded;
}

test('service worker does not try to cache non-GET requests', async () => {
  const { listeners, putCalls } = loadSw();
  await dispatchFetch(listeners, { url: 'http://localhost/api/thing', method: 'POST' });
  const postPuts = putCalls.filter(c => c.method !== 'GET');
  assert.equal(postPuts.length, 0,
    'cache.put must never be called with a non-GET request (it rejects)');
});

test('service worker does not cache error responses', async () => {
  const { listeners, putCalls, sandbox } = loadSw();
  sandbox.__nextResponse = { ok: false, status: 500, clone() { return this; } };
  await dispatchFetch(listeners, { url: 'http://localhost/style.css', method: 'GET' });
  assert.equal(putCalls.length, 0, 'non-OK responses must not be cached');
});

test('service worker still caches successful GET responses', async () => {
  const { listeners, putCalls } = loadSw();
  await dispatchFetch(listeners, { url: 'http://localhost/style.css', method: 'GET' });
  assert.equal(putCalls.length, 1, 'ok GET responses should be cached');
});
