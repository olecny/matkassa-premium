import * as db from './db.js';
import { fetchOffers, AREAS, DEFAULT_AREA, byUnitPrice, bestValueIds } from './tjek.js';
import { DEFAULT_CATEGORIES, NON_FOOD, CATEGORY_VERSION, migrateCategories, makeClassifier, normalize, tokens, matchOffer, parseQty, qtyStep, qtyText, pastedLines } from './categories.js';
import { buildProfile, scoreOffer, normEan, productKey } from './profile.js';
import { parseExtraOffers, mergeExtraOffers, eanCoverage } from './extra-offers.js';
import { defaultSettings, mergeSettings, validArea, validBudget } from './settings.js';
import { detectImport, detectImportText, mergeReceipts, summarize, monthCompare, toNumber, UNCAT, BACKUP_SCHEMA, cleanBackup, cleanCategories, cleanRules, cleanList, validateReceipts, notFinite, friendlyError } from './spending.js';
import { Cloud, cloudConfigured, reconcile, pickSettings, hash, COLLECTIONS } from './cloud.js';
import { createConnection, pickProvider, STATES } from './chains/index.js';
import { REMA } from './chains/rema.js';
import { DONUT, arcLayout, dash, arcAt, meterFraction, meterScale, goalAt, enableTilt, shineBestOffers, reducedMotion } from './figures.js';
import { enableSheetDrag, watchLargeTitle, moveTabIndicator, exitRow, flip, enableSwipe, haptic } from './motion.js';

const APP_VERSION = '0.7.1-premium.rc1';
const STALE_MS = 6 * 60 * 60 * 1000;
const PAGE = 60;
const TABS = ['hjem', 'tilbud', 'liste', 'forbruk', 'mer'];

const $ = (sel, root = document) => root.querySelector(sel);
const esc = (s) => String(s ?? '').replace(/[&<>"']/g, (c) => ({ '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 7);
const kr = (n) => (n == null ? '' : n.toLocaleString('nb-NO', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) + ' kr');
const krShort = (n) => Math.round(n).toLocaleString('nb-NO') + ' kr';
const dayFmt = new Intl.DateTimeFormat('nb-NO', { weekday: 'short', day: 'numeric', month: 'numeric' });
const monthFmt = new Intl.DateTimeFormat('nb-NO', { month: 'long', year: 'numeric' });
const monthShort = new Intl.DateTimeFormat('nb-NO', { month: 'short' });
const timeFmt = new Intl.DateTimeFormat('nb-NO', { day: 'numeric', month: 'numeric', hour: '2-digit', minute: '2-digit' });
const titleCase = (s) => (s === s.toUpperCase() ? s.charAt(0) + s.slice(1).toLowerCase() : s);
const todayISO = () => { const d = new Date(); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`; };

const state = {
  tab: 'hjem',
  morePage: null, // Mer subpage (null = the list)
  offersData: null, // {fetchedAt, chains, offers}
  list: [],
  categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
  rules: [],
  receipts: [],
  savings: [], // [{id, at, kr, text}] offers checked off on the list (this device only)
  settings: defaultSettings(), // no personal defaults (see js/settings.js)
  extraOffers: null, // {fetchedAt, source, offers} from the user's data repo (REMA Superpris with barcodes)
  q: '',
  sort: 'fordeg',
  cat: null,
  shown: PAGE,
  month: todayISO().slice(0, 7),
  loading: false,
  error: null,
  persisted: null,
  originalExists: false, // the original Matkassa has data in this browser (same origin)
};

let classify = makeClassifier(state.categories, state.rules);
let offerIndex = []; // [{o, words, cat}]

/* ---------- persistence ---------- */
const synced = (p) => { scheduleCloudSync(); return p; }; // a local change goes to the account a few seconds later
const save = {
  list: () => synced(db.set('list', state.list)),
  categories: () => synced(db.set('categories', state.categories)),
  rules: () => synced(db.set('rules', state.rules)),
  receipts: () => synced(db.set('receipts', state.receipts)),
  settings: () => synced(db.set('settings', state.settings)),
};

/** Mer → Tekststørrelse: Normal / Stor (+19 %) / Ekstra stor (+37,5 %). All text is in rem, so everything grows.
 *  Mer → Rolig visning: no glow, a softer blue, no tilt or shine (on by itself with Ekstra stor). */
function applyTextSize() {
  const size = state.settings.textSize || (state.settings.bigText ? 'stor' : 'normal');
  const root = document.documentElement;
  root.classList.toggle('big-text', size !== 'normal');
  root.classList.toggle('xbig-text', size === 'xstor');
  root.classList.toggle('calm', !!state.settings.calm);
  // mirrored for the inline script in index.html, like the theme: no flash of normal size or glow on start (Maria L8)
  try { if (size === 'normal' && !state.settings.calm) localStorage.removeItem(LOOK_KEY); else localStorage.setItem(LOOK_KEY, `${size}|${state.settings.calm ? 1 : 0}`); } catch { /* private mode */ }
  applyTheme();
}
/** Mer → Tema: 'auto' follows the phone (prefers-color-scheme), else forced dark/light. Dark is the default. */
const THEME_COLOR = { dark: '#05070a', light: '#f1f4f7' };
const THEME_KEY = 'matkassa-premium-theme';
const LOOK_KEY = 'matkassa-premium-look';
function applyTheme() {
  const t = state.settings.theme || 'auto';
  const root = document.documentElement;
  if (t === 'auto') delete root.dataset.theme; else root.dataset.theme = t;
  // mirror for the inline script in index.html, which sets the theme before the first paint
  try { if (t === 'auto') localStorage.removeItem(THEME_KEY); else localStorage.setItem(THEME_KEY, t); } catch { /* private mode */ }
  for (const m of document.querySelectorAll('meta[name="theme-color"]')) {
    const scheme = /light/.test(m.media) ? 'light' : 'dark';
    m.content = THEME_COLOR[t === 'auto' ? scheme : t];
  }
}

const DEFAULT_IDS = new Set(DEFAULT_CATEGORIES.map((c) => c.id));
const DEFAULT_COLOR = new Map(DEFAULT_CATEGORIES.map((c) => [c.id, c.color.toLowerCase()]));
/** A category's display colour: the theme's --cat-* token while it has its default colour, else the user's pick. */
const catColor = (c) => (!c ? '' : DEFAULT_COLOR.get(c.id) === String(c.color).toLowerCase() ? `var(--cat-${c.id})` : c.color);
/** A category list the app can work with: at least one built-in category. Without them nothing is classified
 * (everything Ukategorisert, "Kun mat" lets everything through). */
const usableCategories = (cats) => Array.isArray(cats) && cats.some((c) => c && typeof c === 'object' && DEFAULT_IDS.has(c.id));
function rebuildClassifier() {
  if (!usableCategories(state.categories)) { // safety net for any path (sync, copy, storage): back to the defaults
    state.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
    save.categories();
  }
  classify = makeClassifier(state.categories, state.rules);
  rebuildOfferIndex();
}

let mergeStats = { attached: 0, added: 0 };
function rebuildOfferIndex() {
  let offers = state.offersData ? state.offersData.offers : [];
  mergeStats = { attached: 0, added: 0 };
  if (offers.length && state.extraOffers && state.extraOffers.offers.length) {
    const m = mergeExtraOffers(offers, state.extraOffers.offers);
    offers = m.offers;
    mergeStats = { attached: m.attached, added: m.added };
  }
  offerIndex = offers.map((o) => ({
    o,
    words: tokens(o.title),
    desc: tokens(o.desc),
    cat: classify(o.title) || classify(o.title + ' ' + o.desc) || 'annet',
  }));
}
const area = () => validArea(state.settings.area) || DEFAULT_AREA;
const offerById = (id) => (offerIndex.find((x) => x.o.id === id) || {}).o;

const catById = (id) => state.categories.find((c) => c.id === id);
const hiddenChains = () => new Set(state.settings.hiddenChains || []);
/** Chains with offers: Tjek's, plus any that only come from extra offers (e.g. REMA Superpris without a Tjek catalog). */
const knownChains = () => {
  const list = state.offersData ? [...state.offersData.chains] : [];
  for (const x of offerIndex) if (x.o.chainId && !list.some((c) => c.id === x.o.chainId)) list.push({ id: x.o.chainId, name: x.o.chain, color: x.o.color });
  return list;
};
/** The offer a list item was added from, unless its chain is hidden now. */
const linkedOffer = (item) => (item.offer && !hiddenChains().has(item.offer.chainId) ? item.offer : null);
/** True when offers exist but every chain in them is hidden (Mer → Kjeder). */
const allChainsHidden = () => {
  const d = state.offersData;
  const hidden = hiddenChains();
  return !!(d && knownChains().length && knownChains().every((c) => hidden.has(c.id)));
};
/** Chain chips the user picked, minus hidden chains. Empty = all. */
const selectedChains = () => {
  const hidden = hiddenChains();
  return new Set((state.settings.chains || []).filter((id) => !hidden.has(id)));
};
const activeOffers = () => {
  const now = Date.now();
  const hidden = hiddenChains();
  return offerIndex.filter((x) => (!x.o.till || x.o.till >= now) && !hidden.has(x.o.chainId));
};
const foodOnly = () => state.settings.foodOnly !== false;
/** "Kun mat" (default on) hides non-food: household, pet food, flowers, clothes, toys … */
const isFood = (x) => !NON_FOOD.has(x.cat);

/* ---------- personal fit: learn from receipts ---------- */
const FIT_MIN = 0.2; // below this an offer isn't "for you"
let profile = null;
let profileFor = null; // [receipts, classifier] the profile was built from
let fitFor = null; // offerIndex the fit was computed for

/** The profile is built only from the receipts stored on this device, i.e. this user's own purchases. */
function ensureFit() {
  if (!profileFor || profileFor[0] !== state.receipts || profileFor[1] !== classify) {
    profile = buildProfile(state.receipts, { classify });
    profileFor = [state.receipts, classify];
    fitFor = null;
  }
  if (fitFor === offerIndex) return;
  for (const x of offerIndex) {
    const { score, because, via } = scoreOffer(profile, x.words, { eans: x.o.eans, cat: x.cat });
    x.fit = score;
    x.because = because;
    x.via = via;
  }
  fitFor = offerIndex;
}
const hasProfile = () => profile && profile.products.length > 0;

/** Top offers for the user: best fit × discount, one per bought product so the strip stays varied. */
function featuredOffers(n = 10) {
  ensureFit();
  if (!hasProfile()) return [];
  const seen = new Set();
  const out = [];
  const now = Date.now();
  const chains = selectedChains();
  const ranked = activeOffers()
    .filter((x) => x.fit >= FIT_MIN && (!x.o.from || x.o.from <= now) && (!chains.size || chains.has(x.o.chainId)) && (!foodOnly() || isFood(x)))
    .sort((a, b) => b.fit * (1 + discount(b.o)) - a.fit * (1 + discount(a.o)));
  const titles = new Set(); // the same product at several chains: show the best one only
  for (const x of ranked) {
    const t = productKey(x.o.title);
    if (seen.has(x.because.name) || titles.has(t)) continue;
    seen.add(x.because.name);
    titles.add(t);
    out.push(x);
    if (out.length === n) break;
  }
  return out;
}

/* ---------- toast ---------- */
// Enters from below and leaves the same way (styles.css .toast). The timer pauses while the app is hidden, so a
// message isn't missed when the user switches away right after an action.
const TOAST_MS = 2600;
const toastMs = (msg) => Math.min(12000, Math.max(TOAST_MS, String(msg).length * 55)); // long messages stay readable
let toastTimer;
let toastAction = null;
/** Show a message; action = {label, run} adds a button (e.g. "Angre" after a delete). */
function toast(msg, action = null) {
  const t = $('#toast');
  toastAction = action;
  t.innerHTML = `<span>${esc(msg)}</span>${action ? `<button type="button" class="toast-act">${esc(action.label)}</button>` : ''}`;
  t.classList.remove('leaving');
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(hideToast, toastMs(msg));
}
function hideToast() {
  const t = $('#toast');
  if (t.hidden) return;
  t.classList.add('leaving');
  const done = () => { if (t.classList.contains('leaving')) { t.hidden = true; t.classList.remove('leaving'); } };
  t.addEventListener('transitionend', done, { once: true });
  setTimeout(done, 450); // reduced motion or no transition: still hide
}

/* ---------- tabs ---------- */
let homeEnterTimer;
function showTab(tab) {
  if (tab === 'mer') state.morePage = null; // the Mer tab always opens on its list, like iOS Settings
  state.tab = tab;
  closePaste(); // a sheet never stays on top of another tab
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${tab}`;
  for (const b of document.querySelectorAll('.tabbar button')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  $('#view-title').textContent = $('#bar-title').textContent = $(`#view-${tab}`).dataset.title;
  moveTabIndicator($('#tab-indicator'), TABS.indexOf(tab), document.querySelector(`.tabbar [data-tab="${tab}"]`));
  $('#refresh').hidden = tab !== 'tilbud';
  $('#geo-card').classList.toggle('off-tab', tab !== 'hjem' && tab !== 'tilbud');
  if (tab === 'hjem') { // the staggered arrival plays once per visit, not on every re-render
    const hb = $('#home-body');
    hb.classList.remove('home-enter');
    void hb.offsetWidth;
    hb.classList.add('home-enter');
    clearTimeout(homeEnterTimer);
    homeEnterTimer = setTimeout(() => hb.classList.remove('home-enter'), 450);
  }
  render();
  window.scrollTo(0, 0);
  try { history.replaceState(null, '', '#' + tab); } catch (e) { /* file:// */ }
}

function render() {
  renderStatus();
  renderBadge();
  if (state.tab === 'hjem') renderHome();
  if (state.tab === 'tilbud') renderOffers();
  if (state.tab === 'liste') renderList();
  if (state.tab === 'forbruk') renderSpending();
  if (state.tab === 'mer') renderMore();
}

const longDay = new Intl.DateTimeFormat('nb-NO', { weekday: 'long', day: 'numeric', month: 'long' });
/** Each tab has its own subtitle; only Tilbud talks about offers and loading. */
function renderStatus() {
  const el = $('#status');
  const d = state.offersData;
  $('#refresh').classList.toggle('spinning', !!state.loading);
  if (state.tab !== 'tilbud') {
    const open = state.list.filter((i) => !i.done).length;
    el.textContent = {
      hjem: titleCaseFirst(longDay.format(new Date())),
      liste: state.list.length ? `${open} ${open === 1 ? 'vare' : 'varer'} igjen` : 'Det du skal handle',
      forbruk: 'Hva du bruker i butikken',
      mer: state.morePage ? '' : 'Innstillinger og personvern',
    }[state.tab] || '';
    return;
  }
  if (state.loading) el.textContent = state.loading;
  else if (state.error && d) el.textContent = `Viser lagrede tilbud fra ${timeFmt.format(d.fetchedAt)} · ${state.error}`;
  else if (state.error) el.textContent = state.error;
  else if (d) el.textContent = `${activeOffers().length} tilbud fra ${knownChains().filter((c) => !hiddenChains().has(c.id)).length} kjeder · oppdatert ${timeFmt.format(d.fetchedAt)}`;
  else el.textContent = '';
}

/* ---------- offers ---------- */
let reloadQueued = false; // a forced reload asked for while a fetch was running (e.g. the location arrived)
async function loadOffers(force = false) {
  if (state.loading) { if (force) reloadQueued = true; return; }
  const d = state.offersData;
  const a = area(); // the area this fetch is for, even if the user changes it while it runs
  if (!force && d && Date.now() - d.fetchedAt < STALE_MS && d.area === a.name) return;
  if (!navigator.onLine) {
    state.error = 'Frakoblet';
    render();
    return;
  }
  state.loading = 'Henter tilbud …';
  state.error = null;
  renderStatus();
  try {
    const data = await fetchOffers(a, (done, total) => {
      state.loading = `Henter tilbud … ${done}/${total} kundeaviser`;
      renderStatus();
    });
    if (!data.offers.length) throw new Error('Tjek ga ingen tilbud');
    data.area = a.name;
    state.offersData = data;
    await db.set('offers', data);
    rebuildOfferIndex();
  } catch (e) {
    console.warn('Tjek-feil', e);
    state.error = navigator.onLine ? 'Klarte ikke å hente tilbud' : 'Frakoblet';
  } finally {
    state.loading = false;
    render();
    if (reloadQueued) { reloadQueued = false; loadOffers(true); }
  }
}

function filteredOffers() {
  ensureFit();
  const chains = selectedChains();
  const qTokens = tokens(state.q);
  // An explicitly picked non-food category shows its offers even with "Kun mat" on.
  const food = foodOnly() && !(state.cat && NON_FOOD.has(state.cat));
  let list = activeOffers().filter((x) => (!chains.size || chains.has(x.o.chainId)) && (!state.cat || x.cat === state.cat) && (!food || isFood(x)));
  if (qTokens.length) {
    const qCat = classify(state.q);
    const run = (q) => list
      .map((x) => ({ x, s: matchOffer(q, qCat, x.words, x.cat, { prefix: true, desc: x.desc }) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((r) => r.x);
    let hits = run(qTokens);
    // "helmelk" with no helmelk on offer this week: show the product group (melk) instead of nothing (Hege round 2)
    state.searchWider = null;
    if (!hits.length) {
      const wider = qTokens.map((t) => SEARCH_HEADS.find((h) => t.length > h.length && t.endsWith(h)) || t);
      if (wider.some((w, i) => w !== qTokens[i])) { hits = run(wider); if (hits.length) state.searchWider = wider.join(' '); }
    }
    list = hits;
  }
  const by = {
    // "Laveste pris" compares like with like: kr/kg, then kr/l, then kr/stk (a 10 kr chewing gum is not cheap food)
    pris: (a, b) => byUnitPrice(a.o, b.o),
    enhet: (a, b) => byUnitPrice(a.o, b.o),
    rabatt: (a, b) => discount(b.o) - discount(a.o),
    fordeg: hasProfile() ? (a, b) => (b.fit || 0) - (a.fit || 0) || discount(b.o) - discount(a.o) : null,
  }[state.sort];
  if (by) list = [...list].sort(by);
  // nothing to go on (no receipts, no search, no sort): food first, sweets and fizzy drinks last (Linn, Hege)
  else if (!qTokens.length) list = [...list].sort((a, b) => foodRank(a.cat) - foodRank(b.cat) || a.o.chain.localeCompare(b.o.chain, 'nb'));
  return list;
}
const SEARCH_HEADS = ['melk', 'ost', 'brød', 'kaffe', 'yoghurt', 'juice', 'smør', 'egg', 'kylling', 'laks', 'pølser', 'pizza'];
const FOOD_ORDER = ['frukt', 'meieri', 'kjott', 'fisk', 'brod', 'palegg', 'ferdigmat', 'frossen', 'torr', 'drikke', 'snacks'];
const foodRank = (cat) => { const i = FOOD_ORDER.indexOf(cat); return i < 0 ? FOOD_ORDER.length : i; };
// For multi-buy the deal is what one item really costs ("3 for 2": 59,90 → 39,93 a piece), not the single price (Maria M1).
const dealPrice = (o) => (o.multi && o.perPiece ? o.perPiece : o.price);
const discount = (o) => (o.prePrice && o.prePrice > dealPrice(o) ? (o.prePrice - dealPrice(o)) / o.prePrice : 0);


function chainColor(id, fallback) {
  const c = state.offersData && state.offersData.chains.find((x) => x.id === id);
  const col = (c && c.color) || fallback;
  return col && col.toLowerCase() !== '#ffffff' && col.toLowerCase() !== '#fff' ? col : '#c8102e';
}

function validText(o) {
  const now = Date.now();
  if (o.from && o.from > now) return `<span class="soon">Fra ${esc(dayFmt.format(o.from))}</span>`;
  if (o.till && new Date(o.till).toDateString() === new Date(now).toDateString()) return '<span class="soon">Siste dag i dag</span>';
  if (o.from && o.till) return `${esc(dayFmt.format(o.from))}–${esc(dayFmt.format(o.till))}`;
  if (o.till) return `Til ${esc(dayFmt.format(o.till))}`;
  return '';
}

function unitText(o) {
  if (!o.unitPrice) return '';
  return `${o.unitFrom ? 'fra ' : ''}${o.multi && o.unit === 'stk' ? 'snitt ' : ''}${kr(o.unitPrice)}/${o.unit}`;
}
/** The big price: "4 for 50 kr" for multi-buy, else the price. */
const priceText = (o) => (o.multi ? (o.multi.payFor ? `${o.multi.n} for ${o.multi.payFor} · ${kr(o.price)}/stk` : `${o.multi.n} for ${kr(o.multi.total)}`) : kr(o.price));

function inList(offerId) {
  return state.list.some((i) => i.offer && i.offer.id === offerId && !i.done);
}

/** Why an offer is "for you". via 'ean' = the same barcode is on your receipts, 'name' = similar name. */
function whyText(because, via) {
  return via === 'ean'
    ? `Du kjøper akkurat denne (${because.n}×) <span class="via" title="Samme strekkode som på kvitteringene dine">strekkode</span>`
    : `Fordi du kjøper ${esc(because.name.toLowerCase())} (${because.n}×)`;
}

function offerCard({ o, fit, because, via }, best = false) {
  const added = inList(o.id);
  const d = discount(o);
  const img = o.img
    ? `<img class="thumb" src="${esc(o.img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb none',textContent:'Bilde'}))">`
    : '<div class="thumb none">Bilde</div>';
  return `<li class="offer${best ? ' best' : ''}" data-offer="${esc(o.id)}"${best ? ` aria-label="${esc(titleCase(o.title))}, ${esc(priceText(o))}, ${esc(unitText(o))}${d >= 0.05 ? `, minus ${Math.round(d * 100)} prosent` : ''}, beste tilbud: lavest ${o.unit === 'l' ? 'literpris' : 'kilopris'} av like varer, ${esc(o.chain)}"` : ''}>
    <span class="tilt-light" aria-hidden="true"></span>${best ? '<span class="best-edge" aria-hidden="true"></span>' : ''}
    ${img}
    <div class="info">
      <div class="title">${esc(titleCase(o.title))}</div>
      ${o.desc ? `<div class="desc">${esc(o.desc)}</div>` : ''}
      <div class="meta"><span class="chain" style="--c:${esc(chainColor(o.chainId, o.color))}">${esc(o.chain)}</span><span>${validText(o)}</span></div>
      ${fit >= FIT_MIN && because ? `<div class="why">${whyText(because, via)}</div>` : ''}
      ${best ? `<span class="best-tag" title="Lavest ${o.unit === 'l' ? 'literpris' : 'kilopris'} blant minst 3 like varer">Beste tilbud · lavest ${o.unit === 'l' ? 'literpris' : 'kilopris'}</span>` : ''}
    </div>
    <div class="priceblock">
      <span class="price">${priceText(o)}</span>
      ${o.pieces ? `<span class="unit">${o.pieces} stk · ${kr(o.perPiece)}/stk</span>` : ''}
      ${o.prePrice && o.prePrice > o.price ? `<span class="pre">${kr(o.prePrice)}</span>` : ''}
      ${o.unitPrice ? `<span class="unit">${unitText(o)}</span>` : ''}
      ${discount(o) >= 0.05 ? `<span class="off">−${Math.round(discount(o) * 100)} %</span>` : ''}
      <button class="add${added ? ' added' : ''}" type="button" data-add="${esc(o.id)}" aria-label="${added ? 'Ligger i handlelisten' : 'Legg til i handlelisten'}: ${esc(o.title)}"><svg class="i-plus" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><svg class="i-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></button>
    </div>
  </li>`;
}

function featCard({ o, because, via }) {
  const added = inList(o.id);
  return `<li class="feat">
    ${o.img ? `<img src="${esc(o.img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<div class="noimg"></div>'}
    <div class="ft">${esc(titleCase(o.title))}</div>
    <div class="fp">${priceText(o)}${o.unitPrice ? ` <small>${unitText(o)}</small>` : ''}${o.prePrice && o.prePrice > o.price ? ` <s>${kr(o.prePrice)}</s>` : ''}</div>
    <div class="meta"><span class="chain" style="--c:${esc(chainColor(o.chainId, o.color))}">${esc(o.chain)}</span></div>
    <div class="why">${esc(because.name)} · ${because.n}×${via === 'ean' ? ' <span class="via" title="Samme strekkode som på kvitteringene dine">strekkode</span>' : ''}</div>
    <button class="add${added ? ' added' : ''}" type="button" data-add="${esc(o.id)}" aria-label="${added ? 'Ligger i handlelisten' : 'Legg til i handlelisten'}: ${esc(o.title)}"><svg class="i-plus" viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg><svg class="i-check" viewBox="0 0 24 24" aria-hidden="true"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg></button>
  </li>`;
}

function renderChips() {
  const d = state.offersData;
  const hidden = hiddenChains();
  const sel = selectedChains();
  const chains = d ? knownChains().filter((c) => !hidden.has(c.id)) : [];
  $('#chain-chips').innerHTML =
    `<button class="chip" type="button" data-chain="" aria-pressed="${sel.size === 0}">Alle kjeder</button>` +
    chains
      .map((c) => `<button class="chip" type="button" data-chain="${esc(c.id)}" aria-pressed="${sel.has(c.id)}"><span class="dot" style="--c:${esc(chainColor(c.id, c.color))}"></span>${esc(c.name)}</button>`)
      .join('');
  const counts = new Map();
  for (const x of activeOffers()) if (!sel.size || sel.has(x.o.chainId)) counts.set(x.cat, (counts.get(x.cat) || 0) + 1);
  const food = foodOnly();
  $('#cat-chips').innerHTML =
    `<button class="chip food-chip" type="button" data-foodonly aria-pressed="${food}" title="Skjul blomster, klær, dyremat og husholdning">Kun mat</button>` +
    `<button class="chip" type="button" data-cat="" aria-pressed="${!state.cat}">Alle kategorier</button>` +
    state.categories
      .filter((c) => counts.get(c.id) && !(food && NON_FOOD.has(c.id) && state.cat !== c.id))
      .map((c) => `<button class="chip" type="button" data-cat="${esc(c.id)}" aria-pressed="${state.cat === c.id}"><span class="dot" style="--c:${esc(catColor(c))}"></span>${esc(c.name)}</button>`)
      .join('');
  $('#chain-chips').hidden = $('#cat-chips').hidden = !d;
}

function renderOffers() {
  renderChips();
  const empty = $('#offer-empty');
  const listEl = $('#offer-list');
  const more = $('#offer-more');
  const skel = $('#offer-skeleton');
  skel.hidden = !!(state.offersData || !state.loading);
  if (!skel.hidden && !skel.firstChild) skel.innerHTML = '<div class="sk-card"><i></i><b></b></div>'.repeat(6);
  if (!state.offersData) {
    listEl.innerHTML = '';
    more.hidden = true;
    $('#offer-count').textContent = '';
    empty.hidden = !!state.loading; // the skeleton shows while loading
    empty.innerHTML = state.loading
      ? ''
      : `<h2>Ingen tilbud ennå</h2><p>${!navigator.onLine ? 'Du er frakoblet. Tilbud hentes når du er på nett igjen.' : state.offersData && !state.error ? 'Kundeavisene har ingen tilbud for området akkurat nå. Prøv igjen senere, eller velg et annet område under Mer.' : 'Klarte ikke å hente tilbud fra Tjek.'}</p><button class="btn btn-primary" type="button" data-action="refresh">Prøv igjen</button>`;
    return;
  }
  const list = filteredOffers();
  const feat = !state.q && !state.cat ? featuredOffers() : [];
  $('#for-deg').hidden = !feat.length;
  $('#for-deg-list').innerHTML = feat.map(featCard).join('');
  $('#offer-count').textContent = state.searchWider ? `Ingen «${state.q}» på tilbud nå · ${list.length} tilbud på ${state.searchWider}` : `${list.length} tilbud${state.q ? ` for «${state.q}»` : ''}`;
  const best = bestValueIds(list); // lowest kr/kg or kr/l among ≥ 3 comparable offers, not % off
  listEl.innerHTML = list.slice(0, state.shown).map((x) => offerCard(x, best.has(x.o.id))).join('');
  enableTilt(listEl);
  shineBestOffers(listEl);
  more.hidden = list.length <= state.shown;
  more.textContent = `Vis flere (${list.length - state.shown} til)`;
  empty.hidden = list.length > 0;
  if (!list.length) {
    empty.innerHTML = allChainsHidden()
      ? '<h2>Alle kjeder er skjult</h2><p>Du har skjult alle kjedene. Slå på kjedene du handler i under Mer → Kjeder.</p><button class="btn btn-primary" type="button" data-morego="kjeder">Gå til Mer → Kjeder</button>'
      : `<h2>Ingen treff</h2><p>Prøv et annet søkeord${state.cat || (state.settings.chains || []).length ? ', eller fjern filteret for kjede eller kategori' : ''}.</p>`;
  }
}

/* ---------- shopping list ---------- */
const STOP = new Set(['og', 'i', 'på', 'med', 'til', 'stk', 'pk', 'kg', 'g', 'l', 'liter', 'x']);
/** The product part of a list item: "2 l melk" → "melk" (old items may still have the amount in the text). */
const itemName = (i) => (i.qty != null ? i.text : parseQty(i.text).name);
/** Multiplier for a price: 3 stk = 3 packs; 500 g or 2 l is one pack's worth (the size is in the offer). */
const packs = (i) => (i.qty != null && (!i.unit || i.unit === 'stk' || i.unit === 'pk') ? i.qty : 1);

/**
 * Offers for a shopping-list item. Barcode first: an item added from an offer remembers that offer's EANs, so the
 * same product is found again in later weeks (marked o.via = 'ean'). Then by name: whole words or the head of a
 * compound, and never a different kind of product (see matchOffer in categories.js). Non-food offers only for a
 * non-food item.
 */
function dealsFor(text, eans) {
  const now = Date.now();
  const chains = selectedChains();
  const name = parseQty(text).name;
  const itemCat = classify(name); // "melk" → Meieri, so milk beats "potetmos med melk"
  const food = !(itemCat && NON_FOOD.has(itemCat));
  const live = activeOffers().filter((x) => (!chains.size || chains.has(x.o.chainId)) && (!x.o.from || x.o.from <= now + 7 * 864e5) && (!food || isFood(x)));
  const want = new Set((eans || []).map(normEan).filter(Boolean));
  const byEan = want.size ? live.filter((x) => (x.o.eans || []).some((e) => want.has(e))) : [];
  const eanIds = new Set(byEan.map((x) => x.o.id));
  const cheap = (a, b) => (a.o.unitPrice ?? a.o.price * 10) - (b.o.unitPrice ?? b.o.price * 10);
  const first = byEan.sort(cheap).map((x) => ({ ...x.o, via: 'ean', cat: x.cat }));
  const q = tokens(name).filter((t) => t.length >= 2 && !STOP.has(t) && !/^\d+$/.test(t));
  if (!q.length) return first;
  return first.concat(live
    .filter((x) => !eanIds.has(x.o.id))
    .map((x) => ({ x, s: matchOffer(q, itemCat, x.words, x.cat) }))
    .filter((r) => r.s > 0)
    .sort((a, b) => b.s - a.s || cheap(a.x, b.x))
    .map((r) => ({ ...r.x.o, cat: r.x.cat })));
}

/** Update every + button for this offer in place (list and "Tilbud for deg"), so the + → ✓ change can animate. */
function syncAddButtons(o) {
  const added = inList(o.id);
  for (const b of document.querySelectorAll('[data-add]')) {
    if (b.dataset.add !== o.id) continue;
    b.classList.toggle('added', added);
    b.setAttribute('aria-label', `${added ? 'Ligger i handlelisten' : 'Legg til i handlelisten'}: ${o.title}`);
  }
}

let justAdded = null; // id of the list row that should animate in on the next render
/** Add a typed line ("2 l melk") or an offer. Typed amounts are kept apart from the name, so matching stays right. */
function addItem(text, offer) {
  text = String(text || '').trim();
  if (!text) return null;
  const eans = offer && offer.eans && offer.eans.length ? offer.eans : undefined;
  const p = offer ? { name: text, qty: null, unit: null } : parseQty(text);
  const id = uid();
  justAdded = id;
  const item = { id, text: p.name, qty: p.qty, unit: p.unit, done: false, added: Date.now(), offer: offer || null, eans };
  state.list.unshift(item);
  save.list();
  return item;
}

function closePaste() {
  const d = $('#dlg-paste');
  if (d && d.open) d.close();
}
/** The "Ukas basis" template: everyday things a family buys every week, added with one tap (Linn). Only adds what is missing. */
const WEEK_BASICS = ['Melk', 'Brød', 'Egg', 'Yoghurt', 'Smør', 'Ost', 'Bananer', 'Epler', 'Kaffe', 'Toalettpapir'];
function addWeekBasics() {
  // "Lettmelk" or "Tine helmelk" on the list already covers "Melk"; a checked-off "Melk" is put back instead (Maria L7)
  const words = (t) => t.toLowerCase().split(/[^a-zæøå]+/).filter(Boolean);
  const covers = (i, b) => words(i.text).some((w) => w === b || w.endsWith(b) || w === b + 'er' || w === b + 'r');
  let n = 0;
  const add = [];
  for (const t of WEEK_BASICS) {
    const b = t.toLowerCase();
    if (state.list.some((i) => !i.done && covers(i, b))) continue;
    const done = state.list.find((i) => i.done && covers(i, b));
    if (done) { done.done = false; n++; continue; }
    add.push(t);
  }
  for (const t of [...add].reverse()) addItem(t);
  if (n) save.list();
  return n + add.length;
}
function renderBadge() {
  const open = state.list.filter((i) => !i.done).length;
  const b = $('#list-badge');
  b.hidden = !open;
  b.textContent = open;
  renderStatus(); // "N varer igjen" under the title follows every change (Linn)
}

/** Everything the list needs about one item, computed once per render: deals, the offer to show, category. */
function itemInfo(i) {
  const now = Date.now();
  const linked = linkedOffer(i);
  let deals = [];
  let shown = null; // {chain, chainId, price, prePrice, title, via, linked}
  if (linked && !(linked.till && linked.till < now)) shown = { ...linked, linked: true };
  else {
    deals = dealsFor(i.text, i.eans);
    if (linked && i.eans) deals = deals.filter((d) => d.via === 'ean'); // an expired offer comes back only as the same product
    if (deals.length) shown = deals[0];
  }
  const cat = classify(itemName(i)) || (shown && shown.cat) || (linked && classify(linked.title)) || 'annet';
  return { linked, expired: !!(linked && linked.till && linked.till < now), deals, shown, cat };
}

function dealHTML(i, info) {
  const { linked, expired, deals, shown } = info;
  if (shown && shown.linked) {
    return `<div class="deal"><span class="deal-tag from">Tilbud hos ${esc(shown.chain)} · ${kr(shown.price)}</span>${shown.till ? `<span class="deal-more">til ${esc(dayFmt.format(shown.till))}</span>` : ''}</div>`;
  }
  if (!deals.length) {
    if (linked && expired) return '<div class="nodeal">Tilbudet er utløpt</div>';
    return state.offersData ? '<div class="nodeal">Ikke på tilbud denne uken</div>' : '';
  }
  const best = deals[0];
  const rest = deals.slice(0, 6);
  const again = linked && expired ? 'igjen ' : '';
  return `<details class="deal"><summary><span class="deal-tag">På tilbud ${again}hos ${esc(best.chain)} · ${kr(best.price)}</span>${best.via === 'ean' ? '<span class="via" title="Samme strekkode">strekkode</span>' : ''}${deals.length > 1 ? `<u>+ ${deals.length - 1} ${deals.length - 1 === 1 ? 'tilbud' : 'tilbud'} til</u>` : ''}</summary>
    <ul>${rest.map((o) => `<li><span class="dc">${esc(o.chain)}</span><span class="dt">${esc(titleCase(o.title))}${o.unitPrice ? `<small>${unitText(o)}</small>` : ''}</span><b>${kr(o.price)}</b></li>`).join('')}</ul></details>`;
}

function itemRow(i, info) {
  const q = qtyText(i.qty, i.unit);
  const canDec = i.qty != null && i.qty - qtyStep(i.unit) >= qtyStep(i.unit) - 1e-9;
  return `<li class="item${i.done ? ' done' : ''}${i.id === justAdded ? ' new' : ''}" data-item="${esc(i.id)}">
    <div class="swipe-bg" aria-hidden="true"><span class="sw-done">${i.done ? 'Angre' : 'Kryss av'}</span><span class="sw-del">Slett</span></div>
    <div class="row">
      <label class="tick"><input type="checkbox" data-toggle="${esc(i.id)}" ${i.done ? 'checked' : ''} aria-label="Kryss av ${esc(i.text)}"></label>
      <div class="body"><div class="name">${esc(i.text)}</div>${dealHTML(i, info)}</div>
      <div class="qty" role="group" aria-label="Mengde for ${esc(i.text)}">
        <button type="button" data-dec="${esc(i.id)}" aria-label="Mindre ${esc(i.text)}"${canDec ? '' : ' disabled'}>−</button>
        <span class="qv" aria-live="polite">${esc(q)}</span>
        <button type="button" data-inc="${esc(i.id)}" aria-label="Mer ${esc(i.text)}">+</button>
      </div>
      <button class="del sr-only" type="button" data-del="${esc(i.id)}" aria-label="Slett ${esc(i.text)}">×</button>
    </div>
  </li>`;
}

/** Cheapest way to buy what's on sale: total of the best price per item, and the chain that covers most items. */
function listTotals(open, infos) {
  let total = 0;
  let onSale = 0;
  const perChain = new Map(); // chainId → {name, n, sum}
  for (const i of open) {
    const info = infos.get(i.id);
    const opts = info.shown && info.shown.linked ? [info.shown] : info.deals;
    if (!opts.length) continue;
    onSale++;
    const m = packs(i);
    total += Math.min(...opts.map((o) => o.price)) * m;
    const seen = new Set();
    for (const o of opts) {
      if (seen.has(o.chainId)) continue; // deals are sorted best first, so the first per chain is that chain's best
      seen.add(o.chainId);
      const c = perChain.get(o.chainId) || { name: o.chain, n: 0, sum: 0 };
      c.n++;
      c.sum += Math.min(...opts.filter((x) => x.chainId === o.chainId).map((x) => x.price)) * m;
      perChain.set(o.chainId, c);
    }
  }
  const best = [...perChain.values()].sort((a, b) => b.n - a.n || a.sum - b.sum)[0] || null;
  return { total, onSale, best };
}

/** Usual buys from the receipts (most often first) that aren't on the list already. */
function usualItems(n = 8) {
  ensureFit();
  if (!hasProfile()) return [];
  const open = new Set(state.list.filter((i) => !i.done).map((i) => normalize(itemName(i))));
  return [...profile.products]
    .filter((p) => p.n >= 2 && p.name && !open.has(normalize(p.name)))
    .sort((a, b) => b.n - a.n || b.w - a.w)
    .slice(0, n);
}

function renderList() {
  const order = new Map(state.categories.map((c, k) => [c.id, k]));
  const infos = new Map(state.list.map((i) => [i.id, itemInfo(i)]));
  const open = state.list.filter((i) => !i.done);
  const done = state.list.filter((i) => i.done);
  // Grouped by category in the order you walk through a store; inside a group the newest first.
  const groups = new Map();
  for (const i of open) {
    const c = infos.get(i.id).cat;
    if (!groups.has(c)) groups.set(c, []);
    groups.get(c).push(i);
  }
  const sorted = [...groups.entries()].sort((a, b) => (order.get(a[0]) ?? 99) - (order.get(b[0]) ?? 99));
  let html = '';
  for (const [cid, items] of sorted) {
    const c = catById(cid);
    html += `<li class="group-h"><span class="dot" style="--c:${esc(c ? catColor(c) : 'var(--text-3)')}"></span>${esc(c ? c.name : 'Annet')}</li>`;
    html += items.map((i) => itemRow(i, infos.get(i.id))).join('');
  }
  if (done.length) {
    html += `<li class="group-h done-h">Avkrysset · ${done.length}<button id="list-clear" class="btn small btn-ghost" type="button">Fjern avkryssede</button></li>`;
    html += done.map((i) => itemRow(i, infos.get(i.id))).join('');
  }
  $('#list-items').innerHTML = html;
  justAdded = null;

  const t = listTotals(open, infos);
  $('#list-summary').textContent = state.list.length
    ? `${open.length} igjen${state.offersData ? ` · ${t.onSale} på tilbud` : ''}${done.length ? ` · ${done.length} avkrysset` : ''}`
    : '';
  const tot = $('#list-total');
  tot.hidden = !t.onSale;
  if (t.onSale) {
    tot.innerHTML = `<div class="tot-row"><span>Varene på tilbud</span><b>ca. ${krShort(t.total)}</b></div>
      ${t.best ? `<p class="tot-best">Billigst samlet: <strong>${esc(t.best.name)}</strong> har ${t.best.n} av ${t.onSale} tilbudsvarer${t.best.n === t.onSale ? '' : ''}, ca. ${krShort(t.best.sum)}</p>` : ''}
      <p class="hint">Regnet med ukens tilbudspriser${open.length > t.onSale ? `. ${count(open.length - t.onSale, 'vare', 'varer')} er ikke på tilbud og er ikke med` : ''}.</p>`;
  }
  $('#list-empty').hidden = state.list.length > 0;
  $('#list-tools').hidden = !open.length;
  const usual = usualItems();
  const u = $('#list-usual');
  u.hidden = !usual.length;
  if (usual.length) {
    u.innerHTML = `<h2>Det du pleier å kjøpe</h2><div class="usual-chips">${usual.map((p) => `<button class="chip" type="button" data-usual="${esc(p.name)}"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg>${esc(p.name)}</button>`).join('')}</div>`;
  }
}

/** Plain text of the open items, for Web Share or the clipboard. */
function listAsText() {
  const open = state.list.filter((i) => !i.done);
  return 'Handleliste\n' + open.map((i) => `- ${[qtyText(i.qty, i.unit), i.text].filter(Boolean).join(' ')}`).join('\n');
}

async function shareList() {
  const text = listAsText();
  if (navigator.share) {
    try { await navigator.share({ title: 'Handleliste', text }); return; } catch (e) { if (e && e.name === 'AbortError') return; }
  }
  try {
    await navigator.clipboard.writeText(text);
    toast('Listen er kopiert. Lim den inn i en melding.');
  } catch (e) {
    $('#paste-text').value = text;
    $('#paste-h').textContent = 'Kopier listen';
    $('#paste-add').hidden = true;
    $('#dlg-paste').showModal();
  }
}

/* ---------- money saved: offers checked off on the list ---------- */
/** What checking off this item saved: (normal price − offer price) × packs, when the offer says its normal price. */
function savingFor(i) {
  const info = itemInfo(i);
  const o = info.shown;
  if (!o || !o.prePrice || !(o.prePrice > o.price)) return 0;
  return Math.round((o.prePrice - o.price) * packs(i) * 100) / 100;
}
function recordSaving(i) {
  state.savings = state.savings.filter((s) => s.id !== i.id);
  if (i.done) {
    const amount = savingFor(i);
    if (amount > 0) state.savings.push({ id: i.id, at: Date.now(), kr: amount, text: i.text });
  }
  db.set('savings', state.savings);
}
function savedThisMonth() {
  const key = todayISO().slice(0, 7);
  return state.savings.filter((s) => { const d = new Date(s.at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === key; })
    .reduce((a, s) => a + s.kr, 0);
}

/* ---------- home ---------- */
function homeItemBadge(i) {
  const o = itemInfo(i).shown;
  return o ? `<span class="deal-tag">${esc(o.chain)} · ${kr(o.price)}</span>` : '';
}

function miniTrend(months, endKey) {
  const keys = [];
  for (let i = 5; i >= 0; i--) keys.push(shiftMonth(endKey, -i));
  const vals = keys.map((k) => (months.get(k) ? months.get(k).total : 0));
  const max = Math.max(...vals, 1);
  const W = 120, H = 40, bw = W / 6;
  const bars = vals.map((v, i) => `<path class="bar${i === 5 ? ' sel' : ''}" d="${barPath(i * bw + 2, H, bw - 4, (v / max) * (H - 2))}"/>`).join('');
  const label = 'Siste 6 måneder: ' + keys.map((k, i) => `${monthShort.format(monthDate(k)).replace('.', '')} ${krShort(vals[i])}`).join(', ');
  return `<svg class="mini-trend" viewBox="0 0 ${W} ${H}" role="img" aria-label="${esc(label)}">${bars}</svg>`;
}

/** "Kom i gang": three steps for a new user; gone when done or hidden. */
function startSteps() {
  return [
    // the area always has a value (Trondheim until you pick one), so the step shows it as done, with the name (Linn)
    { key: 'omrade', label: 'Område', sub: '', doneSub: `${esc(area().name)} · ferdig, trykk for å endre`, done: true },
    { key: 'kjeder', label: 'Velg kjedene dine', sub: 'Skjul butikkene du ikke bruker', done: !!state.settings.chainsSeen },
    { key: 'kvitteringer', label: 'Legg til kvitteringer', sub: 'Da ser du forbruket og får tilbud for deg', done: state.receipts.length > 0 },
  ];
}
function startCard() {
  if (state.settings.startDone) return '';
  const steps = startSteps();
  if (steps.every((x) => x.done)) return '';
  const n = steps.filter((x) => x.done).length;
  return `<section class="card start-card" id="home-start" aria-labelledby="start-h">
    <div class="start-head"><h2 id="start-h">Kom i gang</h2><span class="start-n">${n} av 3</span></div>
    <ol class="start-steps">${steps.map((x, k) => `<li class="${x.done ? 'done' : ''}"><button type="button" data-morego="${x.key}">
      <span class="num" aria-hidden="true">${x.done ? '<svg viewBox="0 0 24 24"><path d="m5 12.5 4.5 4.5L19 7.5"/></svg>' : k + 1}</span>
      <span class="txt"><b>${x.label}</b><small>${x.done ? (x.doneSub || 'Ferdig') : x.sub}</small></span><span class="chev" aria-hidden="true"></span></button></li>`).join('')}</ol>
    <button type="button" class="linkish" data-action="start-hide">Skjul</button></section>`;
}

/** Budget line for the month: progress, what's left and roughly per day for the rest of the month. */
/** A month's spend on food only: the total minus Husholdning, Dyremat and Ikke-mat lines. The budget is "på mat". */
function foodSpend(m) {
  if (!m) return 0;
  let non = 0;
  for (const [id, v] of m.byCat) if (NON_FOOD.has(id)) non += v;
  return Math.max(0, m.total - non);
}
function budgetHTML(used) {
  const b = state.settings.budget;
  if (!b) return '';
  const now = new Date();
  const daysIn = new Date(now.getFullYear(), now.getMonth() + 1, 0).getDate();
  const daysLeft = daysIn - now.getDate() + 1; // today counts
  const left = b - used;
  const pct = Math.min(100, Math.max(0, (used / b) * 100));
  const over = left < 0;
  return `<div class="budget${over ? ' over' : pct > 85 ? ' near' : ''}">
    <div class="row"><span>Mat: ${krShort(used)} av ${krShort(b)}</span><span>${Math.round(pct)} %</span></div>
    <div class="track" role="progressbar" aria-label="Budsjett brukt" aria-valuemin="0" aria-valuemax="100" aria-valuenow="${Math.round(pct)}"><div class="fill" style="width:${pct.toFixed(1)}%"></div></div>
    <p class="budget-left">${over ? `<b>${krShort(-left)} over budsjettet</b>` : `<b>${krShort(left)} igjen</b> · ca. ${krShort(left / daysLeft)} per dag i ${daysLeft} ${daysLeft === 1 ? 'dag' : 'dager'}`}</p></div>`;
}

function renderHome() {
  const body = $('#home-body');
  const parts = [];
  const sc = startCard();
  if (sc) parts.push(sc);
  parts.push(saveCard());
  // Spending overview → Forbruk
  if (!state.receipts.length) {
    parts.push(`<a class="card home-card" href="#forbruk" data-gototab="forbruk" id="home-spend">
      <h2>Forbruk</h2>
      <p class="home-empty">Ingen kvitteringer ennå. Hent inn kvitteringene dine eller legg inn en selv, så ser du hva du bruker i butikken her.</p>
      <span class="home-more">Gå til Forbruk</span></a>`);
  } else {
    const c = monthCompare(state.receipts, todayISO());
    const sum = summarize(state.receipts, classify, state.categories);
    const focus = c.count ? c.thisKey : c.lastKey;
    const fm = sum.months.get(focus) || { total: 0, byCat: new Map() };
    const rows = [...fm.byCat.entries()].filter(([, v]) => v >= 0.5).sort((a, b) => b[1] - a[1]).slice(0, 3);
    const max = Math.max(1, ...rows.map(([, v]) => v));
    let cmp;
    if (c.lastSoFar > 0 && c.count) {
      const pct = Math.round(((c.now - c.lastSoFar) / c.lastSoFar) * 100);
      cmp = `${pct === 0 ? 'Like mye som' : `${Math.abs(pct)} % ${pct > 0 ? 'mer' : 'mindre'} enn`} samme tid i ${esc(monthFmt.format(monthDate(c.lastKey)).split(' ')[0])} (${krShort(c.lastSoFar)})`;
    } else if (c.lastAll > 0) {
      cmp = `${esc(titleCaseFirst(monthFmt.format(monthDate(c.lastKey)).split(' ')[0]))} totalt: ${krShort(c.lastAll)}`;
    } else cmp = `${c.count} kvittering${c.count === 1 ? '' : 'er'} denne måneden`;
    parts.push(`<a class="card home-card" href="#forbruk" data-gototab="forbruk" id="home-spend">
      <div class="home-head"><div><h2>Brukt totalt i ${esc(monthFmt.format(monthDate(c.thisKey)).split(' ')[0])}</h2>
        <p class="hero">${krShort(c.now)}</p><p class="hero-sub">${cmp}</p></div>${miniTrend(sum.months, c.thisKey)}</div>
      ${budgetHTML(foodSpend(sum.months.get(c.thisKey)))}
      ${rows.length ? `<p class="home-label">${focus === c.thisKey ? 'Mest brukt på' : `Mest brukt på i ${esc(monthFmt.format(monthDate(focus)).split(' ')[0])}`}</p>
      <ul class="bars">${rows.map(([id, v]) => { const cat = catById(id); return `<li><div class="row"><span>${esc(cat ? cat.name : 'Ukategorisert')}</span><span>${krShort(v)}</span></div>
        <div class="track"><div class="fill${cat ? '' : ' uncat'}" style="width:${((v / max) * 100).toFixed(1)}%;--c:${esc(catColor(cat))}"></div></div></li>`; }).join('')}</ul>` : ''}
      <span class="home-more">Se alt forbruk</span></a>`);
    if (!state.settings.budget) parts.push('<button type="button" class="home-link" data-morego="budsjett">Sett et månedsbudsjett</button>');
  }
  // Shopping list → Handleliste
  const open = state.list.filter((i) => !i.done);
  parts.push(`<a class="card home-card" href="#liste" data-gototab="liste" id="home-list">
    <h2>Handleliste${open.length ? ` <small>· ${open.length} igjen</small>` : ''}</h2>
    ${open.length ? `<ul class="home-items">${open.slice(0, 4).map((i) => `<li><span class="name">${esc(i.text)}</span>${homeItemBadge(i)}</li>`).join('')}</ul>
      ${open.length > 4 ? `<span class="home-more">+${open.length - 4} til</span>` : '<span class="home-more">Åpne handlelisten</span>'}`
    : '<p class="home-empty">Handlelisten er tom. Legg til varer, eller trykk + på et tilbud.</p><span class="home-more">Åpne handlelisten</span>'}</a>`);
  // Offers for you (only once something is learned)
  const feat = featuredOffers(6);
  if (feat.length) {
    parts.push(`<section class="home-feat" aria-labelledby="home-feat-h"><h2 id="home-feat-h">Tilbud for deg</h2>
      <ul>${feat.map(({ o, because }) => `<li><a href="#tilbud" data-gototab="tilbud">${o.img ? `<img src="${esc(o.img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<span class="noimg"></span>'}
        <span class="ft">${esc(titleCase(o.title))}</span><span class="fp">${priceText(o)}${o.unitPrice ? ` <small class="fu">${unitText(o)}</small>` : ''}${discount(o) >= 0.05 ? ` <span class="off">−${Math.round(discount(o) * 100)} %</span>` : ''}</span><span class="chain" style="--c:${esc(chainColor(o.chainId, o.color))}">${esc(o.chain)}</span>
        <span class="why">Du kjøper ${esc(because.name.toLowerCase())}</span></a></li>`).join('')}</ul>${WHY_FOR_YOU}</section>`);
  }
  body.innerHTML = parts.join('');
  initMeter(body.querySelector('#home-save'));
}

/* ---------- Hjem: the savings meter (DESIGN.md v0.7 § 3b) ---------- */
let meterShownP = null; // last fill shown this session (null = first view: fill from 0)
const meterPulsed = new Set(); // months whose "goal reached" pulse has played
const goalText = (g) => `av ${krShort(g)} mål denne måneden`;
/** Offers on the list that are not checked off yet: what they will save (shown as a striped "on the way" part). */
function pendingSaving() {
  return Math.round(state.list.filter((i) => !i.done).reduce((a, i) => a + savingFor(i), 0) * 100) / 100;
}
/** Plain words for where "spart" comes from, and why it may be 0. */
function saveNote(saved, pending, goal) {
  const noPre = state.list.filter((i) => i.done && itemInfo(i).shown && !savingFor(i)).length;
  const parts = [];
  if (saved >= goal) parts.push('<b class="save-done">Mål nådd!</b> Godt handlet.');
  if (pending > 0) parts.push(`+ ${krShort(pending)} på vei: tilbud i handlelisten som ikke er krysset av ennå.`);
  if (!saved && !pending) parts.push('0 kr betyr bare at ingen tilbud er krysset av ennå. Legg et tilbud i handlelisten og kryss det av når du har kjøpt det, så legges det du sparer mot vanlig pris til her.');
  if (noPre) parts.push(`${noPre === 1 ? 'Ett avkrysset tilbud' : `${noPre} avkryssede tilbud`} oppga ikke vanlig pris, så ${noPre === 1 ? 'det' : 'de'} kan ikke regnes med.`);
  return parts.join(' ');
}
function saveCard() {
  const saved = savedThisMonth();
  const pending = pendingSaving();
  const goal = state.settings.saveGoal || 500;
  const sc = meterScale(saved + pending, goal);
  const month = todayISO().slice(0, 7);
  const items = state.savings.filter((x) => { const d = new Date(x.at); return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}` === month; });
  return `<section class="card save-card" id="home-save" aria-labelledby="save-h">
    <h2 id="save-h" class="sr-only">Spart denne måneden</h2>
    <p class="save-num"><span class="save-v">${krShort(saved)}</span> spart</p>
    <p class="save-sub">${goalText(goal)}</p>
    <div class="save-row" style="--g:${goal / sc}">
      <div class="meter" role="meter" aria-label="Spart denne måneden" aria-valuemin="0" aria-valuemax="${Math.max(goal, Math.round(saved))}" aria-valuenow="${Math.round(saved)}"
        aria-valuetext="${krWords(saved)} spart av et mål på ${krWords(goal)}" style="--p:${saved / sc};--pf:${saved / sc};--pp:${(saved + pending) / sc}">
        <div class="meter-pending"></div><div class="meter-glow"></div><div class="meter-fill"></div><div class="meter-cap"></div>
      </div>
      <span class="save-handle" role="slider" tabindex="0" aria-label="Sparemål, dra eller bruk piltastene" aria-valuemin="50" aria-valuemax="20000" aria-valuenow="${goal}" aria-valuetext="Mål: ${krWords(goal)}">
        <span class="goal-tick" aria-hidden="true"></span><span class="goal-label" aria-hidden="true"><svg viewBox="0 0 12 12" aria-hidden="true"><path d="M4 2.5 1 6l3 3.5M8 2.5 11 6l-3 3.5"/></svg>Mål ${krShort(goal)}</span>
      </span>
    </div>
    <p class="save-hint">Dra langs staven for å endre målet · trykk på den for å se hva du har spart på</p>
    <p class="save-note" aria-live="polite">${saveNote(saved, pending, goal)}</p>
    <button type="button" class="linkish save-what" aria-expanded="false" aria-controls="save-list">${items.length ? 'Hva har jeg spart på?' : 'Hvordan regnes dette?'}</button>
    <ul id="save-list" class="save-list" hidden>${items.length ? items.map((x) => `<li><span>${esc(x.text)}</span><b>${krShort(x.kr)}</b></li>`).join('') : '<li class="hint">Kryss av varer du har lagt i listen fra et tilbud, så regnes det du sparer mot vanlig pris. Dra «Mål»-merket på staven for å endre målet.</li>'}</ul>
  </section>`;
}
function initMeter(card) {
  if (!card) return;
  const meter = card.querySelector('.meter');
  const handle = card.querySelector('.save-handle');
  const sub = card.querySelector('.save-sub');
  const saved = savedThisMonth();
  const reduce = reducedMotion();
  const row = card.querySelector('.save-row');
  const label = card.querySelector('.goal-label');
  const pending = pendingSaving();
  let scale = meterScale(saved + pending, state.settings.saveGoal || 500);
  const p = saved / scale;
  const setP = (v) => meter.style.setProperty('--p', v);
  // keep the "Mål" label inside the card when the marker is near an end
  const placeLabel = () => {
    const w = row.clientWidth;
    const lw = label.offsetWidth;
    const x = (state.settings.saveGoal || 500) / scale * w;
    const shift = Math.min(w - lw / 2, Math.max(lw / 2, x)) - x;
    label.style.setProperty('--lx', `${shift.toFixed(1)}px`);
  };
  requestAnimationFrame(placeLabel);
  if (!reduce) {
    meter.classList.add(meterShownP == null ? 'first' : 'update');
    setP(meterShownP ?? 0);
    meter.getBoundingClientRect();
    requestAnimationFrame(() => setP(p));
  }
  meterShownP = p;
  const month = todayISO().slice(0, 7);
  if (meterFraction(saved, state.settings.saveGoal || 500) >= 1 && !meterPulsed.has(month)) { meterPulsed.add(month); if (!reduce) meter.classList.add('pulse'); }

  const setGoal = (g, persist, rescale = persist) => {
    state.settings.saveGoal = g;
    sub.textContent = goalText(g);
    handle.setAttribute('aria-valuenow', g);
    handle.setAttribute('aria-valuetext', `Mål: ${krWords(g)}`);
    label.lastChild.textContent = `Mål ${krShort(g)}`;
    meter.setAttribute('aria-valuemax', Math.max(g, Math.round(saved)));
    meter.setAttribute('aria-valuetext', `${krWords(saved)} spart av et mål på ${krWords(g)}`);
    // while a finger drags, the scale stays put so the marker follows it; afterwards it settles at ~80 %
    if (rescale) scale = meterScale(saved + pending, g);
    meter.style.setProperty('--pp', (saved + pending) / scale);
    card.querySelector('.save-note').innerHTML = saveNote(saved, pending, g);
    meterShownP = saved / scale;
    setP(meterShownP);
    meter.style.setProperty('--pf', meterShownP);
    row.style.setProperty('--g', g / scale);
    placeLabel();
    if (persist) save.settings();
  };
  const toggleList = () => {
    const b = card.querySelector('.save-what');
    const open = b.getAttribute('aria-expanded') !== 'true';
    b.setAttribute('aria-expanded', String(open));
    card.querySelector('#save-list').hidden = !open;
  };
  card.querySelector('.save-what').addEventListener('click', toggleList);
  handle.addEventListener('keydown', (e) => {
    const g0 = state.settings.saveGoal || 500;
    const step = { ArrowRight: 50, ArrowUp: 50, ArrowLeft: -50, ArrowDown: -50, PageUp: 500, PageDown: -500 }[e.key];
    const g = step ? g0 + step : e.key === 'Home' ? 50 : e.key === 'End' ? 20000 : null;
    if (g == null) return;
    e.preventDefault();
    setGoal(Math.min(20000, Math.max(50, g)), true);
  });
  // Drag the "Mål" marker: it follows the finger along the bar (right = a bigger goal). A tap elsewhere on the
  // bar opens the list, as before.
  let drag = null;
  const goalFromX = (x) => { const r = row.getBoundingClientRect(); return goalAt((x - r.left) / r.width, scale); };
  const endDrag = () => {
    if (drag && drag.on) { row.classList.remove('dragging'); meter.classList.remove('dragging'); setGoal(state.settings.saveGoal, true); }
    drag = null;
  };
  row.addEventListener('pointerdown', (e) => {
    if (e.button > 0) return;
    drag = { x0: e.clientX, y0: e.clientY, id: e.pointerId, onHandle: !!e.target.closest('.save-handle'), on: false };
  });
  row.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.on) {
      // the whole bar can be dragged sideways (the marker jumps to the finger); up/down scrolls the page
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
      if (Math.abs(dx) < (drag.onHandle ? 4 : 6)) return;
      drag.on = true;
      row.classList.add('dragging');
      meter.classList.add('dragging');
      try { row.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    }
    const g = goalFromX(e.clientX);
    if (g !== state.settings.saveGoal) setGoal(g, false, false);
  });
  row.addEventListener('pointerup', () => {
    if (!drag) return;
    if (drag.on) endDrag();
    else { toggleList(); drag = null; }
  });
  row.addEventListener('pointercancel', endDrag);
}
/** "1 vare", "2 varer". */
const count = (n, one, many) => `${n} ${n === 1 ? one : many}`;
const titleCaseFirst = (s) => s.charAt(0).toUpperCase() + s.slice(1);
const WHY_FOR_YOU = `<details class="why-box"><summary>Hvorfor ser jeg disse?</summary><p>Ukens tilbud sammenlignes med varene på kvitteringene dine, her på telefonen. Et tilbud vises bare når det er samme vare (samme strekkode) eller samme slags vare som du har kjøpt, ikke bare samme merke. Ingenting sendes noe sted.</p></details>`;

/* ---------- spending ---------- */
function shiftMonth(key, delta) {
  const [y, m] = key.split('-').map(Number);
  const d = new Date(y, m - 1 + delta, 1);
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
}
const monthDate = (key) => new Date(Number(key.slice(0, 4)), Number(key.slice(5, 7)) - 1, 1);

function renderSpending() {
  const body = $('#spend-body');
  if (!state.receipts.length) {
    body.innerHTML = `<div class="empty">
      <h2>Ingen kvitteringer ennå</h2>
      <p>Her ser du hva du bruker i butikken per måned og per kategori. Alle beløp er totalt, også husholdning og dyremat.</p>
      <p>Kom i gang: be om <strong>innsyn hos Trumf</strong> (Kiwi, Meny, Spar, Joker) eller Coop, og hent inn fila du får på e-post. Du kan også legge inn en kvittering selv.</p>
    </div>`;
    return;
  }
  const sum = summarize(state.receipts, classify, state.categories);
  const m = sum.months.get(state.month) || { total: 0, count: 0, byCat: new Map() };
  // Pant and returns (negative) are never a slice of the donut; shares are of what was spent (Maria B5)
  const rows = [...m.byCat.entries()].filter(([, v]) => v >= 0.5).sort((a, b) => b[1] - a[1]);
  const negRows = [...m.byCat.entries()].filter(([, v]) => v <= -0.5);
  m.posTotal = rows.reduce((a, [, v]) => a + v, 0);
  m.negRows = negRows;
  const uncatAmount = m.byCat.get(UNCAT) || 0;
  const pctCat = m.total ? Math.round(((m.total - uncatAmount) / m.total) * 100) : 0;


  const allMonthReceipts = state.receipts.filter((r) => r.date.startsWith(state.month));
  const rcat = state.receiptCat && rows.some(([id]) => id === state.receiptCat) ? state.receiptCat : null;
  const monthReceipts = rcat ? allMonthReceipts.filter((r) => (summarize([r], classify, state.categories).months.get(state.month)?.byCat.get(rcat) || 0) >= 0.5) : allMonthReceipts;
  const uncatMonth = summarize(allMonthReceipts, classify, state.categories).uncat;

  body.innerHTML = `
    <div class="card">
      <div class="month-nav">
        <button class="icon-btn" type="button" data-month="-1" aria-label="Forrige måned"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m15 18-6-6 6-6"/></svg></button>
        <h2>${esc(monthFmt.format(monthDate(state.month)))}</h2>
        <button class="icon-btn" type="button" data-month="1" aria-label="Neste måned"><svg viewBox="0 0 24 24" aria-hidden="true"><path d="m9 18 6-6-6-6"/></svg></button>
      </div>
      <p class="hero">${kr(m.total)}</p>
      <p class="hero-sub">${m.count} kvittering${m.count === 1 ? '' : 'er'}${m.count ? ` · ${pctCat} % kategorisert` : ''}</p>
    </div>
    ${rows.length ? donutCard(m, rows) : ''}
    <div class="card trend"><h2>Siste 12 måneder</h2>${trendSVG(sum.months)}</div>
    ${uncatMonth.length ? `<div class="card"><h2>Ukategorisert <small>· ${count(uncatMonth.length, 'vare', 'varer')}</small></h2>
      <p class="hint">Velg kategori én gang, så lages en regel som gjelder alle like varer fremover.</p>
      <ul class="queue">${uncatMonth.slice(0, 25).map((u, i) => `<li><span class="q-name">${esc(u.name)}<small>${u.count}× · ${kr(u.amount)}</small></span><button class="btn small" type="button" data-uncat="${i}">Velg</button></li>`).join('')}</ul></div>` : ''}
    <div class="card" id="month-receipts"><h2>Kvitteringer <small>· ${esc(rcat ? catName(rcat) : monthFmt.format(monthDate(state.month)))}</small></h2>
      ${rcat ? `<p class="hint">Bare kvitteringer med ${esc(catName(rcat).toLowerCase())}. <button type="button" class="linkish" data-receipt-all>Vis alle</button></p>` : ''}
      ${monthReceipts.length ? `<ul class="receipts">${monthReceipts.map((r) => `<li><button type="button" data-receipt="${esc(r.id)}"><span>${esc(r.store || r.chain)}<small>${esc(dayFmt.format(new Date(r.date + 'T12:00')))}${r.lines && r.lines.length ? ` · ${count(r.lines.length, 'vare', 'varer')}` : ''} · ${esc(sourceName(r.source))}</small></span><b>${kr(r.total)}</b></button></li>`).join('')}</ul>` : '<p class="hint">Ingen kvitteringer denne måneden.</p>'}
    </div>`;
  body._uncat = uncatMonth;
  initDonut(body.querySelector('.donut'), m);
}

/* ---------- Forbruk: the category donut (DESIGN.md v0.7 § 3a) ---------- */
const catName = (id) => (catById(id) ? catById(id).name : 'Ukategorisert');
const krWords = (v) => `${Math.round(v).toLocaleString('nb-NO')} kroner`;
let donutPrev = null; // {month, arcs: Map(catId → {len, start})}: where the arcs were, for the morph
let donutDrawn = false; // the draw-in plays once per session
function donutCard(m, rows) {
  const lay = arcLayout(rows.map(([, v]) => v));
  const monthName = titleCaseFirst(monthFmt.format(monthDate(state.month)).split(' ')[0]);
  const arcs = rows.map(([id, v], i) => {
    const c = catById(id);
    const pct = m.posTotal ? Math.round((v / m.posTotal) * 100) : 0;
    const d = dash(lay[i]);
    const circ = (cls) => `<circle class="${cls}" cx="100" cy="100" r="${DONUT.R}" stroke-dasharray="${d.array}" stroke-dashoffset="${d.offset}" transform="rotate(-90 100 100)"/>`;
    return `<g class="arc" role="button" tabindex="0" aria-pressed="false" data-arc="${i}" data-cat="${esc(id)}" data-len="${lay[i].len}" data-start="${lay[i].start}"
      aria-label="${esc(catName(id))}: ${esc(krWords(v))}, ${pct} prosent" style="--c:${esc(c ? catColor(c) : 'var(--text-3)')}">${circ('arc-hit')}${circ('arc-ring')}${circ('arc-gap')}${circ('arc-vis')}</g>`;
  }).join('');
  const legend = rows.map(([id, v], i) => {
    const c = catById(id);
    const pct = m.posTotal ? Math.round((v / m.posTotal) * 100) : 0;
    return `<li><button type="button" class="legend-row" data-arc="${i}" aria-pressed="false"><span class="dot" style="--c:${esc(c ? catColor(c) : 'var(--text-3)')}"></span><span class="ln">${esc(catName(id))}</span><span class="lv">${krShort(v)} · ${pct} %</span></button></li>`;
  }).join('') + (m.negRows || []).map(([id, v]) => `<li class="legend-neg"><span class="dot" aria-hidden="true"></span><span class="ln">${esc(catName(id))} (pant og retur)</span><span class="lv">−${krShort(-v)}</span></li>`).join('');
  return `<div class="card donut-card"><h2>Per kategori</h2>
    <div class="donut-wrap">
      <svg class="donut" viewBox="0 0 200 200" role="group" aria-label="Forbruk ${esc(monthName.toLowerCase())}: ${esc(krWords(m.total))} fordelt på ${count(rows.length, 'kategori', 'kategorier')}">
        <circle class="donut-track" cx="100" cy="100" r="${DONUT.R}"/>
        <circle class="donut-glow" cx="100" cy="100" r="${DONUT.R}" transform="rotate(-90 100 100)" stroke-dasharray="0 ${DONUT.C}"/>
        ${arcs}
      </svg>
      <div class="donut-center" aria-hidden="true"><span class="dc-label">Totalt</span><span class="dc-value${kr(m.total).length > 10 ? ' long' : ''}">${kr(m.total)}</span><span class="dc-sub">${count(m.count, 'kvittering', 'kvitteringer')}</span></div>
    </div>
    <p class="donut-hint">Trykk på en farge, eller midt i ringen for å bla gjennom kategoriene</p>
    <div class="donut-actions" hidden><button type="button" class="btn small" data-donut-receipts>Se kvitteringer</button></div>
    <ul class="legend">${legend}</ul></div>`;
}

let donutMonth = null; // the month the Forbruk view last showed, to announce every change, also to/from an empty month (Maria B9)
function initDonut(svg, m) {
  const reduce = reducedMotion();
  const live = $('#sr-live');
  const changed = donutMonth && donutMonth !== state.month;
  donutMonth = state.month;
  if (!svg) {
    donutPrev = null;
    if (changed && live) live.textContent = `${titleCaseFirst(monthFmt.format(monthDate(state.month)).split(' ')[0])}: ingen kvitteringer`;
    return;
  }
  if (changed && !donutPrev && live) live.textContent = `${titleCaseFirst(monthFmt.format(monthDate(state.month)).split(' ')[0])}: ${krWords(m.total)}`;
  const arcs = [...svg.querySelectorAll('.arc')];
  const card = svg.closest('.donut-card');
  const center = card.querySelector('.donut-center');
  const glow = svg.querySelector('.donut-glow');
  const lay = arcs.map((g) => ({ len: Number(g.dataset.len), start: Number(g.dataset.start), frac: 0 }));
  lay.forEach((l, i) => { l.frac = (i + 1 < lay.length ? lay[i + 1].start : 1) - l.start; });
  const monthChanged = donutPrev && donutPrev.month !== state.month;
  if (monthChanged) { const live = $('#sr-live'); if (live) live.textContent = `${titleCaseFirst(monthFmt.format(monthDate(state.month)).split(' ')[0])}: ${krWords(m.total)}`; }

  // Morph (month change) or draw in (first time this session): start from the old arcs, then set the new ones.
  if (!reduce) {
    const from = (g, i) => {
      if (!donutDrawn) return { len: 0, start: lay[i].start };
      const p = donutPrev && donutPrev.arcs.get(g.dataset.cat);
      return p || { len: 0, start: lay[i].start };
    };
    const vis = arcs.map((g) => g.querySelector('.arc-vis'));
    vis.forEach((c, i) => { const d = dash(from(arcs[i], i)); c.setAttribute('stroke-dasharray', d.array); c.setAttribute('stroke-dashoffset', d.offset); });
    svg.classList.add(donutDrawn ? 'morph' : 'draw');
    if (!donutDrawn) vis.forEach((c, i) => { c.style.transitionDelay = `${i * 30}ms`; });
    svg.getBoundingClientRect();
    requestAnimationFrame(() => vis.forEach((c, i) => { const d = dash(lay[i]); c.setAttribute('stroke-dasharray', d.array); c.setAttribute('stroke-dashoffset', d.offset); }));
  } else if (monthChanged) svg.closest('.donut-wrap').classList.add('fade');
  donutDrawn = true;
  donutPrev = { month: state.month, arcs: new Map(arcs.map((g, i) => [g.dataset.cat, lay[i]])) };

  const select = (i, { buzz = false } = {}) => {
    const cur = arcs.findIndex((g) => g.classList.contains('sel'));
    if (i === cur) return;
    if (buzz && i >= 0) haptic(8);
    arcs.forEach((g, k) => { g.classList.toggle('sel', k === i); g.setAttribute('aria-pressed', String(k === i)); });
    svg.classList.toggle('has-sel', i >= 0);
    card.querySelectorAll('.legend-row').forEach((b) => b.setAttribute('aria-pressed', String(Number(b.dataset.arc) === i)));
    state.donutSel = i >= 0 ? arcs[i].dataset.cat : null;
    if (i >= 0) {
      const d = dash(lay[i]);
      glow.setAttribute('stroke-dasharray', d.array);
      glow.setAttribute('stroke-dashoffset', d.offset);
      glow.style.setProperty('--c', arcs[i].style.getPropertyValue('--c'));
    } else glow.setAttribute('stroke-dasharray', `0 ${DONUT.C}`);
    const [label, value, sub] = center.children;
    if (i >= 0) {
      const v = m.byCat.get(arcs[i].dataset.cat) || 0;
      label.textContent = catName(arcs[i].dataset.cat);
      value.textContent = kr(v);
      value.classList.toggle('long', kr(v).length > 10);
      sub.textContent = `${m.posTotal ? Math.round((v / m.posTotal) * 100) : 0} % av det du kjøpte`;
    } else {
      label.textContent = 'Totalt';
      value.textContent = kr(m.total);
      value.classList.toggle('long', kr(m.total).length > 10);
      sub.textContent = count(m.count, 'kvittering', 'kvitteringer');
    }
    center.classList.remove('swap'); center.getBoundingClientRect(); center.classList.add('swap');
    card.querySelector('.donut-actions').hidden = i < 0;
    if (i >= 0) card.querySelector('[data-donut-receipts]').textContent = `Se kvitteringer med ${catName(arcs[i].dataset.cat).toLowerCase()}`;
  };
  const keep = arcs.findIndex((g) => g.dataset.cat === state.donutSel);
  if (keep >= 0) select(keep);

  card.addEventListener('click', (e) => {
    const lr = e.target.closest('.legend-row');
    if (lr) { const i = Number(lr.dataset.arc); select(arcs[i].classList.contains('sel') ? -1 : i); return; }
    if (e.target.closest('[data-donut-receipts]')) {
      state.receiptCat = state.donutSel;
      renderSpending();
      $('#month-receipts')?.scrollIntoView({ block: 'start', behavior: reduce ? 'auto' : 'smooth' });
    }
  });
  let drag = null;
  svg.addEventListener('pointerdown', (e) => {
    const r = svg.getBoundingClientRect(); // cached for the whole drag
    drag = { x0: e.clientX, y0: e.clientY, r, id: e.pointerId, on: false };
  });
  svg.addEventListener('pointermove', (e) => {
    if (!drag || e.pointerId !== drag.id) return;
    const dx = e.clientX - drag.x0;
    const dy = e.clientY - drag.y0;
    if (!drag.on) {
      if (Math.abs(dy) > 8 && Math.abs(dy) > Math.abs(dx)) { drag = null; return; }
      if (Math.abs(dx) < 6) return;
      drag.on = true;
      try { svg.setPointerCapture(e.pointerId); } catch { /* synthetic events */ }
    }
    const x = ((e.clientX - drag.r.left) / drag.r.width) * 200;
    const y = ((e.clientY - drag.r.top) / drag.r.height) * 200;
    const i = arcAt(lay, x, y);
    if (i >= 0) requestAnimationFrame(() => select(i, { buzz: true }));
  });
  const stop = (e) => { if (drag && drag.on) { drag.dragged = true; svg._justDragged = true; setTimeout(() => { svg._justDragged = false; }, 0); } drag = null; };
  svg.addEventListener('pointerup', stop);
  svg.addEventListener('pointercancel', () => { drag = null; });
  svg.addEventListener('click', (e) => {
    if (svg._justDragged) return;
    const g = e.target.closest('.arc');
    if (!g) {
      // a tap in the middle steps through the categories (largest first), then back to the total
      const r = svg.getBoundingClientRect();
      const dx = ((e.clientX - r.left) / r.width) * 200 - DONUT.CX;
      const dy = ((e.clientY - r.top) / r.height) * 200 - DONUT.CY;
      if (Math.hypot(dx, dy) < DONUT.R - DONUT.W / 2 && arcs.length) {
        const cur = arcs.findIndex((a) => a.classList.contains('sel'));
        select(cur + 1 < arcs.length ? cur + 1 : -1, { buzz: true });
        return;
      }
      select(-1);
      return;
    }
    const i = Number(g.dataset.arc);
    select(g.classList.contains('sel') ? -1 : i);
  });
  svg.addEventListener('keydown', (e) => {
    const g = e.target.closest('.arc');
    if (!g) return;
    const i = Number(g.dataset.arc);
    if (e.key === 'ArrowRight' || e.key === 'ArrowDown') { e.preventDefault(); const n = (i + 1) % arcs.length; arcs[n].focus(); select(n); }
    else if (e.key === 'ArrowLeft' || e.key === 'ArrowUp') { e.preventDefault(); const n = (i - 1 + arcs.length) % arcs.length; arcs[n].focus(); select(n); }
    else if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); select(g.classList.contains('sel') ? -1 : i); }
    else if (e.key === 'Escape') select(-1);
  });
}

const sourceName = (s) => ({ trumf: 'Trumf', rema: 'REMA', coop: 'Coop', manual: 'manuell', import: 'import', claude: 'kvitteringsfoto' }[s] || s);

function trendSVG(months) {
  const keys = [];
  for (let i = 11; i >= 0; i--) keys.push(shiftMonth(state.month, -i));
  const vals = keys.map((k) => (months.get(k) ? months.get(k).total : 0));
  const W = 340, H = 150, padL = 36, padB = 20, padT = 16;
  const max = Math.max(...vals, 1);
  const step = niceStep(max);
  const top = Math.ceil(max / step) * step;
  const bw = (W - padL) / 12;
  const y = (v) => padT + (H - padT - padB) * (1 - v / top);
  let grid = '';
  for (let v = 0; v <= top + 0.1; v += step) {
    grid += `<line x1="${padL}" x2="${W}" y1="${y(v)}" y2="${y(v)}"/><text x="${padL - 4}" y="${y(v) + 3}" text-anchor="end">${v >= 1000 ? (v / 1000).toLocaleString('nb-NO') + 'k' : v}</text>`;
  }
  const bars = keys
    .map((k, i) => {
      const x = padL + i * bw + 3;
      const v = vals[i];
      const h = Math.max(0, H - padB - y(v));
      const sel = k === state.month;
      const label = `${monthFmt.format(monthDate(k))}: ${kr(v)}`;
      return `<g><title>${esc(label)}</title>
        <path class="bar${sel ? ' sel' : ''}" d="${barPath(x, H - padB, bw - 6, h)}"/>
        <rect class="hit" x="${padL + i * bw}" y="${padT}" width="${bw}" height="${H - padT}" data-goto="${k}" role="button" aria-label="${esc(label)}"/>
        <text x="${x + (bw - 6) / 2}" y="${H - 6}" text-anchor="middle">${esc(monthShort.format(monthDate(k)).replace('.', '').slice(0, 3))}</text>
        ${sel && v ? `<text class="val" x="${x + (bw - 6) / 2}" y="${y(v) - 4}" text-anchor="middle">${esc(krShort(v).replace(' kr', ''))}</text>` : ''}</g>`;
    })
    .join('');
  return `<svg viewBox="0 0 ${W} ${H}" role="img" aria-label="Forbruk per måned, siste 12 måneder"><g class="grid">${grid}</g>${bars}</svg>`;
}
function niceStep(max) {
  const raw = max / 3;
  const p = Math.pow(10, Math.floor(Math.log10(raw)));
  return [1, 2, 2.5, 5, 10].map((m) => m * p).find((s) => s >= raw);
}
function barPath(x, base, w, h) {
  if (h <= 0) return '';
  const r = Math.min(4, h, w / 2);
  return `M${x},${base}V${base - h + r}Q${x},${base - h} ${x + r},${base - h}H${x + w - r}Q${x + w},${base - h} ${x + w},${base - h + r}V${base}Z`;
}

/* ---------- rule dialog ---------- */
let ruleTarget = null;
function openRuleDialog(target) {
  ruleTarget = target;
  const dlg = $('#dlg-rule');
  const f = $('#rule-form');
  $('#rule-item').textContent = `${target.name}${target.amount != null ? ` · ${kr(target.amount)}` : ''}`;
  f.pattern.value = target.name.toLowerCase();
  $('#rule-ean-row').hidden = !target.ean;
  $('#rule-ean').textContent = target.ean || '';
  f.useEan.checked = false;
  $('#rule-cats').innerHTML =
    '<legend class="sr-only">Kategori</legend>' +
    state.categories.map((c) => `<button type="button" data-pick="${esc(c.id)}"><span class="dot" style="--c:${esc(catColor(c))}"></span>${esc(c.name)}</button>`).join('');
  dlg.showModal();
  if (document.activeElement) document.activeElement.blur(); // don't pop up the iOS keyboard
}
function applyRule(categoryId) {
  const f = $('#rule-form');
  const useEan = f.useEan.checked && ruleTarget.ean;
  const pattern = useEan ? String(ruleTarget.ean) : f.pattern.value.trim();
  if (!pattern) return;
  state.rules = state.rules.filter((r) => !(r.type === (useEan ? 'ean' : 'text') && normalize(r.pattern) === normalize(pattern)));
  state.rules.push({ id: uid(), type: useEan ? 'ean' : 'text', pattern, categoryId, created: Date.now() });
  save.rules();
  rebuildClassifier();
  $('#dlg-rule').close();
  toast(`Regel lagret: «${pattern}» → ${catById(categoryId).name}`);
  render();
  if ($('#dlg-detail').open && detailId) openDetail(detailId);
}

/* ---------- receipt detail ---------- */
let detailId = null;
function openDetail(id) {
  const r = state.receipts.find((x) => x.id === id);
  if (!r) return;
  detailId = id;
  const valid = new Set(state.categories.map((c) => c.id));
  const lineHTML = (r.lines || [])
    .map((l, i) => {
      const cid = (l.category && valid.has(l.category) && l.category) || classify(l.name, l.ean, l.group);
      const c = cid && catById(cid);
      return `<li><span>${esc(l.name)}${l.qty && l.qty !== 1 ? ` <small>× ${esc(String(l.qty).replace('.', ','))}</small>` : ''}</span><b>${kr(l.amount)}</b>
        <button type="button" data-line="${i}"><span class="dot" style="--c:${esc(c ? catColor(c) : 'transparent')};${c ? '' : 'border:1px dashed currentColor'}"></span>${esc(c ? c.name : 'Ukategorisert – velg')}</button></li>`;
    })
    .join('');
  $('#detail-body').innerHTML = `
    <h2>${esc(r.store || r.chain)}</h2>
    <p class="hint" style="margin:0">${esc(dayFmt.format(new Date(r.date + 'T12:00')))} ${esc(r.date.slice(0, 4))}${r.time ? ` kl. ${esc(r.time)}` : ''} · ${esc(sourceName(r.source))} · <b>${kr(r.total)}</b></p>
    ${lineHTML ? `<ul class="lines">${lineHTML}</ul>` : `<p class="hint">Ingen varelinjer. Kategori: ${esc(r.category && catById(r.category) ? catById(r.category).name : 'Ukategorisert')}</p>`}
    <div class="dlg-actions"><button class="btn btn-danger" type="button" data-delreceipt="${esc(r.id)}">Slett kvittering</button><button class="btn btn-primary" type="button" data-close>Lukk</button></div>`;
  if (!$('#dlg-detail').open) $('#dlg-detail').showModal();
}

/* ---------- manual receipt ---------- */
function openReceiptDialog() {
  const f = $('#receipt-form');
  f.reset();
  f.date.value = todayISO();
  f.category.innerHTML = '<option value="">Ukategorisert / fordel på varelinjer</option>' + state.categories.map((c) => `<option value="${esc(c.id)}">${esc(c.name)}</option>`).join('');
  const names = new Set([...(state.offersData ? state.offersData.chains.map((c) => c.name) : []), ...state.receipts.map((r) => r.store)]);
  $('#store-list').innerHTML = [...names].filter(Boolean).map((n) => `<option value="${esc(n)}">`).join('');
  $('#receipt-error').textContent = '';
  $('#dlg-receipt').showModal();
}
function saveManualReceipt() {
  const f = $('#receipt-form');
  const err = $('#receipt-error');
  const lines = [];
  for (const raw of f.lines.value.split('\n')) {
    const s = raw.trim();
    if (!s) continue;
    const m = s.match(/^(.*?)[;\t]\s*(-?[\d\s.,]+)\s*(kr)?$/i) || s.match(/^(.*\S)\s+(-?\d[\d\s]*[.,]\d{1,2})\s*(kr)?$/i);
    if (!m) { err.textContent = `Forstår ikke linjen «${s}». Skriv «navn; beløp».`; return false; }
    lines.push({ name: m[1].trim(), amount: toNumber(m[2]) ?? 0 });
  }
  if (notFinite(f.total.value)) { err.textContent = 'Beløpet må være et tall, f.eks. 249,90.'; return false; }
  let total = toNumber(f.total.value);
  if (total == null) total = lines.reduce((s, l) => s + l.amount, 0);
  if (!f.store.value.trim()) { err.textContent = 'Skriv inn butikk.'; return false; }
  if (!f.date.value) { err.textContent = 'Velg dato.'; return false; }
  if (!total) { err.textContent = 'Skriv inn beløp eller varelinjer.'; return false; }
  const r = {
    id: 'manual-' + uid(),
    source: 'manual',
    chain: f.store.value.trim(),
    store: f.store.value.trim(),
    date: f.date.value,
    time: null,
    total: Math.round(total * 100) / 100,
    currency: 'NOK',
    category: f.category.value || null,
    lines,
  };
  const v = validateReceipts([r]);
  if (v.rejected.length) { err.textContent = v.rejected[0].message.replace(', og ble hoppet over.', '.'); return false; }
  state.receipts = mergeReceipts(state.receipts, [r]).receipts;
  save.receipts();
  state.month = r.date.slice(0, 7);
  toast('Kvittering lagret');
  return true;
}

/* ---------- import / export ---------- */
async function importFile(file) {
  let res;
  try {
    res = detectImportText(await file.text());
  } catch (e) {
    toast(friendlyError(e));
    return;
  }
  if (res.kind === 'backup') {
    const b = res.data;
    if (!confirm(`Hente inn sikkerhetskopien fra ${b.exported ? new Date(b.exported).toLocaleString('nb-NO') : 'ukjent dato'}? Den erstatter kategoriene, reglene, kvitteringene og handlelisten her på telefonen.`)) return;
    const c = cleanBackup(b); // checked before anything is saved: a bad entry must never reach the database
    if (usableCategories(c.categories)) state.categories = c.categories; // never wipe the user's categories with a broken list
    else if (Array.isArray(b.categories) && b.categories.length) b.keptCategories = true;
    state.rules = c.rules;
    state.receipts = c.receipts;
    state.list = c.list;
    if (c.settings) state.settings = mergeSettings(state.settings, c.settings, { fromBackup: true }); // keeps this device's repo + token
    b.rejected = c.rejected;
    b.dropped = c.dropped;
    await Promise.all([save.categories(), save.rules(), save.receipts(), save.list(), save.settings()]);
    rebuildClassifier();
    toast('Sikkerhetskopien er hentet inn' + (b.keptCategories ? '. Kategoriene i fila var ødelagt, så dine er beholdt' : '') + (b.dropped ? `. ${b.dropped} ${b.dropped === 1 ? "ødelagt oppføring" : "ødelagte oppføringer"} ble hoppet over` : '') + rejectedText(b.rejected));
  } else {
    const { receipts, added, updated, duplicates } = mergeReceipts(state.receipts, res.data);
    state.receipts = receipts;
    await save.receipts();
    if (res.data.length) state.month = res.data.map((r) => r.date).sort().pop().slice(0, 7);
    toast(`${{ trumf: 'Trumf', coop: 'Coop' }[res.kind] || 'spending.json'}: ${added} ${added === 1 ? 'ny' : 'nye'}${updated ? `, ${updated} oppdatert` : ''} ${added + updated === 1 ? 'kvittering' : 'kvitteringer'}${duplicates ? ` (${duplicates} dobbelt fra flere kilder slått sammen)` : ''}${rejectedText(res.rejected)}`);
  }
  render();
}

/** One friendly sentence per receipt that was left out of an import (negative, future date, not a number). */
function rejectedText(rejected) {
  if (!rejected || !rejected.length) return '';
  const shown = rejected.slice(0, 5).map((r) => r.message).join(' ');
  return `. ${rejected.length} hoppet over: ${shown}${rejected.length > 5 ? ` Og ${rejected.length - 5} til.` : ''}`;
}

/* ---------- sync from the user's own private GitHub repo (written by ingest/ on their Mac) ---------- */
const SYNC_EVERY_MS = 60 * 60 * 1000;
const RETRY_MS = 10 * 60 * 1000;
const REPO_RE = /^[A-Za-z0-9-]{1,39}\/[A-Za-z0-9._-]{1,100}$/;
const PATH_RE = /^[A-Za-z0-9._\/-]{1,200}$/;
let syncing = false;

async function ghFile(s, path) {
  const res = await fetch(`https://api.github.com/repos/${s.repo}/contents/${path.split('/').map(encodeURIComponent).join('/')}`, {
    headers: { Authorization: `Bearer ${s.token}`, Accept: 'application/vnd.github.raw+json', 'X-GitHub-Api-Version': '2022-11-28' },
    cache: 'no-store',
  });
  if (res.status === 401 || res.status === 403) throw new Error('Nøkkelen ble avvist (utløpt eller mangler lesetilgang)');
  if (res.status === 404) return null;
  if (!res.ok) throw new Error(`GitHub svarte ${res.status}`);
  return res.json();
}

async function syncSpending({ quiet = false } = {}) {
  const s = state.settings.sync;
  if (!s || !s.token || !s.repo || syncing || !navigator.onLine) return;
  syncing = true;
  s.lastTry = Date.now();
  try {
    if (!REPO_RE.test(s.repo) || !PATH_RE.test(s.path) || s.path.includes('..')) throw new Error('Ugyldig repo eller filsti');
    const json = await ghFile(s, s.path);
    if (json === null) throw new Error(`Fant ikke ${s.path} i ${s.repo} (eller nøkkelen har ikke tilgang til repoet)`);
    const { kind, data, rejected } = detectImport(json);
    if (kind === 'backup') throw new Error('Fila er en sikkerhetskopi, ikke kvitteringer');
    const { receipts, added } = mergeReceipts(state.receipts, data);
    state.receipts = receipts;
    // Optional: offers with barcodes next to spending.json (ingest/rema.py --offers). Missing file = fine.
    const dir = s.path.includes('/') ? s.path.slice(0, s.path.lastIndexOf('/') + 1) : '';
    try {
      const extra = await ghFile(s, dir + 'rema-offers.json');
      if (extra) {
        state.extraOffers = { fetchedAt: Date.now(), source: extra.source, offers: parseExtraOffers(extra) };
        await db.set('extraOffers', state.extraOffers);
        rebuildOfferIndex();
      }
    } catch (e) {
      console.warn('rema-offers.json', e);
    }
    s.lastSync = Date.now();
    s.lastError = null;
    await Promise.all([save.receipts(), save.settings()]);
    if (added && data.length) state.month = data.map((r) => r.date).sort().pop().slice(0, 7);
    if (!quiet || added || rejected.length) toast((added ? `Fra Mac-en: ${added === 1 ? '1 ny kvittering' : `${added} nye kvitteringer`}` : 'Fra Mac-en: ingen nye kvitteringer') + rejectedText(rejected));
  } catch (e) {
    s.lastError = friendlyError(e);
    save.settings();
    if (!quiet) toast('Klarte ikke å hente fra Mac-en: ' + friendlyError(e));
  } finally {
    syncing = false;
    render();
  }
}

/** Auto-sync at most hourly, and after a failure wait 10 min instead of retrying on every app switch. */
const syncDue = () => {
  const s = state.settings.sync;
  if (!s || !s.token || !s.repo) return false;
  const now = Date.now();
  if (s.lastTry && now - s.lastTry < RETRY_MS) return false;
  return !s.lastSync || now - s.lastSync > SYNC_EVERY_MS;
};

function exportBackup() {
  const { token, ...sync } = state.settings.sync || {};
  const data = {
    schema: BACKUP_SCHEMA,
    app: 'Matkassa Premium ' + APP_VERSION,
    exported: new Date().toISOString(),
    categories: state.categories,
    rules: state.rules,
    receipts: state.receipts,
    list: state.list,
    settings: { ...state.settings, sync }, // never put the GitHub key in a backup file
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const name = `matkassa-premium-backup-${todayISO()}.json`;
  const file = new File([blob], name, { type: 'application/json' });
  if (navigator.canShare && navigator.canShare({ files: [file] }) && /iPhone|iPad|Android/i.test(navigator.userAgent)) {
    navigator.share({ files: [file], title: name }).catch(() => {});
    return;
  }
  const a = document.createElement('a');
  a.href = URL.createObjectURL(blob);
  a.download = name;
  document.body.appendChild(a);
  a.click();
  setTimeout(() => { URL.revokeObjectURL(a.href); a.remove(); }, 1000);
}

/* ---------- one-way copy from the original Matkassa (same origin, same browser) ---------- */
async function originalExists() {
  try { return typeof indexedDB.databases === 'function' && (await indexedDB.databases()).some((d) => d.name === db.ORIGINAL_DB); } catch (e) { return false; }
}

async function copyFromOriginal() {
  const o = await db.readOriginal();
  const n = (k) => (Array.isArray(o && o[k]) ? o[k].length : 0);
  if (!o || !(n('receipts') || n('list') || n('rules'))) { toast('Fant ingen Matkassa-data i denne nettleseren'); return; }
  if (!confirm(`Kopiere fra Matkassa: ${count(n('receipts'), 'kvittering', 'kvitteringer')}, ${count(n('list'), 'vare', 'varer')} i handlelisten og ${count(n('rules'), 'regel', 'regler')}? Det erstatter dataene i Matkassa Premium på denne enheten. Matkassa selv endres ikke, og GitHub-nøkkelen kopieres ikke.`)) return;
  if (usableCategories(cleanCategories(o.categories))) state.categories = cleanCategories(o.categories);
  state.rules = Array.isArray(o.rules) ? o.rules : [];
  state.receipts = Array.isArray(o.receipts) ? o.receipts : [];
  state.list = Array.isArray(o.list) ? o.list : [];
  if (o.extraOffers && Array.isArray(o.extraOffers.offers)) { state.extraOffers = o.extraOffers; await db.set('extraOffers', o.extraOffers); }
  if (o.offers && Array.isArray(o.offers.offers) && !state.offersData) { state.offersData = o.offers; await db.set('offers', o.offers); }
  // Same rules as a backup: this device's token stays; the repo name is copied so only the key has to be pasted.
  const merged = mergeSettings(state.settings, o.settings || {}, { fromBackup: true });
  const repo = o.settings && o.settings.sync && typeof o.settings.sync.repo === 'string' ? o.settings.sync.repo : '';
  if (repo && REPO_RE.test(repo) && repo !== merged.sync.repo) Object.assign(merged.sync, { repo, lastSync: null, lastTry: null, lastError: null });
  if (merged.area) merged.geo = 'done';
  state.settings = merged;
  await Promise.all([save.categories(), save.rules(), save.receipts(), save.list(), save.settings()]);
  rebuildClassifier();
  renderGeoCard();
  toast(`Kopiert fra Matkassa: ${count(n('receipts'), 'kvittering', 'kvitteringer')}${state.settings.sync.repo && !state.settings.sync.token ? '. Lim inn GitHub-nøkkelen under Mer → Avansert for å hente her også' : ''}`);
  render();
}

/* ---------- Mer: a grouped settings list with subpages (plain Norwegian; technical things under Avansert) ---------- */
const MORE_PAGES = {
  omrade: 'Område', kjeder: 'Kjeder', budsjett: 'Budsjett', kvitteringer: 'Kvitteringer', kategorier: 'Kategorier',
  konto: 'Konto', personvern: 'Hva skjer med dataene mine?', backup: 'Sikkerhetskopi og import', avansert: 'Avansert (for utviklere)', om: 'Om Matkassa',
};
const ICONS = {
  omrade: '<path d="M12 21s-7-6.2-7-11.5a7 7 0 0 1 14 0C19 14.8 12 21 12 21z"/><circle cx="12" cy="9.5" r="2.5"/>',
  kjeder: '<path d="M4 9h16l-1.5-5h-13zM5 9v11h14V9M9 20v-6h6v6"/>',
  budsjett: '<circle cx="12" cy="12" r="8.5"/><path d="M12 7.5v9M14.5 9.5c-.4-1-1.3-1.5-2.5-1.5-1.4 0-2.5.8-2.5 2s1.1 1.6 2.5 2 2.5.8 2.5 2-1.1 2-2.5 2c-1.2 0-2.2-.6-2.6-1.6"/>',
  kvitteringer: '<path d="M6 3h12v18l-3-2-3 2-3-2-3 2zM9 8h6M9 12h6"/>',
  kategorier: '<rect x="4" y="4" width="7" height="7" rx="2"/><rect x="13" y="4" width="7" height="7" rx="2"/><rect x="4" y="13" width="7" height="7" rx="2"/><rect x="13" y="13" width="7" height="7" rx="2"/>',
  konto: '<circle cx="12" cy="8" r="4"/><path d="M4 21a8 8 0 0 1 16 0"/>',
  personvern: '<path d="M12 3 4.5 6v6c0 4.5 3.2 7.7 7.5 9 4.3-1.3 7.5-4.5 7.5-9V6z"/><path d="m9 12 2 2 4-4"/>',
  backup: '<path d="M12 4v11M7.5 10.5 12 15l4.5-4.5"/><path d="M5 15v3a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2v-3"/>',
  avansert: '<path d="M4 7h10M18 7h2M4 17h4M12 17h8"/><circle cx="16" cy="7" r="2"/><circle cx="10" cy="17" r="2"/>',
  om: '<circle cx="12" cy="12" r="8.5"/><path d="M12 11v5M12 8h.01"/>',
  tekst: '<path d="M4 18 9 6l5 12M5.8 14h6.4M15 18l3-7 3 7M15.8 16h4.4"/>',
  tema: '<path d="M20 14.5A8 8 0 0 1 9.5 4a8 8 0 1 0 10.5 10.5z"/>',
  mat: '<path d="M7 3v8a2 2 0 0 0 4 0V3M9 13v8M17 21V3c-2 1-3 4-3 7s1 3 3 3"/>',
};
const icon = (k) => `<span class="ic" aria-hidden="true"><svg viewBox="0 0 24 24">${ICONS[k]}</svg></span>`;
const row = (page, label, value = '') => `<li><button type="button" class="set-row" data-morepage="${page}">${icon(page)}<span class="lbl">${esc(label)}</span><span class="val">${esc(value)}</span><span class="chev" aria-hidden="true"></span></button></li>`;
const toggleRow = (key, ic, label, sub) => `<li><label class="set-row switch-row">${icon(ic)}<span class="lbl">${esc(label)}${sub ? `<small>${esc(sub)}</small>` : ''}</span>
  <input type="checkbox" role="switch" data-setting="${key}" ${state.settings[key] ? 'checked' : ''}></label></li>`;

const YOUR_DATA = [
  ['Hva hentes?', 'Ukens tilbud, uten noe om deg. Og kvitteringene du selv henter inn: fra en fil, eller fra REMA via Mac-en hvis du kobler til.'],
  ['Hvor lagres det?', 'Bare her på telefonen. Lager du en konto (valgfritt), også i din egen konto i skyen, som bare du kan se.'],
  ['Hvem ser det?', 'Bare du. Ingen reklame, og ingenting selges videre.'],
  ['Hvordan kobler jeg fra?', 'Under Kjeder trykker du «Koble fra» på REMA. Nederst her kan du slette kvitteringene eller alt sammen.'],
];

function renderMore() {
  const page = MORE_PAGES[state.morePage] ? state.morePage : null;
  $('#view-title').textContent = $('#bar-title').textContent = page ? MORE_PAGES[page] : 'Mer';
  const body = $('#more-body');
  body.innerHTML = page ? `<button type="button" class="back" data-morepage=""><span class="chev back-chev" aria-hidden="true"></span>Mer</button>${MORE_RENDER[page]()}` : moreRoot();
  renderStatus();
}

function moreRoot() {
  const known = state.offersData ? knownChains() : [];
  const shown = known.filter((c) => !hiddenChains().has(c.id)).length;
  return `<ul class="settings">${row('omrade', 'Område', area().name)}${row('kjeder', 'Kjeder', known.length ? `${shown} av ${known.length}` : '')}${row('budsjett', 'Budsjett', state.settings.budget ? `${krShort(state.settings.budget)} i måneden` : 'Ikke satt')}</ul>
    <ul class="settings">${row('kvitteringer', 'Kvitteringer', String(state.receipts.length))}${row('kategorier', 'Kategorier', String(state.categories.length))}</ul>
    <ul class="settings"><li><label class="set-row">${icon('tema')}<span class="lbl">Tema</span>
      <select class="set-select" data-theme-select>${[['auto', 'Som telefonen'], ['dark', 'Mørkt'], ['light', 'Lyst']].map(([v, l]) => `<option value="${v}"${(state.settings.theme || 'auto') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label></li>
      <li><label class="set-row">${icon('tekst')}<span class="lbl">Tekststørrelse</span>
      <select class="set-select" data-textsize-select>${[['normal', 'Normal'], ['stor', 'Stor'], ['xstor', 'Ekstra stor']].map(([v, l]) => `<option value="${v}"${(state.settings.textSize || 'normal') === v ? ' selected' : ''}>${l}</option>`).join('')}</select></label></li>
      ${toggleRow('calm', 'tema', 'Rolig visning', 'Ingen glød eller vipping, mykere blåfarge')}${toggleRow('foodOnly', 'mat', 'Kun mat i tilbudene', 'Skjuler blomster, klær, dyremat og husholdning')}</ul>
    <ul class="settings">${cloud ? row('konto', 'Konto', cloud.user ? 'Logget inn' : 'Valgfritt') : ''}${row('personvern', 'Hva skjer med dataene mine?')}${row('backup', 'Sikkerhetskopi og import')}${row('avansert', 'Avansert (for utviklere)')}${row('om', 'Om Matkassa', APP_VERSION)}</ul>`;
}

const MORE_RENDER = {
  omrade: () => `<div class="card"><p class="hint" style="margin-top:0">Tilbudene hentes fra kundeavisene rundt dette stedet.</p>
      <div class="add-row"><label class="sr-only" for="area-select">Område</label>
        <select id="area-select">${AREAS.map((a) => `<option value="${esc(a.name)}" ${a.name === area().name ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}${AREAS.some((a) => a.name === area().name) ? '' : `<option selected>${esc(area().name)}</option>`}</select></div>
      <div class="actions" style="margin-top:10px"><button class="btn" type="button" data-action="area-here">Bruk min posisjon</button></div>
      <p class="hint">Posisjonen rundes av til omtrent 1 km og lagres bare her på telefonen.</p></div>`,
  kjeder: () => {
    if (!state.settings.chainsSeen) { state.settings.chainsSeen = true; save.settings(); }
    refreshChainSoon();
    return `<div class="card" id="chain-connect">${chainCard()}</div>
    <div class="card"><p class="hint" style="margin-top:0">Slå av kjedene du ikke handler i. De vises da ikke i tilbudene eller i handlelisten.</p>
      ${state.offersData ? `<div class="chain-toggles">${[...knownChains()].sort((a, b) => a.name.localeCompare(b.name, 'nb')).map((c) => `<label class="toggle"><input type="checkbox" data-chainshow="${esc(c.id)}" ${hiddenChains().has(c.id) ? '' : 'checked'}><span class="dot" style="--c:${esc(chainColor(c.id, c.color))}"></span>${esc(c.name)}</label>`).join('')}</div>` : '<p class="hint">Kjedene vises når tilbudene er hentet.</p>'}</div>`;
  },
  budsjett: () => `<div class="card"><form id="budget-form">
      <label class="field"><span>Hvor mye vil du bruke på mat i måneden?</span>
        <input id="budget-input" inputmode="numeric" placeholder="f.eks. 4 000" value="${state.settings.budget ? esc(String(state.settings.budget)) : ''}" autocomplete="off"></label>
      <div class="actions"><button class="btn btn-primary" type="submit">Lagre</button>${state.settings.budget ? '<button class="btn btn-ghost" type="button" data-action="budget-clear">Fjern budsjettet</button>' : ''}</div>
    </form><p class="hint">På Hjem ser du hvor mye som er igjen denne måneden, og omtrent hvor mye du kan bruke per dag. Det regnes ut fra kvitteringene dine.</p></div>`,
  kvitteringer: () => `<div class="card"><p class="hero">${state.receipts.length}</p><p class="hero-sub">kvittering${state.receipts.length === 1 ? '' : 'er'} lagret her på telefonen</p>
      <div class="actions" style="margin-top:12px"><button class="btn btn-primary" type="button" data-action="import">Hent inn fra fil</button><button class="btn" type="button" data-action="manual">Legg inn selv</button></div></div>
    <div class="card"><h2>Slik får du kvitteringene</h2>
      <ol class="steps"><li><b>Kiwi, Meny, Spar og Joker:</b> logg inn på trumf.no og be om innsyn i dataene dine. Du får en fil på e-post.</li>
      <li><b>Coop:</b> logg inn på coop.no, gå til Min side og be om innsyn. Du får en fil på e-post.</li>
      <li>Trykk <b>Hent inn fra fil</b> over og velg fila. Den samme kvitteringen telles bare én gang.</li></ol></div>`,
  kategorier: () => {
    const rules = [...state.rules].sort((a, b) => (b.created || 0) - (a.created || 0));
    return `<div class="card"><p class="hint" style="margin-top:0">Endre navn eller farge, eller legg til en egen kategori.</p>
      <div id="cat-list">${state.categories.map((c) => `<div class="cat-row">
        <input type="color" value="${esc(c.color)}" data-catcolor="${esc(c.id)}" aria-label="Farge for ${esc(c.name)}">
        <input type="text" value="${esc(c.name)}" data-catname="${esc(c.id)}" aria-label="Navn på kategori" maxlength="40">
        <button class="del" type="button" data-catdel="${esc(c.id)}" aria-label="Slett kategorien ${esc(c.name)}">×</button></div>`).join('')}</div>
      <form id="cat-add" class="add-row" style="margin-top:8px"><label class="sr-only" for="cat-new">Ny kategori</label><input id="cat-new" placeholder="Ny kategori, f.eks. Barnemat" maxlength="40"><button class="btn" type="submit">Legg til</button></form></div>
    <div class="card"><h2>Dine regler <small>· ${rules.length}</small></h2>
      ${rules.length ? `<ul class="rules">${rules.map((r) => `<li><span>${r.type === 'ean' ? 'Strekkode' : 'Navn med'} «${esc(r.pattern)}» → ${esc(catById(r.categoryId) ? catById(r.categoryId).name : '(slettet kategori)')}</span><button class="btn small btn-ghost" type="button" data-ruledel="${esc(r.id)}" aria-label="Slett regelen for ${esc(r.pattern)}">Slett</button></li>`).join('')}</ul>` : '<p class="hint">Ingen egne regler ennå. En regel lages når du velger kategori for en vare under Forbruk, og gjelder da alle like varer, også i tilbudene.</p>'}</div>`;
  },
  konto: () => accountCard(),
  personvern: () => `<div class="card your-data"><h2>Hva skjer med dataene mine?</h2><dl>${YOUR_DATA.map(([q, a]) => `<dt>${q}</dt><dd>${a}</dd>`).join('')}</dl>
      <dl class="kv"><dt>Kvitteringer</dt><dd>${state.receipts.length}</dd><dt>Varer i listen</dt><dd>${state.list.length}</dd><dt>Egne regler</dt><dd>${state.rules.length}</dd></dl></div>
    <div class="card danger-zone"><h2>Slett</h2>
      <p class="hint" style="margin-top:0">Du får spørsmål før noe slettes. Det kan ikke angres.</p>
      <div class="actions"><button class="btn btn-danger" type="button" data-action="wipe-spending">Slett alle kvitteringer</button>
      <button class="btn btn-danger" type="button" data-action="wipe-all">Slett alt på denne telefonen</button></div></div>`,
  backup: () => `<div class="card"><h2>Sikkerhetskopi</h2>
      <p class="hint" style="margin-top:0">${state.persisted ? 'Telefonen har lovet å ta vare på dataene. En sikkerhetskopi er likevel lurt hvis du bytter telefon.' : 'Telefonen kan rydde bort data fra nettsider du ikke har brukt på en stund. Lag en sikkerhetskopi av og til, så mister du ingenting.'}</p>
      <div class="actions"><button class="btn" type="button" data-action="export">Lag sikkerhetskopi</button><button class="btn" type="button" data-action="import">Hent inn sikkerhetskopi</button></div></div>`,
  avansert: () => {
    const d = state.offersData;
    return `<p class="hint">For deg som henter kvitteringer fra REMA 1000 eller Trumf med et skript på Mac-en. Alt her er valgfritt.</p>
    <div class="card"><h2>Kvitteringer fra Mac-en (GitHub)</h2>
      <p class="hint" style="margin-top:0">Kvitteringene hentes fra ditt eget <strong>private</strong> GitHub-repo, som Mac-skriptet (<code>ingest/sync.sh</code>) oppdaterer. Nøkkelen lagres bare her og tas aldri med i sikkerhetskopien.</p>
      <form id="sync-form">
        <label class="field"><span>Ditt private repo</span><input id="sync-repo" value="${esc(state.settings.sync.repo)}" placeholder="brukernavn/matkassa-data" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
        <label class="field"><span>GitHub-nøkkel (kun lesetilgang)</span><input id="sync-token" type="password" placeholder="${state.settings.sync.token ? 'Lagret – lim inn for å bytte' : 'github_pat_…'}" autocomplete="off"></label>
        <div class="actions" style="margin-top:8px">
          <button class="btn" type="submit">${state.settings.sync.token ? 'Hent nå' : 'Lagre og hent'}</button>
          ${state.settings.sync.token ? '<button class="btn btn-ghost" type="button" data-action="sync-forget">Glem nøkkel</button>' : ''}
        </div>
      </form>
      <dl class="kv">
        <dt>Sist hentet</dt><dd>${state.settings.sync.lastSync ? timeFmt.format(state.settings.sync.lastSync) : 'aldri'}</dd>
        ${state.settings.sync.lastError ? `<dt>Feil</dt><dd>${esc(state.settings.sync.lastError)}</dd>` : ''}
      </dl></div>
    ${state.originalExists ? '<div class="card"><h2>Fra vanlige Matkassa</h2><div class="actions"><button class="btn" type="button" data-action="copy-original">Hent data fra Matkassa</button></div><p class="hint" style="margin-top:0">Kopierer kvitteringer, handleliste, kategorier og regler fra den vanlige Matkassa i denne nettleseren. Bare én vei, og ikke GitHub-nøkkelen. På iPhone har hver hjem-skjerm-app egen lagring; bruk da en sikkerhetskopi i stedet.</p></div>' : ''}
    <div class="card"><h2>Data</h2><dl class="kv">
        <dt>Tilbud lagret</dt><dd>${d ? `${d.offers.length} (${timeFmt.format(d.fetchedAt)})` : 'ingen'}</dd>
        <dt>Med strekkode</dt><dd>${(() => { const c = eanCoverage(offerIndex.map((x) => x.o)); return c.n ? `${c.withEan} av ${c.n} (${c.pct.toLocaleString('nb-NO', { maximumFractionDigits: 1 })} %)` : '–'; })()}${state.extraOffers ? ` · REMA Superpris: ${state.extraOffers.offers.length}` : ''}</dd>
        <dt>Varig lagring</dt><dd>${state.persisted ? 'Ja' : 'Ikke bekreftet'}</dd>
      </dl>
      <p class="hint">Filer som kan hentes inn: Trumf-innsyn (JSON), Coop-innsyn (CSV eller JSON), <code>spending.json</code> fra Mac-skriptet og sikkerhetskopier.</p></div>`;
  },
  om: () => `<div class="card"><h2>Matkassa+ ${APP_VERSION}</h2>
      <ul class="about">
        <li>Tilbudene hentes fra Tjek (motoren bak eTilbudsavis) for området rundt ${esc(area().name)}. Det er ikke en offisiell tjeneste.</li>
        <li>Kategorien til et tilbud gjettes fra navnet. Du kan rette den med en egen regel.</li>
        <li>«Tilbud for deg» lærer bare av kvitteringene her på telefonen.</li>
        <li>Alt du legger inn, lagres bare her på telefonen.</li>
      </ul>
      <h3 class="sub">Legg appen på hjem-skjermen</h3>
      <p class="hint" style="margin-top:4px">iPhone: åpne siden i Safari, trykk Del-knappen og velg <strong>Legg til på Hjem-skjerm</strong>. Android: trykk menyen i Chrome og velg <strong>Installer app</strong>.</p></div>`,
};

/** A confirm sheet for anything that deletes data: says exactly what goes, the red button names the action. */
function askConfirm({ title, text, ok }) {
  const dlg = $('#dlg-confirm');
  $('#confirm-h').textContent = title;
  $('#confirm-text').textContent = text;
  $('#confirm-ok').textContent = ok;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((r) => dlg.addEventListener('close', () => r(dlg.returnValue === 'ok'), { once: true }));
}

async function wipeAll() {
  state.list = [];
  state.receipts = [];
  state.rules = [];
  state.savings = [];
  state.categories = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
  state.extraOffers = null;
  state.settings = { ...defaultSettings(), geo: 'done' }; // also forgets the area and the GitHub key
  await Promise.all([save.list(), save.receipts(), save.rules(), save.categories(), save.settings(), db.set('savings', []), db.del('extraOffers')]);
  applyTextSize();
  rebuildClassifier();
  state.morePage = null;
  render();
  toast('Alt er slettet fra denne telefonen');
}

/* ---------- account + cloud sync (optional, Supabase) ---------- */
const COLL = { receipts: 'receipts', list_items: 'list', categories: 'categories', rules: 'rules' };
const CHAINS = [['trumf', 'Trumf', 'Kiwi, Meny, Spar, Joker'], ['rema', 'REMA 1000', 'Æ-appen'], ['coop', 'Coop', 'Coop-medlemskap']];
const cloud = cloudConfigured()
  ? new Cloud({ loadSession: () => db.get('cloudSession'), saveSession: (s) => (s ? db.set('cloudSession', s) : db.del('cloudSession')) })
  : null;
const cloudState = { busy: false, lastSync: null, error: null, connections: null };
let cloudTimer;
let cloudApplying = false; // saves made by the sync itself don't schedule another sync

function scheduleCloudSync(ms = 4000) {
  if (!cloud || !cloud.user || cloudApplying) return;
  clearTimeout(cloudTimer);
  cloudTimer = setTimeout(() => cloudSync({ quiet: true }), ms);
}

function askMerge(local, remote) {
  const dlg = $('#dlg-merge');
  const k = (n) => `${n} kvittering${n === 1 ? '' : 'er'}`;
  const v = (n) => `${n} vare${n === 1 ? '' : 'r'}`;
  $('#merge-text').textContent = `Denne enheten har ${k(local.receipts)} og ${v(local.list)} i handlelisten. Kontoen har ${k(remote.receipts)} og ${v(remote.list)}.`;
  dlg.returnValue = '';
  dlg.showModal();
  return new Promise((r) => dlg.addEventListener('close', () => r(dlg.returnValue || 'cancel'), { once: true }));
}

async function cloudSync({ quiet = false } = {}) {
  if (!cloud || !cloud.user || cloudState.busy) return;
  if (!navigator.onLine) { cloudState.error = 'Frakoblet – oppdateres når nettet er tilbake'; if (state.tab === 'mer') renderMore(); return; }
  cloudState.busy = true;
  if (state.tab === 'mer') renderMore();
  try {
    let meta = await db.get('cloudMeta');
    if (!meta || meta.userId !== cloud.user.id) meta = { userId: cloud.user.id, lastPull: {}, known: {}, settings: null, first: true };
    const pulled = {};
    for (const t of COLLECTIONS) pulled[t] = await cloud.pull(t, meta.lastPull[t] || null);
    const remoteSettings = await cloud.pullSettings();
    let replace = false;
    if (meta.first) {
      const live = (t) => pulled[t].filter((r) => !r.deleted).length;
      const local = { receipts: state.receipts.length, list: state.list.length };
      const remote = { receipts: live('receipts'), list: live('list_items') };
      if ((local.receipts || local.list || state.rules.length) && (remote.receipts || remote.list || live('rules'))) {
        const choice = await askMerge(local, remote);
        if (choice === 'cancel') { cloudState.error = 'Avbrutt – ingenting er endret'; return; }
        replace = choice === 'account';
      }
    }
    cloudApplying = true;
    const changed = [];
    const pushes = {};
    for (const t of COLLECTIONS) {
      const key = COLL[t];
      const r = reconcile(state[key], meta.known[t], pulled[t], { replace });
      if (key === 'categories' && !r.next.length) r.next = DEFAULT_CATEGORIES.map((c) => ({ ...c }));
      if (hash(r.next) !== hash(state[key])) { state[key] = r.next; changed.push(key); }
      meta.known[t] = r.known;
      pushes[t] = r;
      for (const row of pulled[t]) if (!meta.lastPull[t] || row.updated_at > meta.lastPull[t]) meta.lastPull[t] = row.updated_at;
    }
    // settings (area, chains): the account's version wins on a first login and whenever they weren't changed here
    if (remoteSettings && (meta.first || hash(pickSettings(state.settings)) === meta.settings)) {
      state.settings = mergeSettings(state.settings, remoteSettings.data, { fromBackup: true }); // never touches sync/geo
      meta.settings = hash(pickSettings(state.settings));
      changed.push('settings');
    }
    for (const key of changed) await save[key]();
    if (changed.length) { rebuildClassifier(); render(); }
    cloudApplying = false;
    for (const t of COLLECTIONS) {
      const r = pushes[t];
      if (!r.push.length) continue;
      await cloud.push(t, r.push);
      for (const p of r.push) { if (p.deleted) delete meta.known[t][p.id]; else meta.known[t][p.id] = r.pushedHashes[p.id]; }
    }
    const now = hash(pickSettings(state.settings));
    if (!remoteSettings || now !== meta.settings) { await cloud.pushSettings(state.settings); meta.settings = now; }
    meta.first = false;
    await db.set('cloudMeta', meta);
    cloudState.lastSync = Date.now();
    cloudState.error = null;
    if (!quiet) toast('Kontoen er oppdatert');
    cloud.connections().then((c) => { cloudState.connections = c; if (state.tab === 'mer') renderMore(); }).catch(() => {});
  } catch (e) {
    cloudState.error = friendlyError(e);
    if (!quiet) toast(friendlyError(e));
  } finally {
    cloudApplying = false;
    cloudState.busy = false;
    if (state.tab === 'mer') renderMore();
  }
}

function accountCard() {
  if (!cloud) return '';
  if (!cloud.user) {
    return `<div class="card" id="account-card"><h2>Konto</h2>
      <p class="hint" style="margin-top:0">Valgfritt. Med en konto får du kvitteringer, handleliste, kategorier og regler på alle enhetene dine. Uten konto virker alt som før, bare på denne enheten.</p>
      <form id="login-form">
        <label class="field"><span>E-post</span><input id="login-email" type="email" autocomplete="username" autocapitalize="off" spellcheck="false" required></label>
        <label class="field"><span>Passord</span><input id="login-password" type="password" autocomplete="current-password"></label>
        <div class="actions" style="margin-top:8px">
          <button class="btn btn-primary" type="submit">Logg inn</button>
          <button class="btn" type="button" data-action="signup">Opprett konto</button>
          <button class="btn btn-ghost" type="button" data-action="magic">Send innloggingslenke</button>
        </div>
      </form>
      ${cloudState.error ? `<p class="hint" role="alert">${esc(cloudState.error)}</p>` : ''}
    </div>`;
  }
  const conn = new Map((cloudState.connections || []).map((c) => [c.chain, c]));
  return `<div class="card" id="account-card"><h2>Konto</h2>
    <dl class="kv">
      <dt>Logget inn som</dt><dd>${esc(cloud.user.email)}</dd>
      <dt>Sist oppdatert</dt><dd>${cloudState.busy ? 'Oppdaterer …' : cloudState.lastSync ? timeFmt.format(cloudState.lastSync) : 'ikke ennå'}</dd>
      ${cloudState.error ? `<dt>Feil</dt><dd>${esc(cloudState.error)}</dd>` : ''}
    </dl>
    <div class="actions" style="margin-top:8px">
      <button class="btn" type="button" data-action="cloud-sync"${cloudState.busy ? ' aria-busy="true"' : ''}>Oppdater nå</button>
      <button class="btn btn-ghost" type="button" data-action="logout">Logg ut</button>
    </div>
    <h3 class="sub">Kvitteringer fra kjedene</h3>
    <ul class="conns">${CHAINS.map(([id, name, what]) => {
      const c = conn.get(id);
      return `<li data-conn="${id}"><span><b>${esc(name)}</b><small>${c ? `${c.status === 'connected' ? 'Tilkoblet' : c.status === 'expired' ? 'Utløpt – koble til på nytt' : 'Feiler'}${c.last_fetch_at ? ` · hentet ${esc(timeFmt.format(new Date(c.last_fetch_at)))}` : ''}` : esc(what)}</small></span>
        ${c ? `<button class="btn small btn-ghost" type="button" data-disconnect="${id}">Koble fra</button>` : `<button class="btn small" type="button" data-connect="${id}">Koble til</button>`}</li>`;
    }).join('')}</ul>
    <div class="actions" style="margin-top:12px"><button class="btn btn-danger btn-ghost" type="button" data-action="cloud-wipe">Slett dataene mine i skyen</button></div>
  </div>`;
}

const CONNECT_HELP = {
  trumf: 'Trumf kan ikke kobles til inne i appen: innloggingen (telefon, passord og SMS-kode) skjer bare på trumf.no, og Trumf har ingen innlogging for andre apper. Gjør det i stedet én gang på Mac-en: kjør «node ingest/trumf-login.mjs», logg inn hos Trumf i vinduet som åpnes, og lukk det. Deretter hentes kvitteringene hver søndag.',
  rema: 'REMA kobles til fra en Mac én gang: åpne Matkassa der og trykk «Koble til REMA». Du logger inn hos REMA selv, i REMAs eget vindu, og passordet ditt lagres ikke hos oss. Etterpå kommer kvitteringene av seg selv.',
  coop: 'Coop har ingen åpen eller dokumentert måte å hente egne kvitteringer på. Bestill innsyn i stedet: coop.no → Min side → Bestill innsyn. Når du får fila, hent den inn under Mer → Kvitteringer.',
};

/* "Send lenke til Mac-en" (REMA on a phone): the share sheet, else copy the link. Nothing is sent by us. */
async function sendMacLink() {
  const url = location.origin + location.pathname;
  const text = 'Åpne Matkassa på Mac-en for å koble til REMA (én gang):';
  try { if (navigator.share) { await navigator.share({ title: 'Matkassa – koble til REMA', text, url }); return; } } catch (e) { if (e && e.name === 'AbortError') return; }
  try { await navigator.clipboard.writeText(`${text} ${url}`); toast('Lenken er kopiert. Lim den inn i en melding eller e-post til deg selv.'); } catch { toast(`Åpne denne adressen på Mac-en: ${url}`); } // never a bare URL (Maria L6)
}
document.addEventListener('click', (e) => { if (e.target.closest('[data-action="send-mac-link"]')) sendMacLink(); });

/* ---------- Koble til REMA (Mer → Kjeder). The login provider (Mac helper today, an iOS app later) is chosen in
   js/chains/index.js; this part only shows the status and calls the connection's actions. ---------- */
let remaConnection = null;
let chainRefreshedAt = 0;
function remaConn() {
  if (!remaConnection) {
    remaConnection = createConnection(REMA, pickProvider(), {
      onChange: () => { const el = $('#chain-connect'); if (el) el.innerHTML = chainCard(); },
      onSynced: afterChainSync,
    });
  }
  return remaConnection;
}
function refreshChainSoon() {
  if (Date.now() - chainRefreshedAt < 3000) return;
  chainRefreshedAt = Date.now();
  setTimeout(() => remaConn().refresh(), 0);
}
const chainLabel = (s) => {
  if (s.syncing) return 'Synker …';
  switch (s.state) {
    case STATES.UNSUPPORTED: return 'Gjøres fra Mac-en';
    case STATES.NOT_INSTALLED: return 'Hjelper ikke installert';
    case STATES.NEEDS_PAIRING: return 'Koble appen til Mac-en';
    case STATES.DISCONNECTED: return 'Ikke koblet';
    case STATES.CONNECTING: return 'Kobler til …';
    case STATES.CONNECTED: return `Koblet · ${s.lastSync ? `siste synk ${timeFmt.format(new Date(s.lastSync))}` : 'ikke synket ennå'}`;
    case STATES.EXPIRED: return 'Utløpt – logg inn på nytt';
    case STATES.ERROR: return 'Noe gikk galt';
    default: return 'Sjekker …';
  }
};
const chainBtn = (act, label, cls = '', busy = false) => `<button class="btn ${cls}" type="button" data-chainact="${act}"${busy ? ' aria-busy="true" disabled' : ''}>${label}</button>`;
function chainCard() {
  const s = remaConn().status;
  const b = REMA.badge;
  const msg = s.message ? `<p class="hint" role="alert">${esc(s.message)}</p>` : '';
  let body = '';
  if (s.state === STATES.UNSUPPORTED) {
    const c = (cloudState.connections || []).find((x) => x.chain === 'rema');
    body = `<p class="hint">REMA kobles til fra en Mac én gang. Etterpå kommer kvitteringene av seg selv.</p>
      <div class="actions"><button class="btn small" type="button" data-action="send-mac-link">Send lenke til Mac-en</button></div>
      ${c ? `<p class="hint">Koblet via Mac-en${c.last_fetch_at ? ` · hentet ${esc(timeFmt.format(new Date(c.last_fetch_at)))}` : ''}</p>` : ''}`;
  } else if (s.state === STATES.NOT_INSTALLED) {
    body = `<p class="hint">For å koble til REMA trenger Mac-en en liten hjelper som bare denne Mac-en kan nå. Slik installerer du den (én gang):</p>
      <ol class="steps"><li>Åpne <b>Terminal</b> og gå til Matkassa-mappen (<code>mattilbud-app</code>).</li>
      <li>Kjør <code>ingest/launchd/install-helper.sh</code>.</li>
      <li>Kopier koden som vises, trykk <b>Prøv igjen</b> og lim den inn.</li></ol>
      <div class="actions" style="margin-top:10px">${chainBtn('refresh', 'Prøv igjen')}</div>`;
  } else if (s.state === STATES.NEEDS_PAIRING) {
    body = `<form id="pair-form"><label class="field"><span>Kode fra Terminal</span><input id="pair-code" placeholder="XXXX-XXXX-XXXX-XXXX" autocomplete="off" autocapitalize="characters" spellcheck="false" maxlength="40"></label>
      <div class="actions" style="margin-top:8px"><button class="btn btn-primary" type="submit">Koble til Mac-en</button></div></form>
      <p class="hint">Koden vises når hjelperen installeres, eller med <code>python3 ingest/helper.py pair</code>. Den lagres bare i denne nettleseren.</p>${msg}`;
  } else if (s.state === STATES.DISCONNECTED) {
    body = `<p class="hint">${esc(REMA.about)}</p>${msg}<div class="actions" style="margin-top:10px">${chainBtn('login', 'Koble til REMA', 'btn-primary')}</div>`;
  } else if (s.state === STATES.CONNECTING) {
    body = `<p class="hint">Logg inn hos REMA i nettleservinduet som åpnet seg (telefonnummer og kode). Kom tilbake hit etterpå. Ser du ikke vinduet, trykk <b>Åpne på nytt</b>.</p>
      <div class="actions" style="margin-top:10px">${chainBtn('login', 'Åpne på nytt')}</div>`;
  } else if (s.state === STATES.CONNECTED) {
    body = `${s.lastSyncOk === false ? msg : ''}<div class="actions" style="margin-top:10px">${chainBtn('sync', s.syncing ? 'Synker …' : 'Synk nå', 'btn-primary', s.syncing)}${chainBtn('disconnect', 'Koble fra', 'btn-ghost', s.syncing)}</div>`;
  } else if (s.state === STATES.EXPIRED) {
    body = `${msg}<div class="actions" style="margin-top:10px">${chainBtn('login', 'Logg inn på nytt', 'btn-primary')}${chainBtn('disconnect', 'Koble fra', 'btn-ghost')}</div>`;
  } else if (s.state === STATES.ERROR) {
    body = `${msg}<div class="actions" style="margin-top:10px">${chainBtn('refresh', 'Prøv igjen')}</div>`;
  }
  return `<h2>Kvitteringer fra kjedene</h2>
    <div class="chain-conn" data-state="${esc(s.state || 'checking')}">
      <span class="chain-badge" style="--badge-bg:${b.bg};--badge-fg:${b.fg};--badge-stripe:${b.stripe}" aria-hidden="true">${esc(REMA.name)}</span>
      <span class="chain-conn-text"><b>${esc(REMA.name)}</b><small id="rema-state" role="status">${esc(chainLabel(s))}</small></span>
    </div>${body}`;
}
async function chainAction(act) {
  const c = remaConn();
  if (act === 'refresh') { chainRefreshedAt = Date.now(); await c.refresh(); return; }
  if (act === 'login') {
    const s = await c.login();
    if (s.state === STATES.CONNECTING) toast('Logg inn hos REMA i vinduet som åpnet seg');
    return;
  }
  if (act === 'sync') { await c.sync(); return; }
  if (act === 'disconnect') {
    if (!confirm('Koble fra REMA? Innloggingen hos REMA slettes fra Mac-en, og nye kvitteringer hentes ikke. Kvitteringene du alt har, beholdes.')) return;
    const s = await c.disconnect();
    if (s.state === STATES.DISCONNECTED) toast('REMA er koblet fra');
  }
}
async function afterChainSync(s) {
  if (s.lastSyncOk === false) { toast(s.state === STATES.EXPIRED ? 'REMA-innloggingen er utløpt' : 'Synken feilet – se Mer → Kjeder'); return; }
  toast('REMA-kvitteringene er hentet');
  // The Mac delivered them to the account and/or the private data repo; pull them in here too.
  if (cloud && cloud.user) cloudSync({ quiet: true });
  else if (state.settings.sync && state.settings.sync.token) syncSpending({ quiet: true });
}

async function accountAction(act, btn) {
  const email = () => ($('#login-email') ? $('#login-email').value.trim() : '');
  const pw = () => ($('#login-password') ? $('#login-password').value : '');
  try {
    if (act === 'signup') {
      if (!email() || pw().length < 8) { toast('Skriv e-post og et passord på minst 8 tegn'); return; }
      const s = await cloud.signUp(email(), pw());
      if (!s) { toast('Sjekk e-posten din og trykk på lenken for å bekrefte kontoen'); return; }
      toast('Konto opprettet');
      await cloudSync();
    }
    if (act === 'magic') {
      if (!email()) { toast('Skriv e-postadressen din først'); return; }
      await cloud.sendMagicLink(email(), location.origin + location.pathname);
      toast('Innloggingslenke sendt – åpne den på denne enheten');
    }
    if (act === 'logout') {
      await cloud.signOut();
      cloudState.connections = null;
      cloudState.lastSync = null;
      toast('Logget ut. Dataene ligger fortsatt på denne enheten.');
    }
    if (act === 'cloud-sync') await cloudSync();
    if (act === 'cloud-wipe' && confirm('Slette alle dataene dine i skyen (kvitteringer, liste, kategorier, regler, innstillinger og kjedetilkoblinger)? Dataene på denne enheten beholdes. Kontoen slettes helt ved å be om det (se personvern).')) {
      await cloud.wipe();
      await db.del('cloudMeta');
      await cloud.signOut();
      toast('Dataene dine i skyen er slettet, og du er logget ut');
    }
  } catch (e) {
    cloudState.error = friendlyError(e);
    toast(friendlyError(e));
  }
  renderMore();
}

function setArea(a) {
  state.settings.area = a;
  state.settings.geo = 'done'; // an explicit choice ends the first-run question
  save.settings();
  renderGeoCard();
  toast(`Område: ${a.name}. Henter tilbud …`);
  loadOffers(true);
}

/* ---------- location: first run asks once, then Mer → Område ---------- */
const GEO_TIMEOUT_MS = 10000;
// Rounded to ~1 km: Tjek only needs the neighbourhood, not the user's exact position.
const roundedArea = (p) => ({ name: 'Min posisjon', lat: +p.coords.latitude.toFixed(2), lng: +p.coords.longitude.toFixed(2), radius: 30000 });

/** One position request → {area} or {error: 'denied' | 'failed' | 'unsupported'}. Never hangs. */
function locate() {
  return new Promise((resolve) => {
    if (!navigator.geolocation) { resolve({ error: 'unsupported' }); return; }
    let settled = false;
    const finish = (r) => { if (!settled) { settled = true; clearTimeout(guard); resolve(r); } };
    // Some browsers never call back when they can't show the prompt (no user gesture); don't wait forever.
    const guard = setTimeout(() => finish({ error: 'failed' }), GEO_TIMEOUT_MS + 2000);
    navigator.geolocation.getCurrentPosition(
      (p) => finish({ area: roundedArea(p) }),
      (e) => finish({ error: e && e.code === 1 ? 'denied' : 'failed' }),
      { maximumAge: 36e5, timeout: GEO_TIMEOUT_MS },
    );
  });
}

async function geoPermission() {
  try { return (await navigator.permissions.query({ name: 'geolocation' })).state; } catch (e) { return 'unknown'; }
}

let geoBusy = false;
let geoSeq = 0; // only the newest request counts (a tap can overtake the automatic first try)
async function useMyLocation({ auto = false } = {}) {
  const my = ++geoSeq;
  geoBusy = true;
  renderGeoCard();
  const r = await locate();
  if (my !== geoSeq) return;
  geoBusy = false;
  if (r.area) { setArea(r.area); return; }
  // Automatic first try failed without a "no" (timeout, or no prompt without a tap): keep the card so a tap can ask.
  if (auto && r.error === 'failed') { renderGeoCard(); return; }
  geoFallback(r.error);
}

function geoFallback(reason) {
  const first = !state.settings.area;
  state.settings.geo = 'done';
  save.settings();
  renderGeoCard();
  const where = first ? `Viser tilbud for ${DEFAULT_AREA.name}. Bytt i Mer → Område.` : 'Området er uendret.';
  toast(reason === 'denied' ? `Fikk ikke bruke posisjonen. ${where}` : reason === 'unsupported' ? `Posisjon er ikke tilgjengelig. ${where}` : `Fant ikke posisjonen. ${where}`);
  if (state.tab === 'mer') renderMore();
}

/** First start without an area: ask for the location once (Trondheim offers load meanwhile). */
async function firstRunLocation() {
  const s = state.settings;
  if (s.area) { if (s.geo !== 'done') { s.geo = 'done'; save.settings(); } return; } // existing users keep their area
  if (s.geo === 'done') return;
  if (s.geo === 'asked') { renderGeoCard(); return; } // asked before without an answer: offer the button, no new prompt
  const perm = await geoPermission();
  if (perm === 'denied') { geoFallback('denied'); return; }
  s.geo = 'asked';
  save.settings();
  useMyLocation({ auto: true });
}

function renderGeoCard() {
  const el = $('#geo-card');
  if (!el) return;
  const show = !state.settings.area && state.settings.geo === 'asked';
  el.hidden = !show;
  if (!show) return;
  el.innerHTML = `<h2>Finn tilbud nær deg</h2>
    <p>Matkassa bruker posisjonen din, avrundet til omtrent 1 km, til å finne kundeavisene der du handler. Den lagres bare på denne enheten. Uten posisjon viser vi tilbud for ${esc(DEFAULT_AREA.name)}.</p>
    <div class="actions"><button class="btn btn-primary" type="button" data-action="geo-ask"${geoBusy ? ' aria-busy="true"' : ''}>${geoBusy ? 'Finner posisjon …' : 'Finn tilbud nær deg'}</button>
    <button class="btn btn-ghost" type="button" data-action="geo-skip">Bruk ${esc(DEFAULT_AREA.name)}</button></div>`;
}

/* ---------- events ---------- */
let resortTimer;
function bind() {
  for (const d of document.querySelectorAll('dialog.sheet')) enableSheetDrag(d);
  watchLargeTitle($('#large-title'), $('#topbar'));
  $('#toast').addEventListener('click', (e) => {
    if (!e.target.closest('.toast-act') || !toastAction) return;
    const run = toastAction.run;
    toastAction = null;
    hideToast();
    run();
  });
  document.querySelector('.tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });
  $('#refresh').addEventListener('click', () => loadOffers(true));
  window.addEventListener('hashchange', () => {
    const [h, pg] = location.hash.slice(1).split('/');
    if (TABS.includes(h) && h !== state.tab) showTab(h);
    if (h === 'mer' && MORE_PAGES[pg]) { state.morePage = pg; renderMore(); }
  });
  $('#view-hjem').addEventListener('click', (e) => {
    const go = e.target.closest('[data-morego]');
    if (go) { showTab('mer'); state.morePage = go.dataset.morego; renderMore(); return; }
    if (e.target.closest('[data-action="start-hide"]')) { state.settings.startDone = true; save.settings(); renderHome(); return; }
    if (e.target.closest('.why-box')) return;
    const a = e.target.closest('[data-gototab]');
    if (!a) return;
    e.preventDefault();
    showTab(a.dataset.gototab);
  });

  let searchTimer;
  $('#offer-search').addEventListener('input', (e) => {
    clearTimeout(searchTimer);
    searchTimer = setTimeout(() => {
      state.q = e.target.value.trim();
      state.shown = PAGE;
      renderOffers();
    }, 120);
  });
  $('#offer-sort').addEventListener('change', (e) => { state.sort = e.target.value; state.shown = PAGE; renderOffers(); });
  $('#offer-more').addEventListener('click', () => { state.shown += PAGE; renderOffers(); });

  $('#view-tilbud').addEventListener('click', (e) => {
    const chain = e.target.closest('[data-chain]');
    if (chain) {
      const id = chain.dataset.chain;
      const sel = new Set(state.settings.chains || []);
      if (!id) sel.clear();
      else if (sel.has(id)) sel.delete(id);
      else sel.add(id);
      state.settings.chains = [...sel];
      save.settings();
      state.shown = PAGE;
      renderOffers();
      return;
    }
    if (e.target.closest('[data-foodonly]')) {
      state.settings.foodOnly = !foodOnly();
      if (state.settings.foodOnly && NON_FOOD.has(state.cat)) state.cat = null;
      save.settings();
      state.shown = PAGE;
      renderOffers();
      return;
    }
    const cat = e.target.closest('[data-cat]');
    if (cat) { state.cat = cat.dataset.cat || null; state.shown = PAGE; renderOffers(); return; }
    const add = e.target.closest('[data-add]');
    if (add) {
      const o = offerById(add.dataset.add);
      if (!o) return;
      if (inList(o.id)) {
        state.list = state.list.filter((i) => !(i.offer && i.offer.id === o.id && !i.done));
        save.list();
        toast('Fjernet fra handlelisten');
      } else {
        addItem(titleCase(o.title), { id: o.id, chain: o.chain, chainId: o.chainId, price: o.price, prePrice: o.prePrice || null, till: o.till, title: o.title, eans: o.eans });
        toast(`Lagt til: ${titleCase(o.title)}`);
      }
      syncAddButtons(o);
      renderBadge();
    }
    const go = e.target.closest('[data-morego]');
    if (go) { showTab('mer'); state.morePage = go.dataset.morego; renderMore(); return; }
    if (e.target.closest('[data-action="refresh"]')) loadOffers(true);
    if (e.target.closest('[data-gototab]')) showTab(e.target.closest('[data-gototab]').dataset.gototab);
  });

  $('#list-form').addEventListener('submit', (e) => {
    e.preventDefault();
    const input = $('#list-input');
    addItem(input.value);
    input.value = '';
    renderList();
    renderBadge();
    input.focus();
  });
  /** Check an item off (or back on). The row moves to Avkrysset after a short beat, so a quick second tap still lands. */
  const setDone = (it, done) => {
    it.done = done;
    it.doneAt = done ? Date.now() : null;
    save.list();
    recordSaving(it);
    haptic(done ? 12 : 6);
    const row = document.querySelector(`[data-item="${CSS.escape(it.id)}"]`);
    if (row) { row.classList.toggle('done', done); const cb = row.querySelector('[data-toggle]'); if (cb) cb.checked = done; }
    renderBadge();
    clearTimeout(resortTimer);
    resortTimer = setTimeout(() => { if (state.tab === 'liste') flip($('#list-items'), renderList); }, 650);
  };
  const removeItem = async (id, row) => {
    const idx = state.list.findIndex((i) => i.id === id);
    if (idx < 0) return;
    const [gone] = state.list.splice(idx, 1);
    save.list();
    renderBadge();
    if (row) await exitRow(row);
    renderList();
    toast(`Slettet: ${gone.text}`, { label: 'Angre', run: () => { state.list.splice(Math.min(idx, state.list.length), 0, gone); save.list(); renderList(); renderBadge(); } });
  };
  $('#list-items').addEventListener('change', (e) => {
    const id = e.target.dataset.toggle;
    if (!id) return;
    const it = state.list.find((i) => i.id === id);
    if (it) setDone(it, e.target.checked);
  });
  $('#list-items').addEventListener('click', async (e) => {
    const del = e.target.closest('[data-del]');
    if (del) { await removeItem(del.dataset.del, del.closest('.item')); return; }
    const step = e.target.closest('[data-inc], [data-dec]');
    if (step) {
      const it = state.list.find((i) => i.id === (step.dataset.inc || step.dataset.dec));
      if (!it) return;
      if (it.qty == null) { const p = parseQty(it.text); it.text = p.name; it.qty = p.qty ?? 1; it.unit = p.unit || 'stk'; }
      const st = qtyStep(it.unit);
      it.qty = Math.max(st, Math.round((it.qty + (step.dataset.inc ? st : -st)) * 100) / 100);
      save.list();
      haptic(4);
      renderList();
      const again = document.querySelector(`[data-${step.dataset.inc ? 'inc' : 'dec'}="${CSS.escape(it.id)}"]`);
      if (again && !again.disabled) again.focus({ preventScroll: true });
      return;
    }
    if (e.target.closest('#list-clear')) {
      const gone = state.list.filter((i) => i.done);
      state.list = state.list.filter((i) => !i.done);
      save.list();
      renderList();
      renderBadge();
      toast(`Fjernet ${gone.length} avkryssede`, { label: 'Angre', run: () => { state.list = state.list.concat(gone); save.list(); renderList(); renderBadge(); } });
    }
  });
  enableSwipe($('#list-items'), {
    onDone: (id) => { const it = state.list.find((i) => i.id === id); if (it) setDone(it, !it.done); },
    onDelete: (id, row) => removeItem(id, row),
    haptic,
  });
  $('#view-liste').addEventListener('click', (e) => {
    const u = e.target.closest('[data-usual]');
    if (u) { addItem(u.dataset.usual); renderList(); renderBadge(); haptic(6); return; }
    if (e.target.closest('[data-action="share-list"]')) shareList();
    if (e.target.closest('[data-action="week-basics"]')) {
      const n = addWeekBasics();
      renderList();
      renderBadge();
      toast(n ? `La til ${n} faste varer (ukas basis)` : 'Ukas basis ligger allerede i listen');
      return;
    }
    if (e.target.closest('[data-action="paste-list"]')) {
      $('#paste-text').value = '';
      $('#paste-h').textContent = 'Lim inn en liste';
      $('#paste-add').hidden = false;
      $('#dlg-paste').showModal();
    }
  });
  // "Lukk" always closes the sheet (also mid-animation), and so does leaving the tab (Linn)
  $('#paste-form').querySelector('button[value="cancel"]').addEventListener('click', (e) => { e.preventDefault(); closePaste(); });
  $('#paste-form').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value !== 'add') return;
    e.preventDefault();
    const lines = pastedLines($('#paste-text').value);
    for (const l of lines.reverse()) addItem(l);
    closePaste();
    renderList();
    renderBadge();
    if (lines.length) toast(`La til ${lines.length} vare${lines.length === 1 ? '' : 'r'}`);
  });

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    const act = a.dataset.action;
    if (act === 'import') $('#file-input').click();
    if (act === 'manual') openReceiptDialog();
    if (act === 'export') exportBackup();
    if (act === 'copy-original') copyFromOriginal();
    if (act === 'area-here' || act === 'geo-ask') useMyLocation(); // a tap may always ask again (iOS may need the gesture)
    if (act === 'geo-skip') { state.settings.geo = 'done'; save.settings(); renderGeoCard(); toast(`Viser tilbud for ${DEFAULT_AREA.name}. Bytt i Mer → Område.`); }
    if (act === 'sync-forget') {
      Object.assign(state.settings.sync, { token: '', lastError: null });
      save.settings();
      renderMore();
    }
    if (['signup', 'magic', 'logout', 'cloud-sync', 'cloud-wipe'].includes(act) && cloud) accountAction(act, a);
    if (act === 'wipe-spending') {
      askConfirm({ title: 'Slette alle kvitteringer?', text: `${count(state.receipts.length, 'kvittering', 'kvitteringer')} slettes fra denne telefonen. Handlelisten, kategoriene og reglene beholdes. Det kan ikke angres.`, ok: 'Slett kvitteringene' })
        .then((yes) => { if (!yes) return; state.receipts = []; save.receipts(); render(); toast('Kvitteringene er slettet'); });
    }
    if (act === 'wipe-all') {
      askConfirm({ title: 'Slette alt?', text: 'Handlelisten, alle kvitteringer, egne kategorier og regler, budsjettet og innstillingene slettes fra denne telefonen. Det kan ikke angres. Lag gjerne en sikkerhetskopi først.', ok: 'Slett alt' })
        .then((yes) => { if (yes) wipeAll(); });
    }
    if (act === 'budget-clear') { state.settings.budget = null; save.settings(); toast('Budsjettet er fjernet'); renderMore(); }
  });
  $('#file-input').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await importFile(f);
  });

  $('#view-forbruk').addEventListener('click', (e) => {
    const mb = e.target.closest('[data-month]');
    if (mb) { state.month = shiftMonth(state.month, Number(mb.dataset.month)); state.receiptCat = null; renderSpending(); return; }
    if (e.target.closest('[data-receipt-all]')) { state.receiptCat = null; renderSpending(); return; }
    const g = e.target.closest('[data-goto]');
    if (g) { state.month = g.dataset.goto; renderSpending(); return; }
    const u = e.target.closest('[data-uncat]');
    if (u) { const item = $('#spend-body')._uncat[Number(u.dataset.uncat)]; if (item) openRuleDialog(item); return; }
    const r = e.target.closest('[data-receipt]');
    if (r) openDetail(r.dataset.receipt);
  });

  $('#rule-cats').addEventListener('click', (e) => {
    const b = e.target.closest('[data-pick]');
    if (b) applyRule(b.dataset.pick);
  });

  $('#dlg-detail').addEventListener('click', (e) => {
    if (e.target === $('#dlg-detail') || e.target.closest('[data-close]')) { $('#dlg-detail').close(); return; }
    const line = e.target.closest('[data-line]');
    if (line) {
      const r = state.receipts.find((x) => x.id === detailId);
      const l = r && r.lines[Number(line.dataset.line)];
      if (l) openRuleDialog({ name: l.name, ean: l.ean, amount: l.amount });
      return;
    }
    const del = e.target.closest('[data-delreceipt]');
    if (del && confirm('Slette denne kvitteringen?')) {
      state.receipts = state.receipts.filter((x) => x.id !== del.dataset.delreceipt);
      save.receipts();
      $('#dlg-detail').close();
      render();
    }
  });
  $('#dlg-detail').addEventListener('close', () => (detailId = null));

  $('#receipt-form').addEventListener('submit', (e) => {
    if (e.submitter && e.submitter.value === 'cancel') return;
    e.preventDefault();
    if (saveManualReceipt()) { $('#dlg-receipt').close(); render(); }
  });
  for (const d of document.querySelectorAll('dialog.sheet')) {
    d.addEventListener('click', (e) => { if (e.target === d) d.close(); });
  }

  $('#view-mer').addEventListener('click', (e) => {
    const pg = e.target.closest('[data-morepage]');
    if (!pg) return;
    state.morePage = pg.dataset.morepage || null;
    renderMore();
    window.scrollTo(0, 0);
    const focus = state.morePage ? $('#more-body .back') : $(`#more-body [data-morepage="${pg.dataset.morepage}"]`);
    if (focus && e.detail === 0) focus.focus(); // keyboard: keep the place
  });
  $('#view-mer').addEventListener('change', (e) => {
    const t = e.target;
    if (t.matches('[data-theme-select]')) { state.settings.theme = t.value; save.settings(); applyTheme(); return; }
    if (t.matches('[data-textsize-select]')) {
      state.settings.textSize = t.value;
      state.settings.bigText = t.value !== 'normal';
      if (t.value === 'xstor' && !state.settings.calm) { state.settings.calm = true; toast('Rolig visning er slått på. Du kan slå den av under.'); }
      save.settings();
      applyTextSize();
      renderMore();
      return;
    }
    if (t.dataset.setting) {
      state.settings[t.dataset.setting] = t.checked;
      save.settings();
      if (t.dataset.setting === 'bigText' || t.dataset.setting === 'calm') applyTextSize();
      haptic(6);
      return;
    }
    if (t.id === 'area-select') {
      const a = AREAS.find((x) => x.name === t.value);
      if (a) setArea(a);
      return;
    }
    if (t.dataset.chainshow) {
      const hidden = hiddenChains();
      if (t.checked) hidden.delete(t.dataset.chainshow);
      else hidden.add(t.dataset.chainshow);
      state.settings.hiddenChains = [...hidden];
      save.settings();
      return;
    }
    if (t.dataset.catname) {
      const c = catById(t.dataset.catname);
      const name = t.value.trim();
      if (c && name) { c.name = name; save.categories(); rebuildClassifier(); }
    }
    if (t.dataset.catcolor) {
      const c = catById(t.dataset.catcolor);
      if (c) { c.color = t.value; save.categories(); }
    }
  });
  $('#view-mer').addEventListener('click', (e) => {
    const cd = e.target.closest('[data-catdel]');
    if (cd) {
      const c = catById(cd.dataset.catdel);
      const n = state.rules.filter((r) => r.categoryId === c.id).length;
      if (!confirm(`Slette kategorien «${c.name}»?${n ? ` ${count(n, 'regel', 'regler')} som peker hit slettes også.` : ''} Varer i den blir ukategorisert.`)) return;
      state.categories = state.categories.filter((x) => x.id !== c.id);
      state.rules = state.rules.filter((r) => r.categoryId !== c.id);
      if (state.cat === c.id) state.cat = null;
      save.categories(); save.rules(); rebuildClassifier(); renderMore();
      return;
    }
    const rd = e.target.closest('[data-ruledel]');
    if (rd) {
      state.rules = state.rules.filter((r) => r.id !== rd.dataset.ruledel);
      save.rules(); rebuildClassifier(); renderMore();
    }
  });
  $('#view-mer').addEventListener('click', async (e) => {
    const c = e.target.closest('[data-connect]');
    if (c && c.dataset.connect === 'rema') { state.morePage = 'kjeder'; renderMore(); return; }
    if (c) { $('#connect-text').textContent = CONNECT_HELP[c.dataset.connect]; $('#dlg-connect').showModal(); return; }
    const ca = e.target.closest('[data-chainact]');
    if (ca) { chainAction(ca.dataset.chainact); return; }
    const d = e.target.closest('[data-disconnect]');
    if (d && cloud && confirm('Koble fra? Den lagrede innloggingen hos kjeden slettes fra serveren, og kvitteringer hentes ikke lenger automatisk. Kvitteringene du alt har, beholdes.')) {
      try { await cloud.disconnect(d.dataset.disconnect); cloudState.connections = (cloudState.connections || []).filter((x) => x.chain !== d.dataset.disconnect); toast('Koblet fra'); } catch (err) { toast(friendlyError(err)); }
      renderMore();
    }
  });
  $('#view-mer').addEventListener('submit', async (e) => {
    if (e.target.id === 'pair-form') {
      e.preventDefault();
      const s = await remaConn().pair($('#pair-code').value);
      if (s.state !== STATES.NEEDS_PAIRING && s.state !== STATES.NOT_INSTALLED) toast('Appen er koblet til Mac-en');
      return;
    }
    if (e.target.id === 'login-form') {
      e.preventDefault();
      try {
        await cloud.signIn($('#login-email').value.trim(), $('#login-password').value);
        cloudState.error = null;
        toast(`Logget inn som ${cloud.user.email}`);
        renderMore();
        await cloudSync();
      } catch (err) { cloudState.error = friendlyError(err); toast(friendlyError(err)); renderMore(); }
      return;
    }
    if (e.target.id === 'sync-form') {
      e.preventDefault();
      const s = state.settings.sync;
      const repo = $('#sync-repo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '');
      if (repo && !REPO_RE.test(repo)) { toast('Repo må skrives som brukernavn/repo'); return; }
      if (repo !== s.repo) Object.assign(s, { repo, lastSync: null, lastTry: null, lastError: null });
      const token = $('#sync-token').value.trim();
      if (token) s.token = token;
      await save.settings();
      if (!s.repo) { toast('Henting fra Mac-en er slått av'); renderMore(); return; }
      if (!s.token) { toast('Lim inn en GitHub-nøkkel først'); renderMore(); return; }
      syncSpending();
      return;
    }
    if (e.target.id === 'budget-form') {
      e.preventDefault();
      const raw = $('#budget-input').value.trim();
      const b = validBudget(raw);
      if (raw && !b) { toast('Skriv et beløp i kroner, f.eks. 4000'); return; }
      state.settings.budget = b;
      save.settings();
      toast(b ? `Budsjett: ${krShort(b)} i måneden` : 'Budsjettet er fjernet');
      state.morePage = null;
      renderMore();
      return;
    }
    if (e.target.id !== 'cat-add') return;
    e.preventDefault();
    const name = $('#cat-new').value.trim();
    if (!name) return;
    const palette = ['#2a78d6', '#eb6834', '#1baf7a', '#eda100', '#e87ba4', '#008300', '#6250d6', '#e34948'];
    state.categories.push({ id: 'c-' + uid(), name, color: palette[state.categories.length % palette.length] });
    save.categories(); rebuildClassifier(); renderMore();
  });

  window.addEventListener('online', () => { state.error = null; loadOffers(); scheduleCloudSync(500); });
  window.addEventListener('offline', () => { state.error = 'Frakoblet'; renderStatus(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) { if (!$('#toast').hidden) clearTimeout(toastTimer); return; }
    if (!$('#toast').hidden) { clearTimeout(toastTimer); toastTimer = setTimeout(hideToast, toastMs($('#toast').textContent)); }
    loadOffers();
    if (syncDue()) syncSpending({ quiet: true });
    if (cloud && cloud.user && Date.now() - (cloudState.lastSync || 0) > 5 * 60 * 1000) cloudSync({ quiet: true });
  });
}

/* ---------- start ---------- */
async function start() {
  bind();
  try {
    const [offers, list, categories, rules, receipts, settings, extraOffers, savings, catVersion] = await Promise.all(
      ['offers', 'list', 'categories', 'rules', 'receipts', 'settings', 'extraOffers', 'savings', 'catVersion'].map((k) => db.get(k)),
    );
    if (Array.isArray(savings)) state.savings = savings.filter((x) => x && Number.isFinite(x.kr));
    if (offers) state.offersData = offers;
    if (extraOffers && Array.isArray(extraOffers.offers)) state.extraOffers = extraOffers;
    if (list) state.list = cleanList(list);
    const cats = cleanCategories(categories);
    if (usableCategories(cats)) {
      // once: Kjøtt/fisk → Kjøtt, plus Fisk, Pålegg, Ferdigmat, Dyremat, Ikke-mat (user edits kept)
      state.categories = (catVersion || 1) < CATEGORY_VERSION ? migrateCategories(cats) : cats;
      if ((catVersion || 1) < CATEGORY_VERSION) save.categories();
    }
    if ((catVersion || 1) < CATEGORY_VERSION) db.set('catVersion', CATEGORY_VERSION);
    if (rules) state.rules = cleanRules(rules);
    if (Array.isArray(receipts)) state.receipts = receipts.filter((r) => r && typeof r === 'object' && !Array.isArray(r));
    if (settings) state.settings = mergeSettings(state.settings, settings);
    applyTextSize();
  } catch (e) {
    console.error('Lagring utilgjengelig', e);
    state.error = 'Lagring er ikke tilgjengelig i denne nettleseren';
  }
  rebuildClassifier();
  let tabHash = location.hash.slice(1);
  if (cloud) {
    await cloud.init().catch(() => null);
    if (/access_token=|error_description=/.test(tabHash)) { // back from a magic link
      try { await cloud.fromRedirect(tabHash); toast(`Logget inn som ${cloud.user.email}`); } catch (e) { cloudState.error = friendlyError(e); toast(friendlyError(e)); }
      tabHash = 'mer/konto';
      try { history.replaceState(null, '', location.pathname + '#mer'); } catch (e) { /* file:// */ }
    }
  }
  const [hashTab, hashPage] = tabHash.split('/'); // "#mer/konto" opens a Mer subpage
  showTab(TABS.includes(hashTab) ? hashTab : 'hjem');
  if (hashTab === 'mer' && MORE_PAGES[hashPage]) { state.morePage = hashPage; renderMore(); }
  db.persist().then((p) => (state.persisted = p));
  originalExists().then((v) => { state.originalExists = v; if (v && state.tab === 'mer') renderMore(); });
  loadOffers();
  firstRunLocation();
  if (syncDue()) syncSpending({ quiet: true });
  if (cloud && cloud.user) cloudSync({ quiet: true });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch((e) => console.warn('SW', e));
  }
}

/* ---------- recovery: never a blank screen ---------- */
const DATA_KEYS = ['list', 'categories', 'rules', 'receipts', 'offers', 'extraOffers', 'savings', 'catVersion'];
function showCrash(e) {
  console.error('Oppstart feilet', e);
  if (document.querySelector('#crash')) return;
  const d = document.createElement('div');
  d.id = 'crash';
  d.setAttribute('role', 'alertdialog');
  d.setAttribute('aria-labelledby', 'crash-h');
  d.innerHTML = `<div class="crash-box"><h2 id="crash-h">Noe gikk galt – tilbakestill data?</h2>
    <p>Appen klarte ikke å starte, trolig på grunn av ødelagte data på denne enheten. Du kan prøve igjen, eller tilbakestille handlelisten, kategoriene, reglene og kvitteringene her. Innstillingene beholdes.</p>
    <button type="button" id="crash-retry" class="btn">Prøv igjen</button>
    <button type="button" id="crash-reset" class="btn btn-primary">Tilbakestill data</button></div>`;
  document.body.append(d);
  d.querySelector('#crash-retry').addEventListener('click', () => location.reload());
  d.querySelector('#crash-reset').addEventListener('click', async () => {
    if (!confirm('Slette handlelisten, kategoriene, reglene og kvitteringene på denne enheten? Det kan ikke angres.')) return;
    await Promise.all(DATA_KEYS.map((k) => db.del(k).catch(() => null)));
    location.reload();
  });
}

addEventListener('resize', () => moveTabIndicator($('#tab-indicator'), TABS.indexOf(state.tab), document.querySelector(`.tabbar [data-tab="${state.tab}"]`)));
start().catch(showCrash);
