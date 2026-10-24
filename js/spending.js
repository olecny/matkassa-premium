// Receipts: importers (Trumf innsyn, Matkassa spending.json, backup) and aggregation.
// Internal receipt shape = the spending.json receipt shape (see ingest/README.md):
// { id, source, chain, store, date:'YYYY-MM-DD', time?, total, currency, lines:[{name, ean?, qty?, unit?, amount, discount?, deposit?, group?, category?}], category? }

export const SPENDING_SCHEMA = 'matkassa.spending/1';
export const BACKUP_SCHEMA = 'matkassa.backup/1';

export function toNumber(v) {
  if (v == null || v === '') return null;
  if (typeof v === 'number') return Number.isFinite(v) ? v : null;
  let s = String(v).replace(/[\s ]|kr|NOK/gi, '');
  // "1.234,50" → "1234.50"; "1234,5" → "1234.5"
  if (s.includes(',') && s.includes('.')) s = s.replace(/\./g, '');
  s = s.replace(',', '.');
  const n = parseFloat(s);
  return Number.isFinite(n) ? n : null;
}

const pad = (n) => String(n).padStart(2, '0');

/** Parse "24.10.2026 17:32", "24.10.2026", "2026-10-24T17:32:00+02:00", epoch ms. Returns {date, time}. */
export function parseWhen(v) {
  if (v == null) return null;
  if (typeof v === 'number') {
    const d = new Date(v);
    return { date: `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`, time: `${pad(d.getHours())}:${pad(d.getMinutes())}` };
  }
  const s = String(v).trim();
  let m = s.match(/^(\d{1,2})\.(\d{1,2})\.(\d{4})(?:[ T](\d{1,2}):(\d{2}))?/);
  if (m) return { date: `${m[3]}-${pad(m[2])}-${pad(m[1])}`, time: m[4] ? `${pad(m[4])}:${m[5]}` : null };
  m = s.match(/^(\d{4})-(\d{2})-(\d{2})(?:[ T](\d{2}):(\d{2}))?/);
  if (m) return { date: `${m[1]}-${m[2]}-${m[3]}`, time: m[4] ? `${m[4]}:${m[5]}` : null };
  return null;
}

const pick = (o, keys) => {
  for (const k of keys) if (o[k] != null && o[k] !== '') return o[k];
  // case-insensitive fallback
  const lower = Object.keys(o).reduce((acc, k) => ((acc[k.toLowerCase()] = o[k]), acc), {});
  for (const k of keys) if (lower[k.toLowerCase()] != null) return lower[k.toLowerCase()];
  return null;
};

function findArray(root, test) {
  if (Array.isArray(root)) return root.some(test) ? root : null;
  if (root && typeof root === 'object') {
    for (const v of Object.values(root)) {
      const r = findArray(v, test);
      if (r) return r;
    }
  }
  return null;
}

const looksTrumf = (r) => r && typeof r === 'object' && (pick(r, ['varelinjer', 'varer']) != null || pick(r, ['kvitteringsnummer']) != null);

/** Trumf innsyn JSON (format per github.com/olejorgenb/trumf_receipt_tools). Tolerates wrappers and name variants. */
export function parseTrumf(json) {
  const arr = findArray(json, looksTrumf);
  if (!arr) return null;
  const receipts = [];
  for (const r of arr) {
    if (!looksTrumf(r)) continue;
    const when = parseWhen(pick(r, ['dato', 'kjopsdato', 'kjøpsdato', 'tidspunkt', 'date']));
    if (!when) continue;
    const lines = (pick(r, ['varelinjer', 'varer']) || []).map((l) => {
      const amount = toNumber(pick(l, ['vareBelop', 'vareBeløp', 'belop', 'beløp', 'sum', 'amount']));
      return {
        name: String(pick(l, ['varenavn', 'navn', 'beskrivelse', 'name']) || 'Ukjent vare').trim(),
        ean: pick(l, ['ean', 'gtin', 'varenummer', 'strekkode']) ? String(pick(l, ['ean', 'gtin', 'varenummer', 'strekkode'])) : null,
        qty: toNumber(pick(l, ['vareAntallVekt', 'antall', 'mengde', 'qty'])),
        amount: amount ?? 0,
        group: pick(l, ['varegruppe', 'varegruppenavn', 'kategori']) || null,
      };
    });
    const lineSum = lines.reduce((s, l) => s + l.amount, 0);
    const total = toNumber(pick(r, ['totalBelop', 'totalbeløp', 'belop', 'beløp', 'sum', 'total', 'totalsum'])) ?? lineSum;
    const chain = String(pick(r, ['kjede', 'chain']) || '').trim();
    const store = String(pick(r, ['butikknavn', 'butikk', 'store']) || chain).trim();
    const no = pick(r, ['kvitteringsnummer', 'kvitteringsnr', 'id']);
    receipts.push({
      id: `trumf-${no ?? `${when.date}-${when.time}-${store}-${total}`}`,
      source: 'trumf',
      chain: chain || store,
      store,
      date: when.date,
      time: when.time,
      total: Math.round(total * 100) / 100,
      currency: 'NOK',
      lines,
    });
  }
  return receipts;
}

/** Matkassa spending.json (schema "matkassa.spending/1"), or a bare array of receipts in that shape. */
export function parseSpending(json) {
  const arr = Array.isArray(json) ? json : json && Array.isArray(json.receipts) ? json.receipts : null;
  if (!arr) return null;
  if (!arr.every((r) => r && (r.date || r.dato) && (r.total != null || Array.isArray(r.lines)))) return null;
  return arr.map((r, i) => {
    const when = parseWhen(r.date || r.dato) || { date: null };
    const lines = (r.lines || []).map((l) => ({
      name: String(l.name || 'Ukjent vare').trim(),
      ean: l.ean ? String(l.ean) : null,
      qty: toNumber(l.qty),
      unit: l.unit || null,
      amount: toNumber(l.amount) ?? 0,
      discount: toNumber(l.discount),
      deposit: toNumber(l.deposit),
      group: l.group || null,
      category: l.category || null,
    }));
    const total = toNumber(r.total) ?? lines.reduce((s, l) => s + l.amount, 0);
    return {
      id: String(r.id || `${r.source || 'import'}-${when.date}-${r.store || ''}-${total}-${i}`),
      source: r.source || 'import',
      chain: r.chain || r.store || '',
      store: r.store || r.chain || '',
      date: when.date,
      time: r.time || when.time || null,
      total: Math.round(total * 100) / 100,
      currency: r.currency || 'NOK',
      category: r.category || null,
      lines,
    };
  }).filter((r) => r.date);
}

/** Detect file type. Returns {kind:'backup'|'spending'|'trumf', data} or throws a Norwegian error. */
export function detectImport(json) {
  if (json && json.schema === BACKUP_SCHEMA) return { kind: 'backup', data: json };
  if (json && json.schema === SPENDING_SCHEMA) return { kind: 'spending', data: parseSpending(json) || [] };
  const t = parseTrumf(json);
  if (t && t.length) return { kind: 'trumf', data: t };
  const s = parseSpending(json);
  if (s && s.length) return { kind: 'spending', data: s };
  throw new Error('Fant ingen kvitteringer i fila. Støttet: Trumf-innsyn (JSON), Matkassa spending.json eller Matkassa-backup.');
}

/** Merge receipts by id. Returns {receipts, added, updated}. */
export function mergeReceipts(existing, incoming) {
  const map = new Map(existing.map((r) => [r.id, r]));
  let added = 0;
  let updated = 0;
  for (const r of incoming) {
    if (map.has(r.id)) updated++;
    else added++;
    map.set(r.id, r);
  }
  const receipts = [...map.values()].sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
  return { receipts, added, updated };
}

export const UNCAT = '__uncat';

/**
 * Split each receipt into category amounts.
 * Lines → classified category (explicit line.category if it is a known id).
 * No lines → receipt.category or Ukategorisert. Difference between lines and total
 * (rounding, pant, discounts not on lines) → "Ukategorisert" only when it exceeds 1 kr.
 */
export function allocate(receipt, classify, validIds) {
  const parts = [];
  if (receipt.lines && receipt.lines.length) {
    let sum = 0;
    for (const l of receipt.lines) {
      const explicit = l.category && validIds.has(l.category) ? l.category : null;
      const cat = explicit || classify(l.name, l.ean, l.group) || UNCAT;
      parts.push({ cat, amount: l.amount, line: l });
      sum += l.amount;
    }
    const diff = Math.round((receipt.total - sum) * 100) / 100;
    if (Math.abs(diff) > 1) parts.push({ cat: UNCAT, amount: diff, line: null, diff: true });
  } else {
    const cat = receipt.category && validIds.has(receipt.category) ? receipt.category : UNCAT;
    parts.push({ cat, amount: receipt.total, line: null });
  }
  return parts;
}

export const monthKey = (date) => date.slice(0, 7);

export function summarize(receipts, classify, categories) {
  const validIds = new Set(categories.map((c) => c.id));
  const months = new Map(); // 'YYYY-MM' → {total, count, byCat: Map}
  const uncat = new Map(); // normalized name → {name, count, amount, ean}
  for (const r of receipts) {
    const k = monthKey(r.date);
    if (!months.has(k)) months.set(k, { total: 0, count: 0, byCat: new Map() });
    const m = months.get(k);
    m.total += r.total;
    m.count += 1;
    for (const p of allocate(r, classify, validIds)) {
      m.byCat.set(p.cat, (m.byCat.get(p.cat) || 0) + p.amount);
      if (p.cat === UNCAT && p.line) {
        const key = p.line.name.toLowerCase();
        const u = uncat.get(key) || { name: p.line.name, ean: p.line.ean, group: p.line.group, count: 0, amount: 0 };
        u.count += 1;
        u.amount += p.line.amount;
        uncat.set(key, u);
      }
    }
  }
  return { months, uncat: [...uncat.values()].sort((a, b) => b.amount - a.amount) };
}

/** This month so far vs the same days of last month (fair mid-month), plus last month's full total. today = 'YYYY-MM-DD'. */
export function monthCompare(receipts, today) {
  const thisKey = today.slice(0, 7);
  const [y, m] = thisKey.split('-').map(Number);
  const d = new Date(y, m - 2, 1);
  const lastKey = `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}`;
  const day = today.slice(8, 10);
  let now = 0, lastSoFar = 0, lastAll = 0, count = 0;
  for (const r of receipts) {
    if (!r || typeof r.date !== 'string') continue;
    const t = Number(r.total) || 0;
    if (r.date.startsWith(thisKey) && r.date.slice(8, 10) <= day) { now += t; count += 1; }
    else if (r.date.startsWith(lastKey)) { lastAll += t; if (r.date.slice(8, 10) <= day) lastSoFar += t; }
  }
  return { thisKey, lastKey, now, count, lastSoFar, lastAll };
}
