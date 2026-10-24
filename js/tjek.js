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

function unitPrice(o) {
  const price = o.pricing && o.pricing.price;
  const q = o.quantity || {};
  const si = q.unit && q.unit.si;
  if (price && si && (si.symbol === 'kg' || si.symbol === 'l') && q.size) {
    const pieces = (q.pieces && q.pieces.from) || 1;
    const size = (q.size.to || q.size.from) * pieces * (si.factor || 1);
    if (size > 0) {
      return { value: price / size, unit: si.symbol, from: q.size.to && q.size.from !== q.size.to };
    }
  }
  // Fall back to the printed unit price in the description ("Pr kg 69,39", "72,46/KG", "pr. l 9,89").
  const d = (o.description || '').replace(/\n/g, ' ');
  let m = d.match(/pr\.?\s*(kg|l|liter)\.?\s*(?:fra\s*)?(\d+[.,]\d{1,2})/i);
  if (m) return { value: num(m[2]), unit: m[1].toLowerCase().startsWith('l') ? 'l' : 'kg' };
  m = d.match(/(\d+[.,]\d{2})\s*(?:pr\.?\s*|\/\s*)(kg|l)\b/i);
  if (m) return { value: num(m[1]), unit: m[2].toLowerCase() };
  return null;
}

export function normalizeOffer(o) {
  const dealerName = GROCERY_DEALERS[o.dealer_id] || (o.dealer && o.dealer.name) || 'Ukjent';
  const desc = (o.description || '').split('\n').map((s) => s.trim()).filter(Boolean).join(' · ');
  const up = unitPrice(o);
  return {
    id: o.id,
    chainId: o.dealer_id,
    chain: dealerName,
    color: o.dealer && o.dealer.color ? '#' + o.dealer.color : null,
    title: (o.heading || '').trim(),
    desc,
    price: o.pricing ? o.pricing.price : null,
    prePrice: o.pricing ? o.pricing.pre_price : null,
    unitPrice: up ? Math.round(up.value * 100) / 100 : null,
    unit: up ? up.unit : null,
    unitFrom: !!(up && up.from),
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
