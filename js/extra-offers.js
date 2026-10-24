// Extra offer sources that carry barcodes (EAN/GTIN), merged into the Tjek offers.
// Today: REMA's "Superpris" campaign, fetched on the Mac by ingest/rema.py --offers (needs the user's own REMA login)
// and synced to the app from the user's private data repo as rema-offers.json (schema matkassa.offers/1).
// Tjek offers have no barcodes at all, so this is the only place offers get EANs.
import { tokens } from './categories.js';
import { normEan } from './profile.js';

export const OFFERS_SCHEMA = 'matkassa.offers/1';
const REMA_ID = 'faa0Ym'; // Tjek dealer id for REMA 1000
const GENERIC = new Set(['rema', 'utvalgt', 'pakke', 'stk', 'pk', 'flere', 'varianter', 'gode', 'havet']);

/** Parse a matkassa.offers/1 file into normalised offers (same shape as tjek.js), or throw a Norwegian error. */
export function parseExtraOffers(json) {
  if (!json || json.schema !== OFFERS_SCHEMA || !Array.isArray(json.offers)) throw new Error('Ukjent tilbudsfil');
  const out = [];
  for (const o of json.offers) {
    const eans = [...new Set((o.eans || []).map(normEan).filter(Boolean))];
    const price = typeof o.price === 'number' ? o.price : null;
    if (!o.title || price == null) continue;
    const t = (v) => (v ? Date.parse(v) || null : null);
    out.push({
      id: String(o.id || `${json.source}-${o.title}-${price}`),
      chainId: o.chainId || REMA_ID,
      chain: o.chain || 'REMA 1000',
      color: null,
      title: String(o.title).trim(),
      desc: String(o.desc || '').trim(),
      price,
      prePrice: typeof o.prePrice === 'number' && o.prePrice > price ? o.prePrice : null,
      unitPrice: typeof o.unitPrice === 'number' ? o.unitPrice : null,
      unit: o.unit || null,
      unitFrom: false,
      from: t(o.from),
      till: t(o.till),
      img: typeof o.img === 'string' && /^https:\/\//.test(o.img) ? o.img : null,
      eans,
      source: json.source || 'extra',
    });
  }
  return out;
}

const words = (s) => new Set(tokens(s).filter((t) => t.length >= 4 && !/\d/.test(t) && !GENERIC.has(t)));

/**
 * Attach barcodes from extra offers to the matching Tjek offer of the same chain: same price (±1 øre) and at least
 * one shared product/brand word ("FILTERM KJELDSBERG" → "UTVALGT KJELDSBERG KAFFE"). An extra offer that matches
 * nothing is added as its own offer. Returns {offers, attached, added}; never mutates the input.
 */
export function mergeExtraOffers(tjekOffers, extra) {
  const offers = tjekOffers.map((o) => ({ ...o }));
  let attached = 0;
  let added = 0;
  const now = Date.now();
  for (const x of extra || []) {
    if (x.till && x.till < now) continue;
    const xw = words(`${x.title} ${x.desc.split(',')[0]}`);
    const hit = offers.find((o) => o.chainId === x.chainId && o.source !== x.source && Math.abs(o.price - x.price) < 0.011
      && [...words(`${o.title} ${o.desc}`)].some((w) => xw.has(w)));
    if (hit) {
      hit.eans = [...new Set([...(hit.eans || []), ...x.eans])];
      attached++;
    } else {
      offers.push({ ...x });
      added++;
    }
  }
  return { offers, attached, added };
}

/** Share of offers that carry at least one barcode, for the status line in Mer. */
export const eanCoverage = (offers) => {
  const n = offers.length;
  const withEan = offers.filter((o) => o.eans && o.eans.length).length;
  return { n, withEan, pct: n ? (withEan / n) * 100 : 0 };
};
