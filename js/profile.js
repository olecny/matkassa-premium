// Learns what the user usually buys from their own receipts (on this device only), and scores offers against it.
// Matching: barcode (EAN/GTIN) first wherever both the receipt line and the offer have one, name-based as fallback.
import { normalize, tokens } from './categories.js';

const HALF_LIFE_DAYS = 120; // a purchase four months ago counts half
const SKIP_LINE = /^(pant|bærepose|bæreposer|pose)\b/;
// Words that say nothing about the product (store brands, packaging, units).
const GENERIC = new Set([
  'rema', 'lavpris', 'prima', 'first', 'price', 'xtra', 'coop', 'kiwi', 'meny', 'eldorado', 'stk', 'pk', 'pakning',
  'løsvekt', 'ca', 'pr', 'kg', 'gr', 'ltr', 'med', 'og', 'uten', 'til', 'for', 'fra', 'the', 'eko', 'økologisk',
  'norsk', 'norske', 'stor', 'liten', 'ny', 'nye', 'mix', 'familiepakning', 'boks', 'flaske', 'pose',
]);
// Categories too broad to tell two products apart.
const LOOSE_CATS = new Set(['annet']);

const useful = (t) => t.length >= 3 && !/\d/.test(t) && !GENERIC.has(t);
const titleCase = (s) => s.charAt(0).toUpperCase() + s.slice(1).toLowerCase();

/** Normalised EAN/GTIN: digits only, leading zeros dropped (GTIN-14 "07038…" = EAN-13 "7038…"). */
export function normEan(v) {
  const s = String(v ?? '').replace(/\D/g, '').replace(/^0+/, '');
  return s.length >= 8 ? s : null;
}

/** Product name without sizes and noise, e.g. "TINE HELMELK 3.5% 1.75L" → "tine helmelk". */
export function productKey(name) {
  return tokens(name).filter((t) => !/\d/.test(t)).join(' ');
}

/**
 * Build a profile from the user's receipts: one entry per distinct product, with a weight
 * (recency-decayed purchase count, 0–1), its barcodes, its category and its name words weighted by IDF,
 * so a brand that appears on many products ("tine") counts less than the word that says what it is ("helmelk").
 * Lines with the same EAN are the same product even if the receipt text differs.
 * opts.classify(name, ean, group) → category id (optional), opts.now (ms).
 */
export function buildProfile(receipts, opts = {}) {
  const now = typeof opts === 'number' ? opts : opts.now ?? Date.now();
  const classify = typeof opts === 'object' ? opts.classify : null;
  const products = new Map(); // key → {name, w, n, eans:Set, line}
  const keyOfEan = new Map();
  for (const r of receipts || []) {
    const age = r.date ? Math.max(0, (now - Date.parse(r.date)) / 864e5) : 365;
    const decay = Math.pow(0.5, age / HALF_LIFE_DAYS);
    for (const l of r.lines || []) {
      const norm = normalize(l.name);
      if (!norm || SKIP_LINE.test(norm) || (l.amount ?? 0) <= 0) continue;
      const ean = normEan(l.ean);
      const nameKey = productKey(l.name);
      if (!ean && !nameKey.split(' ').some(useful)) continue;
      const key = (ean && keyOfEan.get(ean)) || (nameKey.split(' ').some(useful) ? nameKey : 'ean:' + ean);
      const p = products.get(key) || { name: l.name, w: 0, n: 0, eans: new Set(), line: l };
      p.w += decay;
      p.n += 1;
      if (ean) { p.eans.add(ean); keyOfEan.set(ean, key); }
      products.set(key, p);
    }
  }
  const df = new Map();
  for (const key of products.keys()) for (const t of new Set(key.split(' ').filter(useful))) df.set(t, (df.get(t) || 0) + 1);
  const P = products.size || 1;
  const maxW = Math.max(0, ...[...products.values()].map((p) => p.w)) || 1;
  const byEan = new Map();
  const list = [...products].map(([key, p]) => {
    const words = key.startsWith('ean:') ? [] : [...new Set(key.split(' ').filter(useful))].map((t) => ({ t, idf: Math.log(1 + P / df.get(t)) }));
    const shown = key.startsWith('ean:') ? productKey(p.name) || p.name : key;
    const prod = {
      name: titleCase(shown.split(' ').filter((t) => t.length > 1 && !GENERIC.has(t)).join(' ') || shown),
      n: p.n,
      w: Math.sqrt(p.w / maxW), // sqrt: favourites lead, but occasional buys still count
      words,
      total: words.reduce((a, x) => a + x.idf, 0),
      eans: [...p.eans],
      cat: classify ? classify(p.line.name, p.line.ean, p.line.group) || null : null,
    };
    for (const e of prod.eans) byEan.set(e, prod);
    return prod;
  });
  return { products: list, byEan, receipts: (receipts || []).length };
}

const wordHit = (w, t) => (w === t ? 1 : w.length >= 4 && t.length >= 4 && (w.endsWith(t) || t.endsWith(w)) ? 0.6 : 0);

/**
 * Score an offer against the profile. Returns {score, because, via} where because is the bought product
 * ({name, n}) and via is 'ean' (same barcode) or 'name' (name words).
 * - EAN: any offer barcode the user has bought → score = how much they buy it. Always wins over a name match.
 * - Name: IDF-weighted share of a product's words found in the offer title (≥ 50 %) × how much they buy it,
 *   skipped when both sides have a clear category and they differ ("Egg" vs "Egg nudler").
 * offer = {eans?, cat?}; the old signature scoreOffer(profile, words) still works.
 */
export function scoreOffer(profile, words, offer = {}) {
  const none = { score: 0, because: null, via: null };
  if (!profile || !profile.products.length) return none;
  if (offer.eans && offer.eans.length && profile.byEan) {
    let best = null;
    for (const e of offer.eans) {
      const p = profile.byEan.get(normEan(e));
      if (p && (!best || p.w > best.w)) best = p;
    }
    if (best) return { score: best.w, because: best, via: 'ean' };
  }
  const ws = (words || []).filter(useful);
  if (!ws.length) return none;
  const cat = offer.cat && !LOOSE_CATS.has(offer.cat) ? offer.cat : null;
  let score = 0;
  let because = null;
  for (const p of profile.products) {
    if (!p.total) continue;
    if (cat && p.cat && !LOOSE_CATS.has(p.cat) && p.cat !== cat) continue;
    let got = 0;
    for (const { t, idf } of p.words) {
      let h = 0;
      for (const w of ws) if ((h = Math.max(h, wordHit(w, t))) === 1) break;
      got += h * idf;
    }
    const cover = got / p.total;
    if (cover < 0.5) continue;
    const s = cover * p.w;
    if (s > score) { score = s; because = p; }
  }
  return because ? { score, because, via: 'name' } : none;
}
