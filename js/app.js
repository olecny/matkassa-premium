import * as db from './db.js';
import { fetchOffers, AREAS, DEFAULT_AREA } from './tjek.js';
import { DEFAULT_CATEGORIES, makeClassifier, normalize, tokens } from './categories.js';
import { buildProfile, scoreOffer, normEan } from './profile.js';
import { parseExtraOffers, mergeExtraOffers, eanCoverage } from './extra-offers.js';
import { defaultSettings, mergeSettings, validArea } from './settings.js';
import { detectImport, mergeReceipts, summarize, toNumber, UNCAT, BACKUP_SCHEMA } from './spending.js';

const APP_VERSION = '0.5.0';
const STALE_MS = 6 * 60 * 60 * 1000;
const PAGE = 60;

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
  tab: 'tilbud',
  offersData: null, // {fetchedAt, chains, offers}
  list: [],
  categories: DEFAULT_CATEGORIES.map((c) => ({ ...c })),
  rules: [],
  receipts: [],
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
};

let classify = makeClassifier(state.categories, state.rules);
let offerIndex = []; // [{o, words, cat}]

/* ---------- persistence ---------- */
const save = {
  list: () => db.set('list', state.list),
  categories: () => db.set('categories', state.categories),
  rules: () => db.set('rules', state.rules),
  receipts: () => db.set('receipts', state.receipts),
  settings: () => db.set('settings', state.settings),
};

function rebuildClassifier() {
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
    hay: normalize(o.title + ' ' + o.desc),
    cat: classify(o.title) || classify(o.title + ' ' + o.desc) || 'annet',
  }));
}
const area = () => validArea(state.settings.area) || DEFAULT_AREA;
const offerById = (id) => (offerIndex.find((x) => x.o.id === id) || {}).o;

const catById = (id) => state.categories.find((c) => c.id === id);
const hiddenChains = () => new Set(state.settings.hiddenChains || []);
/** The offer a list item was added from, unless its chain is hidden now. */
const linkedOffer = (item) => (item.offer && !hiddenChains().has(item.offer.chainId) ? item.offer : null);
/** True when offers exist but every chain in them is hidden (Mer → Kjeder). */
const allChainsHidden = () => {
  const d = state.offersData;
  const hidden = hiddenChains();
  return !!(d && d.chains.length && d.chains.every((c) => hidden.has(c.id)));
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
    .filter((x) => x.fit >= FIT_MIN && (!x.o.from || x.o.from <= now) && (!chains.size || chains.has(x.o.chainId)))
    .sort((a, b) => b.fit * (1 + discount(b.o)) - a.fit * (1 + discount(a.o)));
  for (const x of ranked) {
    if (seen.has(x.because.name)) continue;
    seen.add(x.because.name);
    out.push(x);
    if (out.length === n) break;
  }
  return out;
}

/* ---------- toast ---------- */
let toastTimer;
function toast(msg) {
  const t = $('#toast');
  t.textContent = msg;
  t.hidden = false;
  clearTimeout(toastTimer);
  toastTimer = setTimeout(() => (t.hidden = true), 2600);
}

/* ---------- tabs ---------- */
function showTab(tab) {
  state.tab = tab;
  for (const v of document.querySelectorAll('.view')) v.hidden = v.id !== `view-${tab}`;
  for (const b of document.querySelectorAll('.tabbar button')) {
    if (b.dataset.tab === tab) b.setAttribute('aria-current', 'page');
    else b.removeAttribute('aria-current');
  }
  $('#view-title').textContent = $(`#view-${tab}`).dataset.title;
  $('#refresh').hidden = tab !== 'tilbud' && tab !== 'liste';
  render();
  window.scrollTo(0, 0);
  try { history.replaceState(null, '', '#' + tab); } catch (e) { /* file:// */ }
}

function render() {
  renderStatus();
  renderBadge();
  if (state.tab === 'tilbud') renderOffers();
  if (state.tab === 'liste') renderList();
  if (state.tab === 'forbruk') renderSpending();
  if (state.tab === 'mer') renderMore();
}

function renderStatus() {
  const el = $('#status');
  const d = state.offersData;
  if (state.loading) el.textContent = state.loading;
  else if (state.error && d) el.textContent = `Viser lagrede tilbud fra ${timeFmt.format(d.fetchedAt)} · ${state.error}`;
  else if (state.error) el.textContent = state.error;
  else if (d) el.textContent = `${activeOffers().length} tilbud fra ${d.chains.filter((c) => !hiddenChains().has(c.id)).length} kjeder · oppdatert ${timeFmt.format(d.fetchedAt)}`;
  else el.textContent = '';
  $('#refresh').classList.toggle('spinning', !!state.loading);
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
  let list = activeOffers().filter((x) => (!chains.size || chains.has(x.o.chainId)) && (!state.cat || x.cat === state.cat));
  if (qTokens.length) {
    list = list
      .map((x) => ({ x, s: matchScore(qTokens, x) }))
      .filter((r) => r.s > 0)
      .sort((a, b) => b.s - a.s)
      .map((r) => r.x);
  }
  const by = {
    pris: (a, b) => a.o.price - b.o.price,
    enhet: (a, b) => (a.o.unitPrice ?? 1e9) - (b.o.unitPrice ?? 1e9),
    rabatt: (a, b) => discount(b.o) - discount(a.o),
    fordeg: hasProfile() ? (a, b) => (b.fit || 0) - (a.fit || 0) || discount(b.o) - discount(a.o) : null,
  }[state.sort];
  if (by) list = [...list].sort(by);
  else if (!qTokens.length) list = [...list].sort((a, b) => a.o.chain.localeCompare(b.o.chain, 'nb'));
  return list;
}
const discount = (o) => (o.prePrice && o.prePrice > o.price ? (o.prePrice - o.price) / o.prePrice : 0);

/** Word match: every query token must hit a word in the title (whole word, or start/end of a compound) or the description. */
function matchScore(qTokens, x) {
  let score = 0;
  for (const t of qTokens) {
    let best = 0;
    for (const w of x.words) {
      if (w === t) { best = 3; break; }
      if (t.length >= 3 && (w.startsWith(t) || w.endsWith(t))) best = Math.max(best, 2);
    }
    if (!best && t.length >= 3 && x.hay.includes(t)) best = 0.5;
    if (!best) return 0;
    score += best;
  }
  return score;
}

function chainColor(id, fallback) {
  const c = state.offersData && state.offersData.chains.find((x) => x.id === id);
  const col = (c && c.color) || fallback;
  return col && col.toLowerCase() !== '#ffffff' && col.toLowerCase() !== '#fff' ? col : '#c8102e';
}

function validText(o) {
  const now = Date.now();
  if (o.from && o.from > now) return `<span class="soon">Fra ${esc(dayFmt.format(o.from))}</span>`;
  if (o.till) return `Til ${esc(dayFmt.format(o.till))}`;
  return '';
}

function unitText(o) {
  if (!o.unitPrice) return '';
  return `${o.unitFrom ? 'fra ' : ''}${kr(o.unitPrice)}/${o.unit}`;
}

function inList(offerId) {
  return state.list.some((i) => i.offer && i.offer.id === offerId && !i.done);
}

/** Why an offer is "for you". via 'ean' = the same barcode is on your receipts, 'name' = similar name. */
function whyText(because, via) {
  return via === 'ean'
    ? `Du kjøper denne (${because.n}×) <span class="via" title="Samme strekkode som på kvitteringene dine">strekkode</span>`
    : `Du kjøper ofte ${esc(because.name)} (${because.n}×)`;
}

function offerCard({ o, fit, because, via }) {
  const added = inList(o.id);
  const img = o.img
    ? `<img class="thumb" src="${esc(o.img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer" onerror="this.replaceWith(Object.assign(document.createElement('div'),{className:'thumb none',textContent:'Bilde'}))">`
    : '<div class="thumb none">Bilde</div>';
  return `<li class="offer">
    ${img}
    <div class="info">
      <div class="title">${esc(titleCase(o.title))}</div>
      ${o.desc ? `<div class="desc">${esc(o.desc)}</div>` : ''}
      <div class="meta"><span class="chain" style="--c:${esc(chainColor(o.chainId, o.color))}">${esc(o.chain)}</span><span>${validText(o)}</span></div>
      ${fit >= FIT_MIN && because ? `<div class="why">${whyText(because, via)}</div>` : ''}
    </div>
    <div class="priceblock">
      <span class="price">${kr(o.price)}</span>
      ${o.prePrice && o.prePrice > o.price ? `<span class="pre">${kr(o.prePrice)}</span>` : ''}
      ${o.unitPrice ? `<span class="unit">${unitText(o)}</span>` : ''}
      <button class="add${added ? ' added' : ''}" type="button" data-add="${esc(o.id)}" aria-label="${added ? 'Ligger i handlelisten' : 'Legg til i handlelisten'}: ${esc(o.title)}">${added ? '✓' : '+'}</button>
    </div>
  </li>`;
}

function featCard({ o, because, via }) {
  const added = inList(o.id);
  return `<li class="feat">
    ${o.img ? `<img src="${esc(o.img)}" alt="" loading="lazy" decoding="async" referrerpolicy="no-referrer">` : '<div class="noimg"></div>'}
    <div class="ft">${esc(titleCase(o.title))}</div>
    <div class="fp">${kr(o.price)}${o.prePrice && o.prePrice > o.price ? ` <s>${kr(o.prePrice)}</s>` : ''}</div>
    <div class="meta"><span class="chain" style="--c:${esc(chainColor(o.chainId, o.color))}">${esc(o.chain)}</span></div>
    <div class="why">${esc(because.name)} · ${because.n}×${via === 'ean' ? ' <span class="via" title="Samme strekkode som på kvitteringene dine">strekkode</span>' : ''}</div>
    <button class="add${added ? ' added' : ''}" type="button" data-add="${esc(o.id)}" aria-label="${added ? 'Ligger i handlelisten' : 'Legg til i handlelisten'}: ${esc(o.title)}">${added ? '✓' : '+'}</button>
  </li>`;
}

function renderChips() {
  const d = state.offersData;
  const hidden = hiddenChains();
  const sel = selectedChains();
  const chains = d ? d.chains.filter((c) => !hidden.has(c.id)) : [];
  $('#chain-chips').innerHTML =
    `<button class="chip" type="button" data-chain="" aria-pressed="${sel.size === 0}">Alle kjeder</button>` +
    chains
      .map((c) => `<button class="chip" type="button" data-chain="${esc(c.id)}" aria-pressed="${sel.has(c.id)}"><span class="dot" style="--c:${esc(chainColor(c.id, c.color))}"></span>${esc(c.name)}</button>`)
      .join('');
  const counts = new Map();
  for (const x of activeOffers()) if (!sel.size || sel.has(x.o.chainId)) counts.set(x.cat, (counts.get(x.cat) || 0) + 1);
  $('#cat-chips').innerHTML =
    `<button class="chip" type="button" data-cat="" aria-pressed="${!state.cat}">Alle varer</button>` +
    state.categories
      .filter((c) => counts.get(c.id))
      .map((c) => `<button class="chip" type="button" data-cat="${esc(c.id)}" aria-pressed="${state.cat === c.id}"><span class="dot" style="--c:${esc(c.color)}"></span>${esc(c.name)}</button>`)
      .join('');
  $('#chain-chips').hidden = $('#cat-chips').hidden = !d;
}

function renderOffers() {
  renderChips();
  const empty = $('#offer-empty');
  const listEl = $('#offer-list');
  const more = $('#offer-more');
  if (!state.offersData) {
    listEl.innerHTML = '';
    more.hidden = true;
    $('#offer-count').textContent = '';
    empty.hidden = false;
    empty.innerHTML = state.loading
      ? '<h2>Henter ukens tilbud …</h2><p>Første gang tar det noen sekunder. Etterpå ligger tilbudene lagret, så de vises også uten nett.</p>'
      : `<h2>Ingen tilbud ennå</h2><p>${navigator.onLine ? 'Klarte ikke å hente tilbud fra Tjek.' : 'Du er frakoblet. Tilbud hentes når du er på nett igjen.'}</p><button class="btn btn-primary" type="button" data-action="refresh">Prøv igjen</button>`;
    return;
  }
  const list = filteredOffers();
  const feat = !state.q && !state.cat ? featuredOffers() : [];
  $('#for-deg').hidden = !feat.length;
  $('#for-deg-list').innerHTML = feat.map(featCard).join('');
  $('#offer-count').textContent = `${list.length} tilbud${state.q ? ` for «${state.q}»` : ''}`;
  listEl.innerHTML = list.slice(0, state.shown).map(offerCard).join('');
  more.hidden = list.length <= state.shown;
  more.textContent = `Vis flere (${list.length - state.shown} til)`;
  empty.hidden = list.length > 0;
  if (!list.length) {
    empty.innerHTML = allChainsHidden()
      ? '<h2>Alle kjeder er skjult</h2><p>Du har skjult alle kjedene. Slå på kjedene du handler i under Mer → Kjeder.</p><button class="btn btn-primary" type="button" data-gototab="mer">Gå til Mer → Kjeder</button>'
      : `<h2>Ingen treff</h2><p>Prøv et annet søkeord${state.cat || (state.settings.chains || []).length ? ', eller fjern filteret for kjede eller kategori' : ''}.</p>`;
  }
}

/* ---------- shopping list ---------- */
const STOP = new Set(['og', 'i', 'på', 'med', 'til', 'stk', 'pk', 'kg', 'g', 'l', 'liter', 'x']);

/**
 * Offers for a shopping-list item. Barcode first: an item added from an offer remembers that offer's EANs, so the
 * same product is found again in later weeks (marked o.via = 'ean'). Name-based matching is the fallback.
 */
function dealsFor(text, eans) {
  const now = Date.now();
  const chains = selectedChains();
  const live = activeOffers().filter((x) => (!chains.size || chains.has(x.o.chainId)) && (!x.o.from || x.o.from <= now + 7 * 864e5));
  const want = new Set((eans || []).map(normEan).filter(Boolean));
  const byEan = want.size ? live.filter((x) => (x.o.eans || []).some((e) => want.has(e))) : [];
  const eanIds = new Set(byEan.map((x) => x.o.id));
  const cheap = (a, b) => (a.o.unitPrice ?? a.o.price * 10) - (b.o.unitPrice ?? b.o.price * 10);
  const first = byEan.sort(cheap).map((x) => ({ ...x.o, via: 'ean' }));
  const q = tokens(text).filter((t) => t.length >= 2 && !STOP.has(t) && !/^\d+$/.test(t));
  if (!q.length) return first;
  const itemCat = classify(text); // "melk" → Meieri, so milk beats "potetmos med melk"
  return first.concat(live
    .filter((x) => !eanIds.has(x.o.id))
    .map((x) => ({ x, s: titleScore(q, x) }))
    .filter((r) => r.s > 0)
    .map((r) => (itemCat && r.x.cat === itemCat ? { x: r.x, s: r.s + 2 } : r))
    .sort((a, b) => b.s - a.s || cheap(a.x, b.x))
    .map((r) => r.x.o));
}
function titleScore(q, x) {
  let score = 0;
  for (const t of q) {
    let best = 0;
    for (const w of x.words) {
      if (w === t) { best = 3; break; }
      // Norwegian compounds put the head last: "lettmelk" is milk, "melkesjokolade" is not.
      if (t.length >= 3 && w.endsWith(t)) best = 2;
    }
    if (!best) return 0;
    score += best;
  }
  return score;
}

function addItem(text, offer) {
  text = text.trim();
  if (!text) return;
  const eans = offer && offer.eans && offer.eans.length ? offer.eans : undefined;
  state.list.unshift({ id: uid(), text, done: false, added: Date.now(), offer: offer || null, eans });
  save.list();
}

function renderBadge() {
  const open = state.list.filter((i) => !i.done).length;
  const b = $('#list-badge');
  b.hidden = !open;
  b.textContent = open;
}

function dealHTML(item) {
  const now = Date.now();
  if (linkedOffer(item)) {
    const o = item.offer;
    const expired = o.till && o.till < now;
    if (expired && item.eans) {
      const again = dealsFor(item.text, item.eans).filter((d) => d.via === 'ean');
      if (again.length) return `<div class="deal"><span class="deal-tag">På tilbud igjen hos ${esc(again[0].chain)} – ${kr(again[0].price)}</span><span class="via" title="Samme strekkode">strekkode</span></div>`;
    }
    return `<div class="deal"><span class="deal-tag from">${expired ? 'Tilbudet er utløpt' : `Tilbud hos ${esc(o.chain)} – ${kr(o.price)}`}</span>${!expired && o.till ? `<span class="deal-more">til ${esc(dayFmt.format(o.till))}</span>` : ''}</div>`;
  }
  const deals = dealsFor(item.text, item.eans);
  if (!deals.length) return state.offersData ? '<div class="nodeal">Ikke på tilbud denne uken</div>' : '';
  const best = deals[0];
  const rest = deals.slice(0, 6);
  return `<details class="deal"><summary><span class="deal-tag">På tilbud hos ${esc(best.chain)} – ${kr(best.price)}</span>
    <span class="deal-what">${best.via === 'ean' ? '<span class="via" title="Samme strekkode">strekkode</span> ' : ''}${esc(titleCase(best.title))}${best.unitPrice ? ` · ${unitText(best)}` : ''}${deals.length > 1 ? ` · <u>+${deals.length - 1} til</u>` : ''}</span></summary>
    <ul>${rest.map((o) => `<li><span>${esc(o.chain)}: ${esc(titleCase(o.title))}${o.unitPrice ? ` · ${unitText(o)}` : ''}</span><b>${kr(o.price)}</b></li>`).join('')}</ul></details>`;
}

function renderList() {
  const items = [...state.list].sort((a, b) => a.done - b.done);
  $('#list-items').innerHTML = items
    .map(
      (i) => `<li class="item${i.done ? ' done' : ''}">
      <label class="tick"><input type="checkbox" data-toggle="${esc(i.id)}" ${i.done ? 'checked' : ''} aria-label="Kryss av ${esc(i.text)}"></label>
      <div class="body"><div class="name">${esc(i.text)}</div>${dealHTML(i)}</div>
      <button class="del" type="button" data-del="${esc(i.id)}" aria-label="Slett ${esc(i.text)}">×</button>
    </li>`,
    )
    .join('');
  const open = state.list.filter((i) => !i.done);
  const onSale = open.filter((i) => linkedOffer(i) || dealsFor(i.text, i.eans).length).length;
  const done = state.list.length - open.length;
  $('#list-summary').textContent = state.list.length
    ? `${open.length} igjen${state.offersData ? ` · ${onSale} på tilbud` : ''}${done ? ` · ${done} avkrysset` : ''}`
    : '';
  $('#list-empty').hidden = state.list.length > 0;
  const clear = $('#list-clear');
  clear.hidden = !done;
  clear.textContent = `Fjern avkryssede (${done})`;
}

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
      <p>Her ser du hva du bruker på mat per måned og per kategori.</p>
      <p>Kom i gang: bestill <strong>innsyn hos Trumf</strong> (Kiwi, Meny, Spar, Joker) og importer JSON-fila, importer <code>spending.json</code> fra Mac-skriptet (REMA), eller legg inn en kvittering for hånd.</p>
    </div>`;
    return;
  }
  const sum = summarize(state.receipts, classify, state.categories);
  const m = sum.months.get(state.month) || { total: 0, count: 0, byCat: new Map() };
  const rows = [...m.byCat.entries()].filter(([, v]) => Math.abs(v) >= 0.5).sort((a, b) => b[1] - a[1]);
  const max = Math.max(1, ...rows.map(([, v]) => v));
  const uncatAmount = m.byCat.get(UNCAT) || 0;
  const pctCat = m.total ? Math.round(((m.total - uncatAmount) / m.total) * 100) : 0;

  const barRows = rows
    .map(([id, v]) => {
      const c = catById(id);
      const name = c ? c.name : 'Ukategorisert';
      const pct = m.total ? Math.round((v / m.total) * 100) : 0;
      return `<li><div class="row"><span>${esc(name)}</span><span>${krShort(v)} · ${pct} %</span></div>
        <div class="track"><div class="fill${c ? '' : ' uncat'}" style="width:${Math.max(0, (v / max) * 100).toFixed(1)}%;--c:${esc(c ? c.color : '')}"></div></div></li>`;
    })
    .join('');

  const monthReceipts = state.receipts.filter((r) => r.date.startsWith(state.month));
  const uncatMonth = summarize(monthReceipts, classify, state.categories).uncat;

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
    ${rows.length ? `<div class="card"><h2>Per kategori</h2><ul class="bars">${barRows}</ul></div>` : ''}
    <div class="card trend"><h2>Siste 12 måneder</h2>${trendSVG(sum.months)}</div>
    ${uncatMonth.length ? `<div class="card"><h2>Ukategorisert <small>· ${uncatMonth.length} varer</small></h2>
      <p class="hint">Velg kategori én gang, så lages en regel som gjelder alle like varer fremover.</p>
      <ul class="queue">${uncatMonth.slice(0, 25).map((u, i) => `<li><span class="q-name">${esc(u.name)}<small>${u.count}× · ${kr(u.amount)}</small></span><button class="btn small" type="button" data-uncat="${i}">Velg</button></li>`).join('')}</ul></div>` : ''}
    <div class="card"><h2>Kvitteringer <small>· ${esc(monthFmt.format(monthDate(state.month)))}</small></h2>
      ${monthReceipts.length ? `<ul class="receipts">${monthReceipts.map((r) => `<li><button type="button" data-receipt="${esc(r.id)}"><span>${esc(r.store || r.chain)}<small>${esc(dayFmt.format(new Date(r.date + 'T12:00')))}${r.lines && r.lines.length ? ` · ${r.lines.length} varer` : ''} · ${esc(sourceName(r.source))}</small></span><b>${kr(r.total)}</b></button></li>`).join('')}</ul>` : '<p class="hint">Ingen kvitteringer denne måneden.</p>'}
    </div>`;
  body._uncat = uncatMonth;
}

const sourceName = (s) => ({ trumf: 'Trumf', rema: 'REMA', manual: 'manuell', import: 'import', claude: 'kvitteringsfoto' }[s] || s);

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
    state.categories.map((c) => `<button type="button" data-pick="${esc(c.id)}"><span class="dot" style="--c:${esc(c.color)}"></span>${esc(c.name)}</button>`).join('');
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
        <button type="button" data-line="${i}"><span class="dot" style="--c:${esc(c ? c.color : 'transparent')};${c ? '' : 'border:1px dashed currentColor'}"></span>${esc(c ? c.name : 'Ukategorisert – velg')}</button></li>`;
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
  state.receipts = mergeReceipts(state.receipts, [r]).receipts;
  save.receipts();
  state.month = r.date.slice(0, 7);
  toast('Kvittering lagret');
  return true;
}

/* ---------- import / export ---------- */
async function importFile(file) {
  let json;
  try {
    json = JSON.parse(await file.text());
  } catch (e) {
    toast('Fila er ikke gyldig JSON');
    return;
  }
  let res;
  try {
    res = detectImport(json);
  } catch (e) {
    toast(e.message);
    return;
  }
  if (res.kind === 'backup') {
    const b = res.data;
    if (!confirm(`Gjenopprette backup fra ${b.exported ? new Date(b.exported).toLocaleString('nb-NO') : 'ukjent dato'}? Dette erstatter kategorier, regler, kvitteringer og handlelisten på denne enheten.`)) return;
    if (Array.isArray(b.categories) && b.categories.length) state.categories = b.categories;
    state.rules = Array.isArray(b.rules) ? b.rules : [];
    state.receipts = Array.isArray(b.receipts) ? b.receipts : [];
    state.list = Array.isArray(b.list) ? b.list : [];
    if (b.settings) state.settings = mergeSettings(state.settings, b.settings, { fromBackup: true }); // keeps this device's repo + token
    await Promise.all([save.categories(), save.rules(), save.receipts(), save.list(), save.settings()]);
    rebuildClassifier();
    toast('Backup gjenopprettet');
  } else {
    const { receipts, added, updated } = mergeReceipts(state.receipts, res.data);
    state.receipts = receipts;
    await save.receipts();
    if (res.data.length) state.month = res.data.map((r) => r.date).sort().pop().slice(0, 7);
    toast(`${res.kind === 'trumf' ? 'Trumf' : 'spending.json'}: ${added} nye${updated ? `, ${updated} oppdatert` : ''} kvitteringer`);
  }
  render();
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
    const { kind, data } = detectImport(json);
    if (kind === 'backup') throw new Error('Synkfila er en backup, ikke kvitteringer');
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
    if (!quiet || added) toast(added ? `Synk: ${added} nye kvitteringer` : 'Synk: ingen nye kvitteringer');
  } catch (e) {
    s.lastError = e.message;
    save.settings();
    if (!quiet) toast('Synk feilet: ' + e.message);
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
    app: 'Matkassa ' + APP_VERSION,
    exported: new Date().toISOString(),
    categories: state.categories,
    rules: state.rules,
    receipts: state.receipts,
    list: state.list,
    settings: { ...state.settings, sync }, // never put the GitHub key in a backup file
  };
  const blob = new Blob([JSON.stringify(data, null, 2)], { type: 'application/json' });
  const name = `matkassa-backup-${todayISO()}.json`;
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

/* ---------- Mer ---------- */
function renderMore() {
  const rules = [...state.rules].sort((a, b) => (b.created || 0) - (a.created || 0));
  const d = state.offersData;
  $('#more-body').innerHTML = `
    <div class="card"><h2>Synk fra Mac</h2>
      <p class="hint" style="margin-top:0">Valgfritt. Kvitteringene dine hentes fra ditt eget <strong>private</strong> GitHub-repo, som Mac-skriptet (<code>ingest/sync.sh</code>) oppdaterer. Nøkkelen lagres bare på denne enheten og tas aldri med i backup.</p>
      <form id="sync-form">
        <label class="field"><span>Ditt private repo</span><input id="sync-repo" value="${esc(state.settings.sync.repo)}" placeholder="brukernavn/matkassa-data" autocapitalize="off" autocorrect="off" spellcheck="false"></label>
        <label class="field"><span>GitHub-nøkkel (kun lesetilgang)</span><input id="sync-token" type="password" placeholder="${state.settings.sync.token ? 'Lagret – lim inn for å bytte' : 'github_pat_…'}" autocomplete="off"></label>
        <div class="actions" style="margin-top:8px">
          <button class="btn" type="submit">${state.settings.sync.token ? 'Synk nå' : 'Lagre og synk'}</button>
          ${state.settings.sync.token ? '<button class="btn btn-ghost" type="button" data-action="sync-forget">Glem nøkkel</button>' : ''}
        </div>
      </form>
      <dl class="kv">
        <dt>Sist synket</dt><dd>${state.settings.sync.lastSync ? timeFmt.format(state.settings.sync.lastSync) : 'aldri'}</dd>
        ${state.settings.sync.lastError ? `<dt>Feil</dt><dd>${esc(state.settings.sync.lastError)}</dd>` : ''}
      </dl>
    </div>
    <div class="card"><h2>Område</h2>
      <p class="hint" style="margin-top:0">Tilbudene hentes for kundeavisene rundt dette stedet.</p>
      <div class="add-row"><label class="sr-only" for="area-select">Område</label>
        <select id="area-select">${AREAS.map((a) => `<option value="${esc(a.name)}" ${a.name === area().name ? 'selected' : ''}>${esc(a.name)}</option>`).join('')}${AREAS.some((a) => a.name === area().name) ? '' : `<option selected>${esc(area().name)}</option>`}</select>
        <button class="btn" type="button" data-action="area-here">Bruk min posisjon</button></div>
    </div>
    <div class="card"><h2>Kjeder</h2>
      <p class="hint" style="margin-top:0">Skjulte kjeder vises ikke i tilbud, filtre eller handlelisten.</p>
      ${state.offersData ? `<div class="chain-toggles">${[...state.offersData.chains].sort((a, b) => a.name.localeCompare(b.name, 'nb')).map((c) => `<label class="toggle"><input type="checkbox" data-chainshow="${esc(c.id)}" ${hiddenChains().has(c.id) ? '' : 'checked'}><span class="dot" style="--c:${esc(chainColor(c.id, c.color))}"></span>${esc(c.name)}</label>`).join('')}</div>` : '<p class="hint">Kjedene vises når tilbudene er hentet.</p>'}
    </div>
    <div class="card"><h2>Kategorier</h2>
      <div id="cat-list">${state.categories.map((c) => `<div class="cat-row">
        <input type="color" value="${esc(c.color)}" data-catcolor="${esc(c.id)}" aria-label="Farge for ${esc(c.name)}">
        <input type="text" value="${esc(c.name)}" data-catname="${esc(c.id)}" aria-label="Navn på kategori" maxlength="40">
        <button class="del" type="button" data-catdel="${esc(c.id)}" aria-label="Slett ${esc(c.name)}">×</button></div>`).join('')}</div>
      <form id="cat-add" class="add-row" style="margin-top:8px"><label class="sr-only" for="cat-new">Ny kategori</label><input id="cat-new" placeholder="Ny kategori, f.eks. Barnemat" maxlength="40"><button class="btn" type="submit">Legg til</button></form>
    </div>
    <div class="card"><h2>Regler <small>· ${rules.length}</small></h2>
      ${rules.length ? `<ul class="rules">${rules.map((r) => `<li><span>${r.type === 'ean' ? 'EAN' : 'Inneholder'} «${esc(r.pattern)}» → ${esc(catById(r.categoryId) ? catById(r.categoryId).name : '(slettet kategori)')}</span><button class="btn small btn-ghost" type="button" data-ruledel="${esc(r.id)}" aria-label="Slett regel">Slett</button></li>`).join('')}</ul>` : '<p class="hint">Ingen egne regler ennå. De lages når du velger kategori for en ukategorisert vare. Egne regler går foran det innebygde nøkkelordkartet, også for tilbud.</p>'}
    </div>
    <div class="card"><h2>Data</h2>
      <div class="actions">
        <button class="btn" type="button" data-action="export">Eksporter backup</button>
        <button class="btn" type="button" data-action="import">Importer fil</button>
      </div>
      <dl class="kv">
        <dt>Kvitteringer</dt><dd>${state.receipts.length}</dd>
        <dt>Varer i listen</dt><dd>${state.list.length}</dd>
        <dt>Tilbud lagret</dt><dd>${d ? `${d.offers.length} (${timeFmt.format(d.fetchedAt)})` : 'ingen'}</dd>
        <dt>Med strekkode</dt><dd>${(() => { const c = eanCoverage(offerIndex.map((x) => x.o)); return c.n ? `${c.withEan} av ${c.n} (${c.pct.toLocaleString('nb-NO', { maximumFractionDigits: 1 })} %)` : '–'; })()}${state.extraOffers ? ` · REMA Superpris: ${state.extraOffers.offers.length}` : ''}</dd>
        <dt>Varig lagring</dt><dd>${state.persisted ? 'Ja' : 'Ikke bekreftet – ta backup jevnlig'}</dd>
      </dl>
      <div class="actions" style="margin-top:12px"><button class="btn btn-danger btn-ghost" type="button" data-action="wipe-spending">Slett alle kvitteringer</button></div>
    </div>
    <div class="card"><h2>Om Matkassa</h2>
      <p class="hint" style="margin-top:0">Versjon ${APP_VERSION}. Tilbud hentes fra Tjek (motoren bak eTilbudsavis), et uoffisielt API, for området rundt ${esc(area().name)}. Kategorier for tilbud gjettes fra varenavnet. «Tilbud for deg» lærer bare av kvitteringene på denne enheten. Tjek-tilbud har ikke strekkoder, så de matches på navn; strekkodetreff (EAN) vises der begge sider har strekkode. Alt du legger inn lagres bare på denne enheten.</p>
      <p class="hint">Installer: åpne i Safari → Del → <strong>Legg til på Hjem-skjerm</strong>.</p>
    </div>`;
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
function bind() {
  document.querySelector('.tabbar').addEventListener('click', (e) => {
    const b = e.target.closest('button[data-tab]');
    if (b) showTab(b.dataset.tab);
  });
  $('#refresh').addEventListener('click', () => loadOffers(true));

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
        addItem(titleCase(o.title), { id: o.id, chain: o.chain, chainId: o.chainId, price: o.price, till: o.till, title: o.title, eans: o.eans });
        toast(`Lagt til: ${titleCase(o.title)}`);
      }
      renderOffers();
      renderBadge();
    }
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
  $('#list-items').addEventListener('change', (e) => {
    const id = e.target.dataset.toggle;
    if (!id) return;
    const it = state.list.find((i) => i.id === id);
    if (it) { it.done = e.target.checked; save.list(); renderList(); renderBadge(); }
  });
  $('#list-items').addEventListener('click', (e) => {
    const del = e.target.closest('[data-del]');
    if (!del) return;
    state.list = state.list.filter((i) => i.id !== del.dataset.del);
    save.list();
    renderList();
    renderBadge();
  });
  $('#list-clear').addEventListener('click', () => {
    state.list = state.list.filter((i) => !i.done);
    save.list();
    renderList();
    renderBadge();
  });

  document.addEventListener('click', (e) => {
    const a = e.target.closest('[data-action]');
    if (!a) return;
    const act = a.dataset.action;
    if (act === 'import') $('#file-input').click();
    if (act === 'manual') openReceiptDialog();
    if (act === 'export') exportBackup();
    if (act === 'area-here' || act === 'geo-ask') useMyLocation(); // a tap may always ask again (iOS may need the gesture)
    if (act === 'geo-skip') { state.settings.geo = 'done'; save.settings(); renderGeoCard(); toast(`Viser tilbud for ${DEFAULT_AREA.name}. Bytt i Mer → Område.`); }
    if (act === 'sync-forget') {
      Object.assign(state.settings.sync, { token: '', lastError: null });
      save.settings();
      renderMore();
    }
    if (act === 'wipe-spending' && confirm('Slette alle kvitteringer på denne enheten? Kategorier og regler beholdes. Ta gjerne backup først.')) {
      state.receipts = [];
      save.receipts();
      render();
    }
  });
  $('#file-input').addEventListener('change', async (e) => {
    const f = e.target.files[0];
    e.target.value = '';
    if (f) await importFile(f);
  });

  $('#view-forbruk').addEventListener('click', (e) => {
    const mb = e.target.closest('[data-month]');
    if (mb) { state.month = shiftMonth(state.month, Number(mb.dataset.month)); renderSpending(); return; }
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

  $('#view-mer').addEventListener('change', (e) => {
    const t = e.target;
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
      if (!confirm(`Slette kategorien «${c.name}»?${n ? ` ${n} regler som peker hit slettes også.` : ''} Varer i den blir ukategorisert.`)) return;
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
  $('#view-mer').addEventListener('submit', async (e) => {
    if (e.target.id === 'sync-form') {
      e.preventDefault();
      const s = state.settings.sync;
      const repo = $('#sync-repo').value.trim().replace(/^https:\/\/github\.com\//, '').replace(/\.git$|\/$/g, '');
      if (repo && !REPO_RE.test(repo)) { toast('Repo må skrives som brukernavn/repo'); return; }
      if (repo !== s.repo) Object.assign(s, { repo, lastSync: null, lastTry: null, lastError: null });
      const token = $('#sync-token').value.trim();
      if (token) s.token = token;
      await save.settings();
      if (!s.repo) { toast('Synk er slått av'); renderMore(); return; }
      if (!s.token) { toast('Lim inn en GitHub-nøkkel først'); renderMore(); return; }
      syncSpending();
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

  window.addEventListener('online', () => { state.error = null; loadOffers(); });
  window.addEventListener('offline', () => { state.error = 'Frakoblet'; renderStatus(); });
  document.addEventListener('visibilitychange', () => {
    if (document.hidden) return;
    loadOffers();
    if (syncDue()) syncSpending({ quiet: true });
  });
}

/* ---------- start ---------- */
async function start() {
  bind();
  try {
    const [offers, list, categories, rules, receipts, settings, extraOffers] = await Promise.all(
      ['offers', 'list', 'categories', 'rules', 'receipts', 'settings', 'extraOffers'].map((k) => db.get(k)),
    );
    if (offers) state.offersData = offers;
    if (extraOffers && Array.isArray(extraOffers.offers)) state.extraOffers = extraOffers;
    if (list) state.list = list;
    if (categories && categories.length) state.categories = categories;
    if (rules) state.rules = rules;
    if (receipts) state.receipts = receipts;
    if (settings) state.settings = mergeSettings(state.settings, settings);
  } catch (e) {
    console.error('Lagring utilgjengelig', e);
    state.error = 'Lagring er ikke tilgjengelig i denne nettleseren';
  }
  rebuildClassifier();
  const hash = location.hash.slice(1);
  showTab(['tilbud', 'liste', 'forbruk', 'mer'].includes(hash) ? hash : 'tilbud');
  db.persist().then((p) => (state.persisted = p));
  loadOffers();
  firstRunLocation();
  if (syncDue()) syncSpending({ quiet: true });
  if ('serviceWorker' in navigator && location.protocol !== 'file:') {
    const hadController = !!navigator.serviceWorker.controller;
    navigator.serviceWorker.addEventListener('controllerchange', () => { if (hadController) location.reload(); });
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch((e) => console.warn('SW', e));
  }
}

start();
