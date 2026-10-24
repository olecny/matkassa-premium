#!/usr/bin/env node
// End-to-end test of Matkassa in headless Chrome at iPhone size (390×844), driven over the Chrome DevTools Protocol.
// No dependencies: Node ≥ 22 (global WebSocket) + Google Chrome.
//
//   node test/e2e.mjs            # all network faked from test/fake/*-FAKE.json (deterministic, offline-safe)
//   node test/e2e.mjs --live     # real Tjek offers (read-only); GitHub sync is still faked
//   CHROME=/path/to/chrome node test/e2e.mjs
//
// Writes test/tmp/e2e-report.md, test/tmp/e2e-report.json and screenshots in test/tmp/shots/ (git-ignored).
// Safety: uses a fresh Chrome profile every run, never real tokens (the "token" is FAKE-TOKEN-NOT-REAL and every
// api.github.com request is intercepted and answered locally), never pushes or deploys anything.
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FAKE = path.join(ROOT, 'test', 'fake');
const OUT = path.join(ROOT, 'test', 'tmp');
const SHOTS = path.join(OUT, 'shots');
const LIVE = process.argv.includes('--live');
const KEEP = process.argv.includes('--keep-open');
const CHROME = process.env.CHROME || '/Applications/Google Chrome.app/Contents/MacOS/Google Chrome';
const UA = 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/18.0 Mobile/15E148 Safari/604.1';
const FAKE_TOKEN = 'FAKE-TOKEN-NOT-REAL';
const FAKE_REPO = 'test-user/matkassa-data-FAKE';

fs.mkdirSync(SHOTS, { recursive: true });
const results = [];
const check = (ok, name, detail = '') => {
  results.push({ ok: !!ok, name, detail: String(detail) });
  console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${detail ? ` — ${detail}` : ''}`);
};
const warn = (name, detail = '') => { results.push({ ok: true, warn: true, name, detail: String(detail) }); console.log(`WARN ${name}${detail ? ` — ${detail}` : ''}`); };
// Checks that depend on the fake offers (test/fake/tjek-FAKE.json) are skipped with a note in --live mode.
const fixtureCheck = (ok, name, detail = '') => (LIVE ? warn(`skipped in --live: ${name}`) : check(ok, name, detail));
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/* ---------- fake network ---------- */
const rel = (s) => {
  const m = /^NOW([+-]\d+)D$/.exec(s || '');
  return m ? new Date(Date.now() + Number(m[1]) * 864e5).toISOString().replace('Z', '+0000') : s;
};
const tjek = JSON.parse(fs.readFileSync(path.join(FAKE, 'tjek-FAKE.json'), 'utf8'));
const fakeFile = (f) => fs.readFileSync(path.join(FAKE, f), 'utf8');
const remaOffers = () => {
  const j = JSON.parse(fakeFile('rema-offers-FAKE.json'));
  for (const o of j.offers) { o.from = rel(o.from).replace('+0000', 'Z'); o.till = rel(o.till).replace('+0000', 'Z'); }
  return JSON.stringify(j);
};
const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg==', 'base64');
const ghRequests = [];
const tjekAreas = []; // r_lat,r_lng of every Tjek catalog request, to see which area the app asked for

function fakeResponse(url, headers, method = 'GET') {
  const u = new URL(url);
  if (u.hostname === 'squid-api.tjek.com' && u.pathname === '/v2/catalogs' && !Number(u.searchParams.get('offset') || 0)) tjekAreas.push(`${u.searchParams.get('r_lat')},${u.searchParams.get('r_lng')}`);
  if (method === 'OPTIONS' && u.hostname === 'api.github.com') return { status: 204, type: 'text/plain', body: '' }; // CORS preflight
  if (u.hostname === 'squid-api.tjek.com' && !LIVE) {
    if (u.pathname === '/v2/catalogs') {
      const page = Number(u.searchParams.get('offset') || 0) ? [] : tjek.catalogs.map((c) => ({ ...c, run_from: rel(c.run_from), run_till: rel(c.run_till) }));
      return { status: 200, type: 'application/json', body: JSON.stringify(page) };
    }
    if (u.pathname === '/v2/offers') {
      const all = (tjek.offers[u.searchParams.get('catalog_id')] || []).map((o) => ({ ...o, run_from: rel(o.run_from), run_till: rel(o.run_till) }));
      const off = Number(u.searchParams.get('offset') || 0);
      return { status: 200, type: 'application/json', body: JSON.stringify(all.slice(off, off + Number(u.searchParams.get('limit') || 100))) };
    }
    return { status: 404, type: 'application/json', body: '[]' };
  }
  if (u.hostname === 'image-transformer-api.tjek.com' && !LIVE) return { status: 200, type: 'image/png', body: PNG };
  if (u.hostname === 'rema.papirfly.no') return { status: 200, type: 'image/png', body: PNG };
  if (u.hostname === 'api.github.com') {
    const auth = headers.Authorization || headers.authorization || '';
    ghRequests.push({ path: u.pathname, auth });
    if (auth !== `Bearer ${FAKE_TOKEN}`) return { status: 401, type: 'application/json', body: '{"message":"Bad credentials (fake)"}' };
    if (u.pathname === `/repos/${FAKE_REPO}/contents/spending.json`) return { status: 200, type: 'application/json', body: fakeFile('spending-FAKE.json') };
    if (u.pathname === `/repos/${FAKE_REPO}/contents/rema-offers.json`) return { status: 200, type: 'application/json', body: remaOffers() };
    return { status: 404, type: 'application/json', body: '{"message":"Not Found (fake)"}' };
  }
  return null; // let it through (app shell from the local server; real Tjek in --live)
}

/* ---------- static server for the app ---------- */
const TYPES = { '.html': 'text/html; charset=utf-8', '.js': 'text/javascript', '.css': 'text/css', '.json': 'application/json', '.webmanifest': 'application/manifest+json', '.svg': 'image/svg+xml', '.png': 'image/png' };
let serverUp = true;
let stallMs = 0; // > 0: every app-shell response is delayed (weak signal in the shop)
const server = http.createServer(async (req, res) => {
  if (!serverUp) { req.socket.destroy(); return; }
  if (stallMs) await sleep(stallMs);
  let p = decodeURIComponent(new URL(req.url, 'http://x').pathname);
  if (p.endsWith('/')) p += 'index.html';
  const f = path.join(ROOT, p);
  // Only serve the app itself: never data/, ingest/, test/ or dotfiles.
  if (!f.startsWith(ROOT + path.sep) || /\/(data|ingest|test|innsyn|screenshots|\.git)(\/|$)|\/\./.test(p) || !fs.existsSync(f) || fs.statSync(f).isDirectory()) {
    res.writeHead(404); res.end('not found'); return;
  }
  res.writeHead(200, { 'Content-Type': TYPES[path.extname(f)] || 'application/octet-stream', 'Cache-Control': 'no-cache' });
  fs.createReadStream(f).pipe(res);
});
await new Promise((r) => server.listen(0, '127.0.0.1', r));
const BASE = `http://127.0.0.1:${server.address().port}/`;

/* ---------- Chrome + CDP ---------- */
const profile = fs.mkdtempSync(path.join(os.tmpdir(), 'matkassa-e2e-'));
const chrome = spawn(CHROME, [
  '--headless=new', '--remote-debugging-port=0', `--user-data-dir=${profile}`, '--no-first-run', '--no-default-browser-check',
  '--hide-scrollbars', '--disable-extensions', '--window-size=390,844', 'about:blank',
], { stdio: ['ignore', 'ignore', 'pipe'] });
const wsUrl = await new Promise((resolve, reject) => {
  let buf = '';
  const t = setTimeout(() => reject(new Error('Chrome did not start (set CHROME=…)')), 20000);
  chrome.stderr.on('data', (d) => {
    buf += d;
    const m = /DevTools listening on (ws:\/\/\S+)/.exec(buf);
    if (m) { clearTimeout(t); resolve(m[1]); }
  });
  chrome.on('error', reject);
});
const ws = new WebSocket(wsUrl);
await new Promise((r, j) => { ws.onopen = r; ws.onerror = j; });
let seq = 0;
const pending = new Map();
const listeners = [];
ws.onmessage = (ev) => {
  const msg = JSON.parse(ev.data);
  if (msg.id && pending.has(msg.id)) {
    const { resolve, reject } = pending.get(msg.id);
    pending.delete(msg.id);
    msg.error ? reject(new Error(`${msg.error.message} ${msg.error.data || ''}`)) : resolve(msg.result);
  } else if (msg.method) for (const l of listeners) l(msg);
};
const send = (method, params = {}, sessionId) => new Promise((resolve, reject) => {
  const id = ++seq;
  pending.set(id, { resolve, reject });
  ws.send(JSON.stringify({ id, method, params, sessionId }));
});

const consoleErrors = [];
const dialogs = [];
const sessions = new Set();
async function setupSession(sessionId, isPage) {
  sessions.add(sessionId);
  await send('Fetch.enable', { patterns: [{ urlPattern: '*', requestStage: 'Request' }] }, sessionId).catch(() => {});
  if (isPage) {
    await send('Page.enable', {}, sessionId);
    await send('Runtime.enable', {}, sessionId);
    await send('Log.enable', {}, sessionId);
    await send('Network.enable', {}, sessionId);
    await send('Network.setUserAgentOverride', { userAgent: UA, platform: 'iPhone' }, sessionId);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, sessionId);
    await send('Emulation.setTouchEmulationEnabled', { enabled: true, maxTouchPoints: 5 }, sessionId);
    // Headless Chrome follows the host's dark mode; start in light so results don't depend on the Mac's settings.
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, sessionId);
  }
  await send('Runtime.runIfWaitingForDebugger', {}, sessionId).catch(() => {});
}
listeners.push(async (msg) => {
  const sid = msg.sessionId;
  if (msg.method === 'Target.attachedToTarget') {
    // Service workers make their own requests; attach so the fake network covers them too.
    await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, msg.params.sessionId).catch(() => {});
    await setupSession(msg.params.sessionId, false);
  }
  if (msg.method === 'Fetch.requestPaused') {
    const { requestId, request } = msg.params;
    const fake = fakeResponse(request.url, request.headers || {}, request.method);
    if (!fake) return send('Fetch.continueRequest', { requestId }, sid).catch(() => {});
    const body = Buffer.isBuffer(fake.body) ? fake.body : Buffer.from(fake.body);
    send('Fetch.fulfillRequest', {
      requestId, responseCode: fake.status,
      responseHeaders: [{ name: 'Content-Type', value: fake.type }, { name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: 'Authorization, Accept, X-GitHub-Api-Version' }, { name: 'Access-Control-Allow-Methods', value: 'GET, OPTIONS' }],
      body: body.toString('base64'),
    }, sid).catch(() => {});
  }
  if (msg.method === 'Runtime.exceptionThrown') consoleErrors.push(msg.params.exceptionDetails.exception?.description || msg.params.exceptionDetails.text);
  if (msg.method === 'Runtime.consoleAPICalled' && msg.params.type === 'error') consoleErrors.push(msg.params.args.map((a) => a.value ?? a.description).join(' '));
  if (msg.method === 'Log.entryAdded' && msg.params.entry.level === 'error' && !/favicon/.test(msg.params.entry.url || '')) consoleErrors.push(`${msg.params.entry.text} ${msg.params.entry.url || ''}`);
  if (msg.method === 'Page.javascriptDialogOpening') {
    dialogs.push(msg.params.message);
    send('Page.handleJavaScriptDialog', { accept: true }, sid).catch(() => {});
  }
});

const { targetId } = await send('Target.createTarget', { url: 'about:blank' });
let { sessionId: S } = await send('Target.attachToTarget', { targetId, flatten: true });
await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, S);
await setupSession(S, true);

const evaluate = async (expr) => {
  const r = await send('Runtime.evaluate', { expression: `(async () => { ${expr} })()`, awaitPromise: true, returnByValue: true }, S);
  if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || r.exceptionDetails.text);
  return r.result.value;
};
const waitFor = async (expr, ms = 15000) => {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    try { if (await evaluate(`return !!(${expr});`)) return true; } catch { /* page navigating */ }
    await sleep(150);
  }
  return false;
};
const navigate = async (url) => {
  const loaded = new Promise((r) => { const l = (m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === S) { listeners.splice(listeners.indexOf(l), 1); r(); } }; listeners.push(l); });
  await send('Page.navigate', { url }, S);
  await Promise.race([loaded, sleep(15000)]);
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, S);
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
};
const tab = (t) => evaluate(`document.querySelector('.tabbar button[data-tab="${t}"]').click(); await new Promise(r => setTimeout(r, 250)); return true;`);
const click = (sel) => evaluate(`const el = document.querySelector(${JSON.stringify(sel)}); if (!el) throw new Error('missing ' + ${JSON.stringify(sel)}); el.click(); await new Promise(r => setTimeout(r, 250)); return true;`);
const toastText = () => evaluate(`const t = document.querySelector('#toast'); return t && !t.hidden ? t.textContent : '';`);
async function importFixture(file) {
  const { root } = await send('DOM.getDocument', { depth: 0 }, S);
  const { nodeId } = await send('DOM.querySelector', { nodeId: root.nodeId, selector: '#file-input' }, S);
  await send('DOM.setFileInputFiles', { nodeId, files: [file] }, S);
  await sleep(700);
  return toastText();
}
const noHScroll = () => evaluate(`return document.scrollingElement.scrollWidth <= innerWidth + 1;`);

async function a11yAudit(where) {
  const r = await evaluate(`
    const vis = (el) => { const b = el.getBoundingClientRect(); const s = getComputedStyle(el); return b.width > 0 && b.height > 0 && s.visibility !== 'hidden' && !el.closest('[hidden]'); };
    const name = (el) => (el.getAttribute('aria-label') || el.textContent || el.title || (el.labels && el.labels[0] && el.labels[0].textContent) || '').trim();
    const out = { unnamedButtons: [], unlabelledInputs: [], imgsNoAlt: 0, smallTargets: [] };
    for (const b of document.querySelectorAll('button, [role=button]')) {
      if (!vis(b)) continue;
      if (!name(b)) out.unnamedButtons.push(b.outerHTML.slice(0, 80));
      const r = b.getBoundingClientRect();
      if ((r.width < 44 || r.height < 44) && !b.classList.contains('chip') && b.tagName !== 'rect') out.smallTargets.push((name(b) || b.className).slice(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
    for (const i of document.querySelectorAll('input:not([type=hidden]):not([type=file]), select, textarea')) {
      if (!vis(i)) continue;
      if (!(i.labels && i.labels.length) && !i.getAttribute('aria-label') && !i.getAttribute('aria-labelledby')) out.unlabelledInputs.push(i.id || i.name || i.outerHTML.slice(0, 60));
    }
    out.imgsNoAlt = [...document.images].filter((i) => !i.hasAttribute('alt')).length;
    out.lang = document.documentElement.lang;
    return out;`);
  check(!r.unnamedButtons.length, `a11y ${where}: every button has a name`, r.unnamedButtons.join(' | '));
  check(!r.unlabelledInputs.length, `a11y ${where}: every input has a label`, r.unlabelledInputs.join(' | '));
  check(r.imgsNoAlt === 0, `a11y ${where}: images have alt`);
  check(r.lang === 'nb' || r.lang === 'no', `a11y ${where}: <html lang> is Norwegian`, r.lang);
  if (r.smallTargets.length) warn(`a11y ${where}: tap targets under 44px`, [...new Set(r.smallTargets)].slice(0, 6).join(' | '));
}

/* ---------- location: isolated browser contexts (fresh storage, own permissions) ---------- */
const ORIGIN = BASE.replace(/\/$/, '');
const APP_DB = 'matkassa';
const readSettings = () => evaluate(`const db = await new Promise((r, j) => { const q = indexedDB.open('${APP_DB}'); q.onsuccess = () => r(q.result); q.onerror = j; }); if (!db.objectStoreNames.contains('kv')) return null; return await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result || null); });`);
// Counts geolocation calls per page load. failFirst: the first call in this tab fails like iOS without a tap
// (TIMEOUT, no prompt shown); later calls go to Chrome, which answers from Emulation.setGeolocationOverride.
const geoSpy = (failFirst) => `(() => {
  window.__geoCalls = 0;
  const g = navigator.geolocation; if (!g) return;
  const orig = g.getCurrentPosition.bind(g);
  g.getCurrentPosition = function (ok, err, opt) {
    window.__geoCalls++;
    ${failFirst ? `if (!sessionStorage.getItem('geoFailedOnce')) { sessionStorage.setItem('geoFailedOnce', '1'); setTimeout(() => err && err({ code: 3, message: 'FAKE timeout: no prompt without a tap' }), 50); return; }` : ''}
    return orig(ok, err, opt);
  };
})();`;
async function inFreshContext(name, fn) {
  const { browserContextId } = await send('Target.createBrowserContext');
  const { targetId: tid } = await send('Target.createTarget', { url: 'about:blank', browserContextId });
  const { sessionId } = await send('Target.attachToTarget', { targetId: tid, flatten: true });
  await send('Target.setAutoAttach', { autoAttach: true, waitForDebuggerOnStart: true, flatten: true }, sessionId);
  await setupSession(sessionId, true);
  const prev = S;
  S = sessionId;
  try {
    await fn(browserContextId);
  } catch (e) {
    check(false, `${name}: crashed`, e.stack || e.message);
  } finally {
    S = prev;
    await send('Target.closeTarget', { targetId: tid }).catch(() => {});
    await send('Browser.resetPermissions', { browserContextId }).catch(() => {});
    await send('Target.disposeBrowserContext', { browserContextId }).catch(() => {});
  }
}
async function waitSettings(pred, ms = 10000) {
  const end = Date.now() + ms;
  let st = null;
  while (Date.now() < end) { st = await readSettings().catch(() => null); if (st && pred(st)) return st; await sleep(200); }
  return st;
}
const lastArea = () => tjekAreas[tjekAreas.length - 1] || '';
const geoCardShown = () => evaluate(`const c = document.querySelector('#geo-card'); return !!c && !c.hidden && c.getBoundingClientRect().height > 0;`);

async function locationTests() {
  // L1. First start, location allowed → offers for the (rounded) position, no card, no second prompt.
  await inFreshContext('location allowed', async (ctx) => {
    await send('Browser.grantPermissions', { permissions: ['geolocation'], origin: ORIGIN, browserContextId: ctx });
    await send('Emulation.setGeolocationOverride', { latitude: 60.391263, longitude: 5.322054, accuracy: 30 }, S); // Bergen (FAKE position)
    await send('Page.addScriptToEvaluateOnNewDocument', { source: geoSpy(false) }, S);
    const n0 = tjekAreas.length;
    await navigate(BASE + 'index.html');
    check(await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 20000), 'location allowed: offers render');
    const st = await waitSettings((v) => v.area);
    check(st && st.area && st.area.name === 'Min posisjon' && st.area.lat === 60.39 && st.area.lng === 5.32 && st.geo === 'done', 'location allowed: area = rounded position (≈1 km), stored once', JSON.stringify(st && st.area));
    await waitFor(`!document.querySelector('#refresh').classList.contains('spinning')`, 15000);
    check(tjekAreas.slice(n0).includes('60.39,5.32'), 'location allowed: Tjek asked for offers around the position', tjekAreas.slice(n0).join(' | '));
    check(!(await geoCardShown()), 'location allowed: no first-run card');
    await waitFor(`!document.querySelector('#refresh').classList.contains('spinning')`, 15000);
    await tab('mer');
    check(await evaluate(`return document.querySelector('#area-select').selectedOptions[0].textContent === 'Min posisjon';`), 'location allowed: Mer → Område shows "Min posisjon"');
    await navigate(BASE + 'index.html');
    await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 15000);
    await sleep(500);
    check(await evaluate(`return window.__geoCalls === 0;`), 'location allowed: not asked again on the next start');
  });

  // L2. First start, location denied → Trondheim, Mer → Område still works, never asked again.
  await inFreshContext('location denied', async (ctx) => {
    await send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied', origin: ORIGIN, browserContextId: ctx });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: geoSpy(false) }, S);
    const n0 = tjekAreas.length;
    await navigate(BASE + 'index.html');
    check(await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 20000), 'location denied: offers render (fallback)');
    check(await waitFor(`/Trondheim/.test(document.querySelector('#toast').textContent)`, 5000), 'location denied: toast says Trondheim + Mer → Område', await toastText());
    const st = await readSettings();
    check(st && st.area === null && st.geo === 'done', 'location denied: no area stored, flow marked done', JSON.stringify(st && { area: st.area, geo: st.geo }));
    check(tjekAreas.slice(n0).every((a) => a === '63.4305,10.3951'), 'location denied: offers for Trondheim', tjekAreas.slice(n0).join(' | '));
    check(!(await geoCardShown()), 'location denied: no card');
    await shot('00b-location-denied');
    await navigate(BASE + 'index.html');
    await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 15000);
    await sleep(500);
    check(await evaluate(`return window.__geoCalls === 0 && !document.querySelector('#toast').textContent.includes('posisjon');`), 'location denied: no prompt or toast on the next start');
    await tab('mer');
    await evaluate(`const s = document.querySelector('#area-select'); s.value = 'Oslo'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    const picked = await waitFor(`/Område: Oslo/.test(document.querySelector('#toast').textContent)`, 5000);
    await sleep(1500);
    check(picked && lastArea() === '59.9139,10.7522', 'location denied: Mer → Område picker still works', lastArea());
  });

  // L3. iOS-like: the automatic request gets no answer without a tap → clear card; the tap then works.
  await inFreshContext('location needs a tap', async (ctx) => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: geoSpy(true) }, S);
    await navigate(BASE + 'index.html');
    check(await waitFor(`!document.querySelector('#geo-card').hidden`, 8000), 'location needs a tap: first-run card "Finn tilbud nær deg" shown');
    check(await evaluate(`return /Finn tilbud nær deg/.test(document.querySelector('#geo-card').textContent) && !!document.querySelector('#geo-card [data-action="geo-ask"]');`), 'location needs a tap: card has a "Finn tilbud nær deg" button');
    check(await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 20000) && lastArea() === '63.4305,10.3951', 'location needs a tap: Trondheim offers meanwhile', lastArea());
    check(await noHScroll(), 'location needs a tap: no horizontal scroll with the card');
    await a11yAudit('first-run card');
    await shot('00a-location-card');
    await navigate(BASE + 'index.html'); // reopen before tapping: card again, but no new prompt
    await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 15000);
    await sleep(500);
    check(await evaluate(`return window.__geoCalls === 0 && !document.querySelector('#geo-card').hidden;`), 'location needs a tap: reopening shows the card without prompting again');
    await send('Browser.grantPermissions', { permissions: ['geolocation'], origin: ORIGIN, browserContextId: ctx });
    await send('Emulation.setGeolocationOverride', { latitude: 59.913868, longitude: 10.752245, accuracy: 30 }, S); // Oslo (FAKE position)
    await click('#geo-card [data-action="geo-ask"]');
    const st = await waitSettings((v) => v.area);
    check(st && st.area && st.area.lat === 59.91 && st.area.lng === 10.75 && st.geo === 'done', 'location needs a tap: tap → area from position', JSON.stringify(st && st.area));
    check(await waitFor(`document.querySelector('#geo-card').hidden`, 3000), 'location needs a tap: card gone after the tap');
    await sleep(1500);
    check(lastArea() === '59.91,10.75', 'location needs a tap: offers reloaded for the position', lastArea());
  });

  // L4. Existing user with an area already chosen: nothing changes, no prompt.
  await inFreshContext('existing user', async () => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: geoSpy(false) }, S);
    await navigate(BASE + 'manifest.webmanifest'); // same origin, app not running: seed storage like an older version left it
    await evaluate(`const db = await new Promise((r, j) => { const q = indexedDB.open('${APP_DB}', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => r(q.result); q.onerror = j; });
      await new Promise((r) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put({ chains: [], hiddenChains: [], area: { name: 'Bergen', lat: 60.3913, lng: 5.3221, radius: 30000 }, sync: { repo: '', path: 'spending.json', token: '' } }, 'settings'); t.oncomplete = r; });
      db.close(); return true;`);
    const n0 = tjekAreas.length;
    await navigate(BASE + 'index.html');
    check(await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 20000), 'existing user: offers render');
    await sleep(500);
    const st = await readSettings();
    check(await evaluate(`return window.__geoCalls === 0;`) && !(await geoCardShown()), 'existing user with an area: no prompt, no card');
    check(st.area.name === 'Bergen' && tjekAreas.slice(n0).every((a) => a === '60.3913,5.3221'), 'existing user: keeps the chosen area', tjekAreas.slice(n0).join(' | '));
  });
}

/* ---------- the tests ---------- */
try {
  await locationTests();
  // The main run below starts as a user who said no to location (Trondheim), so it doesn't depend on Chrome's prompt.
  await send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied', origin: ORIGIN });

  // 1. First start: offers, empty states
  await navigate(BASE + 'index.html');
  check(await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 20000), 'offers load and render', LIVE ? 'live Tjek' : 'fake Tjek');
  const status = await evaluate(`return document.querySelector('#status').textContent;`);
  check(/tilbud fra \d+ kjeder/.test(status), 'status line shows offer + chain count', status);
  check(await evaluate(`return document.querySelector('#for-deg').hidden;`), 'no receipts → no "Tilbud for deg" strip (nothing learned yet)');
  check(await evaluate(`return document.querySelector('#offer-sort').value === 'fordeg';`), 'default sort is "For deg"');
  fixtureCheck(await evaluate(`return !document.querySelector('#offer-more').hidden;`), 'paging: "Vis flere" shown for > 60 offers', '');
  check(await noHScroll(), 'tilbud: no horizontal scroll at 390px');
  await shot('01-tilbud-tom-profil');
  await a11yAudit('tilbud');

  await tab('forbruk');
  check(await evaluate(`return /Ingen kvitteringer/.test(document.querySelector('#spend-body').textContent);`), 'forbruk: empty state');
  await tab('mer');
  check(await evaluate(`return document.querySelector('#sync-repo').value === '';`), 'mer: sync repo is empty by default (no personal default)');
  await a11yAudit('mer');
  await shot('02-mer-tom');

  // 2. Bad imports
  await tab('forbruk');
  check(/ikke gyldig JSON/.test(await importFixture(path.join(FAKE, 'not-json-FAKE.json'))), 'bad import: not JSON → clear message');
  check(/Fant ingen kvitteringer/.test(await importFixture(path.join(FAKE, 'junk-FAKE.json'))), 'bad import: unknown JSON → clear message');
  check(/Trumf: 1 nye/.test(await importFixture(path.join(FAKE, 'trumf-FAKE.json'))), 'import: Trumf innsyn (fake)');

  // 3. Sync from a (fake) private repo with a (fake) token
  await tab('mer');
  await evaluate(`document.querySelector('#sync-repo').value = 'not a repo'; document.querySelector('#sync-token').value = '${FAKE_TOKEN}'; document.querySelector('#sync-form').requestSubmit(); await new Promise(r => setTimeout(r, 300)); return true;`);
  check(/brukernavn\/repo/.test(await toastText()), 'sync: invalid repo name rejected');
  await evaluate(`document.querySelector('#sync-repo').value = 'https://github.com/${FAKE_REPO}.git'; document.querySelector('#sync-token').value = '${FAKE_TOKEN}'; document.querySelector('#sync-form').requestSubmit(); return true;`);
  check(await waitFor(`/Synk: 12 nye/.test(document.querySelector('#toast').textContent)`), 'sync: 12 fake receipts fetched from the fake repo (URL form accepted)');
  check(ghRequests.some((r) => r.path.endsWith('/rema-offers.json')), 'sync: also fetches rema-offers.json (barcode offers)');
  check(ghRequests.every((r) => r.auth === `Bearer ${FAKE_TOKEN}`), 'sync: only the fake token was ever sent');
  await sleep(300);
  const coverage = await evaluate(`return [...document.querySelectorAll('#more-body dt')].find(d => d.textContent === 'Med strekkode')?.nextElementSibling.textContent || '';`);
  fixtureCheck(/^2 av \d+/.test(coverage), 'mer: shows share of offers with barcode', coverage);
  await shot('03-mer-synk');

  // 4. Backup never contains the token
  const backup = await evaluate(`
    let blob; const orig = URL.createObjectURL; URL.createObjectURL = (b) => { blob = b; return orig(b); };
    const canShare = navigator.canShare; navigator.canShare = undefined; // force the download path so the blob can be read
    document.querySelector('[data-action="export"]').click();
    URL.createObjectURL = orig; navigator.canShare = canShare;
    return blob ? await blob.text() : '';`);
  check(backup.length > 100 && !backup.includes(FAKE_TOKEN) && backup.includes(FAKE_REPO), 'backup: exported without the GitHub token');

  // 4b. Restoring a hostile/edited backup can't move this device's sync to another repo or break the area
  const hostile = JSON.parse(backup);
  hostile.settings = { ...hostile.settings, chains: null, hiddenChains: 'abc', area: { name: 'Uten koordinater (FAKE)' }, sync: { repo: 'evil/other-repo-FAKE', token: 'FAKE-OTHER-TOKEN', path: '../x' } };
  const hostileFile = path.join(OUT, 'backup-hostile-FAKE.json');
  fs.writeFileSync(hostileFile, JSON.stringify(hostile));
  await importFixture(hostileFile);
  const st = await evaluate(`const db = await new Promise(r => { const q = indexedDB.open('${APP_DB}'); q.onsuccess = () => r(q.result); }); return await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); });`);
  check(st.sync.repo === FAKE_REPO && st.sync.token === FAKE_TOKEN && st.sync.path === 'spending.json', 'restore: backup cannot change this device\'s sync repo/token/path');
  check(st.area === null && Array.isArray(st.chains) && Array.isArray(st.hiddenChains), 'restore: broken area/chains in a backup are sanitised');

  // 5. Learning: "Tilbud for deg", EAN vs name
  await tab('tilbud');
  check(await waitFor(`!document.querySelector('#for-deg').hidden`), '"Tilbud for deg" appears after receipts are synced');
  const strip = await evaluate(`return [...document.querySelectorAll('#for-deg-list li')].map(li => li.querySelector('.ft').textContent + (li.querySelector('.via') ? ' [EAN]' : ''));`);
  fixtureCheck(strip.some((s) => /Kjeldsberg/i.test(s) && /\[EAN\]/.test(s)), 'EAN match: coffee matched by barcode, shown as "strekkode"', strip.join(' | '));
  fixtureCheck(strip.some((s) => /Helmelk/i.test(s) && !/\[EAN\]/.test(s)), 'name match fallback: milk matched by name (Tjek has no EAN)');
  check(!strip.some((s) => /nudler/i.test(s)), '"Egg" does not pull in "Egg nudler"');
  fixtureCheck(await evaluate(`return /strekkode/.test(document.querySelector('#offer-list').textContent);`), 'offer list card shows the match kind');
  await shot('04-tilbud-for-deg');

  // 6. Hide a chain
  await tab('mer');
  await evaluate(`const cb = document.querySelector('[data-chainshow="257bxm"]'); cb.click(); return true;`);
  await tab('tilbud');
  const chips = await evaluate(`return [...document.querySelectorAll('#chain-chips .chip')].map(c => c.textContent.trim());`);
  fixtureCheck(!chips.includes('KIWI') && !(await evaluate(`return /KIWI/.test(document.querySelector('#offer-list').textContent);`)), 'hidden chain gone from chips and offers', chips.join(','));
  await tab('mer');
  await evaluate(`document.querySelector('[data-chainshow="257bxm"]').click(); return true;`);

  // 7. Shopping list: name match + barcode remembered from an offer
  await tab('liste');
  await evaluate(`const i = document.querySelector('#list-input'); i.value = 'helmelk'; document.querySelector('#list-form').requestSubmit(); await new Promise(r => setTimeout(r, 200)); return true;`);
  fixtureCheck(await evaluate(`return /På tilbud hos/.test(document.querySelector('#list-items').textContent);`), 'list: "helmelk" finds an offer by name');
  await tab('tilbud');
  await evaluate(`const li = [...document.querySelectorAll('#offer-list .offer')].find(li => /KJELDSBERG/i.test(li.textContent)) || document.querySelector('#offer-list .offer'); li.querySelector('[data-add]').click(); return true;`);
  const item = await evaluate(`const db = await new Promise(r => { const q = indexedDB.open('${APP_DB}'); q.onsuccess = () => r(q.result); }); return await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('list'); q.onsuccess = () => r(q.result.find(i => /Kjeldsberg/i.test(i.text))); });`);
  fixtureCheck(item && item.eans && item.eans.includes('2000000000015'), 'list: item added from an offer remembers its barcode');

  // 7b. Hiding the chain of an offer-linked list item hides its "Tilbud hos …" too (Maria finding 4)
  const linkedChain = item && item.offer ? item.offer.chainId : null;
  const linkedName = item && item.offer ? item.offer.chain : '';
  await tab('mer');
  await evaluate(`document.querySelector('[data-chainshow="${linkedChain}"]').click(); return true;`);
  await tab('liste');
  const linkedText = await evaluate(`return [...document.querySelectorAll('#list-items .item')].find(li => li.textContent.includes(${JSON.stringify((item && item.text) || '')}))?.textContent || '';`);
  check(linkedChain && linkedText && !linkedText.includes(`hos ${linkedName}`), 'list: offer-linked item stops showing a hidden chain', linkedText.replace(/\s+/g, ' ').trim().slice(0, 80));
  await tab('mer');
  await evaluate(`document.querySelector('[data-chainshow="${linkedChain}"]').click(); return true;`);

  // 7c. All chains hidden → helpful empty state with a way back (Maria finding 3)
  await evaluate(`for (const cb of document.querySelectorAll('[data-chainshow]')) if (cb.checked) cb.click(); return true;`);
  await tab('tilbud');
  const emptyText = await evaluate(`return document.querySelector('#offer-empty').hidden ? '' : document.querySelector('#offer-empty').textContent;`);
  check(/Alle kjeder er skjult/.test(emptyText) && /Mer → Kjeder/.test(emptyText), 'all chains hidden: empty state says so and points to Mer → Kjeder');
  await click('#offer-empty [data-gototab="mer"]');
  check(await evaluate(`return !document.querySelector('#view-mer').hidden;`), 'all chains hidden: button opens Mer');
  await evaluate(`for (const cb of document.querySelectorAll('[data-chainshow]')) if (!cb.checked) cb.click(); return true;`);
  await tab('liste');
  check(await noHScroll(), 'liste: no horizontal scroll');
  await a11yAudit('liste');
  await shot('05-liste');

  // 7d. Narrow phone (iPhone SE 1st gen, 320 px): no sideways scroll on any tab (Maria finding 2)
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true }, S);
  for (const t of ['tilbud', 'liste', 'forbruk', 'mer']) { await tab(t); check(await noHScroll(), `320 px: no horizontal scroll on ${t}`); }
  await tab('tilbud');
  await shot('05b-tilbud-320');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S);

  // 8. Forbruk with data
  await tab('forbruk');
  check(await evaluate(`return document.querySelectorAll('.bars li').length > 0 && /kategorisert/.test(document.querySelector('.hero-sub').textContent);`), 'forbruk: categories and % categorised');
  check(await noHScroll(), 'forbruk: no horizontal scroll');
  await a11yAudit('forbruk');
  await shot('06-forbruk-lys');

  // 9. Dark mode
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, S);
  await sleep(200);
  const bg = await evaluate(`return getComputedStyle(document.body).backgroundColor;`);
  const lum = (bg.match(/\d+/g) || [255, 255, 255]).slice(0, 3).reduce((a, b) => a + Number(b), 0) / 3;
  check(lum < 80, 'dark mode: dark background', bg);
  await shot('07-forbruk-mork');
  await tab('tilbud');
  await shot('08-tilbud-mork');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, S);

  // 10. Huge data: 3 000 receipts × 15 lines
  const big = path.join(OUT, 'huge-FAKE.json');
  const items = ['TINE HELMELK', 'GROVBRØD', 'BANANER', 'KYLLINGFILET', 'PASTA', 'TOMATER', 'OST NORVEGIA', 'SMØR', 'KAFFE', 'EPLER', 'LAKS', 'RIS', 'YOGHURT', 'CHIPS', 'BRUS'];
  fs.writeFileSync(big, JSON.stringify({ schema: 'matkassa.spending/1', _note: 'FAKE TEST DATA (generated)', receipts: Array.from({ length: 3000 }, (_, i) => {
    const lines = items.map((n, k) => ({ name: `${n} ${k}`, ean: String(2100000000000 + k * 7 + (i % 50)), amount: 10 + k }));
    return { id: `huge-${i}`, source: 'import', store: 'TESTBUTIKK (FAKE)', date: new Date(Date.now() - (i % 700) * 864e5).toISOString().slice(0, 10), total: lines.reduce((a, l) => a + l.amount, 0), lines };
  }) }));
  await tab('forbruk');
  const t0 = Date.now();
  const msg = await importFixture(big);
  await waitFor(`/3000 nye/.test(document.querySelector('#toast').textContent) || document.querySelectorAll('.receipts li').length`, 20000);
  await tab('tilbud');
  const dt = Date.now() - t0;
  check(dt < 8000, 'huge data: 3 000 receipts import + profile + render', `${dt} ms (${msg})`);
  check(await evaluate(`return document.querySelectorAll('#offer-list li').length > 0;`), 'huge data: app still renders offers');

  // 11. Offline: service worker serves the app shell, data stays
  check(await waitFor(`navigator.serviceWorker && navigator.serviceWorker.controller`, 15000) || (await navigate(BASE + 'index.html'), await waitFor(`navigator.serviceWorker.controller`, 15000)), 'service worker controls the page');
  // 11a. Weak signal: the server answers nothing for 8 s. The app must open from cache in ~3 s, not 3 s per
  // waterfall level (index.html → app.js → module imports) (Maria finding 1).
  await navigate(BASE + 'index.html');
  await waitFor(`document.querySelectorAll('#offer-list li').length > 0`);
  stallMs = 8000;
  const s0 = Date.now();
  await send('Page.navigate', { url: BASE + 'index.html' }, S);
  await sleep(300);
  const shown = await waitFor(`document.readyState !== 'loading' && document.querySelectorAll('#offer-list li').length > 0`, 12000);
  const stallTime = Date.now() - s0;
  check(shown && stallTime < 3700, 'stalled network: offers visible in under ~3.5 s', `${stallTime} ms`);
  stallMs = 0;
  await sleep(500);

  serverUp = false;
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
  await navigate(BASE + 'index.html');
  check(await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 15000), 'offline: app shell from cache, offers from IndexedDB');
  await tab('liste');
  check(await evaluate(`return /helmelk/i.test(document.querySelector('#list-items').textContent);`), 'offline: shopping list still there');
  await shot('09-offline-liste');
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
  serverUp = true;

  // 12. No console errors (offline fetch failures and favicon are expected noise)
  const errs = consoleErrors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::ERR_|Tjek-feil|status of 40[14]/.test(e));
  check(!errs.length, 'no unexpected console errors', errs.slice(0, 5).join(' | '));
  if (dialogs.length) warn('confirm()/alert() dialogs auto-accepted', dialogs.join(' | '));
} catch (e) {
  check(false, 'test run crashed', e.stack || e.message);
} finally {
  const pass = results.filter((r) => r.ok && !r.warn).length;
  const fail = results.filter((r) => !r.ok).length;
  const md = [
    `# Matkassa e2e report`, '', `${new Date().toISOString()} · ${LIVE ? 'live Tjek' : 'fake network'} · 390×844 · **${fail ? 'FAIL' : 'PASS'}** (${pass} passed, ${fail} failed, ${results.filter((r) => r.warn).length} warnings)`, '',
    '| | Check | Detail |', '|---|---|---|',
    ...results.map((r) => `| ${r.warn ? 'WARN' : r.ok ? 'PASS' : 'FAIL'} | ${r.name} | ${r.detail.replace(/\|/g, '\\|').slice(0, 300)} |`),
    '', `Screenshots: test/tmp/shots/`, 'All data used is FAKE test data from test/fake/.',
  ].join('\n');
  fs.writeFileSync(path.join(OUT, 'e2e-report.md'), md);
  fs.writeFileSync(path.join(OUT, 'e2e-report.json'), JSON.stringify(results, null, 2));
  console.log(`\n${fail ? 'FAIL' : 'PASS'}: ${pass} passed, ${fail} failed → test/tmp/e2e-report.md`);
  if (!KEEP) {
    try { ws.close(); } catch {}
    chrome.kill();
    server.close();
    await sleep(300);
    fs.rmSync(profile, { recursive: true, force: true });
  }
  process.exit(fail ? 1 : 0);
}
