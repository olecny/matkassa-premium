// Tjek (eTilbudsavis / mattilbud) adapter. Unofficial, keyless, CORS-open API.
// Verified 2026-10-24: GET /v2/catalogs?r_lat&r_lng&r_radius&limit≤100&offset
//                      GET /v2/offers?catalog_id=…&limit≤100&offset
const API = 'https://squid-api.tjek.com/v2';

// Norwegian grocery chains on Tjek (dealer id → name). Other dealers (Jula, Skeidar …) are ignored.
export const GROCERY_DEALERS = {
  faa0Ym: 'REMA 1000',
  '257bxm': 'KIWI',
  '4333pm': 'MENY',
  c062vm: 'SPAR',
  b3e8Fm: 'Joker',
  '80742m': 'Coop Extra',
  de79dm: 'Coop Mega',
  f5d5lm: 'Coop Prix',
  '68baam': 'Coop Marked',
  '51dawm': 'Obs',
  '5b11sm': 'Bunnpris',
  '2686gD': 'Matkroken',
  '5861Qq': 'Nærbutikken',
  pR2h9x: 'Holdbart',
};

// Areas the user can pick in Mer → Område (or "Bruk min posisjon"). Trondheim is the default because the app
// started there; it is a region, not personal data, and every user can change it.
export const AREAS = [
  { name: 'Oslo', lat: 59.9139, lng: 10.7522, radius: 30000 },
  { name: 'Bergen', lat: 60.3913, lng: 5.3221, radius: 30000 },
  { name: 'Trondheim', lat: 63.4305, lng: 10.3951, radius: 30000 },
  { name: 'Stavanger', lat: 58.97, lng: 5.7331, radius: 30000 },
  { name: 'Kristiansand', lat: 58.1467, lng: 7.9956, radius: 30000 },
  { name: 'Tromsø', lat: 69.6492, lng: 18.9553, radius: 30000 },
  { name: 'Bodø', lat: 67.2804, lng: 14.4049, radius: 30000 },
  { name: 'Ålesund', lat: 62.4722, lng: 6.1495, radius: 30000 },
  { name: 'Drammen', lat: 59.7439, lng: 10.2045, radius: 30000 },
  { name: 'Fredrikstad', lat: 59.2181, lng: 10.9298, radius: 30000 },
];
export const TRONDHEIM = AREAS[2];
export const DEFAULT_AREA = TRONDHEIM;

// Safari does not parse "+0000" offsets; make them "+00:00".
export function parseDate(s) {
  if (!s) return null;
  return new Date(String(s).replace(/([+-]\d{2})(\d{2})$/, '$1:$2'));
}

async function getJSON(url, signal) {
  const res = await fetch(url, { signal, headers: { Accept: 'application/json' } });
  if (!res.ok) throw new Error(`Tjek svarte ${res.status}`);
  return res.json();
}

async function pool(items, limit, fn) {
  const out = [];
  let i = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (i < items.length) {
      const idx = i++;
      out[idx] = await fn(items[idx], idx);
    }
  });
  await Promise.all(workers);
  return out;
}

const num = (s) => parseFloat(String(s).replace(/\s/g, '').replace(',', '.'));
const UNIT = { kg: 'kg', kilo: 'kg', l: 'l', liter: 'l', stk: 'stk', boks: 'stk', flaske: 'stk', pk: 'stk', pakke: 'stk' };
const U = 'kg|kilo|liter|l|stk|boks|flaske|pakke|pk';

/** The unit price the chain printed ("Pr kg 69,39", "72,46/KG", "Kilopris fra 220,59", "9,90 pr boks"). It always wins. */
export function printedUnitPrice(text) {
  const d = String(text || '').replace(/\n/g, ' ');
  let m = d.match(new RegExp(`(?:pr\\.?|per)\\s*(${U})\\.?\\s*(?:kr\\.?\\s*)?(fra\\s*)?(?:kr\\.?\\s*)?(\\d+[.,]\\d{1,2})`, 'i'));
  if (m) return { value: num(m[3]), unit: UNIT[m[1].toLowerCase()], from: !!m[2] };
  m = d.match(new RegExp(`(fra\\s*)?(?:kr\\.?\\s*)?(\\d+[.,]\\d{2})\\s*(?:kr\\.?\\s*)?(?:pr\\.?\\s*|per\\s*|\\/\\s*)(${U})\\b`, 'i'));
  if (m) return { value: num(m[2]), unit: UNIT[m[3].toLowerCase()], from: !!m[1] };
  m = d.match(/(kilo|liter)pris:?\s*(fra\s*)?(?:kr\.?\s*)?(\d+[.,]\d{1,2})/i);
  if (m) return { value: num(m[3]), unit: m[1].toLowerCase() === 'kilo' ? 'kg' : 'l', from: !!m[2] };
  return null;
}

/** "4 for 50" → {n: 4, total: 50}; "3 for 2" → {n: 3, payFor: 2}. */
export function multiBuy(text) {
  const m = String(text || '').match(/\b(\d{1,2})\s*(?:stk\.?\s*|pk\.?\s*)?for\s*(?:kr\.?\s*)?(\d+(?:[.,]\d{1,2})?)\s*(?:,-|kr\b)?/i);
  if (!m) return null;
  const n = Number(m[1]);
  const v = num(m[2]);
  if (n < 2 || n > 24) return null;
  if (Number.isInteger(v) && v < n) return { n, payFor: v };
  return { n, total: v };
}

/** "10 x 0,33 l", "6x1,5 l", "4 x 125 g": pieces and the size of one. */
function packText(text) {
  const m = String(text || '').match(/\b(\d{1,2})\s*[x×]\s*(\d+(?:[.,]\d+)?)\s*(ml|cl|dl|l|g|kg)\b/i);
  if (!m) return null;
  const f = { ml: 0.001, cl: 0.01, dl: 0.1, l: 1, g: 0.001, kg: 1 }[m[3].toLowerCase()];
  return { pieces: Number(m[1]), size: num(m[2]) * f, unit: /l$/i.test(m[3]) ? 'l' : 'kg' };
}

/**
 * Price facts for one Tjek offer. Order of trust: the chain's printed unit price, then multi-buy ("4 for 50"
 * is shown as 4 for 50 kr and 12,50 kr/stk), then our own sum from the size. Returns
 * {value, unit, from, src} | null plus multi / pieces / perPiece for the card.
 */
export function priceFacts(o) {
  const price = o.pricing && o.pricing.price;
  const text = `${o.heading || ''} · ${o.description || ''}`;
  const q = o.quantity || {};
  const si = q.unit && q.unit.si;
  const out = { unit: null, multi: null, pieces: null, perPiece: null };
  const mb = price ? multiBuy(text) : null;
  if (mb) {
    // the Tjek price is either the whole deal (50) or already per piece (12,50)
    const total = mb.total != null ? mb.total : price * mb.payFor;
    const per = mb.total != null ? (Math.abs(price - total) <= Math.abs(price - total / mb.n) ? total / mb.n : price) : (price * mb.payFor) / mb.n;
    out.multi = { n: mb.n, total: Math.round((mb.total != null ? total : per * mb.n) * 100) / 100, payFor: mb.payFor || null };
    out.perPiece = Math.round(per * 100) / 100;
  }
  const pack = !mb && price ? packText(text) : null;
  const tjekPieces = (q.pieces && q.pieces.from) || 1;
  if (!mb && (pack || tjekPieces > 1)) {
    out.pieces = pack ? pack.pieces : tjekPieces;
    out.perPiece = Math.round((price / out.pieces) * 100) / 100;
  }
  const printed = printedUnitPrice(o.description);
  if (printed) return { ...out, value: printed.value, unit: printed.unit, from: printed.from, src: 'kjede' };
  if (mb) return { ...out, value: out.perPiece, unit: 'stk', from: false, src: 'flerkjøp' };
  if (price && si && (si.symbol === 'kg' || si.symbol === 'l') && q.size && (q.size.from || q.size.to)) {
    const size = (q.size.to || q.size.from) * tjekPieces * (si.factor || 1);
    if (size > 0) return { ...out, value: price / size, unit: si.symbol, from: !!(q.size.to && q.size.from !== q.size.to), src: 'regnet' };
  }
  if (pack && pack.size > 0) return { ...out, value: price / (pack.size * pack.pieces), unit: pack.unit, from: false, src: 'regnet' };
  return { ...out, value: null };
}

const UNIT_RANK = { kg: 0, l: 1, stk: 2 };
/** "Laveste pris": by unit price within the same unit (kg, then l, then stk), offers without one last by price. */
export function byUnitPrice(a, b) {
  const ra = a.unitPrice ? UNIT_RANK[a.unit] ?? 3 : 4;
  const rb = b.unitPrice ? UNIT_RANK[b.unit] ?? 3 : 4;
  return ra - rb || (a.unitPrice || a.price || 0) - (b.unitPrice || b.price || 0);
}

/**
 * "Beste tilbud": the lowest unit price among comparable offers (same category and unit, at least 3 of them),
 * at least 15 % under that group's median, and not a small thing under 15 kr. At most one per category.
 * items: [{o, cat}] → Set of offer ids.
 */
export function bestValueIds(items, n = 3) {
  const groups = new Map();
  for (const x of items) {
    const o = x.o;
    if (!o.unitPrice || !o.unit || o.unit === 'stk' || !x.cat || x.cat === 'annet' || x.cat === 'ikkemat') continue;
    const k = `${x.cat}|${o.unit}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(x);
  }
  const picks = [];
  for (const [k, g] of groups) {
    if (g.length < 3) continue;
    const ups = g.map((x) => x.o.unitPrice).sort((a, b) => a - b);
    const median = ups[Math.floor(ups.length / 2)];
    const cand = g.filter((x) => (x.o.multi ? x.o.multi.total : x.o.price) >= 15 && !x.o.unitFrom)
      .map((x) => ({ x, r: x.o.unitPrice / median })).filter((c) => c.r <= 0.85).sort((a, b) => a.r - b.r)[0];
    if (cand) picks.push({ id: cand.x.o.id, r: cand.r, cat: k.split('|')[0] });
  }
  const seen = new Set();
  return new Set(picks.sort((a, b) => a.r - b.r).filter((p) => !seen.has(p.cat) && seen.add(p.cat)).slice(0, n).map((p) => p.id));
}

export function normalizeOffer(o) {
  const dealerName = GROCERY_DEALERS[o.dealer_id] || (o.dealer && o.dealer.name) || 'Ukjent';
  const desc = (o.description || '').split('\n').map((s) => s.trim()).filter(Boolean).join(' · ');
  const up = priceFacts(o);
  return {
    id: o.id,
    chainId: o.dealer_id,
    chain: dealerName,
    color: o.dealer && o.dealer.color ? '#' + o.dealer.color : null,
    title: (o.heading || '').trim(),
    desc,
    price: o.pricing ? o.pricing.price : null,
    prePrice: o.pricing ? o.pricing.pre_price : null,
    unitPrice: up.value ? Math.round(up.value * 100) / 100 : null,
    unit: up.value ? up.unit : null,
    unitFrom: !!(up.value && up.from),
    unitSrc: up.value ? up.src : null,
    multi: up.multi,
    pieces: up.pieces,
    perPiece: up.perPiece,
    from: parseDate(o.run_from)?.getTime() || null,
    till: parseDate(o.run_till)?.getTime() || null,
    img: o.images ? o.images.thumb : null,
    catalogId: o.catalog_id,
  };
}

/**
 * Fetch all current and upcoming grocery offers near a location.
 * Returns { fetchedAt, chains:[{id,name,color}], offers:[normalized] }.
 */
export async function fetchOffers(loc = TRONDHEIM, onProgress = () => {}, signal) {
  const now = Date.now();
  const catalogs = [];
  for (let offset = 0; offset < 500; offset += 100) {
    const page = await getJSON(
      `${API}/catalogs?r_lat=${loc.lat}&r_lng=${loc.lng}&r_radius=${loc.radius}&limit=100&offset=${offset}`,
      signal,
    );
    catalogs.push(...page);
    if (page.length < 100) break;
  }
  const wanted = catalogs.filter(
    (c) => GROCERY_DEALERS[c.dealer_id] && parseDate(c.run_till) > now && c.offer_count > 0,
  );
  onProgress(0, wanted.length);

  let done = 0;
  const lists = await pool(wanted, 5, async (c) => {
    const all = [];
    for (let offset = 0; offset < 2000; offset += 100) {
      const page = await getJSON(`${API}/offers?catalog_id=${c.id}&limit=100&offset=${offset}`, signal);
      all.push(...page);
      if (page.length < 100) break;
    }
    onProgress(++done, wanted.length);
    return all;
  });

  const seen = new Set();
  const offers = [];
  for (const raw of lists.flat()) {
    const o = normalizeOffer(raw);
    if (!o.title || o.price == null) continue;
    if (o.till && o.till < now) continue;
    const key = `${o.chainId}|${o.title.toLowerCase()}|${o.price}`;
    if (seen.has(key)) continue;
    seen.add(key);
    offers.push(o);
  }

  const chainMap = new Map();
  for (const c of wanted) {
    if (!chainMap.has(c.dealer_id)) {
      chainMap.set(c.dealer_id, {
        id: c.dealer_id,
        name: GROCERY_DEALERS[c.dealer_id],
        color: c.dealer && c.dealer.color ? '#' + c.dealer.color : null,
      });
    }
  }
  const chains = [...chainMap.values()].sort((a, b) => a.name.localeCompare(b.name, 'nb'));
  return { fetchedAt: now, source: 'tjek', chains, offers };
}
