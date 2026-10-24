// Run: node test/unit.test.mjs   (no dependencies). All data here is FAKE test data.
import fs from 'node:fs';
import { detectImport, summarize, toNumber, mergeReceipts, monthCompare } from '../js/spending.js';
import { makeClassifier, DEFAULT_CATEGORIES, tokens } from '../js/categories.js';
import { buildProfile, scoreOffer, normEan, productKey } from '../js/profile.js';
import { parseExtraOffers, mergeExtraOffers, eanCoverage } from '../js/extra-offers.js';
import { normalizeOffer, AREAS, DEFAULT_AREA } from '../js/tjek.js';
import { defaultSettings, mergeSettings, validArea } from '../js/settings.js';
import { reconcile, hash, stable, pickSettings, cloudConfigured, Cloud } from '../js/cloud.js';

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
ok(!/localStorage|sessionStorage/.test(appSrcP), 'app: no shared localStorage keys at all (everything in its own IndexedDB)');
ok(/matkassa-premium-backup-/.test(appSrcP), 'app: own backup file name (same, compatible backup format)');

/* ---------- motion lint: the never-ship rules from the design skills, checked on styles.css ---------- */
const css = fs.readFileSync(new URL('../styles.css', import.meta.url), 'utf8').replace(/\/\*[\s\S]*?\*\//g, '');
ok(!/transition:\s*all|transition-property:\s*all/.test(css), 'motion: no `transition: all`');
ok(!/ease-in[;,)\s]/.test(css.replace(/ease-in-out/g, '')), 'motion: no ease-in on UI');
ok(!/scale\(0\)/.test(css), 'motion: nothing animates from scale(0)');
ok(/--ease-out: cubic-bezier\(0\.23, 1, 0\.32, 1\)/.test(css) && /--ease-drawer: cubic-bezier\(0\.32, 0\.72, 0, 1\)/.test(css), 'motion: easing tokens from the skill');
const durations = [...css.matchAll(/(\d+)ms/g)].map((m) => Number(m[1]));
ok(durations.every((d) => d <= 400 || d === 700 || d === 1200), 'motion: UI durations ≤ 400 ms (spinner/pulse excepted)', durations.join(','));
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

console.log(failed ? `\n${failed} FAILED` : '\nAll unit tests passed');
