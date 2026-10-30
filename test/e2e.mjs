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
import { makeFakeSupabase, FAKE_SUPABASE_HOST, FAKE_ANON } from './fake-supabase.mjs';

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
const supa = makeFakeSupabase(); // FAKE Supabase (auth + REST), only reachable when cloudOn
let cloudOn = false; // serve a (fake) Supabase config, so the app shows "Logg inn"
const tjekAreas = []; // r_lat,r_lng of every Tjek catalog request, to see which area the app asked for

function fakeResponse(url, headers, method = 'GET', body = '') {
  const u = new URL(url);
  if (u.host === '127.0.0.1:47321') return fakeHelper(u, headers, method);
  if (u.hostname.endsWith('.supabase.co')) return supa.handle(url, method, headers, body) || { status: 404, type: 'application/json', body: '{}' };
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


/* ---------- FAKE Mac helper (ingest/helper.py) on 127.0.0.1:47321: same replies, no real REMA ---------- */
const HELPER_CODE = 'FAKE-PAIR-CODE-0001';
const helperState = { installed: false, rema: { state: 'disconnected', lastSync: null, lastSyncOk: null, message: null }, syncing: false, pollsLeft: 0, requests: [] };
function fakeHelper(u, headers, method) {
  const auth = headers.Authorization || headers.authorization || '';
  helperState.requests.push({ method, path: u.pathname, auth });
  if (!helperState.installed) return { status: 0, abort: true };
  const json = (status, b) => ({ status, type: 'application/json', body: JSON.stringify(b) });
  if (method === 'OPTIONS') return { status: 204, type: 'text/plain', body: '' };
  const norm = (c) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
  if (norm(auth.replace(/^Bearer\s+/i, '')) !== norm(HELPER_CODE)) return json(401, { error: 'unpaired', helper: 'matkassa' });
  const r = helperState.rema;
  if (method === 'POST' && u.pathname === '/rema/login') { r.state = 'connecting'; helperState.pollsLeft = 2; }
  else if (method === 'POST' && u.pathname === '/sync') { helperState.syncing = true; helperState.pollsLeft = 1; }
  else if (method === 'POST' && u.pathname === '/rema/logout') Object.assign(r, { state: 'disconnected', lastSync: null, lastSyncOk: null, message: null });
  else if (method === 'GET' && u.pathname === '/status') {
    // The user "logs in" in REMA's window after a couple of polls; a sync takes one poll.
    if (helperState.pollsLeft > 0 && --helperState.pollsLeft === 0) {
      if (r.state === 'connecting') r.state = 'connected';
      else if (helperState.syncing) { helperState.syncing = false; Object.assign(r, { lastSync: new Date().toISOString(), lastSyncOk: true, message: null }); }
    }
  } else return json(404, { error: 'not found' });
  return json(method === 'GET' ? 200 : 202, { helper: 'matkassa', version: 1, rema: { ...r }, syncing: helperState.syncing });
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
  if (p === '/js/cloud-config.js' && cloudOn) {
    res.writeHead(200, { 'Content-Type': 'text/javascript', 'Cache-Control': 'no-cache' });
    res.end(`export const CLOUD = { url: 'https://${FAKE_SUPABASE_HOST}', anonKey: '${FAKE_ANON}' };`);
    return;
  }
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
// Always remove the temp profile and stop Chrome, also when the run crashes or is interrupted (a full disk once
// came from leftover profiles). --keep-open skips this on purpose.
let cleaned = false;
const cleanupSync = () => {
  if (cleaned || KEEP) return;
  cleaned = true;
  try { chrome.kill('SIGKILL'); } catch {}
  try { fs.rmSync(profile, { recursive: true, force: true, maxRetries: 5, retryDelay: 100 }); } catch {}
};
process.on('exit', cleanupSync);
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { cleanupSync(); process.exit(130); });
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
    const fake = fakeResponse(request.url, request.headers || {}, request.method, request.postData || '');
    if (!fake) return send('Fetch.continueRequest', { requestId }, sid).catch(() => {});
    if (fake.abort) return send('Fetch.failRequest', { requestId, errorReason: 'ConnectionRefused' }, sid).catch(() => {});
    const body = Buffer.isBuffer(fake.body) ? fake.body : Buffer.from(fake.body);
    send('Fetch.fulfillRequest', {
      requestId, responseCode: fake.status,
      responseHeaders: [{ name: 'Content-Type', value: fake.type }, { name: 'Access-Control-Allow-Origin', value: '*' }, { name: 'Access-Control-Allow-Headers', value: 'Authorization, Accept, X-GitHub-Api-Version, apikey, Content-Type, Prefer, Range' }, { name: 'Access-Control-Allow-Methods', value: 'GET, POST, DELETE, OPTIONS' }],
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
  // A URL with #tab on the page already open would only change the fragment; go via about:blank for a real fresh start.
  if (url.includes('#')) { await send('Page.navigate', { url: 'about:blank' }, S); await sleep(150); }
  const loaded = new Promise((r) => { const l = (m) => { if (m.method === 'Page.loadEventFired' && m.sessionId === S) { listeners.splice(listeners.indexOf(l), 1); r(); } }; listeners.push(l); });
  await send('Page.navigate', { url }, S);
  await Promise.race([loaded, sleep(15000)]);
};
const shot = async (name) => {
  const { data } = await send('Page.captureScreenshot', { format: 'png' }, S);
  fs.writeFileSync(path.join(SHOTS, `${name}.png`), Buffer.from(data, 'base64'));
};
const tab = (t) => evaluate(`document.querySelector('.tabbar button[data-tab="${t}"]').click(); await new Promise(r => setTimeout(r, 250)); return true;`);
/** Mer is a settings list now: open one of its subpages (Område, Kjeder, Konto, Avansert …). */
const merPage = async (p) => { await tab('mer'); return evaluate(`document.querySelector('[data-morepage="${p}"]').click(); await new Promise(r => setTimeout(r, 120)); return true;`); };
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
      if ((r.width < 44 || r.height < 44) && !b.classList.contains('chip') && !b.classList.contains('sr-only') && b.tagName !== 'rect') out.smallTargets.push((name(b) || b.className).slice(0, 30) + ' ' + Math.round(r.width) + 'x' + Math.round(r.height));
    }
    for (const i of document.querySelectorAll('input:not([type=hidden]):not([type=file]), select, textarea')) {
      if (!vis(i)) continue;
      if (!(i.labels && i.labels.length) && !i.getAttribute('aria-label') && !i.getAttribute('aria-labelledby')) out.unlabelledInputs.push(i.id || i.name || i.outerHTML.slice(0, 60));
    }
    out.imgsNoAlt = [...document.images].filter((i) => !i.hasAttribute('alt')).length;
    out.lang = document.documentElement.lang;
    // iOS zooms into any field under 16 px; check every field, also those in closed sheets
    out.small = [...document.querySelectorAll('input:not([type=hidden]):not([type=file]):not([type=checkbox]):not([type=color]), select, textarea')]
      .filter((i) => parseFloat(getComputedStyle(i).fontSize) < 16).map((i) => (i.id || i.name || i.className) + ' ' + getComputedStyle(i).fontSize);
    return out;`);
  check(!r.unnamedButtons.length, `a11y ${where}: every button has a name`, r.unnamedButtons.join(' | '));
  check(!r.unlabelledInputs.length, `a11y ${where}: every input has a label`, r.unlabelledInputs.join(' | '));
  check(r.imgsNoAlt === 0, `a11y ${where}: images have alt`);
  check(r.lang === 'nb' || r.lang === 'no', `a11y ${where}: <html lang> is Norwegian`, r.lang);
  check(!r.small.length, `mobile ${where}: every input/select/textarea ≥ 16 px (no iOS zoom)`, r.small.join(' | '));
  if (r.smallTargets.length) warn(`a11y ${where}: tap targets under 44px`, [...new Set(r.smallTargets)].slice(0, 6).join(' | '));
}

/* ---------- location: isolated browser contexts (fresh storage, own permissions) ---------- */
const ORIGIN = BASE.replace(/\/$/, '');
const APP_DB = 'matkassa-premium';
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
    await navigate(BASE + 'index.html#tilbud');
    check(await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 20000), 'location allowed: offers render');
    const st = await waitSettings((v) => v.area);
    check(st && st.area && st.area.name === 'Min posisjon' && st.area.lat === 60.39 && st.area.lng === 5.32 && st.geo === 'done', 'location allowed: area = rounded position (≈1 km), stored once', JSON.stringify(st && st.area));
    await waitFor(`!document.querySelector('#refresh').classList.contains('spinning')`, 15000);
    check(tjekAreas.slice(n0).includes('60.39,5.32'), 'location allowed: Tjek asked for offers around the position', tjekAreas.slice(n0).join(' | '));
    check(!(await geoCardShown()), 'location allowed: no first-run card');
    await waitFor(`!document.querySelector('#refresh').classList.contains('spinning')`, 15000);
    await merPage('omrade');
    check(await evaluate(`return document.querySelector('#area-select').selectedOptions[0].textContent === 'Min posisjon';`), 'location allowed: Mer → Område shows "Min posisjon"');
    await navigate(BASE + 'index.html#tilbud');
    await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 15000);
    await sleep(500);
    check(await evaluate(`return window.__geoCalls === 0;`), 'location allowed: not asked again on the next start');
  });

  // L2. First start, location denied → Trondheim, Mer → Område still works, never asked again.
  await inFreshContext('location denied', async (ctx) => {
    await send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied', origin: ORIGIN, browserContextId: ctx });
    await send('Page.addScriptToEvaluateOnNewDocument', { source: geoSpy(false) }, S);
    const n0 = tjekAreas.length;
    await navigate(BASE + 'index.html#tilbud');
    check(await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 20000), 'location denied: offers render (fallback)');
    check(await waitFor(`/Trondheim/.test(document.querySelector('#toast').textContent)`, 5000), 'location denied: toast says Trondheim + Mer → Område', await toastText());
    const st = await readSettings();
    check(st && st.area === null && st.geo === 'done', 'location denied: no area stored, flow marked done', JSON.stringify(st && { area: st.area, geo: st.geo }));
    check(tjekAreas.slice(n0).every((a) => a === '63.4305,10.3951'), 'location denied: offers for Trondheim', tjekAreas.slice(n0).join(' | '));
    check(!(await geoCardShown()), 'location denied: no card');
    await shot('00b-location-denied');
    await navigate(BASE + 'index.html#tilbud');
    await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 15000);
    await sleep(500);
    check(await evaluate(`return window.__geoCalls === 0 && !document.querySelector('#toast').textContent.includes('posisjon');`), 'location denied: no prompt or toast on the next start');
    await merPage('omrade');
    await evaluate(`const s = document.querySelector('#area-select'); s.value = 'Oslo'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    const picked = await waitFor(`/Område: Oslo/.test(document.querySelector('#toast').textContent)`, 5000);
    await sleep(1500);
    check(picked && lastArea() === '59.9139,10.7522', 'location denied: Mer → Område picker still works', lastArea());
  });

  // L3. iOS-like: the automatic request gets no answer without a tap → clear card; the tap then works.
  await inFreshContext('location needs a tap', async (ctx) => {
    await send('Page.addScriptToEvaluateOnNewDocument', { source: geoSpy(true) }, S);
    await navigate(BASE + 'index.html#tilbud');
    check(await waitFor(`!document.querySelector('#geo-card').hidden`, 8000), 'location needs a tap: first-run card "Finn tilbud nær deg" shown');
    check(await evaluate(`return /Finn tilbud nær deg/.test(document.querySelector('#geo-card').textContent) && !!document.querySelector('#geo-card [data-action="geo-ask"]');`), 'location needs a tap: card has a "Finn tilbud nær deg" button');
    check(await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 20000) && lastArea() === '63.4305,10.3951', 'location needs a tap: Trondheim offers meanwhile', lastArea());
    check(await noHScroll(), 'location needs a tap: no horizontal scroll with the card');
    await a11yAudit('first-run card');
    await shot('00a-location-card');
    await navigate(BASE + 'index.html'); // reopen on Hjem before tapping: card again, but no new prompt
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
    await navigate(BASE + 'index.html#tilbud');
    check(await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 20000), 'existing user: offers render');
    await sleep(500);
    const st = await readSettings();
    check(await evaluate(`return window.__geoCalls === 0;`) && !(await geoCardShown()), 'existing user with an area: no prompt, no card');
    check(st.area.name === 'Bergen' && tjekAreas.slice(n0).every((a) => a === '60.3913,5.3221'), 'existing user: keeps the chosen area', tjekAreas.slice(n0).join(' | '));
  });
}

/* ---------- premium: same origin as the original Matkassa, nothing shared by accident ---------- */

/* ---------- Koble til REMA (Mer → Kjeder) against the FAKE helper; screenshots of every state ---------- */
const V07 = path.join(ROOT, 'screenshots', 'v0.7');
const MAC_UA = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/130.0.0.0 Safari/537.36';
const remaState = () => evaluate(`const el = document.querySelector('#rema-state'); return el ? el.textContent : '';`);
async function stateShot(name) {
  await evaluate(`document.querySelector('#chain-connect').scrollIntoView({ block: 'start' }); window.scrollBy(0, -70); await new Promise(r => setTimeout(r, 150)); return true;`);
  await shot(name);
  fs.mkdirSync(V07, { recursive: true });
  fs.copyFileSync(path.join(SHOTS, `${name}.png`), path.join(V07, `${name}.png`));
}
async function chainTests() {
  await inFreshContext('rema-mac', async () => {
    await send('Network.setUserAgentOverride', { userAgent: MAC_UA, platform: 'MacIntel' }, S);
    await send('Emulation.setTouchEmulationEnabled', { enabled: false }, S);
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: false }, S);
    await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, S);
    helperState.installed = false;
    helperState.requests.length = 0;
    await navigate(BASE + 'index.html#mer');
    await waitFor(`document.querySelector('[data-morepage="kjeder"]')`);
    await merPage('kjeder');
    check(await waitFor(`/Ikke koblet/.test(document.querySelector('#rema-state')?.textContent)`, 8000), 'rema: first visit → "Ikke koblet"', await remaState());
    await sleep(300);
    check(!helperState.requests.length, 'rema: nothing is sent to 127.0.0.1 before the user taps "Koble til REMA"', helperState.requests.length);
    await stateShot('rema-0-ikke-koblet');
    await click('[data-chainact="login"]');
    check(await waitFor(`/Hjelper ikke installert/.test(document.querySelector('#rema-state')?.textContent)`, 8000), 'rema: no helper → "Hjelper ikke installert"', await remaState());
    const guide = await evaluate(`return document.querySelector('#chain-connect').textContent;`);
    check(/install-helper\.sh/.test(guide) && /Terminal/.test(guide), 'rema: the install guide names Terminal and install-helper.sh');
    check(await evaluate(`const b = document.querySelector('.chain-badge'); return b && b.textContent.trim() === 'REMA 1000' && !document.querySelector('#chain-connect img');`), 'rema: a REMA 1000 text badge, no logo image');
    await stateShot('rema-1-hjelper-ikke-installert');

    helperState.installed = true;
    await click('[data-chainact="refresh"]');
    check(await waitFor(`/Koble appen til Mac-en/.test(document.querySelector('#rema-state')?.textContent) && document.querySelector('#pair-code')`, 8000), 'rema: helper there, no code → asks for the pairing code', await remaState());
    await stateShot('rema-2-parkobling');
    await evaluate(`document.querySelector('#pair-code').value = 'FAKE-WRNG-CODE-9999'; document.querySelector('#pair-form').requestSubmit(); return true;`);
    check(await waitFor(`/stemmer ikke/.test(document.querySelector('#chain-connect').textContent)`, 8000), 'rema: a wrong code says so and is not kept');
    check(await evaluate(`return localStorage.getItem('matkassa.helperPairing') === null;`), 'rema: wrong code not stored');
    await evaluate(`document.querySelector('#pair-code').value = 'fake-pair-code-0001'; document.querySelector('#pair-form').requestSubmit(); return true;`);
    check(await waitFor(`/Ikke koblet/.test(document.querySelector('#rema-state')?.textContent)`, 8000), 'rema: right code → "Ikke koblet" with a Koble til REMA button', await remaState());
    check(await evaluate(`return !!document.querySelector('[data-chainact="login"]') && /Koble til REMA/.test(document.querySelector('[data-chainact="login"]').textContent);`), 'rema: "Koble til REMA" button shown');
    await stateShot('rema-3-parkoblet-ikke-koblet');

    await click('[data-chainact="login"]');
    check(/Kobler til/.test(await remaState()), 'rema: tapping the button → "Kobler til …"', await remaState());
    check(helperState.requests.some((r) => r.method === 'POST' && r.path === '/rema/login'), 'rema: the app asked the helper to start REMA\'s own login');
    await stateShot('rema-4-kobler-til');
    check(await waitFor(`/Synker|Koblet/.test(document.querySelector('#rema-state')?.textContent)`, 15000), 'rema: after the login the status moves on by itself (polling)', await remaState());
    check(await waitFor(`/Koblet · siste synk/.test(document.querySelector('#rema-state')?.textContent)`, 15000), 'rema: the first sync runs by itself → "Koblet · siste synk …"', await remaState());
    check(helperState.requests.some((r) => r.method === 'POST' && r.path === '/sync'), 'rema: first sync was started after connecting');
    check(await evaluate(`return !!document.querySelector('[data-chainact="sync"]') && !!document.querySelector('[data-chainact="disconnect"]');`), 'rema: connected shows "Synk nå" and "Koble fra"');
    await stateShot('rema-5-koblet');

    const n = helperState.requests.filter((r) => r.path === '/sync').length;
    await click('[data-chainact="sync"]');
    check(helperState.requests.filter((r) => r.path === '/sync').length === n + 1, 'rema: "Synk nå" starts a sync');
    check(await waitFor(`/Koblet · siste synk/.test(document.querySelector('#rema-state')?.textContent) && !document.querySelector('[data-chainact="sync"][disabled]')`, 15000), 'rema: "Synk nå" ends back at "Koblet"');

    Object.assign(helperState.rema, { state: 'expired', lastSyncOk: false, message: 'REMA-innloggingen er utløpt. Logg inn på nytt.' });
    await sleep(3100);
    await merPage('kjeder');
    check(await waitFor(`/Utløpt/.test(document.querySelector('#rema-state')?.textContent)`, 8000), 'rema: expired login → "Utløpt – logg inn på nytt"', await remaState());
    check(await evaluate(`return /Logg inn på nytt/.test(document.querySelector('[data-chainact="login"]')?.textContent || '');`), 'rema: expired offers "Logg inn på nytt"');
    await stateShot('rema-6-utlopt');

    await click('[data-chainact="disconnect"]');
    check(await waitFor(`/Ikke koblet/.test(document.querySelector('#rema-state')?.textContent)`, 8000) && helperState.requests.some((r) => r.path === '/rema/logout'), '"Koble fra" logs out on the Mac → "Ikke koblet"');

    const actions = helperState.requests.filter((r) => r.method === 'POST');
    check(actions.length >= 4 && actions.every((r) => /FAKE-PAIR-CODE-0001|FAKEPAIRCODE0001/i.test(r.auth)), 'rema: every helper action carried the pairing code', actions.length);
    const settings = JSON.stringify(await readSettings());
    check(!/PAIR|FAKEPAIR/i.test(settings), 'rema: the pairing code is not in the settings (so not in backups or the account)');
    check(await noHScroll(), 'rema: no horizontal scroll on the Kjeder page');
    await a11yAudit('rema-kjeder');
  });

  await inFreshContext('rema-phone', async () => {
    helperState.requests.length = 0;
    await navigate(BASE + 'index.html#mer');
    await waitFor(`document.querySelector('[data-morepage="kjeder"]')`);
    await merPage('kjeder');
    check(await waitFor(`/Gjøres fra Mac-en/.test(document.querySelector('#rema-state')?.textContent)`, 8000), 'rema on a phone: "Gjøres fra Mac-en"', await remaState());
    check(!(await evaluate(`return !!document.querySelector('[data-chainact="login"]');`)), 'rema on a phone: no login button');
    await sleep(300);
    check(!helperState.requests.length, 'rema on a phone: the app never calls the Mac helper', helperState.requests.length);
    await stateShot('rema-7-telefon');
  });
}


/* ---------- v0.7 Neon: the three figures, themes, reduced motion, screenshots (all data FAKE) ---------- */
const media = (scheme, motion = 'no-preference') => send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }, { name: 'prefers-reduced-motion', value: motion }] }, S);
async function v07Shot(name) {
  await evaluate(`window.scrollTo(0, 0); await new Promise(r => setTimeout(r, 120)); return true;`);
  await shot(name);
  fs.mkdirSync(V07, { recursive: true });
  fs.copyFileSync(path.join(SHOTS, `${name}.png`), path.join(V07, `${name}.png`));
}
const ptr = (sel, type, x, y, idx = 0) => evaluate(`const el = document.querySelectorAll(${JSON.stringify(sel)})[${idx}]; const r = el.getBoundingClientRect();
  el.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { bubbles: true, pointerId: 7, pointerType: 'touch', isPrimary: true, clientX: r.left + ${x}, clientY: r.top + ${y} })); return true;`);
const scaleX = (sel) => evaluate(`const t = getComputedStyle(document.querySelector(${JSON.stringify(sel)})).transform; const m = /matrix\\(([^,]+)/.exec(t); return m ? Number(m[1]) : (t === 'none' ? 1 : NaN);`);
async function whereTests() {
  // Linn r2: the first time, Tilbud asks "Hvor handler du?"; only the picked chains are shown afterwards
  await inFreshContext('where', async () => {
    await navigate(BASE + 'index.html#tilbud');
    check(await waitFor(`!document.querySelector('#where-card').hidden && document.querySelectorAll('#where-card [data-where]').length >= 2`, 10000), 'Linn r2: first start asks «Hvor handler du?» with chain chips');
    const rema = await evaluate(`const b = [...document.querySelectorAll('#where-card [data-where]')].find((x) => /REMA/.test(x.textContent)); b.click(); return b.dataset.where;`);
    await click('[data-action="where-done"]');
    await sleep(300);
    const r = await evaluate(`return { hidden: document.querySelector('#where-card').hidden, chains: [...new Set([...document.querySelectorAll('#offer-list .offer .chain')].map((c) => c.textContent))] };`);
    const st = await readSettings();
    check(r.hidden && r.chains.length === 1 && /REMA/.test(r.chains[0]) && st.chainsSeen && !st.hiddenChains.includes(rema) && st.hiddenChains.length >= 1, 'Linn r2: a REMA-only shopper sees only REMA offers (no Bunnpris/KIWI), and is not asked again', JSON.stringify(r));
    await navigate(BASE + 'index.html#hjem');
    await waitFor(`document.querySelector('#home-body') && document.querySelector('#home-body').children.length`);
    await sleep(300);
    check(await evaluate(`return !document.querySelector('.where-card:not([hidden]) [data-where]');`), 'round 3: once chains are chosen, «Hvor handler du?» never shows again (Hjem or Tilbud)');
  });
  // round 3: it shows on Hjem at first start, is compact, has ×, the offers stay visible on Tilbud, and × is for good
  await inFreshContext('where-3', async () => {
    await navigate(BASE + 'index.html#hjem');
    check(await waitFor(`document.querySelectorAll('#home-body .where-card [data-where]').length >= 2`, 10000), 'round 3 (Linn): a fresh profile is asked «Hvor handler du?» on Hjem');
    await tab('tilbud');
    await waitFor(`document.querySelectorAll('#offer-list .offer').length > 0`);
    const w = await evaluate(`const c = document.querySelector('#where-card'); const o = document.querySelector('#offer-list .offer'); const rows = new Set([...c.querySelectorAll('[data-where]')].map((b) => Math.round(b.getBoundingClientRect().top)));
      return { h: Math.round(c.getBoundingClientRect().height), rows: rows.size, x: !!c.querySelector('[data-action="where-close"]'), offerTop: Math.round(o.getBoundingClientRect().top), vh: innerHeight, sort: document.querySelector('#offer-sort').selectedOptions[0]?.textContent || '' };`);
    check(w.h <= 170 && w.rows === 1 && w.x && w.offerTop < w.vh && w.sort.length > 0, 'round 3: the step is compact (one chip row, ≤ 170 px, a × button), the first offer is still on screen, and the sort select shows a value', JSON.stringify(w));
    const firstChains = await evaluate(`return [...document.querySelectorAll('#offer-list .offer .chain')].slice(0, 8).map((c) => c.textContent);`);
    check(firstChains.length >= 4 && new Set(firstChains).size >= 2, 'round 3 (Linn): without receipts Tilbud does not open with one chain (Bunnpris) by the alphabet', firstChains.join(', '));
    await click('#where-card [data-action="where-close"]');
    await sleep(300);
    const st = await readSettings();
    check(await evaluate(`return document.querySelector('#where-card').hidden;`) && st.chainsSeen === true && !(st.hiddenChains || []).length, 'round 3: × closes it for good and keeps every chain', JSON.stringify({ seen: st.chainsSeen, hidden: st.hiddenChains }));
    // toasts close with a tap, and the page makes room for them
    await evaluate(`document.querySelector('#offer-list .offer [data-add]').click(); return true;`);
    await sleep(200);
    await evaluate(`document.querySelector('#offer-list .offer [data-add]').click(); return true;`);
    await sleep(150);
    const t1 = await evaluate(`const t = document.querySelector('#toast'); return { shown: !t.hidden, room: getComputedStyle(document.documentElement).getPropertyValue('--toast-room').trim() };`);
    await evaluate(`document.querySelector('#toast span').click(); return true;`);
    await sleep(500);
    check(t1.shown && parseFloat(t1.room) > 16 && (await evaluate(`return document.querySelector('#toast').hidden && getComputedStyle(document.documentElement).getPropertyValue('--toast-room').trim() === '0px';`)), 'round 3: a toast closes with a tap, and while it shows the page gets room below it', JSON.stringify(t1));
    // the switches in Mer are ≥ 44 px at Normal text too (Arne)
    await tab('mer');
    const sw = await evaluate(`return [...document.querySelectorAll('#view-mer .switch-row input')].filter((e) => e.offsetParent).map((e) => Math.round(e.getBoundingClientRect().height));`);
    check(sw.length && Math.min(...sw) >= 44, 'round 3 (Arne): Mer switches are ≥ 44 px at Normal text size', sw.join());
  });
}
async function neonTests() {
  await inFreshContext('neon', async () => {
    await media('dark');
    await navigate(BASE + 'index.html#hjem');
    await waitFor(`document.querySelector('#home-body') && document.querySelector('#home-body').children.length`);
    const start = await evaluate(`const b = [...document.querySelectorAll('.start-steps [data-step], .start-steps button, .start-steps li')].map((x) => x.textContent.replace(/\\s+/g, ' ').trim()); return b.join(' | ');`);
    check(/Område/.test(start) && /Trondheim/.test(start) && !/Velg område/.test(start), 'kunde 7 (Linn): Kom i gang shows the area as done, with its name', start.slice(0, 200));
    await tab('tilbud');
    await waitFor(`document.querySelectorAll('#offer-list .offer').length > 0`);
    const first = await evaluate(`return [...document.querySelectorAll('#offer-list .offer .title')].slice(0, 3).map((t) => t.textContent);`);
    check(first.length && !first.some((t) => /chips|cola|pepsi|sjokolade|brus|smågodt|godteri/i.test(t)), 'kunde 7: without receipts, Tilbud opens with food, not sweets or fizzy drinks', first.join(' | '));
    await tab('hjem');
    const zero = await evaluate(`return { note: document.querySelector('#home-save .save-note').textContent, hint: document.querySelector('#home-save .save-hint').textContent };`);
    check(/0 kr betyr bare at ingen tilbud er krysset av/.test(zero.note) && /Dra langs staven/.test(zero.hint), 'kunde 2: «0 kr spart» is explained in plain words, and the drag hint is visible', JSON.stringify(zero));
    // Jonas r2: at 0 kr the meter says how many list items have a known regular price, and that offers without one do not count
    await tab('tilbud');
    const preId = await evaluate(`const o = [...document.querySelectorAll('#offer-list .offer')].find((x) => x.querySelector('.pre') && x.querySelector('[data-add]')); if (!o) return null; o.querySelector('[data-add]').click(); return o.querySelector('[data-add]').dataset.add;`);
    await sleep(300);
    await tab('hjem');
    const kn = await evaluate(`return document.querySelector('#home-save .save-note').textContent;`);
    fixtureCheck(preId && /1 vare på lista har kjent førpris/.test(kn) && /uten oppgitt førpris .*teller ikke/.test(kn), 'Jonas r2: at 0 kr the meter says «1 vare på lista har kjent førpris» and that offers without a regular price do not count', kn);
    await evaluate(`const db = await new Promise((r) => { const q = indexedDB.open('${APP_DB}'); q.onsuccess = () => r(q.result); });
      await new Promise((r) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put([], 'list'); t.oncomplete = r; });
      return true;`);
    await evaluate(`const db = await new Promise((r) => { const q = indexedDB.open('${APP_DB}'); q.onsuccess = () => r(q.result); });
      await new Promise((r) => { const t = db.transaction('kv', 'readwrite'); t.objectStore('kv').put([{ id: 'save-FAKE-1', at: Date.now(), kr: 212, text: 'TINE HELMELK (FAKE)' }, { id: 'save-FAKE-2', at: Date.now(), kr: 100, text: 'KYLLINGFILET (FAKE)' }], 'savings'); t.oncomplete = r; });
      return true;`);
    await tab('forbruk');
    await importFixture(path.join(FAKE, 'spending-FAKE.json'));
    await navigate(BASE + 'index.html#hjem');
    check(await waitFor(`document.querySelector('#home-save .meter')`, 10000), 'neon: Hjem shows the savings meter');
    check(await evaluate(`const m = document.querySelector('#home-save [role="meter"]'); return m.getAttribute('aria-valuenow') === '312' && m.getAttribute('aria-valuemax') === '500' && /312 kroner spart av et mål på 500 kroner/.test(m.getAttribute('aria-valuetext'));`), 'neon meter: role=meter with value, max and a spoken text');
    await sleep(900);
    const fill = await scaleX('#home-save .meter-fill');
    check(Math.abs(fill - 312 / 650) < 0.01, 'neon meter: the fill grows to 312 kr on a 650 kr scale (scaleX, not width)', fill);
    const mk = await evaluate(`const row = document.querySelector('#home-save .save-row').getBoundingClientRect(); const h = document.querySelector('.save-handle'); const t = h.querySelector('.goal-tick').getBoundingClientRect(); const l = h.querySelector('.goal-label');
      return { label: l.textContent.trim(), x: (t.left + t.width / 2 - row.left) / row.width, onBar: t.top <= row.top + row.height / 2 && t.bottom >= row.top + row.height / 2, role: h.getAttribute('role'), name: h.getAttribute('aria-label'), vt: h.getAttribute('aria-valuetext') };`);
    check(mk.label === 'Mål 500 kr' && Math.abs(mk.x - 500 / 650) < 0.02 && mk.onBar && mk.role === 'slider' && /Sparemål/.test(mk.name) && mk.vt === 'Mål: 500 kroner', 'B1 meter: the goal is a labelled marker on the bar ("Mål 500 kr"), a named slider', JSON.stringify(mk));
    check(await evaluate(`return getComputedStyle(document.querySelector('.meter-glow')).boxShadow !== 'none';`), 'neon meter: glow in dark');
    const mcol = await evaluate(`return { fill: getComputedStyle(document.querySelector('.meter-fill')).backgroundImage, glow: getComputedStyle(document.querySelector('.meter-glow')).boxShadow };`);
    check(/rgb\(0, 229, 255\)/.test(mcol.fill) && /rgb\(0, 229, 255\)|rgba\(0, 229, 255/.test(mcol.glow) && !/255, 154, 85/.test(mcol.fill + mcol.glow), 'Jonas r2: the meter fill and glow are neon (the accent), not orange', JSON.stringify(mcol));
    await click('#home-save .save-what');
    check(await evaluate(`return !document.querySelector('#save-list').hidden && /TINE HELMELK/.test(document.querySelector('#save-list').textContent);`), 'neon meter: tapping shows what the savings are made of');
    await click('#home-save .save-what');
    // drag the marker to the right end of the bar: the goal grows and the marker follows the finger
    const atRow = (type, f) => evaluate(`const row = document.querySelector('#home-save .save-row').getBoundingClientRect(); const h = document.querySelector('.save-handle'); const t = h.getBoundingClientRect();
      h.dispatchEvent(new PointerEvent(${JSON.stringify(type)}, { bubbles: true, pointerId: 9, pointerType: 'touch', isPrimary: true, clientX: ${f} == null ? t.left + t.width / 2 : row.left + row.width * ${f}, clientY: t.top + 20 })); return true;`);
    const tickX = () => evaluate(`const row = document.querySelector('#home-save .save-row').getBoundingClientRect(); const t = document.querySelector('.goal-tick').getBoundingClientRect(); return (t.left + t.width / 2 - row.left) / row.width;`);
    await atRow('pointerdown', null);
    await atRow('pointermove', 0.85);
    await atRow('pointermove', 1);
    await sleep(80);
    const mid = { x: await tickX(), label: await evaluate(`return document.querySelector('.goal-label').textContent.trim();`), list: await evaluate(`return document.querySelector('#save-list').hidden;`) };
    await atRow('pointerup', 1);
    await sleep(600);
    const g = await evaluate(`return document.querySelector('#home-save .save-sub').textContent;`);
    check(mid.x > 0.97 && mid.label === 'Mål 650 kr' && mid.list, 'B1 meter: dragging the marker right makes the goal bigger, and the marker follows the finger', JSON.stringify(mid));
    check(/650 kr/.test(g) && (await readSettings()).saveGoal === 650 && Math.abs((await tickX()) - 650 / 850) < 0.02, 'B1 meter: on release the goal is saved and the bar rescales (marker at ~80 %)', g);
    const key = (k) => evaluate(`document.querySelector('.save-handle').dispatchEvent(new KeyboardEvent('keydown', { key: '${k}', bubbles: true })); return true;`);
    await key('Home');
    await sleep(500);
    check(await evaluate(`const row = document.querySelector('#home-save .save-card, #home-save').getBoundingClientRect(); const l = document.querySelector('.goal-label').getBoundingClientRect(); return document.querySelector('.goal-label').textContent.trim() === 'Mål 50 kr' && l.left >= row.left && l.right <= row.right;`), 'B1 meter: Home sets the smallest goal, and the label stays inside the card');
    await key('PageUp');
    for (let i = 0; i < 1; i++) await key('ArrowLeft');
    check(await evaluate(`return document.querySelector('.save-handle').getAttribute('aria-valuenow') === '500' && document.querySelector('.goal-label').textContent.trim() === 'Mål 500 kr';`), 'neon meter: the goal slider works with arrow keys and Page Up/Down');
    // kunde 2: the whole bar can be dragged, not just the marker
    await ptr('#home-save .meter', 'pointerdown', 20, 7);
    await ptr('#home-save .meter', 'pointermove', 40, 8);
    await ptr('#home-save .meter', 'pointermove', 60, 8);
    await ptr('#home-save .meter', 'pointerup', 60, 8);
    await sleep(500);
    const dg = (await readSettings()).saveGoal;
    check(dg < 500 && dg >= 50 && dg % 50 === 0, 'kunde 2: dragging along the bar itself moves the goal to the finger', dg);
    for (let i = 0; i < 20 && (await readSettings()).saveGoal < 500; i++) await key('ArrowRight');
    await ptr('#home-save .save-row', 'pointerdown', 20, 22);
    await ptr('#home-save .save-row', 'pointerup', 20, 22);
    check(await evaluate(`return !document.querySelector('#save-list').hidden;`), 'neon meter: a tap on the bar itself still opens the list');
    await click('#home-save .save-what');
    await sleep(300);
    await v07Shot('neon-dark-hjem');

    await tab('forbruk');
    check(await waitFor(`document.querySelectorAll('#spend-body .donut .arc').length >= 2`), 'neon donut: Forbruk shows the category donut');
    const a11y = await evaluate(`const s = document.querySelector('.donut'); const a = s.querySelector('.arc'); return { role: s.getAttribute('role'), label: s.getAttribute('aria-label'), arcRole: a.getAttribute('role'), tab: a.getAttribute('tabindex'), arcLabel: a.getAttribute('aria-label') };`);
    check(a11y.role === 'group' && /kroner fordelt på \d+ kategori/.test(a11y.label) && a11y.arcRole === 'button' && a11y.tab === '0' && /kroner, \d+ prosent/.test(a11y.arcLabel), 'neon donut: group + arcs as buttons with spoken amounts', JSON.stringify(a11y));
    await sleep(900);
    check(await evaluate(`return document.querySelector('.dc-value').textContent === '307,80 kr' && /307,80 kr/.test(document.querySelector('#spend-body').textContent.replace(/\\s/g, ' '));`), 'Maria B10: the donut centre shows the same øre as the card above (307,80 kr)');
    check(await evaluate(`return [...document.querySelectorAll('.donut .arc')].every((g) => { const v = g.querySelector('.arc-vis'); return Math.abs(parseFloat(v.getAttribute('stroke-dasharray')) - Number(g.dataset.len)) < 0.05; });`), 'neon donut: the arcs draw in to their real share');
    await evaluate(`document.querySelectorAll('.donut .arc')[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); return true;`);
    await sleep(400);
    const sel = await evaluate(`const g = document.querySelectorAll('.donut .arc')[1]; return { pressed: g.getAttribute('aria-pressed'), center: document.querySelector('.dc-label').textContent, legend: document.querySelectorAll('.legend-row')[1].getAttribute('aria-pressed'), dim: getComputedStyle(document.querySelectorAll('.donut .arc')[0]).opacity, receipts: !document.querySelector('.donut-actions').hidden };`);
    check(sel.pressed === 'true' && sel.center !== 'Totalt' && sel.legend === 'true' && Number(sel.dim) < 0.5 && sel.receipts, 'neon donut: tapping an arc selects it (centre, legend, others dimmed, "Se kvitteringer")', JSON.stringify(sel));
    await evaluate(`document.querySelectorAll('.donut .arc')[1].dispatchEvent(new MouseEvent('click', { bubbles: true })); return true;`);
    check(await evaluate(`return document.querySelector('.dc-label').textContent === 'Totalt' && !document.querySelector('.donut .arc.sel');`), 'neon donut: tapping it again clears the choice');
    // drag around the ring: 6 px sideways starts scrubbing; the arc under the finger is chosen
    await ptr('.donut', 'pointerdown', 130, 20);
    await ptr('.donut', 'pointermove', 140, 22);
    await ptr('.donut', 'pointermove', 236, 130);
    await sleep(100);
    await ptr('.donut', 'pointerup', 236, 130);
    check(await evaluate(`return !!document.querySelector('.donut .arc.sel');`), 'neon donut: dragging around the ring picks the arc under the finger');
    await evaluate(`const a = document.querySelector('.donut .arc'); a.focus(); a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); return true;`);
    // B3: keyboard focus shows a ring in the --text colour (a real key press makes the focus :focus-visible)
    await send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 }, S);
    await send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Shift', code: 'ShiftLeft', windowsVirtualKeyCode: 16 }, S);
    const fr = await evaluate(`const a = document.querySelectorAll('.donut .arc')[1]; a.focus(); const r = a.querySelector('.arc-ring'); return { fv: a.matches(':focus-visible'), op: getComputedStyle(r).opacity, stroke: getComputedStyle(r).stroke, text: getComputedStyle(document.body).color, w: getComputedStyle(r).strokeWidth };`);
    check(fr.fv && fr.op === '1' && fr.stroke === fr.text && fr.w === '32px', 'B3 donut: a keyboard-focused arc gets a visible ring (--text, ≥ 3:1 on the card)', JSON.stringify(fr));
    await evaluate(`document.activeElement.blur(); return true;`);
    await click('[data-month="-1"]');
    check(await evaluate(`return /:/.test(document.querySelector('#sr-live').textContent) && /kroner/.test(document.querySelector('#sr-live').textContent);`), 'neon donut: a month change is announced (aria-live)', await evaluate(`return document.querySelector('#sr-live').textContent;`));
    await click('[data-month="1"]');
    check(await evaluate(`return document.querySelector('.donut').classList.contains('morph');`), 'neon donut: switching month morphs the arcs');
    await sleep(600);
    // kunde 4: the figures show that they can be touched, and a tap in the middle of the ring does something
    check(/Trykk på en farge/.test(await evaluate(`return document.querySelector('.donut-hint').textContent;`)), 'kunde 4: the donut says it can be tapped');
    check(/dra fingeren rundt ringen/.test(await evaluate(`return document.querySelector('.donut-hint').textContent;`)), 'Jonas r2: the donut hint mentions dragging round the ring');
    const ringTA = await evaluate(`return { arc: getComputedStyle(document.querySelector('.donut .arc')).touchAction, svg: getComputedStyle(document.querySelector('.donut')).touchAction };`);
    check(ringTA.arc === 'none' && ringTA.svg === 'pan-y', 'Jonas r2: touch-action is none on the ring arcs only (the rest of the donut still scrolls)', JSON.stringify(ringTA));
    const ring = await evaluate(`const s = document.querySelector('.donut'); const r = s.getBoundingClientRect(); const cx = r.left + r.width / 2, cy = r.top + r.height / 2, R = r.width * 80 / 200;
      const at = (deg) => ({ x: cx + R * Math.sin(deg * Math.PI / 180), y: cy - R * Math.cos(deg * Math.PI / 180) });
      const fire = (t, p, target) => (target || s).dispatchEvent(new PointerEvent(t, { bubbles: true, pointerId: 5, pointerType: 'touch', isPrimary: true, clientX: p.x, clientY: p.y }));
      const p0 = at(80); fire('pointerdown', p0, document.elementFromPoint(p0.x, p0.y)); const seen = new Set();
      for (let d = 85; d <= 200; d += 15) { fire('pointermove', at(d)); await new Promise((r) => requestAnimationFrame(() => requestAnimationFrame(r))); const g = document.querySelector('.donut .arc.sel'); if (g) seen.add(g.dataset.arc); }
      fire('pointerup', at(200)); return [...seen];`);
    check(ring.length >= 1, 'Jonas r2: a mostly vertical drag that starts on the ring moves round the categories instead of being dropped', ring.join());
    // Maria N1: a real touch gesture (not synthetic PointerEvents, which skip touch-action), straight down the ring's left side
    const side = await evaluate(`const s = document.querySelector('.donut'); s.scrollIntoView({ block: 'center' }); const r = s.getBoundingClientRect();
      window.__ring = { move: 0, cancel: 0 }; s.addEventListener('pointermove', () => window.__ring.move++); s.addEventListener('pointercancel', () => window.__ring.cancel++);
      return { x: Math.round(r.left + r.width * (100 - 80) / 200), y: Math.round(r.top + r.height / 2 - 30), sy: scrollY };`);
    await sleep(200);
    await send('Input.synthesizeScrollGesture', { x: side.x, y: side.y, xDistance: 0, yDistance: -70, speed: 300, gestureSourceType: 'touch', repeatCount: 1 }, S);
    await sleep(300);
    const g1 = await evaluate(`return { sy: scrollY, ...window.__ring, sel: document.querySelector('.donut .arc.sel')?.dataset.arc ?? null };`);
    check(Math.abs(g1.sy - side.sy) < 2 && g1.cancel === 0 && g1.move >= 3, 'Maria N1: a real vertical touch drag on the side of the ring drags round it; the page does not scroll and the pointer is not cancelled', JSON.stringify({ before: side.sy, ...g1 }));
    const off = await evaluate(`const r = document.querySelector('.donut-card').getBoundingClientRect(); return { x: Math.round(r.left + 12), y: Math.round(r.top + r.height / 2), sy: scrollY };`);
    await send('Input.synthesizeScrollGesture', { x: off.x, y: off.y, xDistance: 0, yDistance: -120, speed: 600, gestureSourceType: 'touch', repeatCount: 1 }, S);
    await sleep(300);
    check((await evaluate(`return scrollY;`)) > off.sy + 20, 'Maria N1: the same vertical swipe outside the ring still scrolls the page');
    await evaluate(`const a = document.querySelector('.donut .arc'); a.focus(); a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); a.blur(); return true;`);
    await sleep(100);
    const hub = async () => { await evaluate(`const s = document.querySelector('.donut'); const r = s.getBoundingClientRect(); s.dispatchEvent(new MouseEvent('click', { bubbles: true, clientX: r.left + r.width / 2, clientY: r.top + r.height / 2 })); return true;`); return evaluate(`const g = document.querySelector('.donut .arc.sel'); return g ? g.dataset.arc : '-';`); };
    const h1 = await hub(); const h2 = await hub();
    check(h1 === '0' && h2 === '1', 'kunde 4: tapping the middle of the donut steps through the categories', h1 + ',' + h2);
    await evaluate(`const a = document.querySelector('.donut .arc'); a.focus(); a.dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true })); a.blur(); return true;`);
    await sleep(700);
    await v07Shot('neon-dark-forbruk');

    await tab('tilbud');
    await waitFor(`document.querySelectorAll('#offer-list .offer').length > 0`);
    const best = await evaluate(`return [...document.querySelectorAll('#offer-list .offer.best')].map((c) => ({ tag: !!c.querySelector('.best-tag'), label: c.getAttribute('aria-label') || '' }));`);
    fixtureCheck(best.length > 0 && best.length <= 3 && best.every((b) => b.tag && /beste tilbud: lavest (kilo|liter)pris/.test(b.label)) && best.some((b) => /Svinekotelett/i.test(b.label)) && !best.some((b) => /kaffe|bananer/i.test(b.label)), 'kunde 1: «Beste tilbud» is the lowest kr/kg among like offers (svinekotelett 99 kr/kg), not the biggest % off', JSON.stringify(best).slice(0, 200));
    await ptr('#offer-list .offer .info', 'pointerdown', 40, 20);
    await sleep(160);
    await ptr('#offer-list .offer .info', 'pointermove', 60, 24);
    await sleep(60);
    const tilt = await evaluate(`return document.querySelector('#offer-list .offer').style.transform;`);
    check(/rotateX/.test(tilt) && /rotateY/.test(tilt), 'neon tilbud: holding and moving a finger tilts the card', tilt);
    await ptr('#offer-list .offer .info', 'pointerup', 60, 24);
    check(!(await evaluate(`return document.querySelector('#offer-list .offer').style.transform;`)), 'neon tilbud: letting go puts the card back');
    await ptr('#offer-list .offer .info', 'pointerdown', 40, 20, 1);
    await ptr('#offer-list .offer .info', 'pointermove', 41, 60, 1);
    await sleep(200);
    check(!(await evaluate(`return document.querySelectorAll('#offer-list .offer')[1].style.transform;`)), 'neon tilbud: a vertical swipe scrolls and never tilts');
    await ptr('#offer-list .offer .info', 'pointerup', 41, 60, 1);
    await sleep(1000);
    await v07Shot('neon-dark-tilbud');
    // kunde 2: an offer on the list counts as "på vei" (striped) on the meter before it is checked off
    await click('#offer-list [data-add="fake-r2"]');
    await sleep(300);
    await tab('hjem');
    await sleep(300);
    const pend = await evaluate(`return { note: document.querySelector('#home-save .save-note').textContent, pp: getComputedStyle(document.querySelector('#home-save .meter')).getPropertyValue('--pp') };`);
    check(/\+ 15 kr på vei/.test(pend.note) && Math.abs(Number(pend.pp) - 327 / 650) < 0.01, 'kunde 2: offers on the list show as savings on the way (+15 kr, striped)', JSON.stringify(pend));
    await tab('liste');
    await v07Shot('neon-dark-liste');
    await tab('mer');
    await v07Shot('neon-dark-mer');
    check(await evaluate(`return getComputedStyle(document.body).backgroundColor;`) === 'rgb(5, 7, 10)', 'neon: dark is the default look');

    // light: prefers-color-scheme light, and Mer → Tema
    await media('light');
    await sleep(200);
    check(await evaluate(`return getComputedStyle(document.body).backgroundColor;`) === 'rgb(241, 244, 247)', 'neon: a light phone gets the light theme');
    for (const t of ['hjem', 'tilbud', 'liste', 'forbruk', 'mer']) { await tab(t); await sleep(t === 'forbruk' ? 700 : 250); await v07Shot(`neon-lys-${t}`); }
    await evaluate(`const s = document.querySelector('[data-theme-select]'); s.value = 'dark'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    check(await evaluate(`return document.documentElement.dataset.theme === 'dark' && getComputedStyle(document.body).backgroundColor === 'rgb(5, 7, 10)';`) && (await readSettings()).theme === 'dark', 'neon: Mer → Tema → Mørkt wins over a light phone, and is saved');
    // B6: on the next start the chosen theme is there before the app (and IndexedDB) has loaded
    const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: `document.addEventListener('DOMContentLoaded', () => { window.__themeAtDCL = (document.documentElement.dataset.theme || '-') + '|' + getComputedStyle(document.body).backgroundColor; }, { once: true });` }, S);
    await navigate(BASE + 'index.html#mer');
    await waitFor(`window.__themeAtDCL`);
    const early = await evaluate(`return window.__themeAtDCL;`);
    await send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, S);
    check(early === 'dark|rgb(5, 7, 10)', 'B6 theme: the saved theme is applied before the first paint (no flash of the phone\'s theme)', early);
    await waitFor(`document.querySelector('[data-theme-select]')`);
    await evaluate(`const s = document.querySelector('[data-theme-select]'); s.value = 'auto'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    check(await evaluate(`return !document.documentElement.dataset.theme;`), 'neon: Tema → Som telefonen follows the phone again');
    // kunde 3: Ekstra stor tekst at 320 px: the tab names are whole, chips and switch rows ≥ 44 px; it turns on Rolig visning
    await media('dark');
    await evaluate(`const s = document.querySelector('[data-textsize-select]'); s.value = 'xstor'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    await sleep(200);
    const xs = await evaluate(`return { x: document.documentElement.classList.contains('xbig-text'), calm: document.documentElement.classList.contains('calm'), sel: document.querySelector('[data-textsize-select]').value };`);
    check(xs.x && xs.calm && xs.sel === 'xstor' && (await readSettings()).textSize === 'xstor' && (await readSettings()).calm === true, 'kunde 3+4: Tekststørrelse → Ekstra stor is saved and turns on Rolig visning', JSON.stringify(xs));
    await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true }, S);
    await sleep(300);
    const tabs = await evaluate(`return [...document.querySelectorAll('.tabbar button > span:not(.badge)')].map((sp) => ({ t: sp.textContent, cut: sp.scrollWidth > sp.parentElement.clientWidth + 1, fs: parseFloat(getComputedStyle(sp).fontSize) }));`);
    check(tabs.length === 5 && tabs.every((t) => !t.cut && t.fs >= 13) && tabs.some((t) => t.t === 'Liste'), 'kunde 3: at 320 px with Ekstra stor the tab names are never cut (≥ 13 px)', JSON.stringify(tabs));
    const rows = await evaluate(`return Math.min(...[...document.querySelectorAll('#view-mer .switch-row')].map((r) => r.getBoundingClientRect().height));`);
    check(rows >= 44, 'kunde 3: switch rows are ≥ 44 px tall (the whole row is the target)', rows);
    const ctl = await evaluate(`const sel = [...document.querySelectorAll('#view-mer select')].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().height); const sw = [...document.querySelectorAll('#view-mer .switch-row input')].filter((e) => e.offsetParent).map((e) => e.getBoundingClientRect().height); return { sel: Math.min(...sel), sw: Math.min(...sw), n: sel.length + sw.length };`);
    check(ctl.n && ctl.sel >= 44 && ctl.sw >= 44, 'Arne r2: Mer selects and switches (with their tap area) are ≥ 44 px at Ekstra stor', JSON.stringify(ctl));
    await tab('hjem');
    const hj = await evaluate(`const v = document.querySelector('#view-hjem'); const wide = [...v.querySelectorAll('*')].filter((e) => e.offsetParent && !e.closest('.home-feat ul') && e.getBoundingClientRect().right > innerWidth + 0.5).map((e) => e.className || e.tagName).slice(0, 5); return { sw: document.documentElement.scrollWidth, wide };`);
    check(hj.sw <= 320 && !hj.wide.length, 'Arne r2: Hjem at 320 px with Ekstra stor is not wider than the screen', JSON.stringify(hj));
    await tab('tilbud');
    // Arne r2: the filters sit behind one "Filter" button with a summary
    const fs = await evaluate(`const d = document.querySelector('#offer-filters'); return { open: d.open, sum: document.querySelector('#filter-sum').textContent };`);
    check(!fs.open && /Kun mat · alle kjeder/.test(fs.sum), 'Arne r2: the filters are closed behind «Filter» with a one-line summary', JSON.stringify(fs));
    await evaluate(`document.querySelector('#offer-filters').open = true; return true;`);
    const chips = await evaluate(`return [...document.querySelectorAll('#view-tilbud .chip')].filter((c) => c.offsetParent).map((c) => Math.round(c.getBoundingClientRect().height));`);
    const pressed = await evaluate(`const c = document.querySelector('#view-tilbud .chip[aria-pressed="true"]'); const u = document.querySelector('#view-tilbud .chip[aria-pressed="false"]'); return { mark: getComputedStyle(c, '::before').content !== 'none', bgOn: getComputedStyle(c).backgroundColor, bgOff: getComputedStyle(u).backgroundColor };`);
    check(chips.length && Math.min(...chips) >= 44, 'kunde 3: filter chips are ≥ 44 px tall', chips.join());
    check(pressed.mark && pressed.bgOff === 'rgba(0, 0, 0, 0)' && pressed.bgOn !== pressed.bgOff, 'kunde 3: the chosen filter has a check mark and is filled; the others are only outlined', JSON.stringify(pressed));
    await ptr('#offer-list .offer .info', 'pointerdown', 40, 20);
    await sleep(160);
    await ptr('#offer-list .offer .info', 'pointermove', 60, 24);
    await sleep(60);
    check(!(await evaluate(`return document.querySelector('#offer-list .offer').style.transform;`)) && (await evaluate(`return getComputedStyle(document.querySelector('.btn-primary, .chip') || document.body).boxShadow;`)) !== undefined, 'kunde 4: Rolig visning: offer cards do not tilt');
    await ptr('#offer-list .offer .info', 'pointerup', 60, 24);
    check(await evaluate(`return getComputedStyle(document.documentElement).getPropertyValue('--accent').trim() === '#7cc4ff' && getComputedStyle(document.documentElement).getPropertyValue('--glow').trim() === 'none';`), 'kunde 4: Rolig visning: softer blue, no glow');
    await v07Shot('rc3-rolig-ekstra-stor-320-tilbud');
    await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: false }, S);
    await tab('mer');
    await evaluate(`const s = document.querySelector('[data-textsize-select]'); s.value = 'normal'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
    await evaluate(`const c = document.querySelector('[data-setting="calm"]'); if (c.checked) c.click(); return true;`);
    await sleep(200);
    check(!(await evaluate(`return document.documentElement.classList.contains('calm') || document.documentElement.classList.contains('big-text');`)), 'kunde 4: Rolig visning can be turned off again, and Normal text is back');
    await media('light');
    await a11yAudit('neon-mer');

    // reduced motion: everything is shown at once, nothing tilts
    await media('dark', 'reduce');
    await navigate(BASE + 'index.html#forbruk');
    await waitFor(`document.querySelectorAll('#spend-body .donut .arc').length >= 2`);
    check(await evaluate(`return [...document.querySelectorAll('.donut .arc')].every((g) => Math.abs(parseFloat(g.querySelector('.arc-vis').getAttribute('stroke-dasharray')) - Number(g.dataset.len)) < 0.05) && getComputedStyle(document.querySelector('.arc-vis')).transitionDuration === '0s';`), 'reduced motion: the donut shows its final values at once, no transition');
    await evaluate(`document.querySelectorAll('.donut .arc')[0].dispatchEvent(new MouseEvent('click', { bubbles: true })); return true;`);
    check(await evaluate(`const g = document.querySelector('.donut .arc.sel'); return !!g && getComputedStyle(g).transform === 'none' && getComputedStyle(document.querySelector('.donut-glow')).opacity === '1';`), 'reduced motion: a chosen arc gets a ring instead of growing');
    await v07Shot('neon-dark-forbruk-redusert-bevegelse');
    await tab('hjem');
    const rf = await scaleX('#home-save .meter-fill');
    check(Math.abs(rf - 312 / 650) < 0.01, 'reduced motion: the meter is filled at once', rf);
    await tab('tilbud');
    await waitFor(`document.querySelectorAll('#offer-list .offer').length > 0`);
    await ptr('#offer-list .offer .info', 'pointerdown', 40, 20);
    await sleep(160);
    await ptr('#offer-list .offer .info', 'pointermove', 60, 24);
    await sleep(60);
    check(!(await evaluate(`return document.querySelector('#offer-list .offer').style.transform;`)), 'reduced motion: offer cards do not tilt');
    await ptr('#offer-list .offer .info', 'pointerup', 60, 24);
    fixtureCheck(await evaluate(`const b = document.querySelector('.offer.best'); return !!b && getComputedStyle(b.querySelector('.best-edge')).display === 'none' && !!b.querySelector('.best-tag');`), 'reduced motion: best offers keep the ring and the label, no shine');
  });
}

const ORIG_DB = 'matkassa';
const dbNames = () => evaluate(`return (await indexedDB.databases()).map((d) => d.name + '@' + d.version).sort();`);
async function isolationTests() {
  // I1. The original Matkassa already lives on this origin (data + caches). Premium installs next to it.
  await inFreshContext('isolation', async () => {
    await navigate(BASE + 'manifest.webmanifest');
    await evaluate(`const db = await new Promise((r, j) => { const q = indexedDB.open('${ORIG_DB}', 1); q.onupgradeneeded = () => q.result.createObjectStore('kv'); q.onsuccess = () => r(q.result); q.onerror = j; });
      await new Promise((r) => { const t = db.transaction('kv', 'readwrite'); const s = t.objectStore('kv');
        s.put([{ id: 'orig-1-FAKE', source: 'manual', store: 'TESTBUTIKK (FAKE)', chain: 'TESTBUTIKK (FAKE)', date: '2026-10-01', total: 99, lines: [{ name: 'TINE HELMELK (FAKE)', amount: 99 }] }], 'receipts');
        s.put([{ id: 'l1', text: 'egg (FAKE)', done: false, added: 1, offer: null }], 'list');
        s.put({ chains: [], hiddenChains: [], area: { name: 'Bergen', lat: 60.3913, lng: 5.3221, radius: 30000 }, geo: 'done', sync: { repo: '${FAKE_REPO}', path: 'spending.json', token: '${FAKE_TOKEN}' } }, 'settings');
        t.oncomplete = r; });
      db.close();
      await (await caches.open('matkassa-v7')).put('/matkassa/index.html', new Response('original shell (FAKE)'));
      await (await caches.open('matkassa-img')).put('/img-FAKE.png', new Response('img'));
      return true;`);
    await navigate(BASE + 'index.html#tilbud');
    check(await waitFor(`navigator.serviceWorker && navigator.serviceWorker.controller`, 15000) || (await navigate(BASE + 'index.html#tilbud'), await waitFor(`navigator.serviceWorker.controller`, 15000)), 'isolation: premium service worker installed and active');
    await sleep(500);
    const keys = await evaluate(`return (await caches.keys()).sort();`);
    check(keys.includes('matkassa-v7') && keys.includes('matkassa-img'), "isolation: the original's caches survive premium's install/activate", keys.join(', '));
    check(keys.some((k) => /^matkassa-premium-v\d+$/.test(k)) && keys.every((k) => k.startsWith('matkassa-premium-') || k === 'matkassa-v7' || k === 'matkassa-img'), 'isolation: premium only adds its own matkassa-premium-* caches', keys.join(', '));
    const names = await dbNames();
    check(names.includes(`${ORIG_DB}@1`) && names.includes(`${APP_DB}@1`), 'isolation: two separate IndexedDB databases, the original still at version 1', names.join(', '));
    check((await readSettings()) === null || !(await readSettings()).sync.token, 'isolation: premium does not pick up the original\'s settings by itself');
    await merPage('avansert');
    check(await waitFor(`!!document.querySelector('[data-action="copy-original"]')`, 5000), 'copy: "Hent data fra Matkassa" offered when the original has data');
    await click('[data-action="copy-original"]');
    await sleep(500);
    const copied = await evaluate(`const db = await new Promise((r) => { const q = indexedDB.open('${APP_DB}'); q.onsuccess = () => r(q.result); });
      const get = (k) => new Promise((r) => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => r(q.result); });
      return { receipts: (await get('receipts') || []).length, list: (await get('list') || []).length, settings: await get('settings') };`);
    check(copied.receipts === 1 && copied.list === 1, 'copy: receipts and list copied into premium', JSON.stringify({ r: copied.receipts, l: copied.list }));
    check(copied.settings.sync.repo === FAKE_REPO && !copied.settings.sync.token && copied.settings.area && copied.settings.area.name === 'Bergen', 'copy: repo name and area copied, GitHub token NOT copied');
    const orig = await evaluate(`const db = await new Promise((r) => { const q = indexedDB.open('${ORIG_DB}'); q.onsuccess = () => r(q.result); });
      const v = db.version; const st = await new Promise((r) => { const q = db.transaction('kv').objectStore('kv').get('settings'); q.onsuccess = () => r(q.result); }); db.close(); return { v, token: st.sync.token };`);
    check(orig.v === 1 && orig.token === FAKE_TOKEN, "copy: the original's database is untouched (version 1, its own token)");
  });

  // I2. No original on this origin: premium must not create an empty 'matkassa' database (that would break it).
  await inFreshContext('no original', async () => {
    await navigate(BASE + 'index.html#tilbud');
    await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 20000);
    await merPage('avansert');
    await sleep(800);
    const names = await dbNames();
    check(!names.some((n) => n.startsWith(`${ORIG_DB}@`)), "isolation: premium never creates the original's database", names.join(', '));
    check(!(await evaluate(`return !!document.querySelector('[data-action="copy-original"]');`)), 'copy: button hidden when there is no original data');
  });
}

/* ---------- premium: motion and native feel ---------- */
const touchDrag = async (x, y0, y1, steps, msPerStep) => {
  await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x, y: y0 }] }, S);
  for (let i = 1; i <= steps; i++) {
    await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x, y: y0 + ((y1 - y0) * i) / steps }] }, S);
    await sleep(msPerStep);
  }
  await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, S);
};
async function motionTests() {
  // M1. + → ✓ morphs in place (same element, not a re-render), so the transition can actually play.
  await tab('tilbud');
  const morph = await evaluate(`const b = [...document.querySelectorAll('#offer-list [data-add]')].find((x) => !x.classList.contains('added'));
    b.click(); await new Promise((r) => setTimeout(r, 50));
    const same = document.contains(b) && b.classList.contains('added');
    const t = getComputedStyle(b.querySelector('.i-check')).transitionProperty;
    b.click(); await new Promise((r) => setTimeout(r, 50));
    return { same, back: !b.classList.contains('added'), t };`);
  check(morph.same && morph.back && /opacity/.test(morph.t) && /transform/.test(morph.t), 'motion: add button morphs + → ✓ in place (opacity/transform transition)', JSON.stringify(morph));
  check(await waitFor(`document.querySelector('#toast').hidden`, 5000), 'motion: toast leaves by itself (exit transition, then hidden)');

  // M2. Press feedback exists on pressables (scale on :active) and hover is gated.
  const rules = await evaluate(`return [...document.styleSheets].flatMap((s) => [...s.cssRules]).map((r) => r.cssText).join(' ');`);
  const press = { btn: /\.btn:active \{[^}]*scale\(0\.97\)/.test(rules), chip: /\.chip:active \{[^}]*scale\(0\.95\)/.test(rules), add: /\.add:active \{[^}]*scale\(0\.92\)/.test(rules) };
  check(press.btn && press.chip && press.add, 'motion: press feedback (scale) on buttons, chips and +', JSON.stringify(press));

  // M3. Bottom sheet: slides up; a flick down on the grabber closes it; a short slow drag snaps back.
  await tab('forbruk');
  await click('[data-action="manual"]');
  await sleep(500);
  const g = await evaluate(`const r = document.querySelector('#dlg-receipt .grabber').getBoundingClientRect(); return { x: r.x + r.width / 2, y: r.y + r.height / 2, open: document.querySelector('#dlg-receipt').open, tf: getComputedStyle(document.querySelector('#dlg-receipt')).transform };`);
  check(g.open && (g.tf === 'none' || /matrix\(1, 0, 0, 1, 0, 0\)/.test(g.tf)), 'sheet: opens and settles at rest', g.tf);
  await shot('10-sheet-open');
  await touchDrag(g.x, g.y, g.y + 40, 8, 60); // slow, short (≈ 0.08 px/ms over the last 100 ms): stays
  await sleep(600);
  check(await evaluate(`return document.querySelector('#dlg-receipt').open;`), 'sheet: a short slow drag snaps back (stays open)');
  await touchDrag(g.x, g.y, g.y + 160, 4, 8); // a flick: closes
  check(await waitFor(`!document.querySelector('#dlg-receipt').open`, 2000), 'sheet: a flick down on the grabber closes it');
  check(await evaluate(`const f = document.querySelector('#receipt-form'); f.store.value = ''; return document.activeElement === document.body || !document.querySelector('dialog[open]');`), 'sheet: nothing left open or focused after the drag');

  // M4. Reduced motion: the sheet fades instead of sliding, nothing moves.
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, S);
  await click('[data-action="manual"]');
  const rm = await evaluate(`const d = document.querySelector('#dlg-receipt'); const cs = getComputedStyle(d); return { tf: cs.transform, tp: cs.transitionProperty };`);
  check((rm.tf === 'none') && !/transform/.test(rm.tp) && /opacity/.test(rm.tp), 'reduced motion: sheet cross-fades, no slide', JSON.stringify(rm));
  await evaluate(`document.querySelector('#dlg-receipt').close(); return true;`);
  await sleep(300);
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, S);

  // M4b. Check-off: the tick shows at once, then the row glides to the bottom (FLIP), not a jump; no glide with reduced motion.
  await tab('liste');
  const flipRun = async () => evaluate(`const first = document.querySelector('#list-items .item:not(.done) input[type=checkbox]');
    if (!first || document.querySelectorAll('#list-items .item').length < 2) return { skip: true };
    const id = first.dataset.toggle; first.click();
    await new Promise((r) => setTimeout(r, 720));
    const moved = [...document.querySelectorAll('#list-items .item')].some((li) => li.getAnimations().some((a) => /translateY/.test(JSON.stringify(a.effect.getKeyframes()))));
    await new Promise((r) => setTimeout(r, 400));
    document.querySelector('[data-toggle="' + id + '"]').click(); await new Promise((r) => setTimeout(r, 1100));
    return { moved };`);
  const fl = await flipRun();
  check(fl.skip || fl.moved, 'motion: checked row glides to its new place (FLIP)', JSON.stringify(fl));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }, { name: 'prefers-reduced-motion', value: 'reduce' }] }, S);
  const flr = await flipRun();
  check(flr.skip || !flr.moved, 'reduced motion: checked row moves without gliding', JSON.stringify(flr));
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, S);

  // M5. Scroll edge: the hairline and compact title appear only once the large title is under the bar.
  await tab('tilbud');
  const top = await evaluate(`return document.querySelector('#topbar').classList.contains('scrolled');`);
  await evaluate(`window.scrollTo(0, 600); await new Promise((r) => setTimeout(r, 400)); return true;`);
  const down = await evaluate(`return document.querySelector('#topbar').classList.contains('scrolled') && getComputedStyle(document.querySelector('#bar-title')).opacity !== '0';`);
  check(!top && down, 'scroll edge: compact title + hairline only when scrolled', JSON.stringify({ top, down }));
  await shot('11-tilbud-scrolled');
  await evaluate(`window.scrollTo(0, 0); return true;`);
}

/* ---------- account + sync against the FAKE Supabase ---------- */
const A_EMAIL = 'ole-FAKE@example.invalid';
const A_PW = 'riktig-passord-FAKE';
const listTexts = () => evaluate(`return [...document.querySelectorAll('#list-items .item .name')].map(n => n.textContent);`);
const kv = (key) => evaluate(`const db = await new Promise(r => { const q = indexedDB.open('${APP_DB}'); q.onsuccess = () => r(q.result); }); return await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('${key}'); q.onsuccess = () => r(q.result ?? null); });`);
async function cloudTests() {
  const A = supa.addUser(A_EMAIL, A_PW);
  supa.seed('list_items', A.id, 'konto-1', { id: 'konto-1', text: 'kaffe fra kontoen', done: false, added: 1 });
  supa.seed('receipts', A.id, 'konto-r1', { id: 'konto-r1', source: 'manual', store: 'KONTOBUTIKK (FAKE)', date: '2026-10-01', total: 99, lines: [] });
  supa.seed('chain_connections', A.id, undefined, undefined, { chain: 'trumf', status: 'connected', connected_at: '2026-10-20T10:00:00Z', last_fetch_at: '2026-10-20T18:00:00Z', last_error: null, secret_id: 'FAKE-SECRET-ID' });
  cloudOn = true;
  try {
    await inFreshContext('cloud', async () => {
      await navigate(BASE + 'index.html#liste');
      await waitFor(`document.querySelector('#list-form')`);
      await evaluate(`document.querySelector('#list-input').value = 'melk lokal'; document.querySelector('#list-form').requestSubmit(); return true;`);
      await merPage('avansert');
      // a (fake) GitHub key on this device must never reach Supabase
      await evaluate(`document.querySelector('#sync-repo').value = '${FAKE_REPO}'; document.querySelector('#sync-token').value = '${FAKE_TOKEN}'; document.querySelector('#sync-form').requestSubmit(); return true;`);
      await waitFor(`/Fra Mac-en: \\d+ nye/.test(document.querySelector('#toast').textContent)`);
      await merPage('konto');
      check(await evaluate(`return !!document.querySelector('#account-card #login-form') && /Logg inn/.test(document.querySelector('#account-card').textContent);`), 'cloud: "Logg inn" shown when a Supabase config is present');
      await a11yAudit('mer-konto');
      await evaluate(`document.querySelector('#login-email').value = '${A_EMAIL}'; document.querySelector('#login-password').value = 'feil-FAKE'; document.querySelector('#login-form').requestSubmit(); return true;`);
      check(await waitFor(`/Feil e-post eller passord/.test(document.querySelector('#toast').textContent)`, 5000), 'cloud: wrong password → clear Norwegian message');
      await evaluate(`document.querySelector('#login-email').value = '${A_EMAIL}'; document.querySelector('#login-password').value = '${A_PW}'; document.querySelector('#login-form').requestSubmit(); return true;`);
      check(await waitFor(`document.querySelector('#dlg-merge').open`, 8000), 'cloud: first login with data on both sides asks how to merge');
      const mergeText = await evaluate(`return document.querySelector('#merge-text').textContent;`);
      check(/kvitteringer/.test(mergeText) && /Kontoen har 1 kvittering og 1 vare\./.test(mergeText), 'cloud: merge dialog shows the counts on both sides', mergeText);
      await shot('10-konto-sla-sammen');
      await evaluate(`document.querySelector('#dlg-merge button[value="merge"]').click(); return true;`);
      check(await waitFor(`/Kontoen er oppdatert/.test(document.querySelector('#toast').textContent)`, 10000), 'cloud: merge + sync finishes');
      await tab('liste');
      const texts = await listTexts();
      check(texts.includes('melk lokal') && texts.includes('kaffe fra kontoen'), 'cloud: merge keeps local and account items', texts.join(', '));
      const rowsA = supa.tables.list_items.filter((r) => r.user_id === A.id && !r.deleted).map((r) => r.data.text);
      check(rowsA.includes('melk lokal'), 'cloud: local item pushed to the user\'s own rows', rowsA.join(', '));
      check(supa.tables.receipts.filter((r) => r.user_id === A.id).length > 1, 'cloud: local receipts pushed, account receipt kept');
      const leaked = supa.log.filter((r) => r.body.includes(FAKE_TOKEN) || r.auth.includes(FAKE_TOKEN) || /"sync"/.test(r.body));
      check(!leaked.length && supa.tables.settings.length === 1 && !JSON.stringify(supa.tables.settings).includes(FAKE_TOKEN), 'cloud: the GitHub key never reaches Supabase (settings = area/chains only)', leaked.map((r) => r.path).join(' '));
      check(supa.log.every((r) => r.apikey === FAKE_ANON) && supa.log.filter((r) => r.path.startsWith('/rest/')).every((r) => /^Bearer FAKE-AT-/.test(r.auth)), 'cloud: anon key + the user\'s own JWT on every call (no service key)');
      // a change here reaches the account a few seconds later
      await evaluate(`const cb = [...document.querySelectorAll('#list-items .item')].find(li => /melk lokal/.test(li.textContent)).querySelector('[data-toggle]'); cb.click(); return true;`);
      const pushed = await (async () => { const end = Date.now() + 9000; while (Date.now() < end) { const r = supa.tables.list_items.find((x) => x.data && x.data.text === 'melk lokal'); if (r && r.data.done) return true; await sleep(300); } return false; })();
      check(pushed, 'cloud: checking off an item syncs on its own (debounced)');
      // another device changes and deletes items → "Synk nå" brings it here
      supa.remoteWrite('list_items', A.id, 'konto-1', { id: 'konto-1', text: 'kaffe (endret på mobilen)', done: false, added: 1 });
      supa.remoteWrite('list_items', A.id, 'konto-2', { id: 'konto-2', text: 'egg fra mobilen', done: false, added: 2 });
      await merPage('konto');
      await click('[data-action="cloud-sync"]');
      await waitFor(`/Kontoen er oppdatert/.test(document.querySelector('#toast').textContent)`, 8000);
      await tab('liste');
      let t2 = await listTexts();
      check(t2.includes('kaffe (endret på mobilen)') && t2.includes('egg fra mobilen'), 'cloud: changes from another device arrive', t2.join(', '));
      supa.remoteWrite('list_items', A.id, 'konto-2', {}, true);
      await merPage('konto');
      await click('[data-action="cloud-sync"]');
      await sleep(1200);
      await tab('liste');
      t2 = await listTexts();
      check(!t2.includes('egg fra mobilen'), 'cloud: a delete on another device arrives (tombstone)');
      // deleting here becomes a tombstone there
      await evaluate(`const li = [...document.querySelectorAll('#list-items .item')].find(li => /kaffe/.test(li.textContent)); li.querySelector('[data-del]').click(); return true;`);
      const tomb = await (async () => { const end = Date.now() + 9000; while (Date.now() < end) { if (supa.tables.list_items.find((x) => x.id === 'konto-1').deleted) return true; await sleep(300); } return false; })();
      check(tomb, 'cloud: deleting here marks it deleted in the account');
      // chain connections: status only, "Koble fra" deletes it, "Koble til" explains honestly
      await merPage('konto');
      await waitFor(`document.querySelector('[data-conn="trumf"]') && /Tilkoblet/.test(document.querySelector('[data-conn="trumf"]').textContent)`, 5000);
      check(await evaluate(`return /Tilkoblet/.test(document.querySelector('[data-conn="trumf"]').textContent) && !!document.querySelector('[data-disconnect="trumf"]') && !!document.querySelector('[data-connect="rema"]');`), 'connect: Mer shows Trumf connected, REMA not');
      check(!supa.log.some((r) => /chain_connections\?select=[^&]*secret/.test(r.path)), 'connect: the app never asks for the secret');
      await click('[data-connect="rema"]');
      check(await waitFor(`/Gjøres fra Mac-en/.test(document.querySelector('#rema-state')?.textContent || '') && /kobles til fra en Mac én gang\. Etterpå kommer kvitteringene av seg selv/.test(document.querySelector('#chain-connect').textContent) && !/reCAPTCHA|Mer → Kjeder/.test(document.querySelector('#chain-connect').textContent) && !!document.querySelector('#chain-connect [data-action="send-mac-link"], #chain-connect [data-action="copy-mac-link"]')`, 5000), 'connect: "Koble til" for REMA opens Mer → Kjeder, which explains it is done on the Mac (no bypassing reCAPTCHA)');
      const ml = await evaluate(`const c = document.querySelector('#chain-connect'); const m = c.querySelector('[data-action="mail-mac-link"]'); return { share: !!navigator.share, btn: !!c.querySelector('[data-action="send-mac-link"]'), copy: !!c.querySelector('[data-action="copy-mac-link"]'), mail: m ? decodeURIComponent(m.getAttribute('href')) : null, two: /ca\\. 2 minutter: én installasjon, så logger du inn hos REMA/.test(c.textContent) };`);
      check(ml.two && (ml.share ? ml.btn : ml.copy && /^mailto:\?subject=.*#mer\/kjeder/s.test(ml.mail || '')), 'round 3: the phone REMA card says what the Mac step is (ca. 2 min) and offers the share sheet, or «Kopier lenke» + «Send på e-post» with a link to Mer → Kjeder', JSON.stringify(ml));
      await merPage('konto');
      await waitFor(`document.querySelector('[data-disconnect="trumf"]')`, 5000);
      await click('[data-disconnect="trumf"]');
      await sleep(500);
      check(!supa.tables.chain_connections.some((r) => r.user_id === A.id && r.chain === 'trumf'), '"Koble fra" deletes the connection (and with it the stored token)');
      await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true }, S);
      check(await noHScroll(), '320 px: Mer with account card has no sideways scroll');
      await shot('11-konto-320');
      await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S);
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, S);
      await shot('12-konto-mork');
      await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, S);
      // log out: local data stays, session gone
      await click('[data-action="logout"]');
      check(!(await kv('cloudSession')) && (await kv('list')).length > 0, 'cloud: log out removes the session, keeps local data');
      check(await evaluate(`return !!document.querySelector('#login-form');`), 'cloud: login form back after logout');
    });
    // second device: fresh browser, same account → no question (nothing local), everything arrives
    await inFreshContext('cloud device 2', async () => {
      await navigate(BASE + 'index.html#mer/konto');
      await waitFor(`document.querySelector('#login-form')`);
      await evaluate(`document.querySelector('#login-email').value = '${A_EMAIL}'; document.querySelector('#login-password').value = '${A_PW}'; document.querySelector('#login-form').requestSubmit(); return true;`);
      check(await waitFor(`/Kontoen er oppdatert/.test(document.querySelector('#toast').textContent)`, 10000), 'cloud device 2: login syncs without a merge question');
      await tab('liste');
      const t = await listTexts();
      check(t.includes('melk lokal') && !t.some((x) => /kaffe/.test(x)), 'cloud device 2: gets the list as it is now (incl. deletes)', t.join(', '));
    });
    // magic link: the app picks the session up from the redirect
    await inFreshContext('cloud magic link', async () => {
      const s = supa.magicLinkToken(A_EMAIL);
      await navigate(BASE + `index.html#access_token=${s.access_token}&expires_in=3600&refresh_token=${s.refresh_token}&token_type=bearer&type=magiclink`);
      check(await waitFor(`location.hash === '#mer' && /Logget inn som/.test(document.querySelector('#account-card')?.textContent || '')`, 10000), 'cloud: magic-link redirect logs in and cleans the URL');
      check(!(await evaluate(`return location.href;`)).includes('access_token'), 'cloud: no token left in the address bar');
    });
  } finally {
    cloudOn = false;
  }
}

/* ---------- the tests ---------- */
try {
  await isolationTests();
  await locationTests();
  await cloudTests();
  // The main run below starts as a user who said no to location (Trondheim), so it doesn't depend on Chrome's prompt.
  await send('Browser.setPermission', { permission: { name: 'geolocation' }, setting: 'denied', origin: ORIGIN });

  // 0. First start opens Hjem with empty states
  await navigate(BASE + 'index.html');
  check(await waitFor(`!document.querySelector('#view-hjem').hidden && !!document.querySelector('#home-spend')`), 'hjem: first tab, shown on start');
  check(await evaluate(`return document.querySelector('.tabbar button').dataset.tab === 'hjem' && document.querySelector('.tabbar button[data-tab="hjem"]').getAttribute('aria-current') === 'page';`), 'hjem: first in the tab bar and marked current');
  check(await evaluate(`return /Ingen kvitteringer/.test(document.querySelector('#home-spend').textContent) && /tom/.test(document.querySelector('#home-list').textContent) && !document.querySelector('.home-feat');`), 'hjem: empty states for a new user (no spending, empty list, no "Tilbud for deg")');
  check(await noHScroll(), 'hjem: no horizontal scroll at 390px');
  await a11yAudit('hjem');
  await shot('00-hjem-tom');
  await click('#home-list');
  check(await evaluate(`return !document.querySelector('#view-liste').hidden && location.hash === '#liste';`), 'hjem: tapping the list card opens Handleliste');

  // 1. First start: offers, empty states
  await navigate(BASE + 'index.html#tilbud');
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
  await merPage('avansert');
  check(await evaluate(`return document.querySelector('#sync-repo').value === '';`), 'mer: sync repo is empty by default (no personal default)');
  check(await evaluate(`return !document.querySelector('#account-card') && !/Logg inn/.test(document.querySelector('#view-mer').textContent);`), 'mer: no "Logg inn" without a Supabase config (works fully without an account)');
  await a11yAudit('mer');
  await shot('02-mer-tom');

  // 2. Bad imports
  await tab('forbruk');
  check(/ikke gyldig JSON/.test(await importFixture(path.join(FAKE, 'not-json-FAKE.json'))), 'bad import: not JSON → clear message');
  check(/Fant ingen kvitteringer/.test(await importFixture(path.join(FAKE, 'junk-FAKE.json'))), 'bad import: unknown JSON → clear message');
  check(/Trumf: 1 ny kvittering/.test(await importFixture(path.join(FAKE, 'trumf-FAKE.json'))), 'import: Trumf innsyn (fake)');
  check(/Coop: 2 nye/.test(await importFixture(path.join(FAKE, 'coop-innsyn-FAKE.csv'))), 'import: Coop innsyn CSV (fake, guessed format)');

  // 3. Sync from a (fake) private repo with a (fake) token
  await merPage('avansert');
  await evaluate(`document.querySelector('#sync-repo').value = 'not a repo'; document.querySelector('#sync-token').value = '${FAKE_TOKEN}'; document.querySelector('#sync-form').requestSubmit(); await new Promise(r => setTimeout(r, 300)); return true;`);
  check(/brukernavn\/repo/.test(await toastText()), 'sync: invalid repo name rejected');
  await evaluate(`document.querySelector('#sync-repo').value = 'https://github.com/${FAKE_REPO}.git'; document.querySelector('#sync-token').value = '${FAKE_TOKEN}'; document.querySelector('#sync-form').requestSubmit(); return true;`);
  check(await waitFor(`/Fra Mac-en: 12 nye/.test(document.querySelector('#toast').textContent)`), 'sync: 12 fake receipts fetched from the fake repo (URL form accepted)');
  check(ghRequests.some((r) => r.path.endsWith('/rema-offers.json')), 'sync: also fetches rema-offers.json (barcode offers)');
  check(ghRequests.every((r) => r.auth === `Bearer ${FAKE_TOKEN}`), 'sync: only the fake token was ever sent');
  await sleep(300);
  const coverage = await evaluate(`return [...document.querySelectorAll('#more-body dt')].find(d => d.textContent === 'Med strekkode')?.nextElementSibling.textContent || '';`);
  fixtureCheck(/^2 av \d+/.test(coverage), 'mer: shows share of offers with barcode', coverage);
  await shot('03-mer-synk');

  // 4. Backup never contains the token (kunde 5: backup has its own page, out of "personvern")
  await merPage('personvern');
  const pv = await evaluate(`return document.querySelector('#more-body').textContent;`);
  check(/Hva hentes\?/.test(pv) && /Hvor lagres det\?/.test(pv) && /Hvordan kobler jeg fra\?/.test(pv) && !/Sikkerhetskopi|GitHub|sync\.sh|nøkkel/i.test(pv), 'kunde 5: «Hva skjer med dataene mine?» in plain words, no backup or GitHub details', pv.match(/Sikkerhetskopi|GitHub|sync\.sh|nøkkel/i)?.[0] || '');
  await merPage('backup');
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

  // 4c. A backup with null and broken entries (Maria 4b): checked before anything is saved, and the app still starts
  const poisoned = JSON.parse(backup);
  poisoned.categories = [null, 7, ...poisoned.categories, { name: 'uten id (FAKE)' }];
  poisoned.rules = [null, ...(poisoned.rules || []), { pattern: null, categoryId: 'meieri' }];
  poisoned.list = [null, 'bare tekst', ...(poisoned.list || [])];
  poisoned.receipts = [null, ...(poisoned.receipts || []),
    { id: 'old-FAKE', date: '1900-01-01', total: 10, store: 'FAKE' },
    { id: 'huge-FAKE', date: '2026-10-01', total: 99999999999, store: 'FAKE' },
    { id: 'abc-FAKE', date: '2026-10-01', total: 'abc', store: 'FAKE' }];
  const poisonFile = path.join(OUT, 'backup-poisoned-FAKE.json');
  fs.writeFileSync(poisonFile, JSON.stringify(poisoned));
  const poisonToast = await importFixture(poisonFile);
  check(/hoppet over/.test(poisonToast) && /før år 2000/.test(poisonToast) && /urimelig mye/.test(poisonToast), 'restore: broken entries are skipped, with a message', poisonToast.slice(0, 200));
  const stored = await evaluate(`const db = await new Promise(r => { const q = indexedDB.open('${APP_DB}'); q.onsuccess = () => r(q.result); });
    const get = (k) => new Promise(r => { const q = db.transaction('kv').objectStore('kv').get(k); q.onsuccess = () => r(q.result); });
    const out = {}; for (const k of ['categories', 'rules', 'list', 'receipts']) { const v = await get(k); out[k] = Array.isArray(v) && v.every((x) => x && typeof x === 'object'); }
    out.noBad = !(await get('receipts')).some((r) => /-FAKE$/.test(r.id) && /^(old|huge|abc)/.test(r.id)); return out;`);
  check(Object.values(stored).every(Boolean), 'restore: nothing broken reaches the database', JSON.stringify(stored));
  await navigate(BASE + 'index.html#hjem');
  check(await waitFor(`document.querySelector('#home-body') && document.querySelector('#home-body').children.length > 0`) && !(await evaluate(`return !!document.querySelector('#crash');`)), 'restore: the app starts normally after a broken backup');

  // 4d. Dates of any type and a category list with nothing usable (Jarvis 4c): a message per receipt, categories kept
  const before4c = await kv('categories');
  const broken2 = JSON.parse(backup);
  broken2.categories = [null, { id: 'q' }];
  broken2.list = [...(broken2.list || []), { id: 'q1-FAKE', text: 'x'.repeat(500), qty: 'abc', unit: 'tonn' }, { id: 'q2-FAKE', text: 'melk (FAKE)', qty: -2, unit: 'l' }];
  broken2.receipts = [...(broken2.receipts || []),
    { id: 'numdate-FAKE', date: 20261001, total: 10, store: 'FAKE' },
    { id: 'nulldate-FAKE', date: null, total: 10, store: { navn: 'FAKE' } },
    { id: 'objdate-FAKE', date: { y: 2026 }, total: 10, store: 'FAKE' }];
  const broken2File = path.join(OUT, 'backup-dates-FAKE.json');
  fs.writeFileSync(broken2File, JSON.stringify(broken2));
  const t4c = await importFixture(broken2File);
  check(/hentet inn|gjenopprettet/.test(t4c) && /ukjent dato/.test(t4c) && /mangler en gyldig dato/.test(t4c) && /dine er beholdt/.test(t4c), 'restore 4c: numeric/null/object dates give a friendly message per receipt', t4c.slice(0, 220));
  const after4c = await kv('categories');
  const l4c = (await kv('list')).filter((i) => /^q[12]-FAKE$/.test(i.id));
  check(l4c.length === 2 && l4c[0].text.length === 200 && l4c.every((i) => i.qty === null) && l4c[0].unit === null && l4c[1].unit === 'l', 'restore 4c: list items cleaned (qty a number > 0, known unit, text max 200)', JSON.stringify(l4c.map((i) => [i.text.length, i.qty, i.unit])));
  check(Array.isArray(after4c) && after4c.length === before4c.length && after4c.some((c) => c.id === 'meieri') && !after4c.some((c) => c.id === 'q'), 'restore 4c: a broken category list never wipes the user\'s categories', JSON.stringify(after4c.map((c) => c.id)));
  await tab('tilbud');
  await waitFor(`document.querySelectorAll('#offer-list li').length > 0`);
  const food4c = await evaluate(`return { pressed: document.querySelector('[data-foodonly]')?.getAttribute('aria-pressed'), text: document.querySelector('#offer-list').textContent };`);
  fixtureCheck(food4c.pressed === 'true' && !/DREAMIES|ROSEBUKETT/i.test(food4c.text), 'restore 4c: "Kun mat" still hides non-food after a broken backup', food4c.pressed);

  // 5. Learning: "Tilbud for deg", EAN vs name
  await tab('tilbud');
  check(await waitFor(`!document.querySelector('#for-deg').hidden`), '"Tilbud for deg" appears after receipts are synced');
  const strip = await evaluate(`return [...document.querySelectorAll('#for-deg-list li')].map(li => li.querySelector('.ft').textContent + (li.querySelector('.via') ? ' [EAN]' : ''));`);
  fixtureCheck(strip.some((s) => /Kjeldsberg/i.test(s) && /\[EAN\]/.test(s)), 'EAN match: coffee matched by barcode, shown as "strekkode"', strip.join(' | '));
  fixtureCheck(strip.some((s) => /Helmelk/i.test(s) && !/\[EAN\]/.test(s)), 'name match fallback: milk matched by name (Tjek has no EAN)');
  check(!strip.some((s) => /nudler/i.test(s)), '"Egg" does not pull in "Egg nudler"');
  fixtureCheck(await evaluate(`return /strekkode/.test(document.querySelector('#offer-list').textContent);`), 'offer list card shows the match kind');
  await shot('04-tilbud-for-deg');

  // 5b. Hjem with data: spending overview, list items with offer badges, offers for you
  await tab('liste');
  for (const t of ['melk', 'kaffe', 'egg', 'brød', 'bananer']) await evaluate(`document.querySelector('#list-input').value = '${t}'; document.querySelector('#list-form').requestSubmit(); return true;`);
  await tab('hjem');
  const home = await evaluate(`return { hero: document.querySelector('#home-spend .hero')?.textContent || '', trend: !!document.querySelector('#home-spend svg.mini-trend[aria-label*="Siste 6"]'),
    items: document.querySelectorAll('#home-list .home-items li').length, more: document.querySelector('#home-list .home-more')?.textContent || '',
    badges: document.querySelectorAll('#home-list .deal-tag').length, feat: document.querySelectorAll('.home-feat li').length };`);
  check(/\d.*kr/.test(home.hero) && home.trend, 'hjem: this month total + 6-month mini trend', JSON.stringify(home));
  check(home.items === 4 && /\+\d+ til/.test(home.more), 'hjem: at most 4 unchecked items, "+N til" for the rest', `${home.items} · ${home.more}`);
  fixtureCheck(home.badges > 0, 'hjem: list items on sale get an offer badge', `${home.badges} badges`);
  check(home.feat > 0 && home.feat <= 6, 'hjem: compact "Tilbud for deg" row once something is learned', `${home.feat}`);
  check(await noHScroll(), 'hjem with data: no horizontal scroll');
  const top3 = await evaluate(`const li = [...document.querySelectorAll('.home-feat li')]; return { top: li.filter((x) => x.classList.contains('top')).length, badges: [...document.querySelectorAll('.home-feat .match-badge')].map((b) => b.textContent), firstTop: li[0]?.classList.contains('top'), shadow: li[0] ? getComputedStyle(li[0].querySelector('a')).boxShadow : '', tilbud: document.querySelectorAll('#for-deg-list .feat.top .match-badge').length };`);
  await tab('tilbud');
  const ml = await evaluate(`const top = [...document.querySelectorAll('#for-deg-list .feat.top [data-add]')].map((b) => b.dataset.add); const marked = [...document.querySelectorAll('#offer-list .offer.match')].map((o) => o.dataset.offer);
    return { top, marked, badge: [...document.querySelectorAll('#offer-list .offer.match .match-badge')].length, extra: marked.filter((id) => !top.includes(id)).length, counts: [...document.querySelectorAll('#offer-list .offer')].filter((o) => o.querySelector('.pre')).every((o) => /Teller med i sparemåleren/.test(o.textContent)) && [...document.querySelectorAll('#offer-list .offer')].filter((o) => !o.querySelector('.pre')).every((o) => !o.querySelector('.counts')) };`);
  check(ml.marked.length >= 1 && ml.extra === 0 && ml.badge === ml.marked.length, 'round 3: the «Beste match» items are marked in the main Tilbud list too (and only those)', JSON.stringify(ml));
  check(ml.counts, 'round 3 (Jonas): offers with a regular price say «Teller med i sparemåleren», others do not');
  await tab('hjem');
  check(top3.top === Math.min(3, home.feat) && top3.firstTop && top3.badges.every((t) => t === 'Beste match') && /1\.5px/.test(top3.shadow) && top3.tilbud >= 1 && top3.tilbud <= 3, 'Jonas r2: the «For deg» top 3 get a cyan glow edge and a «Beste match» label (Hjem and Tilbud)', JSON.stringify(top3));
  await a11yAudit('hjem-data');
  await shot('04b-hjem');
  await tab('tilbud');
  await evaluate(`document.querySelector('.tabbar button[data-tab="hjem"]').click(); return true;`);
  check(await evaluate(`const a = getComputedStyle(document.querySelector('#home-body > *')); const b = getComputedStyle(document.querySelector('#home-body > :nth-child(2)')); return a.animationName === 'home-rise' && parseFloat(a.animationDuration) <= 0.3 && parseFloat(b.animationDelay) > 0;`), 'motion: Hjem cards rise in, staggered, ≤ 300 ms');
  await sleep(500);
  check(await evaluate(`return !document.querySelector('#home-body').classList.contains('home-enter');`), 'motion: the arrival plays once per visit (class removed afterwards)');
  check(await evaluate(`return getComputedStyle(document.querySelector('#tab-indicator')).transform.includes('matrix') && document.querySelectorAll('.tabbar button').length === 5;`), 'tab indicator: 5 tabs, indicator on Hjem');
  await click('#home-spend');
  check(await evaluate(`return !document.querySelector('#view-forbruk').hidden;`), 'hjem: tapping the overview opens Forbruk');
  await tab('hjem');
  await click('.home-feat a');
  check(await evaluate(`return !document.querySelector('#view-tilbud').hidden;`), 'hjem: tapping an offer opens Tilbud');

  // 6. Hide a chain
  await merPage('kjeder');
  await evaluate(`const cb = document.querySelector('[data-chainshow="257bxm"]'); cb.click(); return true;`);
  await tab('tilbud');
  const chips = await evaluate(`return [...document.querySelectorAll('#chain-chips .chip')].map(c => c.textContent.trim());`);
  fixtureCheck(!chips.includes('KIWI') && !(await evaluate(`return /KIWI/.test(document.querySelector('#offer-list').textContent);`)), 'hidden chain gone from chips and offers', chips.join(','));
  await merPage('kjeder');
  await evaluate(`document.querySelector('[data-chainshow="257bxm"]').click(); return true;`);

  // 7. Shopping list: name match + barcode remembered from an offer
  await tab('liste');
  await evaluate(`const i = document.querySelector('#list-input'); i.value = 'helmelk'; document.querySelector('#list-form').requestSubmit(); await new Promise(r => setTimeout(r, 200)); return true;`);
  fixtureCheck(await evaluate(`return /På tilbud hos/.test(document.querySelector('#list-items').textContent);`), 'list: "helmelk" finds an offer by name');
  await tab('tilbud');
  await evaluate(`const li = [...document.querySelectorAll('#offer-list .offer')].find(li => /KJELDSBERG/i.test(li.textContent)) || document.querySelector('#offer-list .offer'); li.querySelector('[data-add]').click(); return true;`);
  const item = await evaluate(`const db = await new Promise(r => { const q = indexedDB.open('${APP_DB}'); q.onsuccess = () => r(q.result); }); return await new Promise(r => { const q = db.transaction('kv').objectStore('kv').get('list'); q.onsuccess = () => r(q.result.find(i => /Kjeldsberg/i.test(i.text)) || [...q.result].filter(i => i.offer).sort((a, b) => b.added - a.added)[0]); });`); // live: whatever offer was added
  fixtureCheck(item && item.eans && item.eans.includes('2000000000015'), 'list: item added from an offer remembers its barcode');

  // 7b. Hiding the chain of an offer-linked list item hides its "Tilbud hos …" too (Maria finding 4)
  const linkedChain = item && item.offer ? item.offer.chainId : null;
  const linkedName = item && item.offer ? item.offer.chain : '';
  if (!linkedChain) fixtureCheck(false, 'list: offer-linked item stops showing a hidden chain', 'no offer-linked item');
  else {
    await merPage('kjeder');
    await evaluate(`document.querySelector('[data-chainshow="${linkedChain}"]').click(); return true;`);
    await tab('liste');
    const linkedText = await evaluate(`return [...document.querySelectorAll('#list-items .item')].find(li => li.textContent.includes(${JSON.stringify((item && item.text) || '')}))?.textContent || '';`);
    check(linkedChain && linkedText && !linkedText.includes(`hos ${linkedName}`), 'list: offer-linked item stops showing a hidden chain', linkedText.replace(/\s+/g, ' ').trim().slice(0, 80));
    await merPage('kjeder');
    await evaluate(`document.querySelector('[data-chainshow="${linkedChain}"]').click(); return true;`);
  }

  // 7c. All chains hidden → helpful empty state with a way back (Maria finding 3)
  await evaluate(`for (const cb of document.querySelectorAll('[data-chainshow]')) if (cb.checked) cb.click(); return true;`);
  await tab('tilbud');
  const emptyText = await evaluate(`return document.querySelector('#offer-empty').hidden ? '' : document.querySelector('#offer-empty').textContent;`);
  check(/Alle kjeder er skjult/.test(emptyText) && /Mer → Kjeder/.test(emptyText), 'all chains hidden: empty state says so and points to Mer → Kjeder');
  await click('#offer-empty [data-morego="kjeder"]');
  check(await evaluate(`return !document.querySelector('#view-mer').hidden && !!document.querySelector('[data-chainshow]');`), 'all chains hidden: button opens Mer → Kjeder');
  await evaluate(`for (const cb of document.querySelectorAll('[data-chainshow]')) if (!cb.checked) cb.click(); return true;`);
  await tab('liste');
  check(await noHScroll(), 'liste: no horizontal scroll');
  await a11yAudit('liste');
  await shot('05-liste');

  // 7d. Narrow phone (iPhone SE 1st gen, 320 px): no sideways scroll on any tab (Maria finding 2)
  await send('Emulation.setDeviceMetricsOverride', { width: 320, height: 568, deviceScaleFactor: 2, mobile: true }, S);
  for (const t of ['hjem', 'tilbud', 'liste', 'forbruk', 'mer']) { await tab(t); check(await noHScroll(), `320 px: no horizontal scroll on ${t}`); }
  const clip320 = await evaluate(`return [...document.querySelectorAll('.tabbar button > span')].filter((sp) => sp.scrollWidth > sp.clientWidth).map((sp) => sp.textContent + ' ' + sp.scrollWidth + '>' + sp.clientWidth).join(', ');`);
  check(!clip320, '320 px: no tab label cut off ("Handleliste")', clip320);
  await tab('tilbud');
  await shot('05b-tilbud-320');
  await send('Emulation.setDeviceMetricsOverride', { width: 390, height: 844, deviceScaleFactor: 2, mobile: true }, S);

  // 8. Forbruk with data
  await tab('forbruk');
  check(await evaluate(`return document.querySelectorAll('#spend-body .legend li').length > 0 && /kategorisert/.test(document.querySelector('#spend-body .hero-sub').textContent);`), 'forbruk: categories and % categorised');
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
  await tab('hjem');
  check(await evaluate(`const c = getComputedStyle(document.querySelector('#home-spend')); const t = getComputedStyle(document.querySelector('#home-spend h2')).color; return c.backgroundColor !== 'rgb(255, 255, 255)' && t !== 'rgb(0, 0, 0)';`), 'dark mode: Hjem cards follow the dark theme');
  await shot('08b-hjem-mork');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-reduced-motion', value: 'reduce' }] }, S);
  await tab('tilbud');
  await evaluate(`document.querySelector('.tabbar button[data-tab="hjem"]').click(); return true;`);
  check(await evaluate(`return getComputedStyle(document.querySelector('#home-body > *')).animationName === 'home-fade';`), 'reduced motion: Hjem arrives with a fade only, no movement');
  await send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'light' }] }, S);

  // R4. Customer round 1 changes (Matkassa+ 0.6.1)
  await tab('tilbud');
  await evaluate(`const i = document.querySelector('#offer-search'); i.value = 'melk'; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await sleep(300);
  const melkHits = await evaluate(`return [...document.querySelectorAll('#offer-list .offer .title')].map((t) => t.textContent);`);
  fixtureCheck(melkHits.some((t) => /helmelk/i.test(t)) && melkHits.findIndex((t) => /sjokomelk/i.test(t)) > melkHits.findIndex((t) => /helmelk/i.test(t)), 'r4 search + kunde 7: "melk" finds helmelk first, and sjokomelk after it', melkHits.join(' | '));
  await evaluate(`const i = document.querySelector('#offer-search'); i.value = ''; i.dispatchEvent(new Event('input', { bubbles: true })); return true;`);
  await sleep(300);
  const food = await evaluate(`return { pressed: document.querySelector('[data-foodonly]')?.getAttribute('aria-pressed'), text: document.querySelector('#offer-list').textContent };`);
  fixtureCheck(food.pressed === 'true' && !/DREAMIES|ROSEBUKETT/i.test(food.text), 'r4 Kun mat: on by default, hides pet food and flowers', food.pressed);
  await click('[data-foodonly]');
  await sleep(200);
  fixtureCheck(/ROSEBUKETT/i.test(await evaluate(`return document.querySelector('#offer-list').textContent;`)), 'r4 Kun mat: off shows non-food again');
  await click('[data-foodonly]');
  check(await evaluate(`const t = document.querySelector('.toolbar'); return getComputedStyle(t).position === 'sticky';`), 'r4 design: search toolbar is sticky');

  await tab('liste');
  await evaluate(`document.querySelector('#list-input').value = '2 l melk'; document.querySelector('#list-form').requestSubmit(); return true;`);
  await sleep(250);
  const q = await evaluate(`const li = [...document.querySelectorAll('#list-items .item')].find((x) => x.querySelector('.name').textContent === 'melk' && x.querySelector('.qv').textContent); return { name: li.querySelector('.name').textContent, qty: li.querySelector('.qv').textContent, deal: li.textContent };`);
  check(q.name === 'melk' && q.qty === '2 l', 'r4 list: "2 l melk" → name "melk" and amount "2 l"', JSON.stringify(q));
  fixtureCheck(/På tilbud hos/.test(q.deal) && !/sjokomelk/i.test(q.deal), 'r4 list: the amount does not break matching (milk, not sjokomelk)', q.deal.replace(/\s+/g, ' ').slice(0, 120));
  const melkId = await evaluate(`return [...document.querySelectorAll('#list-items .item')].find((x) => x.querySelector('.qv').textContent === '2 l').dataset.item;`);
  await evaluate(`document.querySelector('[data-inc="${melkId}"]').click(); return true;`);
  check(await evaluate(`return document.querySelector('[data-item="${melkId}"] .qv').textContent;`) === '2,5 l', 'r4 list: + adds half a litre');
  const rowH = await evaluate(`return Math.round([...document.querySelectorAll('#list-items .item')].find((li) => /Ikke på tilbud/.test(li.textContent) || li.querySelector('.deal'))?.getBoundingClientRect().height || 0);`);
  check(rowH >= 44 && rowH <= 60, 'r4 list: compact rows (~52 px)', `${rowH}px`);
  check(await evaluate(`return document.querySelectorAll('#list-items .group-h').length >= 2;`), 'r4 list: grouped by category');
  check(await evaluate(`return [...document.querySelectorAll('.tabbar button > span')].every((sp) => sp.scrollWidth <= sp.clientWidth + 1) && !document.querySelector('#list-badge').hidden;`), 'r4 tabs: "Handleliste" fits next to its badge at 390 px');
  fixtureCheck(await evaluate(`return !document.querySelector('#list-total').hidden && /ca\\./.test(document.querySelector('#list-total').textContent) && /Billigst samlet/.test(document.querySelector('#list-total').textContent);`), 'r4 list: total and cheapest store');
  fixtureCheck(await evaluate(`return document.querySelectorAll('#list-usual [data-usual]').length > 0;`), 'r4 list: "Det du pleier å kjøpe" chips from the receipts');
  // swipe right = check off, swipe left = delete (+ Angre)
  const touchSwipe = async (y, x0, x1) => {
    await send('Input.dispatchTouchEvent', { type: 'touchStart', touchPoints: [{ x: x0, y }] }, S);
    for (let i = 1; i <= 8; i++) { await send('Input.dispatchTouchEvent', { type: 'touchMove', touchPoints: [{ x: x0 + ((x1 - x0) * i) / 8, y }] }, S); await sleep(16); }
    await send('Input.dispatchTouchEvent', { type: 'touchEnd', touchPoints: [] }, S);
  };
  const rowAt = async (n) => evaluate(`const li = [...document.querySelectorAll('#list-items .item:not(.done)')][${n}]; li.scrollIntoView({ block: 'center' }); await new Promise(r => setTimeout(r, 100)); const r = li.querySelector('.name').getBoundingClientRect(); return { id: li.dataset.item, y: r.y + r.height / 2, x: r.x + 10 };`);
  let sw = await rowAt(0);
  await touchSwipe(sw.y, sw.x, sw.x + 200);
  await sleep(300);
  check(await evaluate(`return document.querySelector('[data-item="${sw.id}"]').classList.contains('done');`), 'r4 swipe: right checks the item off');
  await sleep(900);
  sw = await rowAt(0);
  const before = await evaluate(`return document.querySelectorAll('#list-items .item').length;`);
  await touchSwipe(sw.y, sw.x + 120, sw.x - 10); // start left of the amount stepper
  await sleep(600);
  check(!(await evaluate(`return !!document.querySelector('[data-item="${sw.id}"]');`)) && /Slettet/.test(await toastText()), 'r4 swipe: left deletes, with an Angre toast');
  await click('#toast .toast-act');
  await sleep(200);
  check(await evaluate(`return document.querySelectorAll('#list-items .item').length;`) === before, 'r4 swipe: Angre brings it back');
  // share (no Web Share in headless → clipboard or the copy sheet), paste a list
  await evaluate(`navigator.share = undefined; navigator.clipboard.writeText = async (t) => { window.__shared = t; }; return true;`);
  await click('[data-action="share-list"]');
  await sleep(200);
  check(/^Handleliste\n- 2,5 l melk/m.test(await evaluate(`return window.__shared || '';`)) || /- 2,5 l melk/.test(await evaluate(`return window.__shared || '';`)), 'r4 share: the list as plain text with amounts', await evaluate(`return (window.__shared || '').slice(0, 60);`));
  await click('[data-action="paste-list"]');
  await evaluate(`document.querySelector('#paste-text').value = 'Handleliste:\\n- 500 g kjøttdeig\\n• løk\\n3. tomater (FAKE)'; document.querySelector('#paste-add').click(); return true;`);
  await sleep(300);
  const pasted = await listTexts();
  check(['kjøttdeig', 'løk', 'tomater (FAKE)'].every((t) => pasted.includes(t)), 'r4 paste: one item per line, bullets and numbers removed', pasted.slice(0, 6).join(', '));
  // kunde 6 (Linn): the counter under the title follows, "bleier str 5" keeps its size, Lukk closes, tabs close the sheet, Ukas basis
  const cnt = () => evaluate(`return { st: document.querySelector('#status').textContent, open: [...document.querySelectorAll('#list-items .item')].filter((li) => !li.classList.contains('done')).length };`);
  const c1 = await cnt();
  check(new RegExp(`^${c1.open} varer? igjen`).test(c1.st), 'kunde 6: «N varer igjen» is right right after adding', JSON.stringify(c1));
  await click('[data-action="paste-list"]');
  await evaluate(`document.querySelector('#paste-text').value = 'bleier str 5'; document.querySelector('#paste-add').click(); return true;`);
  await sleep(300);
  const c2 = await cnt();
  check(c2.open === c1.open + 1 && new RegExp(`^${c2.open} varer igjen`).test(c2.st) && (await listTexts()).some((t) => /bleier str 5/i.test(t)), 'kunde 6: «bleier str 5» is one item called «bleier str 5», and the counter follows', JSON.stringify(c2));
  await click('[data-action="paste-list"]');
  await click('#paste-form button[value="cancel"]');
  await sleep(450);
  check(!(await evaluate(`return document.querySelector('#dlg-paste').open;`)), 'kunde 6: «Lukk» closes the paste sheet');
  check((await evaluate(`return [...document.querySelectorAll('button')].filter((b) => b.textContent.trim() === 'Lukk').length;`)) === 1, 'Linn r2: only one «Lukk» button in the page (the paste sheet)');
  await click('[data-action="paste-list"]');
  await tab('mer');
  await sleep(200);
  check(!(await evaluate(`return document.querySelector('#dlg-paste').open;`)), 'kunde 6: switching tab closes the paste sheet');
  await tab('liste');
  await click('[data-action="week-basics"]');
  await sleep(300);
  const wb = await listTexts();
  check(['Yoghurt', 'Smør', 'Ost'].every((t) => wb.includes(t)) && wb.filter((t) => /^egg$/i.test(t)).length === 1 && !wb.includes('Melk') && !wb.includes('Bananer'), 'kunde 6 + Maria L7: «Legg inn ukas basis» adds what is missing (helmelk covers Melk, bananer covers Bananer)', wb.slice(0, 12).join(', '));
  const before2 = wb.length;
  await click('[data-action="week-basics"]');
  await sleep(300);
  check((await listTexts()).length === before2, 'kunde 6: Ukas basis twice does not add duplicates');
  const plus = await evaluate(`return [...document.querySelectorAll('#list-items .deal summary u')].map((u) => u.textContent);`);
  fixtureCheck(plus.length > 0 && plus.every((t) => /^\+ \d+ tilbud til \([A-ZÆØÅa-zæøå0-9 ,.-]+\)$/.test(t)), 'kunde 6 + Linn r2: «+2» says «+ 2 tilbud til (MENY, Kiwi)»', plus.join(' | '));

  // Hjem: budget and "Kom i gang"
  await merPage('budsjett');
  await evaluate(`document.querySelector('#budget-input').value = '4 000'; document.querySelector('#budget-form').requestSubmit(); return true;`);
  await sleep(200);
  check(/4\s000 kr i måneden/.test(await evaluate(`return document.querySelector('#more-body').textContent;`)), 'r4 budget: saved and shown in Mer');
  await tab('hjem');
  check(await evaluate(`const b = document.querySelector('#home-spend .budget'); return !!b && /av 4\\s000 kr/.test(b.textContent) && /(igjen|over budsjettet)/.test(b.textContent);`), 'r4 budget: progress and kr left on Hjem');
  // the area step is always done now (kunde 7), so with receipts and chains seen the card has nothing left and goes away
  if (await evaluate(`return !!document.querySelector('#home-start');`)) {
    check(await evaluate(`return document.querySelectorAll('#home-start .start-steps li').length === 3;`), 'r4 kom i gang: three-step card on Hjem');
    await click('[data-action="start-hide"]');
    check(!(await evaluate(`return !!document.querySelector('#home-start');`)), 'r4 kom i gang: "Skjul" removes it');
  } else {
    const st = await readSettings();
    check(st.chainsSeen === true, 'r4 kom i gang: the card hides itself once every step is done', JSON.stringify({ chainsSeen: st.chainsSeen }));
  }

  // Mer: grouped list, plain words, your data, bigger text, danger zone with confirmation
  await tab('mer');
  const root = await evaluate(`return document.querySelector('#more-body').textContent;`);
  check(/Hva skjer med dataene mine\?/.test(root) && /Sikkerhetskopi og import/.test(root) && /Avansert \(for utviklere\)/.test(root) && !/backup|synk|\bEAN\b|JSON|GitHub/i.test(root), 'r4 mer: plain Norwegian on the main list (no backup/synk/EAN/JSON/GitHub)', root.match(/backup|synk|\bEAN\b|JSON|GitHub/i)?.[0] || '');
  check(await evaluate(`return document.querySelectorAll('#more-body .set-row').length >= 8;`), 'r4 mer: grouped rows with subpages');
  await evaluate(`const s = document.querySelector('[data-textsize-select]'); s.value = 'stor'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  const bigText = await evaluate(`return { on: document.documentElement.classList.contains('big-text'), fs: parseFloat(getComputedStyle(document.documentElement).fontSize) };`);
  check(bigText.on && bigText.fs > 18, 'r4 mer: Tekststørrelse → Stor makes all text bigger', JSON.stringify(bigText));
  check(await noHScroll(), 'r4 mer: no horizontal scroll with bigger text');
  const tabClip = () => evaluate(`return [...document.querySelectorAll('.tabbar button > span')].filter((sp) => sp.scrollWidth > sp.clientWidth + 1).map((sp) => sp.textContent).join(', ');`);
  check(!(await tabClip()), 'r4 tabs: no tab label cut off with Større tekst and a badge', await tabClip());
  await evaluate(`const s = document.querySelector('[data-textsize-select]'); s.value = 'normal'; s.dispatchEvent(new Event('change', { bubbles: true })); return true;`);
  await merPage('personvern');
  const kvOff = await evaluate(`return [...document.querySelectorAll('#more-body dl.kv dt')].map((dt) => Math.abs(dt.getBoundingClientRect().top - dt.nextElementSibling.getBoundingClientRect().top)).filter((d) => d > 3).length;`);
  check(kvOff === 0, 'r4 personvern: the facts list lines up (term next to value)', `${kvOff} rows out of line`);
  await click('[data-action="wipe-spending"]');
  await sleep(300);
  check(await evaluate(`return document.querySelector('#dlg-confirm').open && /kvitteringer slettes/.test(document.querySelector('#confirm-text').textContent);`), 'r4 mer: deleting asks first and says what goes');
  await evaluate(`document.querySelector('#dlg-confirm button[value="cancel"]').click(); return true;`);
  await sleep(300);
  await tab('forbruk');
  check(!/Ingen kvitteringer/.test(await evaluate(`return document.querySelector('#spend-body').textContent;`)), 'r4 mer: Avbryt keeps the receipts');
  await a11yAudit('r4-liste-mer');

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

  await motionTests();
  await chainTests();
  await neonTests();
  await whereTests();

  // 11. Offline: service worker serves the app shell, data stays
  check(await waitFor(`navigator.serviceWorker && navigator.serviceWorker.controller`, 15000) || (await navigate(BASE + 'index.html#tilbud'), await waitFor(`navigator.serviceWorker.controller`, 15000)), 'service worker controls the page');
  // 11a. Weak signal: the server answers nothing for 8 s. The app must open from cache in ~3 s, not 3 s per
  // waterfall level (index.html → app.js → module imports) (Maria finding 1).
  await navigate(BASE + 'index.html#tilbud');
  await waitFor(`document.querySelectorAll('#offer-list li').length > 0`);
  stallMs = 8000;
  const s0 = Date.now();
  await send('Page.navigate', { url: BASE + 'index.html#tilbud' }, S);
  await sleep(300);
  const shown = await waitFor(`document.readyState !== 'loading' && document.querySelectorAll('#offer-list li').length > 0`, 12000);
  const stallTime = Date.now() - s0;
  check(shown && stallTime < 3700, 'stalled network: offers visible in under ~3.5 s', `${stallTime} ms`);
  stallMs = 0;
  await sleep(500);

  serverUp = false;
  await send('Network.emulateNetworkConditions', { offline: true, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
  await navigate(BASE + 'index.html#tilbud');
  check(await waitFor(`document.querySelectorAll('#offer-list li').length > 0`, 15000), 'offline: app shell from cache, offers from IndexedDB');
  await tab('liste');
  check(await evaluate(`return /helmelk/i.test(document.querySelector('#list-items').textContent);`), 'offline: shopping list still there');
  await shot('09-offline-liste');
  await send('Network.emulateNetworkConditions', { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 }, S);
  serverUp = true;

  // 12. No console errors (offline fetch failures and favicon are expected noise)
  const errs = consoleErrors.filter((e) => !/ERR_INTERNET_DISCONNECTED|Failed to fetch|net::ERR_|Tjek-feil|status of 40[14]|status of 400 \(Bad Request\) https:\/\/matkassa-fake\.supabase\.co\/auth\/v1\/token\?grant_type=password/.test(e));
  check(!errs.length, 'no unexpected console errors', errs.slice(0, 5).join(' | '));
  if (dialogs.length) warn('confirm()/alert() dialogs auto-accepted', dialogs.join(' | '));

  // 13. A start-up that fails shows a way out, never a blank screen (Maria 4b). Runs last: it resets the data.
  const plural = await evaluate(`return /(^|[^\\d,])1 (varer|kvitteringer|regler)\\b/.test(document.body.innerText);`);
  check(!plural, 'r4 text: "1 vare", not "1 varer"');
  const { identifier } = await send('Page.addScriptToEvaluateOnNewDocument', { source: `{ const q = Document.prototype.querySelector; Document.prototype.querySelector = function (s) { if (s === '#home-body') throw new Error('FAKE start-up failure'); return q.call(this, s); }; }` }, S);
  await navigate(BASE + 'index.html#hjem');
  check(await waitFor(`!!document.querySelector('#crash') && /Noe gikk galt/.test(document.querySelector('#crash').textContent)`), 'crash: a failed start shows "Noe gikk galt – tilbakestill data?"');
  await send('Page.removeScriptToEvaluateOnNewDocument', { identifier }, S);
  try { await evaluate(`document.querySelector('#crash-reset').click(); return true;`); } catch { /* reloading */ }
  await sleep(1500);
  check(await waitFor(`!document.querySelector('#crash') && document.querySelector('#home-body') && document.querySelector('#home-body').children.length > 0`, 10000)
    && (await kv('list') ?? []).length === 0 && (await kv('settings')) !== null, 'crash: "Tilbakestill data" clears the data (keeps settings) and the app starts');
} catch (e) {
  check(false, 'test run crashed', e.stack || e.message);
} finally {
  const pass = results.filter((r) => r.ok && !r.warn).length;
  const fail = results.filter((r) => !r.ok).length;
  const md = [
    `# Matkassa Premium e2e report`, '', `${new Date().toISOString()} · ${LIVE ? 'live Tjek' : 'fake network'} · 390×844 · **${fail ? 'FAIL' : 'PASS'}** (${pass} passed, ${fail} failed, ${results.filter((r) => r.warn).length} warnings)`, '',
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
    cleanupSync();
  }
  process.exit(fail ? 1 : 0);
}
