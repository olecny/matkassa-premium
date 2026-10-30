// Run: node test/unit.test.mjs   (no dependencies). All data here is FAKE test data.
import fs from 'node:fs';
import { detectImport, detectImportText, summarize, toNumber, mergeReceipts, monthCompare, parseCSV, dedupeReceipts, validateReceipts, notFinite, cleanBackup, friendlyError } from '../js/spending.js';
import { makeClassifier, DEFAULT_CATEGORIES, tokens, matchOffer, parseQty, qtyStep, qtyText, migrateCategories, compatible, wordMatch, NON_FOOD, keywordCategory } from '../js/categories.js';
import { buildProfile, scoreOffer, normEan, productKey } from '../js/profile.js';
import { parseExtraOffers, mergeExtraOffers, eanCoverage } from '../js/extra-offers.js';
import { normalizeOffer, AREAS, DEFAULT_AREA } from '../js/tjek.js';
import { defaultSettings, mergeSettings, validArea } from '../js/settings.js';
import { reconcile, hash, stable, pickSettings, cloudConfigured, Cloud } from '../js/cloud.js';
import { createConnection, pickProvider, isMobileDevice, STATES } from '../js/chains/index.js';
import { macHelperProvider } from '../js/chains/mac-helper.js';
import { REMA } from '../js/chains/rema.js';

let failed = 0;
const ok = (c, m, d = '') => { console.log((c ? 'PASS ' : 'FAIL ') + m + (d && !c ? ` — ${d}` : '')); if (!c) { failed++; process.exitCode = 1; } };
const fake = (f) => JSON.parse(fs.readFileSync(new URL(`./fake/${f}`, import.meta.url)));
const cls = makeClassifier(DEFAULT_CATEGORIES, []);

/* ---------- import + sums ---------- */
const t = detectImport([{ dato: '03.10.2026 12:05', kvitteringsnummer: 'A1', kjede: 'KIWI', butikknavn: 'KIWI Sentrum', varelinjer: [{ varenavn: 'TINE LETTMELK', vareAntallVekt: '1,000', vareBelop: '24,90' }, { varenavn: 'PANT', vareAntallVekt: '1', vareBelop: '2,00' }] }]);
ok(t.kind === 'trumf' && t.data[0].date === '2026-10-03' && t.data[0].total === 26.9, 'trumf bare array');
const t2 = detectImport({ data: { kvitteringer: [{ dato: '03.10.2026', kvitteringsnummer: 5, kjede: 'MENY', varelinjer: [{ varenavn: 'X', vareBelop: 10 }] }] } });
ok(t2.kind === 'trumf' && t2.data[0].total === 10 && t2.data[0].time === null, 'trumf wrapped + date only');
const s = detectImport({ schema: 'matkassa.spending/1', receipts: [{ id: 'r1', source: 'rema', store: 'REMA', date: '2026-10-20', total: 100, lines: [{ name: 'COLA', amount: 91.9, group: 'BRUS (STOR)' }, { name: '????', amount: 8.1 }] }] });
ok(s.kind === 'spending' && s.data[0].lines.length === 2, 'spending.json');
const cls2 = makeClassifier(DEFAULT_CATEGORIES, [{ type: 'text', pattern: '????', categoryId: 'annet' }]);
const m = summarize(s.data, cls2, DEFAULT_CATEGORIES).months.get('2026-10');
ok(Math.abs(m.total - 100) < 1e-9 && Math.abs([...m.byCat.values()].reduce((a, b) => a + b, 0) - 100) < 1e-9, 'month total == sum of categories == receipts');
ok(m.byCat.get('drikke') === 91.9, 'group/keyword → drikke');
ok(toNumber('1.234,50') === 1234.5 && toNumber('24,90 kr') === 24.9, 'toNumber');
try { detectImport({ foo: 1 }); ok(false, 'reject junk'); } catch (e) { ok(/Fant ingen/.test(e.message), 'reject junk'); }
ok(mergeReceipts(s.data, s.data).added === 0, 'merge is idempotent (same id = update)');

/* ---------- fake fixtures are valid and labelled ---------- */
for (const f of fs.readdirSync(new URL('./fake/', import.meta.url))) {
  const raw = fs.readFileSync(new URL(`./fake/${f}`, import.meta.url), 'utf8');
  ok(/FAKE/.test(raw), `fixture ${f} is labelled FAKE`);
}
const spend = detectImport(fake('spending-FAKE.json'));
ok(spend.kind === 'spending' && spend.data.length === 12, 'fake spending.json imports (12 receipts)');
ok(spend.data.every((r) => Math.abs(r.total - r.lines.reduce((a, l) => a + l.amount, 0)) < 0.01), 'fake receipts: line sums = totals');

/* ---------- EAN helpers ---------- */
ok(normEan('07038010000737') === '7038010000737' && normEan(' 7038-0100 ') === '70380100' && normEan('123') === null, 'normEan: GTIN-14 → EAN-13, junk → null');
ok(productKey('TINE HELMELK 3.5% 1.75L') === 'tine helmelk', 'productKey strips sizes');

/* ---------- profile: per user, EAN first, name fallback ---------- */
const now = Date.parse('2026-10-24');
const prof = buildProfile(spend.data, { classify: cls, now });
ok(prof.products.length === 4 && prof.receipts === 12, 'profile: 4 products from 12 fake receipts (pant skipped)');
ok(buildProfile([], { now }).products.length === 0, 'profile: empty receipts → empty profile (new user learns nothing from anyone else)');
const other = buildProfile([{ date: '2026-10-01', lines: [{ name: 'GULROT', amount: 20 }] }], { classify: cls, now });
ok(other.products.length === 1 && scoreOffer(other, tokens('TINE HELMELK')).score === 0, 'profile: built only from the receipts given (other user)');
const sameEan = buildProfile([{ date: '2026-10-01', lines: [{ name: 'KAFFE A', ean: '2000000000015', amount: 1 }, { name: 'FILTERKAFFE B', ean: '2000000000015', amount: 1 }] }], { now });
ok(sameEan.products.length === 1 && sameEan.products[0].n === 2, 'profile: two receipt names with one EAN = one product');

const byEan = scoreOffer(prof, tokens('HELT ANNET NAVN'), { eans: ['2000000000015'], cat: 'torr' });
ok(byEan.via === 'ean' && byEan.score > 0 && /Filterkaffe/i.test(byEan.because.name), 'scoreOffer: EAN match wins even when the names differ');
const byName = scoreOffer(prof, tokens('TINE HELMELK'), { cat: 'meieri' });
ok(byName.via === 'name' && byName.score > 0.2, 'scoreOffer: name fallback without EAN');
ok(scoreOffer(prof, tokens('EGG NUDLER'), { cat: cls('EGG NUDLER') }).score === 0, 'scoreOffer: "Egg" does not match "Egg nudler" (category gate)');
ok(scoreOffer(prof, tokens('FRITTGÅENDE EGG 12 STK'), { cat: cls('FRITTGÅENDE EGG 12 STK') }).score > 0, 'scoreOffer: "Egg" still matches real eggs');
ok(scoreOffer(prof, tokens('TINE HELMELK')).score > 0, 'scoreOffer: old signature (no opts) still works');

/* ---------- extra offers (REMA Superpris with GTIN) merged into Tjek ---------- */
const soon = (s) => (s === 'NOW-2D' ? new Date(Date.now() - 2 * 864e5) : new Date(Date.now() + 5 * 864e5)).toISOString().replace('Z', '+0000');
const tj = fake('tjek-FAKE.json');
const tjekOffers = Object.values(tj.offers).flat().map((o) => normalizeOffer({ ...o, run_from: soon(o.run_from), run_till: soon(o.run_till) }));
const extraRaw = fake('rema-offers-FAKE.json');
extraRaw.offers.forEach((o) => { o.from = new Date(Date.now() - 864e5).toISOString(); o.till = new Date(Date.now() + 864e5).toISOString(); });
const extra = parseExtraOffers(extraRaw);
ok(extra.length === 2 && extra[0].eans[0] === '2000000000015', 'parseExtraOffers');
try { parseExtraOffers({ schema: 'x' }); ok(false, 'parseExtraOffers rejects junk'); } catch { ok(true, 'parseExtraOffers rejects junk'); }
const merged = mergeExtraOffers(tjekOffers, extra);
const kaffe = merged.offers.find((o) => o.id === 'fake-r2');
ok(merged.attached === 1 && kaffe.eans && kaffe.eans.includes('2000000000015'), 'merge: GTIN attached to the matching Tjek offer (same price + shared word)');
ok(merged.added === 1 && merged.offers.some((o) => o.id === 'rema-sp-FAKE-2'), 'merge: unmatched campaign offer added on its own');
ok(!tjekOffers.some((o) => o.eans), 'merge: input not mutated');
ok(!merged.offers.find((o) => o.id === 'fake-r3').eans, 'merge: same price but no shared word → no EAN');
ok(eanCoverage(merged.offers).withEan === 2, 'eanCoverage');
const expired = parseExtraOffers({ ...extraRaw, offers: [{ ...extraRaw.offers[0], till: '2020-01-01T00:00:00Z' }] });
ok(mergeExtraOffers(tjekOffers, expired).attached === 0, 'merge: expired campaign offers ignored');

/* ---------- per-user defaults ---------- */
ok(AREAS.length >= 5 && AREAS.includes(DEFAULT_AREA), 'areas: selectable list incl. default');
const appSrc = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
ok(!/olecny/i.test(appSrc), 'app.js has no hard-wired personal repo');
ok(defaultSettings().sync.repo === '' && defaultSettings().area === null, 'sync repo default is empty, no area set');

/* ---------- settings restore hardening (Maria finding 5) ---------- */
const mine = { ...defaultSettings(), sync: { ...defaultSettings().sync, repo: 'me/my-data-FAKE', token: 'FAKE-TOKEN-NOT-REAL', lastSync: 5 } };
const hostile = { chains: null, hiddenChains: 'abc', area: { name: 'X' }, sync: { repo: 'evil/other-FAKE', token: 'FAKE-OTHER', path: '../x' } };
const restored = mergeSettings(mine, hostile, { fromBackup: true });
ok(restored.sync.repo === 'me/my-data-FAKE' && restored.sync.token === 'FAKE-TOKEN-NOT-REAL' && restored.sync.path === 'spending.json', 'restore: backup cannot change this device\'s sync repo, path or token');
ok(Array.isArray(restored.chains) && restored.chains.length === 0 && Array.isArray(restored.hiddenChains) && restored.hiddenChains.length === 0, 'restore: bad chains/hiddenChains become empty lists');
ok(restored.area === null, 'restore: area without coordinates is dropped (no r_lat=undefined)');
ok(validArea({ name: 'Bergen', lat: 60.39, lng: 5.32 }).radius === 30000 && validArea({ lat: '60', lng: 5 }) === null && validArea({ lat: 91, lng: 5 }) === null, 'validArea: numbers in range, default radius');
const loaded = mergeSettings(defaultSettings(), { sync: { repo: 'me/my-data-FAKE', token: 'FAKE-TOKEN-NOT-REAL' }, area: AREAS[0] });
ok(loaded.sync.repo === 'me/my-data-FAKE' && loaded.sync.token === 'FAKE-TOKEN-NOT-REAL' && loaded.area.name === 'Oslo', 'load from device storage keeps sync + area');
ok(mergeSettings(defaultSettings(), undefined).sync.path === 'spending.json', 'missing settings → defaults');

/* ---------- service worker: slow-network window (Maria finding 1) ---------- */
const swSrc = fs.readFileSync(new URL('../sw.js', import.meta.url), 'utf8');
ok(/slowUntil/.test(swSrc) && /if \(degraded\) return cached/.test(swSrc), 'sw: after one slow request the rest of the load is served from cache');
const missing = fs.readdirSync(new URL('../js/', import.meta.url)).filter((f) => f.endsWith('.js') && !swSrc.includes(`'js/${f}'`));
ok(!missing.length, 'sw: every js module is precached for offline', missing.join(','));
/* ---------- first-run location (geo) ---------- */
ok(defaultSettings().geo === null, 'geo: never asked by default');
ok(mergeSettings(defaultSettings(), { geo: 'done' }).geo === 'done' && mergeSettings(defaultSettings(), { geo: 'x' }).geo === null, 'geo: only known states are kept');
ok(mergeSettings({ ...defaultSettings(), geo: 'asked' }, { geo: 'done' }, { fromBackup: true }).geo === 'asked', 'geo: a backup never changes this device\'s location state');
ok(mergeSettings({ ...defaultSettings(), geo: 'done' }, { chains: [] }).geo === 'done', 'geo: kept when stored settings lack the field');

/* ---------- same origin as the original Matkassa: nothing shared by accident ---------- */
ok(/const PREFIX = 'matkassa-premium-v'/.test(swSrc) && /k\.startsWith\(PREFIX\) && k !== VERSION/.test(swSrc), 'sw: own cache prefix, only deletes its own caches');
ok(/IMG_CACHE = 'matkassa-premium-img'/.test(swSrc), 'sw: own image cache');
for (const theirs of ['matkassa-v7', 'matkassa-v8', 'matkassa-img']) ok(!theirs.startsWith('matkassa-premium-v'), `sw: never deletes the original's cache ${theirs}`);
ok(!'matkassa-premium-v1'.startsWith('matkassa-v'), "sw: the original's cleanup (prefix matkassa-v) can't match our caches");
const dbSrc = fs.readFileSync(new URL('../js/db.js', import.meta.url), 'utf8');
ok(/const DB_NAME = 'matkassa-premium'/.test(dbSrc), 'db: own IndexedDB database');
ok(/onupgradeneeded = \(\) => req\.transaction\.abort\(\)/.test(dbSrc) && !/indexedDB\.open\(ORIGINAL_DB,/.test(dbSrc), "db: reading the original never creates or upgrades its database");
ok(!/\.put\(|readwrite/.test(dbSrc.slice(dbSrc.indexOf('export async function readOriginal'), dbSrc.indexOf('export async function persist'))), "db: the original's database is only read");
const manifest = JSON.parse(fs.readFileSync(new URL('../manifest.webmanifest', import.meta.url), 'utf8'));
ok(manifest.scope === './' && manifest.start_url.startsWith('./') && /Premium/.test(manifest.name), 'manifest: relative scope (/matkassa-premium/), own name');
const appSrcP = fs.readFileSync(new URL('../js/app.js', import.meta.url), 'utf8');
{
  // Both apps share the github.io origin. Data lives in IndexedDB; the only localStorage use is the theme mirror
  // (B6: theme before first paint), under a key the original never uses.
  const ls = [...appSrcP.matchAll(/(localStorage|sessionStorage)\.\w+\(([^,)]+)/g)].map((m) => m[2].trim());
  const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
  ok(!/sessionStorage/.test(appSrcP) && ls.length > 0 && ls.every((k) => k === 'THEME_KEY') && /const THEME_KEY = 'matkassa-premium-theme'/.test(appSrcP)
    && /localStorage\.getItem\('matkassa-premium-theme'\)/.test(html) && (!fs.existsSync(new URL('../../mattilbud-app/js/app.js', import.meta.url)) || !/matkassa-premium-theme/.test(fs.readFileSync(new URL('../../mattilbud-app/js/app.js', import.meta.url), 'utf8'))),
  'app: no shared localStorage keys (only the Premium-only theme mirror; everything else in its own IndexedDB)', ls.join(','));
}
ok(/matkassa-premium-backup-/.test(appSrcP), 'app: own backup file name (same, compatible backup format)');

/* ---------- motion lint: the never-ship rules from the design skills, checked on styles.css ---------- */
const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
ok(!/transition:\s*all|transition-property:\s*all/.test(css), 'motion: no `transition: all`');
ok(!/ease-in[;,)\s]/.test(css.replace(/ease-in-out/g, '')), 'motion: no ease-in on UI');
ok(!/scale\(0\)/.test(css), 'motion: nothing animates from scale(0)');
ok(/--ease-out: cubic-bezier\(0\.23, 1, 0\.32, 1\)/.test(css) && /--ease-drawer: cubic-bezier\(0\.32, 0\.72, 0, 1\)/.test(css), 'motion: easing tokens from the skill');
const durations = [...css.matchAll(/(\d+)ms/g)].map((m) => Number(m[1]));
ok(durations.every((d) => d <= 400 || [450, 600, 700, 900, 1200].includes(d)), 'motion: UI durations ≤ 400 ms (spinner/pulse and the v0.7 figure timings from DESIGN.md excepted)', durations.join(','));
const hovers = css.split('@media (hover: hover) and (pointer: fine)');
ok(!/:hover/.test(hovers[0]) && hovers.length === 2 && !/:hover/.test(hovers[1].slice(hovers[1].indexOf('\n}\n'))), 'mobile: every :hover is behind (hover: hover) and (pointer: fine)');
ok(/@media \(prefers-reduced-motion: reduce\)/.test(css) && /@media \(prefers-reduced-transparency: reduce\)/.test(css), 'a11y: reduced motion and reduced transparency handled');
ok(/-webkit-tap-highlight-color: transparent/.test(css) && /touch-action: manipulation/.test(css) && /font-size: 16px/.test(css), 'mobile: no tap flash, no tap delay, no input zoom');
ok(/100dvh|92dvh/.test(css) && !/100vh/.test(css), 'mobile: dvh, not 100vh');
const transitions = [...css.matchAll(/transition(?:-property)?:([^;]+);/g)].map((m) => m[1]);
const layoutProps = transitions.filter((t) => /\b(width|height|top|left|margin|padding)\b/.test(t));
ok(!layoutProps.length, 'performance: no layout properties in transitions (block-size only for the accordion)', layoutProps.join(' | '));
const html = fs.readFileSync(new URL('../index.html', import.meta.url), 'utf8');
ok(/viewport-fit=cover/.test(html) && !/user-scalable=no|maximum-scale=1/.test(html), 'mobile: safe areas on, zoom never disabled');
const motion = await import('../js/motion.js');
ok(motion.shouldDismiss(60, 0.5, 600) && !motion.shouldDismiss(60, 0.05, 600) && motion.shouldDismiss(260, 0.01, 600) && !motion.shouldDismiss(-40, 1, 600), 'sheet: a flick (> 0.11 px/ms) or a third of the height closes; up never closes');
const S = (pts) => pts.map(([t, y]) => ({ t, y }));
ok(Math.abs(motion.releaseVelocity(S([[0, 0], [60, 5], [120, 10], [180, 15], [240, 20]]), 250) - 5 / 60) < 1e-9, 'sheet velocity: averaged over the last 100 ms (slow drag ≈ 0.083 px/ms, below the flick threshold)');
ok(motion.releaseVelocity(S([[0, 0], [8, 40], [16, 80]]), 200) === 0, 'sheet velocity: zero when the finger stopped > 80 ms before lifting');
ok(motion.releaseVelocity(S([[0, 0], [100, 2], [104, 8]]), 105) < 0.11, 'sheet velocity: one jittery event does not make a flick');
ok(motion.releaseVelocity(S([[0, 0], [8, 40], [16, 80], [24, 120]]), 26) > 1, 'sheet velocity: a real flick is fast');
const rb = (x) => motion.rubberband(x, 600);
ok(rb(100) < 100 && rb(400) - rb(300) < rb(100) - rb(0), 'sheet: dragging up rubber-bands (resistance grows)');

/* ---------- Hjem: this month vs same time last month ---------- */
{
  const R = (date, total) => ({ date, total });
  const c = monthCompare([R('2026-10-02', 300), R('2026-10-20', 200), R('2026-09-05', 100), R('2026-09-24', 999), R('2026-09-30', 50), R('2026-08-01', 7)], '2026-10-24');
  ok(c.thisKey === '2026-10' && c.lastKey === '2026-09', 'hjem: month keys');
  ok(c.now === 500 && c.count === 2, 'hjem: this month so far');
  ok(c.lastSoFar === 1099 && c.lastAll === 1149, 'hjem: last month up to the same day vs whole month');
  const j = monthCompare([R('2026-12-31', 10), R('2027-01-03', 5), R('2026-12-02', 4)], '2027-01-03');
  ok(j.lastKey === '2026-12' && j.now === 5 && j.lastSoFar === 4 && j.lastAll === 14, 'hjem: January compares with December');
  ok(monthCompare([], '2026-10-24').now === 0 && monthCompare([{ total: 5 }, null], '2026-10-24').count === 0, 'hjem: empty and broken receipts');
}

/* ---------- cloud sync (Supabase): reconcile is pure ---------- */
{
  ok(stable({ b: 1, a: [2, { d: 1, c: 2 }] }) === stable({ a: [2, { c: 2, d: 1 }], b: 1 }) && hash({ a: 1 }) !== hash({ a: 2 }), 'cloud: stable hash ignores key order');
  const A = { id: 'a', text: 'melk' }, B = { id: 'b', text: 'brød' }, C = { id: 'c', text: 'egg' };
  // first login: nothing known, local A,B; account has B' and C → union, local B wins and is pushed, C added
  let r = reconcile([A, B], {}, [{ id: 'b', data: { id: 'b', text: 'brød (konto)' } }, { id: 'c', data: C }]);
  ok(r.next.map((x) => x.id).join() === 'a,b,c' && r.next[1].text === 'brød', 'cloud: first merge = union, this device wins on the same id');
  ok(r.push.map((p) => p.id).sort().join() === 'a,b' && !r.push.some((p) => p.deleted), 'cloud: first merge pushes local items');
  // replace: use the account's data
  r = reconcile([A, B], {}, [{ id: 'c', data: C }], { replace: true });
  ok(r.next.map((x) => x.id).join() === 'c' && !r.push.length, 'cloud: "use the account\'s data" drops local-only items, pushes nothing');
  // steady state: known = synced hashes
  const known = { a: hash(A), b: hash(B) };
  r = reconcile([A, B], known, [{ id: 'a', data: { id: 'a', text: 'lettmelk' } }]);
  ok(r.next[0].text === 'lettmelk' && !r.push.length, 'cloud: remote change applied when unchanged here');
  r = reconcile([{ ...A, done: true }, B], known, [{ id: 'a', data: { id: 'a', text: 'lettmelk' } }]);
  ok(r.next[0].done === true && r.push.length === 1 && r.push[0].id === 'a', 'cloud: changed on both → this device wins and is pushed');
  r = reconcile([A], known, []);
  ok(r.push.length === 1 && r.push[0].id === 'b' && r.push[0].deleted, 'cloud: local delete becomes a tombstone');
  r = reconcile([A, B], known, [{ id: 'b', deleted: true, data: {} }]);
  ok(r.next.map((x) => x.id).join() === 'a' && !('b' in r.known) && !r.push.length, 'cloud: remote tombstone removes an unchanged item');
  r = reconcile([A, { ...B, text: 'rugbrød' }], known, [{ id: 'b', deleted: true, data: {} }]);
  ok(r.next.length === 2 && r.push[0].id === 'b' && !r.push[0].deleted, 'cloud: edited here after a remote delete → kept and pushed');
  r = reconcile([A, B], known, [{ id: 'x', data: null }, { id: 'y', data: 'junk' }]);
  ok(r.next.length === 2, 'cloud: broken remote rows ignored');
  ok(stable(pickSettings({ area: { name: 'X', lat: 1, lng: 2 }, chains: [], hiddenChains: ['k'], geo: 'done', sync: { token: 'FAKE-TOKEN', repo: 'x/y' } })) === stable({ area: { name: 'X', lat: 1, lng: 2 }, chains: [], hiddenChains: ['k'] }), 'cloud: only area/chains/hiddenChains leave the device (never the GitHub key)');
  ok(!cloudConfigured({ url: '', anonKey: '' }) && !cloudConfigured({ url: 'https://evil.example.com', anonKey: 'x'.repeat(40) }) && cloudConfigured({ url: 'https://abcd-fake.supabase.co', anonKey: 'x'.repeat(40) }), 'cloud: config only counts for a *.supabase.co URL with a key');
  const cfgSrc = fs.readFileSync(new URL('../js/cloud-config.js', import.meta.url), 'utf8');
  ok(!/service_role['"]?\s*[:=]\s*['"][^'"]/.test(cfgSrc) && !/eyJ[A-Za-z0-9_-]{20,}\.eyJ[A-Za-z0-9_-]*InNlcnZpY2Vfcm9sZS/.test(cfgSrc), 'cloud: no service_role key in the config');
}
{
  // REST client against a tiny fake: password login, refresh on expiry, pull paging, push chunks
  const calls = [];
  const res = (status, body) => ({ ok: status < 300, status, json: async () => body });
  let sess = null;
  const fakeFetch = async (url, o = {}) => {
    calls.push({ url, method: o.method || 'GET', headers: o.headers || {}, body: o.body });
    if (url.includes('/auth/v1/token?grant_type=password')) return JSON.parse(o.body).password === 'riktig-FAKE' ? res(200, { access_token: 'AT1', refresh_token: 'RT1', expires_in: 3600, user: { id: 'u1', email: 'a@fake.invalid' } }) : res(400, { error_description: 'Invalid login credentials' });
    if (url.includes('grant_type=refresh_token')) return res(200, { access_token: 'AT2', refresh_token: 'RT2', expires_in: 3600 });
    if (url.includes('/rest/v1/receipts?select')) { const off = Number(/offset=(\d+)/.exec(url)[1]); return res(200, off === 0 ? Array.from({ length: 1000 }, (_, i) => ({ id: 'r' + i })) : [{ id: 'last' }]); }
    if (url.includes('/rest/v1/receipts?on_conflict')) return res(201, JSON.parse(o.body).map((r) => ({ id: r.id, updated_at: '2026-10-24T10:00:00Z' })));
    return res(404, {});
  };
  const c = new Cloud({ config: { url: 'https://abcd-fake.supabase.co', anonKey: 'FAKE-anon' }, fetchImpl: fakeFetch, loadSession: async () => sess, saveSession: async (s) => { sess = s; } });
  await c.init();
  let err = '';
  try { await c.signIn('a@fake.invalid', 'feil'); } catch (e) { err = e.message; }
  ok(err === 'Feil e-post eller passord' && !c.user, 'cloud client: wrong password gives a Norwegian message');
  await c.signIn('a@fake.invalid', 'riktig-FAKE');
  ok(c.user.id === 'u1' && sess.refresh_token === 'RT1', 'cloud client: login stores the session (IndexedDB in the app)');
  c.session.expires_at = Date.now() + 1000;
  const rows = await c.pull('receipts', null);
  ok(rows.length === 1001 && calls.some((x) => x.url.includes('refresh_token')) && calls.filter((x) => x.url.includes('/rest/')).every((x) => x.headers.Authorization === 'Bearer AT2' && x.headers.apikey === 'FAKE-anon'), 'cloud client: refreshes an expiring token, pages through 1000+ rows');
  calls.length = 0;
  await c.push('receipts', Array.from({ length: 450 }, (_, i) => ({ id: 'n' + i, data: { id: 'n' + i } })));
  const posts = calls.filter((x) => x.method === 'POST');
  ok(posts.length === 3 && JSON.parse(posts[0].body).every((r) => r.user_id === 'u1') && /merge-duplicates/.test(posts[0].headers.Prefer), 'cloud client: upserts in chunks of 200 with the user id');
}

/* ---------- Coop innsyn importer (FAKE fixtures; real format unverified) + cross-source dedupe ---------- */
{
  const csv = fs.readFileSync(new URL('./fake/coop-innsyn-FAKE.csv', import.meta.url), 'utf8');
  const c = detectImportText(csv);
  ok(c.kind === 'coop' && c.data.length === 2, 'coop: CSV with one row per product line → 2 receipts', JSON.stringify(c.data.map((r) => r.id)));
  const r1 = c.data.find((r) => r.id === 'coop-FAKE-9001');
  ok(r1 && r1.date === '2026-10-03' && r1.time === '17:42' && r1.total === 112.7 && r1.lines.length === 3 && r1.chain === 'Coop Extra' && r1.source === 'coop', 'coop: date, time, total, chain from the store name');
  ok(r1.lines[0].ean === '2000000000107' && r1.lines[0].qty === 2 && r1.lines[2].ean === null && r1.lines[2].qty === 1.2, 'coop: barcodes, quantities, missing EAN');
  const j = detectImportText(fs.readFileSync(new URL('./fake/coop-innsyn-FAKE.json', import.meta.url), 'utf8'));
  ok(j.kind === 'coop' && j.data.length === 2 && j.data[0].total === 245.5 && j.data[1].chain === 'Coop Obs', 'coop: JSON with one row per purchase');
  const q = parseCSV('a,b\n"x, y","z ""q"""\n')[0];
  ok(q.a === 'x, y' && q.b === 'z "q"', 'csv: quotes and escaped quotes');
  let err = '';
  try { detectImportText('dato;noe\nikke en dato;x\n'); } catch (e) { err = e.message; }
  ok(/CSV/.test(err), 'coop: CSV without receipts gives a clear message', err);
  // the same purchase from Trumf innsyn and trumf.py (different id schemes) collapses to the richer copy
  const innsyn = { id: 'trumf-123456', source: 'trumf', chain: 'KIWI', store: 'KIWI 412 (FAKE)', date: '2026-10-02', time: '17:31', total: 254.3, lines: [{ name: 'MELK', amount: 254.3 }] };
  const api = { id: 'trumf-b987', source: 'trumf', chain: 'Kiwi', store: 'Kiwi 412 (FAKE)', date: '2026-10-02', time: '17:32', total: 254.3, lines: [{ name: 'MELK', ean: '2000000000107', amount: 254.3 }] };
  const later = { ...api, id: 'trumf-b988', time: '19:10' };
  const manual = { id: 'm1', source: 'manual', chain: 'REMA 1000', store: 'REMA 1000', date: '2026-10-02', total: 99, lines: [] };
  const rema = { id: 'rema-55', source: 'rema', chain: 'REMA 1000', store: 'REMA 1000 Test (FAKE)', date: '2026-10-02', time: '12:00', total: 99, lines: [{ name: 'X', ean: '2000000000114', amount: 99 }] };
  const d = dedupeReceipts([innsyn, api, later, manual, rema]);
  ok(d.removed.sort().join() === 'm1,trumf-123456', 'dedupe: same day/chain/total/time ±3 min → one; keeps the copy with barcodes', d.removed.join());
  ok(d.receipts.some((r) => r.id === 'trumf-b988'), 'dedupe: same total two hours later is a different purchase');
  const m = mergeReceipts([innsyn], [api, later]);
  ok(m.receipts.length === 2 && m.duplicates === 1, 'dedupe: merge reports collapsed duplicates', JSON.stringify({ n: m.receipts.length, d: m.duplicates, a: m.added }));
}


/* ---------- round 4: category precision, whole-word/head matching, quantities ---------- */
// Offer names below are public product names copied from Tjek offers for Trondheim on 2026-10-25 (not personal data).
{
  const C = makeClassifier(DEFAULT_CATEGORIES, []);
  const cases = {
    dyremat: ['DREAMIES LAKS OG KYLLING', 'SHEBA FILET KYLLING & TUNFISK', 'WHISKAS/CESAR', 'Gourmet perle/gold', 'PEDIGREE/DREAMIES DYREMAT', 'LATZ MENYBOKSER TIL KATT', 'Tyggeknute/tyggepinner', 'SHEBA SAUCE LOVER TUNFISK'],
    ikkemat: ['NORTHPEAK ACTIVE SOKKER 3 PK', 'Roser, Chrysanthemum og Hyperikum', 'ROSEBUKETT 20 PK', 'HOT WHEELS BASIC CAR', 'XTRA KLESHENGER 5 PK', 'Halloween utskjæringssett', 'XTRA LED LYSPÆRE', 'STEKEPANNE TEFAL HARMONY 28 CM', 'North Peak Lue', 'TULIPANER'],
    hus: ['LAMBI TOALETTPAPIR 8 PK/ TØRKEPAPIR 4 PK', 'ZENDIUM TANNKREM', 'OMO COLOR/HVITT', 'Libero Up&Go 6', 'Kubbelys', 'SUN MAXPOWER ALT I 1'],
    torr: ['KLAR KYLLING, FISK OG GRØNNSAKSBULJONG', 'NUDLER M/KYLLINGSMAK OG KJØTTSMAK', 'Maggi juicy chicken', 'Kebabsaus', 'Bearnaisesaus', 'Havregrøt', 'HAVREGRØT MANDEL OG BLÅBÆR', 'Kokosmelk', 'Hakkede tomater', 'Coop Tortelloni', 'Potetmos', 'Blåbær-/ bringebærsyltetøy', 'Friele frokostkaffe', 'MUTTI PIZZASAUS'],
    ferdigmat: ['MARRY ME CHICKEN', 'BALI KYLLINGGRYTE', 'PASTA SNACK POT BOLOGNESE, CARBONARA OG BACON & LØK', 'KYSTENS FISKEGRATENG', 'Stabburet pai', 'FJORDLAND MIDDAGSFAVORITTER', 'Gorbys pirog', 'Coop Kyllingnuggets'],
    drikke: ['Iste fersken', 'ELDORADO ISTE FERSKEN OG SITRON M/U SUKKER', 'MIN FRUKT SMOOTHIE JORDBÆR, EPLE & PÆRE OG EPLE & BRINGEBÆR', 'IMSDAL NATURELL, FERSKEN OG EPLE', 'FUN LIGHT BRINGEBÆR', 'SUNNIVA EPLEJUICE', 'Coca-Cola zero/Fanta zero/ Sprite zero', 'HUSHOLDNINGSSAFT', 'PANT'],
    snacks: ['RITZ KJEKS OG TUC KJEKS SALT/PAPRIKA', 'MAISKAKER CHIA & HAVSALT, OST OG PAPRIKA', 'Coop maiskake', 'FREIA MELKESJOKOLADE', 'COOP SPRØ CHIPS SALT/PAPRIKA', 'KINDER BUENO, BUENO WHITE OG KINDEREGG', 'MELKERULL, SMIL OG KROKANRULL'],
    meieri: ['LITAGO JORDBÆR- OG SJOKOMELK M/U SUKKER', 'DANONINO DRIKKE JORDBÆR', 'TINE SJOKOMELK', 'Prior Frokostegg', 'PHILADELPHIA ORIGINAL, LIGHT OG LIGHT HVITLØK', 'OLIVERO SMØR-OG OLIVENOLJE', 'Middagsklar Crème fraîche', 'GRESK YOGHURT VANILJE & GRANOLA, PEKAN & HONNING OG SALTED CARAMEL', 'TINE MEIERISMØR', 'Brunost'],
    palegg: ['Leverpostei', 'GRILSTAD GULLSALAMI', 'Kokt skinke', 'PRIOR KYLLINGBACON', 'PRIOR KYLLING SALATKJØTT SPISEKLAR', 'Coop Makrell i tomat', 'Lakserøre', 'KOKT KJØTTPÅLEGG', 'Serranoskinke'],
    fisk: ['Røkt laks', 'FERSKE FISKEKAKER', 'Coop laksefilet', 'REKER NORSKE', 'Klippfisk', 'Sprøbakt lysing', 'Spekesild'],
    kjott: ['KJØTTDEIG STORFE', 'Kyllingfilet', 'Kylling lårfilet', 'Coop ytrefilet av svin', 'GILDE WIENERPØLSE 8 STK', 'Falukorv', 'Baconterninger', 'Gilde Karbonader', 'Lungemos/ blodpudding'],
    frukt: ['COOP GUL LØK 2 STK', 'Bananer', 'Paprika fargemiks 3-pk.', 'ASPARGESBØNNER', 'Änglamark koriander', 'Norske epler 6-pk.', 'GULROT'],
    brod: ['COOP FROKOSTBRØD', 'UTVALGTE WASA KNEKKEBRØD', 'Hvitløksbaguetter 2-pk', 'Rundstykker', 'Hverdagsgrovt', 'COOP FESTKAKE'],
    frossen: ['PIZZA GRANDIOSA PEPPERONI OG ORIGINAL PORSJON', 'FINDUS FISKEPINNER', 'COOP STEINOVNSPIZZA', 'Opphøgde potteter', 'SØRLANDSIS'],
  };
  const wrong = [];
  let n = 0;
  for (const [cat, names] of Object.entries(cases)) for (const name of names) { n++; const got = C(name); if (got !== cat) wrong.push(`${name} → ${got} (want ${cat})`); }
  ok(!wrong.length, `categories: ${n} real Tjek offer names land in the right category`, wrong.join('; '));
  ok(!['DREAMIES LAKS OG KYLLING', 'SHEBA FILET KYLLING & TUNFISK', 'KLAR KYLLING, FISK OG GRØNNSAKSBULJONG', 'NUDLER M/KYLLINGSMAK OG KJØTTSMAK', 'MARRY ME CHICKEN', 'PASTA SNACK POT BOLOGNESE, CARBONARA OG BACON & LØK'].some((x) => C(x) === 'kjott'), 'categories: pet food, stock, noodles and ready meals are never Kjøtt');
  ok(!['Iste fersken', 'RITZ KJEKS OG TUC KJEKS SALT/PAPRIKA', 'HAVREGRØT MANDEL OG BLÅBÆR', 'LITAGO JORDBÆR- OG SJOKOMELK M/U SUKKER', 'Halloween utskjæringssett'].some((x) => C(x) === 'frukt'), 'categories: drinks, crackers and grøt are never Frukt/grønt');
  ok(['hus', 'dyremat', 'ikkemat'].every((c) => NON_FOOD.has(c)) && !NON_FOOD.has('annet') && !NON_FOOD.has('meieri'), 'categories: non-food set (for "Kun mat")');
  ok(['fisk', 'palegg', 'ferdigmat', 'dyremat', 'ikkemat'].every((id) => DEFAULT_CATEGORIES.some((c) => c.id === id)) && DEFAULT_CATEGORIES.find((c) => c.id === 'kjott').name === 'Kjøtt', 'categories: new Fisk, Pålegg, Ferdigmat, Dyremat, Ikke-mat; Kjøtt without fish');

  // migration of a stored v1 list keeps user edits and adds the new ones in store order
  const v1 = [{ id: 'meieri', name: 'Melk og ost', color: '#2a78d6' }, { id: 'kjott', name: 'Kjøtt/fisk', color: '#123456' }, { id: 'frukt', name: 'Frukt/grønt', color: '#008300' }, { id: 'c-x', name: 'Barnemat', color: '#abcdef' }, { id: 'hus', name: 'Husholdning', color: '#5f7186' }];
  const mg = migrateCategories(v1);
  ok(mg.find((c) => c.id === 'meieri').name === 'Melk og ost' && mg.find((c) => c.id === 'kjott').name === 'Kjøtt' && mg.find((c) => c.id === 'kjott').color === '#123456', 'migrate: renames Kjøtt/fisk, keeps user names and colours');
  ok(mg.find((c) => c.id === 'meieri').color !== '#2a78d6' && mg.some((c) => c.id === 'c-x'), 'migrate: untouched old colours become muted, own categories stay');
  ok(['fisk', 'palegg', 'ferdigmat', 'dyremat', 'ikkemat'].every((id) => mg.some((c) => c.id === id)) && mg.findIndex((c) => c.id === 'fisk') === mg.findIndex((c) => c.id === 'kjott') + 1, 'migrate: new categories added next to their neighbours', mg.map((c) => c.id).join());
  ok(migrateCategories(null).length === DEFAULT_CATEGORIES.length, 'migrate: nothing stored → defaults');

  // whole-word / head-noun matching
  const offers = ['Tine sjokomelk', 'Kokosmelk', 'Hoff potetmos', 'TINE LETTMELK 1,75 L', 'Q helmelk', 'FREIA MELKESJOKOLADE', 'PHILADELPHIA ORIGINAL, LIGHT OG LIGHT HVITLØK', 'Hvitløk 3 stk', 'Bladsalat assortert', 'Paprikachips', 'Paprika rød', 'OLIVERO SMØR-OG OLIVENOLJE', 'Filippo Berio olivenolje', 'Kyllingfilet', 'DREAMIES LAKS OG KYLLING', 'Peanøttsmør', 'Tine meierismør']
    .map((t) => ({ t, words: tokens(t), cat: C(t) || 'annet', desc: tokens(t === 'Hoff potetmos' ? 'med melk og smør' : '') }));
  const hits = (q, o = {}) => { const p = parseQty(q); return offers.filter((x) => matchOffer(tokens(p.name), C(p.name), x.words, x.cat, { ...o, desc: x.desc }) > 0).map((x) => x.t); };
  const melk = hits('melk', { prefix: true });
  const strict = hits('melk');
  ok(strict.includes('TINE LETTMELK 1,75 L') && strict.includes('Q helmelk') && !strict.some((t) => /sjokomelk|Kokosmelk|potetmos|MELKESJOKOLADE/i.test(t)), 'match: on the list "melk" is lettmelk/helmelk, not sjokomelk, kokosmelk, potetmos or melkesjokolade', strict.join(' | '));
  const rank = (q) => { const p = parseQty(q); return offers.map((x) => ({ t: x.t, s: matchOffer(tokens(p.name), C(p.name), x.words, x.cat, { prefix: true, desc: x.desc }) })).filter((r) => r.s > 0).sort((a, b) => b.s - a.s).map((r) => r.t); };
  const search = rank('melk');
  ok(search.includes('Tine sjokomelk') && search.indexOf('Tine sjokomelk') > search.indexOf('Q helmelk') && search.indexOf('Tine sjokomelk') > search.indexOf('TINE LETTMELK 1,75 L') && !search.some((t) => /MELKESJOKOLADE/i.test(t)),
    'kunde 7 (Hege): searching «melk» also finds sjokomelk and other milk drinks, ranked after real milk', search.join(' | '));
  ok(hits('2 l melk').join() === hits('melk').join(), 'match: a quantity does not change what "2 l melk" matches');
  const hv = hits('hvitløk');
  ok(hv.length === 1 && hv[0] === 'Hvitløk 3 stk', 'match: "hvitløk" ≠ Philadelphia hvitløk', hv.join(' | '));
  ok(!hits('sort', { prefix: true }).length, 'match: "sort" does not match "assortert"');
  ok(hits('3 stk paprika').join() === 'Paprika rød', 'match: "3 stk paprika" ≠ paprikachips');
  ok(hits('olivenolje').join() === 'Filippo Berio olivenolje', 'match: "olivenolje" ≠ Olivero smør- og olivenolje');
  ok(hits('kylling').join() === 'Kyllingfilet', 'match: "kylling" → kyllingfilet (same kind), not cat food');
  ok(hits('kyll', { prefix: true }).includes('Kyllingfilet'), 'match: search-as-you-type prefix for an unknown word');
  ok(!hits('kyll').length, 'match: no loose prefixes on the shopping list');
  ok(!hits('smør').includes('Peanøttsmør') && hits('smør').includes('Tine meierismør'), 'match: "smør" ≠ peanøttsmør');
  ok(wordMatch('melk', 'lettmelk') === 2 && wordMatch('melk', 'sjokomelk') === 0 && wordMatch('melk', 'melkesjokolade') === 1 && wordMatch('sort', 'assortert') === 0, 'wordMatch: head vs front vs inside');
  ok(compatible('kjott', 'palegg') && compatible('frukt', 'annet') && !compatible('meieri', 'snacks') && !compatible('frukt', 'meieri'), 'compatible: related categories only');

  // quantities
  const pq = (s) => { const r = parseQty(s); return `${r.name}|${r.qty}|${r.unit}`; };
  ok(pq('bleier str 5') === 'bleier str 5|null|null' && pq('sko størrelse 38') === 'sko størrelse 38|null|null' && pq('bleier nr. 4') === 'bleier nr. 4|null|null' && pq('egg 12') === 'egg|12|stk', 'kunde 6: a number after «str»/«størrelse»/«nr» is part of the name, not how many', [pq('bleier str 5'), pq('bleier nr. 4')].join(' / '));
  ok(pq('2 l melk') === 'melk|2|l' && pq('500 g kjøttdeig') === 'kjøttdeig|500|g' && pq('kjøttdeig 500 g') === 'kjøttdeig|500|g', 'qty: "2 l melk", "500 g kjøttdeig", "kjøttdeig 500 g"');
  ok(pq('3 stk paprika') === 'paprika|3|stk' && pq('epler 1 kg') === 'epler|1|kg' && pq('2x melk') === 'melk|2|stk' && pq('melk x2') === 'melk|2|stk' && pq('2 melk') === 'melk|2|stk' && pq('1,5 kg poteter') === 'poteter|1.5|kg', 'qty: stk, kg, 2x, x2, bare number, decimal comma');
  ok(pq('melk') === 'melk|null|null' && pq('4-korn brød') === '4-korn brød|null|null' && pq('Tine helmelk 3.5%') === 'Tine helmelk 3.5%|null|null' && pq('Pepsi max 1,5') === 'Pepsi max 1,5|null|null', 'qty: names with numbers inside stay whole');
  ok(qtyStep('g') === 100 && qtyStep('kg') === 0.5 && qtyStep('stk') === 1 && qtyText(2, 'l') === '2 l' && qtyText(1, 'stk') === '' && qtyText(1.5, 'kg') === '1,5 kg', 'qty: steps and labels');
}

/* ---------- round 4: "Tilbud for deg" reasons per product, not per brand ---------- */
{
  const C = makeClassifier(DEFAULT_CATEGORIES, []);
  const pr = buildProfile([{ date: '2026-10-20', lines: Array.from({ length: 12 }, () => ({ name: 'TINE HELMELK 1.75L', amount: 30 })).concat([{ name: 'BANANER', amount: 20 }]) }], { classify: C, now: Date.parse('2026-10-24') });
  const sc = (t) => scoreOffer(pr, tokens(t), { cat: C(t) });
  ok(sc('Tine helmelk').score > 0.2 && sc('Q helmelk').score > 0.2, 'for deg: the same product (any brand) matches');
  ok(sc('Tine lettmelk').score === 0 && sc('Tine skummetmelk').score === 0 && sc('Tine helmelk 1 l').score > 0.2, 'kunde 7 (Hege): a helmelk buyer is not offered lettmelk or skummetmelk (fat level counts)');
  ok(sc('TINE YOGHURT').score === 0 && sc('TINE RISLUNSJ').score === 0 && sc('TINE REVET OST').score === 0 && sc('TINE SJOKOMELK').score === 0, 'for deg: a Tine helmelk purchase is no reason for every Tine product');
  ok(sc('FREIA MELKESJOKOLADE').score === 0, 'for deg: "melk" at the front of a word is not milk');
}


/* ---------- Maria round 3: import validation, monthCompare with Date, merge with holes (all FAKE data) ---------- */
{
  const NOW = Date.parse('2026-10-25T12:00:00');
  const spendingFile = (receipts) => JSON.stringify({ schema: 'matkassa.spending/1', receipts });
  const imp = detectImportText(spendingFile([
    { id: 'ok-1', store: 'TESTBUTIKK (FAKE)', date: '2026-10-24', total: 100, lines: [] },
    { id: 'neg-1', store: 'TESTBUTIKK (FAKE)', date: '2026-10-23', total: -50, lines: [] },
    { id: 'fut-1', store: 'TESTBUTIKK (FAKE)', date: '2026-10-30', total: 10, lines: [] },
    { id: 'tom-1', store: 'TESTBUTIKK (FAKE)', date: '2026-10-26', total: 10, lines: [] },
  ]), { now: NOW });
  ok(imp.data.map((r) => r.id).sort().join() === 'ok-1,tom-1', 'validate: keeps a normal receipt and one dated tomorrow', imp.data.map((r) => r.id).join());
  ok(imp.rejected.length === 2 && imp.rejected.some((r) => r.id === 'neg-1' && r.reason === 'negativ') && imp.rejected.some((r) => r.id === 'fut-1' && r.reason === 'fremtid'), 'validate: rejects a negative total and a date more than a day ahead');
  ok(imp.rejected.every((r) => /^Kvitteringen \d{2}\.\d{2}\.\d{4} fra TESTBUTIKK \(FAKE\) .*hoppet over\.$/.test(r.message)) && /negativt beløp \(−?-?50,00 kr\)/.test(imp.rejected.find((r) => r.reason === 'negativ').message), 'validate: one friendly Norwegian message per rejected receipt', imp.rejected.map((r) => r.message).join(' | '));
  // 1e309 in JSON is Infinity: never read as 0 or Infinity
  const inf = detectImportText('{"schema":"matkassa.spending/1","receipts":[{"id":"inf-1","store":"FAKE","date":"2026-10-20","total":1e309,"lines":[]},{"id":"inf-2","store":"FAKE","date":"2026-10-20","total":20,"lines":[{"name":"X","amount":1e309}]},{"id":"ok-2","store":"FAKE","date":"2026-10-20","total":20,"lines":[]}]}', { now: NOW });
  ok(inf.data.map((r) => r.id).join() === 'ok-2' && inf.rejected.length === 2 && inf.rejected.every((r) => r.reason === 'tall'), 'validate: non-finite total or line amount (1e309) is rejected, not 0 or Infinity', JSON.stringify(inf.rejected.map((r) => r.id)));
  ok(notFinite(Infinity) && notFinite('1e309') && !notFinite('24,90') && !notFinite(null) && !notFinite('') && !notFinite(0), 'validate: notFinite');
  const tr = detectImport([{ dato: '01.01.2030 12:00', kvitteringsnummer: 'F1', kjede: 'KIWI', butikknavn: 'KIWI (FAKE)', varelinjer: [{ varenavn: 'X', vareBelop: '10,00' }] }, { dato: '03.10.2026 12:00', kvitteringsnummer: 'F2', kjede: 'KIWI', butikknavn: 'KIWI (FAKE)', totalBelop: '-12,00', varelinjer: [] }, { dato: '03.10.2026 12:00', kvitteringsnummer: 'F3', kjede: 'KIWI', varelinjer: [{ varenavn: 'X', vareBelop: '1e309' }] }], { now: NOW });
  ok(tr.kind === 'trumf' && tr.data.length === 0 && tr.rejected.map((r) => r.reason).join() === 'fremtid,negativ,tall', 'validate: Trumf innsyn too (future, negative, non-finite)', JSON.stringify(tr.rejected));
  const coop = detectImportText('Dato;Butikk;Totalbeløp\n03.10.2026;Coop Extra (FAKE);-99,00\n04.10.2026;Coop Extra (FAKE);1e309\n05.10.2026;Coop Extra (FAKE);45,00\n', { now: NOW });
  ok(coop.kind === 'coop' && coop.data.length === 1 && coop.rejected.length === 2, 'validate: Coop CSV too', JSON.stringify(coop.rejected));
  ok(validateReceipts([null, undefined, { id: 'a', date: '2026-10-01', total: 1 }], NOW).receipts.length === 1, 'validate: holes in the list are skipped');
  ok(!('_bad' in imp.data[0]), 'validate: no internal marker left on kept receipts');

  // monthCompare: Date or ISO string, month boundaries
  const R = (date, total) => ({ id: date + total, date, total });
  const rs = [R('2026-10-02', 300), R('2026-09-05', 100), R('2026-09-30', 50)];
  const a = monthCompare(rs, '2026-10-24');
  ok(JSON.stringify(monthCompare(rs, new Date(2026, 9, 24, 15, 30))) === JSON.stringify(a) && JSON.stringify(monthCompare(rs, '2026-10-24T09:00:00')) === JSON.stringify(a), 'monthCompare: a Date, an ISO day and an ISO timestamp give the same result');
  const d31 = monthCompare([R('2026-10-31', 10), R('2026-09-30', 7), R('2026-09-01', 3)], new Date(2026, 9, 31));
  ok(d31.thisKey === '2026-10' && d31.lastKey === '2026-09' && d31.now === 10 && d31.lastSoFar === 10 && d31.lastAll === 10, 'monthCompare: the 31st (previous month has 30 days)', JSON.stringify(d31));
  const mar = monthCompare([R('2026-03-31', 5), R('2026-02-28', 4), R('2026-02-01', 1)], '2026-03-31');
  ok(mar.lastKey === '2026-02' && mar.lastSoFar === 5 && mar.lastAll === 5, 'monthCompare: 31 March vs February (28 days)', JSON.stringify(mar));
  const feb = monthCompare([R('2028-02-29', 8), R('2028-01-29', 2), R('2028-01-30', 9)], new Date(2028, 1, 29));
  ok(feb.thisKey === '2028-02' && feb.lastKey === '2028-01' && feb.now === 8 && feb.lastSoFar === 2 && feb.lastAll === 11, 'monthCompare: leap day 29 February', JSON.stringify(feb));
  const ny = monthCompare([R('2027-01-01', 6), R('2026-12-01', 4), R('2026-12-31', 9)], new Date(2027, 0, 1));
  ok(ny.thisKey === '2027-01' && ny.lastKey === '2026-12' && ny.now === 6 && ny.lastSoFar === 4 && ny.lastAll === 13, 'monthCompare: New Year (1 January vs December)', JSON.stringify(ny));
  ok(monthCompare(null, '2026-10-24').now === 0, 'monthCompare: no receipts at all');
  let threw = false; try { monthCompare([], 'not a date'); } catch { threw = true; }
  ok(threw, 'monthCompare: rejects a bad date instead of guessing');

  // mergeReceipts tolerates holes
  const mm = mergeReceipts([null, R('2026-10-01', 5), undefined], [R('2026-10-02', 6), null]);
  ok(mm.receipts.length === 2 && mm.added === 1 && mm.receipts.every(Boolean), 'merge: null/undefined entries in the existing list (and the new one) are ignored');
  ok(mergeReceipts(undefined, [R('2026-10-02', 6)]).receipts.length === 1, 'merge: no existing list at all');
}

/* ---------- Maria 4b: backups with broken entries, sane receipt ranges, friendly errors ---------- */
{
  const NOW = new Date(2026, 9, 25, 12).getTime();
  const b = cleanBackup({
    categories: [null, 7, 'x', { id: 'meieri', name: 'Meieri', color: '#123456' }, { name: 'uten id' }, { id: 'meieri', name: 'dobbel' }],
    rules: [null, { pattern: null, categoryId: 'meieri' }, { type: 'ean', pattern: 7038010009457, categoryId: 'meieri' }, 'regel'],
    list: [null, 'bare tekst', { text: 'melk' }, { id: 'a', text: '' }, { id: 'b', text: 'brød', done: 1 }],
    receipts: [null, 5, { id: 'ok', date: '2026-10-01', total: 120, lines: [null, { name: 'MELK', amount: 20 }] }, { id: 'old', date: '1900-01-01', total: 10 },
      { id: 'huge', date: '2026-10-01', total: 99999999999 }, { id: 'abc', date: '2026-10-01', total: 'abc' }, { id: 'nodate', total: 5 }, { id: 'inf', date: '2026-10-01', total: Infinity }],
  }, { now: NOW });
  ok(b.categories.length === 1 && b.categories[0].id === 'meieri' && b.categories[0].color === '#123456', 'backup: categories without an id, duplicates and nulls are dropped', JSON.stringify(b.categories));
  ok(b.rules.length === 1 && b.rules[0].type === 'ean' && b.rules[0].pattern === '7038010009457', 'backup: rules need a pattern and a category');
  ok(b.list.length === 2 && b.list.every((i) => i.id && i.text) && b.list[1].done === true, 'backup: list items need a text; ids filled in', JSON.stringify(b.list));
  ok(b.receipts.length === 1 && b.receipts[0].id === 'ok' && b.receipts[0].lines.length === 1, 'backup: only the sane receipt is kept, null lines removed');
  ok(['gammel', 'stor', 'tall', 'dato', 'tall'].every((r, i) => b.rejected[i] && b.rejected[i].reason === r), 'backup: 1900, 99 999 999 999 kr, "abc", no date and Infinity are rejected with reasons', b.rejected.map((r) => r.reason).join());
  ok(b.rejected.every((r) => /hoppet over\.$/.test(r.message)), 'backup: a friendly message per rejected receipt');
  ok(b.dropped > 0 && cleanBackup(null).categories === null && cleanBackup({ categories: 'x', rules: {}, list: 5 }).list.length === 0, 'backup: non-arrays and a missing backup are safe');
  const edge = validateReceipts([{ id: 'a', date: '2000-01-01', total: 99999.99 }, { id: 'b', date: '1999-12-31', total: 5 }, { id: 'c', date: '2026-10-01', total: 100000 }], NOW);
  ok(edge.receipts.length === 1 && edge.receipts[0].id === 'a', 'receipts: sane range is year 2000 or later and under 100 000 kr');
  const sp = detectImport({ schema: 'matkassa.spending/1', receipts: [{ id: 'x', date: '2026-10-01', total: 'abc', lines: [] }, { id: 'y', date: '2026-10-01', total: '12,50', lines: [] }] }, { now: NOW });
  ok(sp.data.length === 1 && sp.data[0].id === 'y' && sp.rejected[0].reason === 'tall', 'import: total "abc" is rejected, not read as 0 kr');
  ok(notFinite('abc') && !notFinite('') && !notFinite('-') && !notFinite('12,50') && !notFinite(null), 'notFinite: text that is not a number is bad, blank or "-" is missing');

  // the classifier never throws on bad entries
  let threw = false;
  try { const c = makeClassifier([null, { id: 'meieri' }, 7], [null, { pattern: null }, { type: 'text', pattern: 'lettmelk', categoryId: 'meieri' }, 'x']); ok(c('TINE LETTMELK') === 'meieri', 'classifier: works with null categories and rules'); } catch (e) { threw = e; }
  ok(!threw, 'classifier: null entries do not throw', String(threw));
  try { makeClassifier(null, null)('melk'); makeClassifier(undefined, 'x')('melk'); } catch (e) { threw = e; }
  ok(!threw, 'classifier: missing lists do not throw');

  ok(friendlyError(new TypeError("Cannot read properties of null (reading 'id')")) === 'Noe gikk galt. Prøv igjen.', 'errors: a raw JS error becomes a friendly sentence');
  ok(/Fikk ikke kontakt/.test(friendlyError(new TypeError('Failed to fetch'))), 'errors: a network error says so in Norwegian');
  ok(friendlyError(new Error('Fila er ikke gyldig JSON eller CSV')) === 'Fila er ikke gyldig JSON eller CSV', 'errors: our own Norwegian messages are kept');
  ok(friendlyError(new SyntaxError('Unexpected token < in JSON at position 0')) === 'Noe gikk galt. Prøv igjen.' && friendlyError(null) === 'Noe gikk galt. Prøv igjen.', 'errors: JSON errors and nothing at all');
}

/* ---------- Maria 4b (Premium): fish fillets, generic tails, non-food, category order ---------- */
{
  for (const n of ['Torskefilet', 'Seifilet', 'Sildefilet', 'Ørretfilet', 'Hyse filet', 'LOFOTEN TORSKEFILET NATURELL 400G', 'Laksefilet']) ok(cls(n) === 'fisk', `fish fillet: ${n} → Fisk`, cls(n));
  for (const n of ['Kyllingfilet', 'Svinefilet', 'Indrefilet av storfe', 'PRIOR KYLLINGFILET 700G']) ok(cls(n) === 'kjott', `meat fillet: ${n} → Kjøtt`, cls(n));
  const hit = (q, title) => matchOffer(tokens(q), keywordCategory(q), tokens(title), cls(title), { prefix: true });
  ok(hit('torsk', 'Torskefilet') > 0 && hit('torsk', 'LOFOTEN TORSKEFILET NATURELL 400G') > 0, 'search: "torsk" finds Torskefilet');
  ok(!hit('torsk', 'Kyllingfilet') && !hit('kyllingfilet', 'Torskefilet'), 'search: a shared "filet" is not a match');
  const fishBuyer = buildProfile([R2('2026-10-01', 'LOFOTEN TORSKEFILET'), R2('2026-10-08', 'LOFOTEN TORSKEFILET')], cls);
  const sc = (t) => scoreOffer(fishBuyer, tokens(t), { cat: cls(t) }).score;
  ok(sc('Kyllingfilet') === 0 && sc('PRIOR KYLLINGFILET 700G') === 0, 'for deg: buying torskefilet does not suggest kyllingfilet (generic tail "filet")');
  ok(sc('Torskefilet naturell') > 0, 'for deg: buying torskefilet still suggests torskefilet');
  for (const n of ['Barnesko str 24-30', 'Grillkull 2,5 kg', 'Tennbriketter', 'Bjørkeved 40 l', 'NORTHPEAK ULLERN VINTERSKO']) ok(NON_FOOD.has(cls(n)), `Kun mat hides: ${n}`, cls(n));
  for (const n of ['Vilje kullsyredrikk', 'SOLBOLLER/SKOLEBRØD', 'Skogsbær']) ok(!NON_FOOD.has(cls(n)), `Kun mat keeps: ${n}`, cls(n));
  const OLD = ['meieri', 'kjott', 'frukt', 'brod', 'torr', 'snacks', 'drikke', 'frossen', 'hus', 'annet'].map((id) => ({ id, name: id, color: '#000' }));
  ok(migrateCategories(OLD).map((c) => c.id).join() === DEFAULT_CATEGORIES.map((c) => c.id).join(), 'migrate: an untouched old order becomes the new store order');
  const custom = [...OLD]; custom.splice(3, 0, { id: 'baby', name: 'Baby', color: '#000' });
  const mc = migrateCategories(custom).map((c) => c.id);
  ok(mc.indexOf('baby') === mc.indexOf('frukt') + 1 && mc[0] === 'frukt', 'migrate: a category the user made stays after the one it followed', mc.join());
  const moved = [OLD[2], OLD[0], OLD[1], ...OLD.slice(3)];
  ok(migrateCategories(moved).slice(0, 2).map((c) => c.id).join() === 'frukt,meieri', 'migrate: a list the user reordered keeps its order');
}
function R2(date, name) { return { id: date + name, date, total: 50, store: 'FAKE', lines: [{ name, amount: 50 }] }; }


/* ---------- Koble til REMA: provider interface + Mac helper provider (FAKE helper, no network) ---------- */
{
  const mem = () => { const m = new Map(); return { getItem: (k) => m.get(k) ?? null, setItem: (k, v) => m.set(k, String(v)), removeItem: (k) => m.delete(k), m }; };
  const CODE = 'FAKE-CODE-ABCD-EFGH';
  const norm = (c) => c.toUpperCase().replace(/[^A-Z0-9]/g, '');
  // A fake helper: same JSON shape as ingest/helper.py.
  const fakeHelper = (opts = {}) => {
    const st = { rema: { state: 'disconnected', lastSync: null, lastSyncOk: null, message: null }, syncing: false, calls: [] };
    const f = async (url, init = {}) => {
      if (opts.down) throw new TypeError('Failed to fetch');
      const path = new URL(url).pathname;
      const auth = (init.headers || {}).Authorization || '';
      st.calls.push(`${init.method} ${path}`);
      const reply = (status, body) => ({ status, json: async () => body });
      if (norm(auth.replace(/^Bearer /, '')) !== norm(CODE)) return reply(401, { error: 'unpaired', helper: 'matkassa' });
      if (path === '/rema/login') st.rema.state = 'connecting';
      if (path === '/sync') st.syncing = true;
      if (path === '/rema/logout') st.rema = { state: 'disconnected' };
      return reply(path === '/status' ? 200 : 202, { helper: 'matkassa', version: 1, rema: { ...st.rema }, syncing: st.syncing, token: undefined });
    };
    return { f, st };
  };
  const timers = () => { const q = []; return { setTimeout: (fn) => { q.push(fn); return q.length; }, clearTimeout: () => {}, run: async () => { const fn = q.shift(); if (fn) await fn(); }, q }; };

  ok(isMobileDevice({ userAgent: 'Mozilla/5.0 (iPhone; CPU iPhone OS 18_0 like Mac OS X)' }), 'chains: an iPhone is a phone');
  ok(isMobileDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit', maxTouchPoints: 5 }), 'chains: an iPad (Mac UA + touch) counts as mobile');
  ok(!isMobileDevice({ userAgent: 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit', maxTouchPoints: 0 }), 'chains: a Mac is not a phone');
  ok(pickProvider({ nav: { userAgent: 'iPhone' } }).id === 'unsupported' && pickProvider({ nav: { userAgent: 'Macintosh' }, storage: mem() }).id === 'mac-helper', 'chains: phone → "Gjøres fra Mac-en", Mac → helper');
  ok(REMA.id === 'rema' && /^#[0-9a-f]{6}$/i.test(REMA.badge.bg) && !/logo|\.png|\.svg|http/i.test(JSON.stringify(REMA)), 'chains: REMA is a text badge (name + colours), no logo file or URL');

  const phone = createConnection(REMA, pickProvider({ nav: { userAgent: 'iPhone' } }));
  ok((await phone.refresh()).state === STATES.UNSUPPORTED && (await phone.login()).state === STATES.UNSUPPORTED, 'chains: on a phone every action says "unsupported", nothing is called');

  const down = macHelperProvider({ storage: mem(), fetchImpl: fakeHelper({ down: true }).f });
  ok((await down.status('rema')).state === 'disconnected', 'mac-helper: before the first tap nothing is asked ("Ikke koblet", no local-network request)');
  ok((await down.login('rema')).state === 'not-installed' && (await down.status('rema')).state === 'not-installed', 'mac-helper: tapping Koble til with no helper → "Hjelper ikke installert" (and stays so on refresh)');
  const ls = mem();
  const h = fakeHelper();
  const p = macHelperProvider({ storage: ls, fetchImpl: h.f });
  await p.status('rema');
  ok(!h.st.calls.length, 'mac-helper: no request to 127.0.0.1 before the user taps');
  ok((await p.login('rema')).state === 'needs-pairing', 'mac-helper: helper there but no code → ask for the code');
  ok((await p.pair('FAKE-WRONG-CODE-0000')).state === 'needs-pairing' && !ls.m.size, 'mac-helper: a wrong code is not saved');
  const before = h.st.calls.length;
  ok((await p.pair('short')).state === 'needs-pairing' && h.st.calls.length === before, 'mac-helper: a too short code is refused before asking the helper');
  ok((await p.pair(' fake-code-abcd-efgh ')).state === 'disconnected' && ls.m.size === 1, 'mac-helper: the right code (any case, spaces) is saved → "Ikke koblet"');
  ok(![...ls.m.values()].join().includes('-'), 'mac-helper: only the normalized code is stored, nothing else');

  const t = timers();
  const changes = [];
  let synced = null;
  const conn = createConnection(REMA, p, { onChange: (s) => changes.push(s.state + (s.syncing ? '+sync' : '')), onSynced: (s) => { synced = s; }, timers: t, pollMs: 1 });
  await conn.refresh();
  ok(conn.status.state === STATES.DISCONNECTED && !t.q.length, 'connection: idle status does not poll');
  await conn.login();
  ok(conn.status.state === STATES.CONNECTING && t.q.length === 1, 'connection: login → "Kobler til …" and polls');
  h.st.rema = { state: 'connected', lastSync: null, lastSyncOk: null };
  await t.run();
  await new Promise((r) => setTimeout(r, 0));
  ok(conn.status.state === STATES.CONNECTED && conn.status.syncing && h.st.calls.includes('POST /sync'), 'connection: when the login ends connected, the first sync starts by itself');
  h.st.syncing = false; h.st.rema.lastSync = '2026-10-29T20:00:00+01:00'; h.st.rema.lastSyncOk = true;
  await t.run();
  ok(!conn.status.syncing && synced && synced.lastSyncOk === true && !t.q.length, 'connection: polling stops and onSynced runs when the sync is done');
  await conn.disconnect();
  ok(conn.status.state === STATES.DISCONNECTED && h.st.calls.includes('POST /rema/logout'), 'connection: "Koble fra" calls the helper logout');
  ok(!changes.some((x) => /token|FAKE-CODE/i.test(x)) && !JSON.stringify(conn.status).includes('ABCD'), 'connection: no code or token ever in a status');
  const throwing = createConnection(REMA, { id: 'x', status: async () => { throw new Error('boom'); } });
  ok((await throwing.refresh()).state === STATES.ERROR, 'connection: a provider that throws gives an error state, not a crash');
}


/* ---------- v0.7 Neon: WCAG contrast of the final tokens in styles.css (dark default + light) ---------- */
{
  const raw = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
  const block = (re) => { const m = re.exec(raw); if (!m) throw new Error('token block missing: ' + re); let i = m.index + m[0].length, depth = 1; const st = i; while (depth) { if (raw[i] === '{') depth++; if (raw[i] === '}') depth--; i++; } return raw.slice(st, i - 1); };
  const tokens = (b) => Object.fromEntries([...b.matchAll(/--([a-z0-9-]+):\s*([^;]+);/g)].map((m) => [m[1], m[2].trim()]));
  const dark = tokens(block(/:root \{/));
  const lightBlock = block(/:root\[data-theme="light"\] \{/);
  const light = { ...dark, ...tokens(lightBlock) };
  const mediaLight = block(/@media \(prefers-color-scheme: light\) \{\s*:root:not\(\[data-theme="dark"\]\) \{/);
  ok(JSON.stringify(tokens(mediaLight)) === JSON.stringify(tokens(lightBlock)), 'theme: the light tokens are the same for prefers-color-scheme and Mer → Tema (Lyst)');
  ok(/color-scheme: dark/.test(block(/:root \{/)), 'theme: dark is the default');
  const parse = (v) => {
    let m = /^#([0-9a-f]{6})$/i.exec(v);
    if (m) return [0, 2, 4].map((i) => parseInt(m[1].slice(i, i + 2), 16)).concat(1);
    m = /^rgb\((\d+) (\d+) (\d+)(?: \/ (\d+)%)?\)$/.exec(v);
    if (m) return [+m[1], +m[2], +m[3], m[4] ? +m[4] / 100 : 1];
    throw new Error('colour? ' + v);
  };
  const over = (fg, bg) => fg.slice(0, 3).map((c, i) => c * fg[3] + bg[i] * (1 - fg[3])).concat(1);
  const lum = (c) => { const [r, g, b] = c.slice(0, 3).map((x) => { x /= 255; return x <= 0.03928 ? x / 12.92 : ((x + 0.055) / 1.055) ** 2.4; }); return 0.2126 * r + 0.7152 * g + 0.0722 * b; };
  const ratio = (a, b) => { const [x, y] = [lum(a), lum(b)].sort((p, q) => q - p); return (x + 0.05) / (y + 0.05); };
  for (const [name, t] of [['dark', dark], ['light', light]]) {
    const col = (k, on) => { const c = parse(t[k]); return c[3] < 1 ? over(c, on) : c; };
    const bad = [];
    const check = (fg, bg, min) => { for (const b of [].concat(bg)) { const bgc = b === 'accent-soft' || b === 'sale-soft' ? over(parse(t[b]), parse(t.surface)) : parse(t[b]); const r = ratio(col(fg, bgc), bgc); if (r < min) bad.push(`${fg} on ${b} ${r.toFixed(2)}`); } };
    const grounds = ['bg', 'surface', 'surface-2', 'sheet'];
    for (const fg of ['text', 'text-2', 'text-3', 'accent', 'sale', 'danger']) check(fg, grounds, 4.5);
    check('badge', ['bg', 'surface'], 4.5);
    check('accent-ink', 'accent', 4.5);
    check('badge-ink', 'badge', 4.5);
    check('danger-ink', 'danger', 4.5);
    check('accent', 'accent-soft', 4.5);
    check('text', 'accent-soft', 4.5);
    check('sale', 'sale-soft', 4.5);
    check('thumb-ink', 'thumb-bg', 4.5);
    for (const k of Object.keys(t).filter((x) => x.startsWith('cat-'))) check(k, 'surface', 3);
    ok(!bad.length, `contrast ${name}: all text ≥ 4.5:1, category colours ≥ 3:1 (WCAG 2.1)`, bad.join(' | '));
    // B3: the donut's keyboard focus ring is --text on the card (--surface); the goal marker's tick too
    const ring = ratio(parse(t.text), parse(t.surface));
    ok(ring >= 3, `contrast ${name}: donut focus ring and goal marker ≥ 3:1 against the card (WCAG 1.4.11)`, ring.toFixed(2));
  }
  ok(/\.arc:focus-visible \.arc-ring/.test(raw) && /\.arc-ring, \.arc-gap \{[^}]*stroke: var\(--text\)/.test(raw) && !/\.arc:focus-visible \.arc-vis/.test(raw), 'a11y: a focused donut arc gets a --text ring, not just a recolour');
  // kunde 3: no text under 13 px (all in rem, so it grows with Tekststørrelse); chips ≥ 44 px
  const small = [...raw.matchAll(/font-size:\s*([\d.]+)(rem|px)/g)].filter((m) => (m[2] === 'rem' ? +m[1] * 16 : +m[1]) < 13).map((m) => m[0]);
  ok(!small.length, 'kunde 3: no text under 13 px anywhere in styles.css', small.join(', '));
  ok(/\.chip \{[^}]*min-height: 44px/.test(raw) && /html\.xbig-text \{ font-size: 137\.5%; \}/.test(raw) && /\.chip\[aria-pressed="true"\]::before/.test(raw), 'kunde 3: chips ≥ 44 px with a check mark when chosen; Ekstra stor text exists');
  ok(/\.toast \{[^}]*background: rgb\(26 33 43/.test(raw), 'kunde 3: toasts are dark in both themes');
  // kunde 4: Rolig visning's softer blue keeps every contrast
  {
    const calmB = block(/html\.calm \{/);
    const ct = { ...dark, ...tokens(calmB) };
    const bad = [];
    for (const b of ['bg', 'surface', 'surface-2', 'sheet']) { const r = ratio(parse(ct.accent), parse(ct[b])); if (r < 4.5) bad.push(`accent on ${b} ${r.toFixed(2)}`); }
    if (ratio(parse(ct['accent-ink']), parse(ct.accent)) < 4.5) bad.push('accent-ink on accent');
    const soft = over(parse(ct['accent-soft']), parse(ct.surface));
    if (ratio(parse(ct.accent), soft) < 4.5 || ratio(parse(ct.text), soft) < 4.5) bad.push('on accent-soft');
    ok(!bad.length && /--glow: none/.test(calmB), 'kunde 4: Rolig visning has no glow and its softer blue is ≥ 4.5:1', bad.join(' | '));
  }
  ok(Object.keys(dark).filter((k) => k.startsWith('cat-')).length === 15, 'theme: a --cat-* colour for each of the 15 default categories');
}


/* ---------- v0.7 figures: pure parts ---------- */
{
  const F = await import('../js/figures.js');
  const lay = F.arcLayout([610, 940, 480, 260, 520, 330, 280, 300, 240, 160]); // FAKE month (DESIGN.md example)
  ok(Math.abs(lay.reduce((a, x) => a + x.frac, 0) - 1) < 1e-9 && lay[0].start === 0 && Math.abs(lay[1].start - 610 / 4120) < 1e-9, 'donut: arcs add up to the whole ring, clockwise from the top');
  ok(lay.every((x) => Math.abs(x.len - (x.frac * F.DONUT.C - 2)) < 1e-9), 'donut: 2 px gap between arcs');
  ok(F.arcLayout([5]).every((x) => Math.abs(x.len - F.DONUT.C) < 1e-9) && F.arcLayout([0, 0]).every((x) => x.len === 0), 'donut: one category is a full ring, nothing spent is no arcs');
  ok(F.arcAt(lay, 100, 20) === 0 && F.arcAt(lay, 180, 100) === 1 && F.arcAt(lay, 99, 20) === 9, 'donut: dragging finds the arc under the finger (top = first, right = second, just left of top = last)');
  ok(F.dash(lay[1]).offset === (-lay[1].start * F.DONUT.C).toFixed(2), 'donut: the dash offset puts an arc at its start angle');
  ok(F.meterFraction(312, 500) === 0.624 && F.meterFraction(900, 500) === 1 && F.meterFraction(0, 500) === 0 && F.meterFraction(10, 0) === 0, 'meter: fill fraction, capped at the goal');
  ok(F.meterScale(312, 500) === 650 && F.meterScale(900, 500) === 1150 && F.meterScale(0, 50) === 100 && F.goalAt(0.8, 650) === 500 && F.goalAt(1, 650) === 650 && F.goalAt(-1, 650) === 50 && F.goalAt(0.83, 650) === 550 && F.goalAt(1, 1e6) === 20000, 'meter: dragging moves the goal in steps of 50 kr within 50–20 000');
  ok(/rotateX\(-8\.00deg\) rotateY\(8\.00deg\)/.test(F.tiltTransform(2, 1)), 'tilbud: tilt is capped at 8° (visible, Jonas)');
}

/* ---------- Kundeprøve 30.10 punkt 1: enhetspris – regresjon med Heges eksempler (FAKE-tilbud, ekte prisformater) ---------- */
{
  const T = await import('../js/tjek.js');
  const g = (pieces, a, b) => ({ unit: { symbol: 'g', si: { symbol: 'kg', factor: 0.001 } }, size: { from: a, to: b || a }, pieces: { from: pieces, to: pieces } });
  const N = (heading, description, price, quantity = null, pre = null) => T.normalizeOffer({ id: 'FAKE-' + heading, heading, description, pricing: { price, pre_price: pre }, quantity, dealer_id: 'FAKE' });
  const regal = N('Utvalgte melsorter', 'Regal, 1 kg. 4 for 50,-', 50, g(1, 1000));
  ok(regal.multi && regal.multi.n === 4 && regal.multi.total === 50 && regal.unitPrice === 12.5 && regal.unit === 'stk', 'Hege: Regal «4 for 50» is 4 for 50 kr and 12,50 kr/stk, not 12,50 kr/kg', JSON.stringify(regal.multi) + regal.unit);
  const regal4 = N('Utvalgte melsorter', 'Regal. 4 for 50', 50, g(4, 1000));
  ok(regal4.unitPrice === 12.5 && regal4.unit === 'stk', 'Hege: Regal with Tjek pieces = 4 is still 12,50 kr/stk (no double count)');
  const perPiece = N('Pålegg', '3 stk for 89,70', 29.9, g(1, 100));
  ok(perPiece.multi.total === 89.7 && perPiece.unitPrice === 29.9, 'multi-buy: a Tjek price that is already per piece is not divided again');
  const treFor2 = N('Yoghurt', 'Ta 3 betal for 2. 3 for 2', 20, g(1, 500));
  ok(treFor2.multi.payFor === 2 && Math.abs(treFor2.unitPrice - 13.33) < 0.01, '«3 for 2»: pay for 2, 13,33 kr/stk');
  const ris = N('Tine rislunsj/sjokomelk/sunniva', 'Tine, 300 g. Pr kg 40,00', 20, g(1, 300));
  ok(ris.unitPrice === 40 && ris.unit === 'kg' && ris.unitSrc === 'kjede', 'Hege: Rislunsj shows the chain\'s 40,00 kr/kg, not our 66,67', ris.unitPrice);
  const makrell = N('King Oscar makrell', '68–110 g. Pr kg fra 220,59', 15, g(1, 68, 110));
  ok(makrell.unitPrice === 220.59 && makrell.unitFrom && makrell.unitSrc === 'kjede', 'Hege: Makrell shows fra 220,59 kr/kg, not fra 136,36', makrell.unitPrice);
  const pepsi = N('Pepsi Max', '10 x 0,33 l', 99);
  ok(pepsi.pieces === 10 && pepsi.perPiece === 9.9 && pepsi.unit === 'l' && pepsi.unitPrice === 30, 'Hege: Pepsi 99 kr is 10 stk · 9,90 kr/stk (30 kr/l)', JSON.stringify([pepsi.pieces, pepsi.perPiece, pepsi.unitPrice]));
  for (const [d, v, u] of [['72,46/KG', 72.46, 'kg'], ['pr. l 9,89', 9.89, 'l'], ['Kilopris fra 99,50', 99.5, 'kg'], ['kr 12,90 pr boks', 12.9, 'stk'], ['Literpris: 21,90', 21.9, 'l']]) {
    const p = T.printedUnitPrice(d);
    ok(p && p.value === v && p.unit === u, `printed unit price: «${d}»`, JSON.stringify(p));
  }
  ok(N('Hel kylling', 'Prior, ca. 1,2 kg', 79.9, g(1, 1200)).unitSrc === 'regnet', 'no printed price: our own kr/kg from the size');
  const gum = N('Extra tyggegummi', '16 g', 10, g(1, 16), 25);
  ok(gum.unitPrice === 625, 'gum: 625 kr/kg (correct, but…)');
  // «Beste tilbud» = lowest unit price among ≥ 3 comparable, not the biggest %
  const it = (id, cat, unitPrice, price, unit = 'kg', extra = {}) => ({ o: { id, unitPrice, unit, price, ...extra }, cat });
  const items = [
    it('gum', 'snacks', 625, 10), it('gum2', 'snacks', 700, 12), it('gum3', 'snacks', 900, 15), it('donut', 'snacks', 300, 12),
    it('kj1', 'kjott', 99, 99), it('kj2', 'kjott', 160, 80), it('kj3', 'kjott', 180, 90), it('kj4', 'kjott', 200, 100),
    it('melk1', 'meieri', 18, 25, 'l'), it('melk2', 'meieri', 19, 27, 'l'), it('melk3', 'meieri', 20, 28, 'l'),
    it('honning', 'torr', 100, 40, 'kg', { prePrice: 100 }), it('torr2', 'torr', 90, 30), it('torr3', 'torr', 95, 35),
  ];
  const best = T.bestValueIds(items);
  ok(best.has('kj1') && !best.has('gum') && !best.has('donut') && !best.has('honning') && !best.has('melk1'), 'Beste tilbud: lowest kr/kg among ≥ 3 like offers (≥ 15 % under the median); no small things under 15 kr, not just % off', [...best].join());
  ok(T.bestValueIds([it('a', 'kjott', 50, 50), it('b', 'kjott', 200, 100)]).size === 0, 'Beste tilbud: needs at least 3 comparable offers');
  const sorted = [{ unitPrice: 30, unit: 'l', price: 99 }, { unitPrice: 625, unit: 'kg', price: 10 }, { unitPrice: 12.5, unit: 'stk', price: 50 }, { unitPrice: null, price: 5 }, { unitPrice: 40, unit: 'kg', price: 20 }].sort(T.byUnitPrice);
  ok(sorted.map((o) => o.unit || '-').join() === 'kg,kg,l,stk,-' && sorted[0].unitPrice === 40, 'Laveste pris: by unit price within kg, l and stk, each on its own');
}

{
  const S = await import('../js/settings.js');
  const m = (inc, cur) => S.mergeSettings(cur ? S.mergeSettings(null, cur) : null, inc);
  ok(m({ bigText: true }).textSize === 'stor' && m({ bigText: false }).textSize === 'normal' && m({ textSize: 'xstor' }).textSize === 'xstor' && m({ textSize: 'huge' }).textSize === 'normal' && m({}, { textSize: 'xstor' }).textSize === 'xstor',
    'kunde 3: Tekststørrelse Normal / Stor / Ekstra stor; an old backup with bigText becomes Stor');
  ok(m({ calm: true }).calm === true && m({}).calm === false && m({ calm: 'ja' }).calm === false, 'kunde 4: Rolig visning is a saved yes/no');
}
/* ---------- Kundeprøve 30.10 punkt 7: kategorier, duplikater og kampanjenavn (FAKE) ---------- */
{
  const T = await import('../js/tjek.js');
  const C = await import('../js/categories.js');
  const offers = [{ id: 'p1', chainId: 'FAKE-B', title: 'Persimon', price: 10 }, { id: 'p2', chainId: 'FAKE-B', title: 'Persimon/kaki', price: 10 },
    { id: 'p3', chainId: 'FAKE-K', title: 'Persimon', price: 10 }, { id: 'm1', chainId: 'FAKE-B', title: 'Tine helmelk', price: 24.9 }, { id: 'm2', chainId: 'FAKE-B', title: 'Tine lettmelk', price: 24.9 }];
  T.dedupeOffers(offers);
  ok(offers.map((o) => o.id).join() === 'p2,p3,m1,m2', 'Hege: «Persimon» and «Persimon/kaki» from one chain at one price are one offer; other chains and other milks stay', offers.map((o) => o.id).join());
  ok(T.isNonProduct('Kronemarked') && T.isNonProduct('Ukens kupp!') && !T.isNonProduct('Smågodt') && !T.isNonProduct('Kronesis'), 'Hege: campaign names without a product (Kronemarked) are hidden');
  const cats = ['Persimon', 'Persimon/kaki', 'Kinakål', 'Surkål', 'Rødkål', 'Toro Bali kylling', 'Kyllingfilet'].map((t) => C.keywordCategory(t));
  ok(cats.join() === 'frukt,frukt,frukt,frukt,frukt,torr,kjott', 'Hege: persimon, kinakål, surkål → Frukt/grønt; Toro Bali kylling → Tørrvarer, not Kjøtt', cats.join());
}

console.log(failed ? `\n${failed} FAILED` : '\nAll unit tests passed');
