// Run: node test/unit.test.mjs   (no dependencies). All data here is FAKE test data.
import fs from 'node:fs';
import { detectImport, summarize, toNumber, mergeReceipts } from '../js/spending.js';
import { makeClassifier, DEFAULT_CATEGORIES, tokens } from '../js/categories.js';
import { buildProfile, scoreOffer, normEan, productKey } from '../js/profile.js';
import { parseExtraOffers, mergeExtraOffers, eanCoverage } from '../js/extra-offers.js';
import { normalizeOffer, AREAS, DEFAULT_AREA } from '../js/tjek.js';
import { defaultSettings, mergeSettings, validArea } from '../js/settings.js';

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
const syncSh = fs.readFileSync(new URL('../ingest/sync.sh', import.meta.url), 'utf8');
ok(!/olecny/i.test(syncSh) && /OFFENTLIG/.test(syncSh), 'sync.sh: no personal default, refuses public repos');

/* ---------- first-run location (geo) ---------- */
ok(defaultSettings().geo === null, 'geo: never asked by default');
ok(mergeSettings(defaultSettings(), { geo: 'done' }).geo === 'done' && mergeSettings(defaultSettings(), { geo: 'x' }).geo === null, 'geo: only known states are kept');
ok(mergeSettings({ ...defaultSettings(), geo: 'asked' }, { geo: 'done' }, { fromBackup: true }).geo === 'asked', 'geo: a backup never changes this device\'s location state');
ok(mergeSettings({ ...defaultSettings(), geo: 'done' }, { chains: [] }).geo === 'done', 'geo: kept when stored settings lack the field');

/* ---------- service worker: shared origin with Matkassa Premium ---------- */
ok(/k\.startsWith\(PREFIX\) && k !== VERSION/.test(swSrc) && /const PREFIX = 'matkassa-v'/.test(swSrc), 'sw: only deletes its own caches (premium copy shares the origin)');
ok(!'matkassa-premium-v1'.startsWith('matkassa-v') && !'matkassa-premium-img'.startsWith('matkassa-v'), 'sw: premium cache names fall outside this prefix');

/* ---------- weekly sync (launchd) ---------- */
const tpl = fs.readFileSync(new URL('../ingest/launchd/matkassa-weekly-sync.plist.template', import.meta.url), 'utf8');
ok(/__APP_DIR__/.test(tpl) && /__PATH__/.test(tpl) && !/\/Users\//.test(tpl) && /StartCalendarInterval/.test(tpl), 'launchd: plist is a template with placeholders, no personal paths');
const runSync = fs.readFileSync(new URL('../ingest/launchd/run-sync.sh', import.meta.url), 'utf8');
ok(/GIT_TERMINAL_PROMPT=0/.test(runSync) && /last-run\.txt/.test(runSync) && /mask/.test(runSync), 'launchd: no git prompts, status file, token masking');
ok(fs.readFileSync(new URL('../.gitignore', import.meta.url), 'utf8').includes('ingest/logs/'), 'launchd: logs are git-ignored');

console.log(failed ? `\n${failed} FAILED` : '\nAll unit tests passed');
