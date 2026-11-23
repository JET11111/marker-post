// Stand-ins for the browser pieces the data-*.test.mjs files need: a network
// that answers when the test says so, the service worker's caches, the
// phone's IndexedDB. Not a test file itself.

import nodeTest from 'node:test';

/**
 * A test that fails after ten seconds instead of hanging. These tests deal in
 * requests that never answer, so a mistake in the code under test would
 * otherwise leave the whole run waiting for ever.
 */
export const test = (name, fn) => nodeTest(name, { timeout: 10000 }, fn);

/** A promise settled from outside. */
export function deferred() {
  let resolve, reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

/** Let everything already queued run (timers are faked in these tests; setImmediate is not). */
export async function flush(rounds = 8) {
  for (let i = 0; i < rounds; i++) await new Promise((resolve) => setImmediate(resolve));
}

export const jsonResponse = (data, { status = 200, headers = {} } = {}) =>
  new Response(typeof data === 'string' ? data : JSON.stringify(data), { status, headers });

/**
 * A fetch() whose answers the test controls.
 *   net.answer(url, data, options)   answer at once with JSON
 *   net.fail(url)                    fail at once, as when offline
 *   net.stall(url)                   leave the request hanging; returns { release(data, options), drop() }
 *   net.trickle(url, options)        answer at once, with a body that arrives when the test says;
 *                                    returns { push(text), end() }
 * An address with no route fails at once. Every call is recorded in net.calls.
 * As in a browser, a request that is given up (its signal) fails, and so does
 * a body that was still arriving.
 */
export function fakeNetwork() {
  const routes = new Map();
  const calls = [];
  const fetch = (url, init = {}) => {
    const key = String(url);
    const call = { url: key, init, aborted: false };
    calls.push(call);
    const route = routes.get(key);
    if (!route) return Promise.reject(new TypeError(`Failed to fetch ${key}`));
    return new Promise((resolve, reject) => {
      const aborted = () => { call.aborted = true; reject(new DOMException('The operation was aborted.', 'AbortError')); };
      if (init.signal?.aborted) { aborted(); return; }
      init.signal?.addEventListener('abort', aborted);
      Promise.resolve().then(() => route(init)).then(resolve, reject);
    });
  };
  return {
    fetch, calls, routes,
    count: (url) => calls.filter((c) => c.url === url).length,
    answer(url, data, options) { routes.set(url, () => jsonResponse(data, options)); },
    fail(url) { routes.set(url, () => { throw new TypeError('Failed to fetch'); }); },
    stall(url) {
      const gate = deferred();
      routes.set(url, () => gate.promise);
      return {
        release: (data, options) => gate.resolve(jsonResponse(data, options)),
        drop: () => gate.reject(new TypeError('Failed to fetch')),
      };
    },
    trickle(url, options = {}) {
      let body = null; // the body of the request now being answered
      routes.set(url, (init) => new Response(new ReadableStream({
        start(controller) {
          body = controller;
          init.signal?.addEventListener('abort', () => {
            try { controller.error(new DOMException('The operation was aborted.', 'AbortError')); } catch { /* it had finished */ }
          });
        },
      }), { status: 200, ...options }));
      return {
        push: (text) => body.enqueue(new TextEncoder().encode(text)),
        end: () => body.close(),
      };
    },
  };
}

/**
 * The Cache Storage the service worker fills, as the page sees it.
 * initial: { cacheName: { url: data } } in the order the caches were made.
 * A string is stored as it is (for a copy that is not JSON).
 */
export function fakeCaches(initial = {}) {
  const store = new Map(Object.entries(initial).map(([name, entries]) => [name, new Map(Object.entries(entries))]));
  const reads = [];
  return {
    store, reads,
    async keys() { return [...store.keys()]; },
    async match(url, { cacheName } = {}) {
      reads.push({ url: String(url), cacheName });
      for (const name of cacheName ? [cacheName] : [...store.keys()]) {
        const body = store.get(name)?.get(String(url));
        if (body !== undefined) return jsonResponse(body);
      }
      return undefined;
    },
  };
}

/** Just enough IndexedDB for data.js: one database, object stores, get and put. */
export function fakeIndexedDB() {
  const stores = new Map();
  const db = {
    createObjectStore(name) { stores.set(name, new Map()); },
    transaction(name) {
      const tx = {
        objectStore: () => ({
          get(key) {
            const req = {};
            queueMicrotask(() => { req.result = stores.get(name).get(key); req.onsuccess?.(); });
            return req;
          },
          put(value, key) {
            stores.get(name).set(key, value);
            queueMicrotask(() => tx.oncomplete?.());
            return {};
          },
        }),
      };
      return tx;
    },
  };
  return {
    stores,
    saved: (key) => stores.get('files')?.get(key),
    open() {
      const req = { result: db };
      queueMicrotask(() => { if (!stores.size) req.onupgradeneeded?.(); req.onsuccess?.(); });
      return req;
    },
  };
}

/** Collects promise rejections nobody handled, so a test can insist there were none. */
export function watchUnhandled() {
  const seen = [];
  process.on('unhandledRejection', (reason) => seen.push(reason));
  return seen;
}
