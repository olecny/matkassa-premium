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


/* ---------- Coop innsyn (GDPR "Bestill innsyn" on coop.no) ----------
 * Coop has no documented API for your own receipts, so this reads the innsyn export instead. The exact format is
 * not public: this accepts CSV (; , or tab) and JSON with Norwegian or English column names, either one row per
 * receipt or one row per product line (grouped by receipt number, or by date + time + store). Verify on the first
 * real file and adjust the synonyms below if needed. */
const COOP_COLS = {
  date: ['dato', 'kjøpsdato', 'kjopsdato', 'transaksjonsdato', 'tidspunkt', 'kjøpstidspunkt', 'date', 'purchasedate', 'timestamp'],
  time: ['klokkeslett', 'tid', 'kl', 'time'],
  store: ['butikk', 'butikknavn', 'butikk navn', 'sted', 'store', 'storename'],
  receipt: ['kvitteringsnummer', 'kvitteringsnr', 'kvittering', 'bongnummer', 'bong', 'transaksjonsid', 'transaksjonsnummer', 'receiptid', 'receipt', 'transactionid'],
  total: ['totalbeløp', 'totalbelop', 'totalt', 'kjøpsbeløp', 'kjopsbelop', 'sum kvittering', 'total', 'totalamount'],
  item: ['varenavn', 'vare', 'produkt', 'produktnavn', 'artikkel', 'varebeskrivelse', 'product', 'productname', 'item'],
  ean: ['ean', 'gtin', 'strekkode', 'ean-kode', 'eankode', 'barcode'],
  qty: ['antall', 'mengde', 'kvantum', 'quantity', 'qty'],
  amount: ['beløp', 'belop', 'varebeløp', 'varebelop', 'linjebeløp', 'pris', 'sum', 'amount', 'price'],
  group: ['varegruppe', 'kategori', 'category'],
};
const normKey = (k) => String(k).trim().toLowerCase().replace(/^﻿/, '').replace(/[_]+/g, ' ').replace(/\s+/g, ' ');
function colMap(keys) {
  const nk = keys.map(normKey);
  const out = {};
  for (const [field, names] of Object.entries(COOP_COLS)) {
    const i = nk.findIndex((k) => names.includes(k) || names.includes(k.replace(/ /g, '')));
    if (i >= 0) out[field] = keys[i];
  }
  return out;
}

/** Minimal CSV parser: quotes, "" escapes, ; , or tab (picked from the header line). */
export function parseCSV(text) {
  const src = String(text).replace(/^﻿/, '');
  const head = src.split(/\r?\n/, 1)[0] || '';
  const delim = [';', '\t', ','].map((d) => [d, head.split(d).length]).sort((a, b) => b[1] - a[1])[0][0];
  const rows = [];
  let row = [], cell = '', q = false;
  for (let i = 0; i < src.length; i++) {
    const c = src[i];
    if (q) {
      if (c === '"' && src[i + 1] === '"') { cell += '"'; i++; } else if (c === '"') q = false; else cell += c;
    } else if (c === '"') q = true;
    else if (c === delim) { row.push(cell); cell = ''; }
    else if (c === '\n' || c === '\r') { if (c === '\r' && src[i + 1] === '\n') i++; row.push(cell); rows.push(row); row = []; cell = ''; }
    else cell += c;
  }
  if (cell !== '' || row.length) { row.push(cell); rows.push(row); }
  const nonEmpty = rows.filter((r) => r.some((x) => x.trim() !== ''));
  if (nonEmpty.length < 2) return [];
  const keys = nonEmpty[0].map((k) => k.trim());
  return nonEmpty.slice(1).map((r) => Object.fromEntries(keys.map((k, i) => [k, (r[i] ?? '').trim()])));
}

const coopChain = (store) => {
  const s = String(store || '').toLowerCase();
  for (const [k, name] of [['extra', 'Coop Extra'], ['obs bygg', 'Obs Bygg'], ['obs', 'Coop Obs'], ['prix', 'Coop Prix'], ['mega', 'Coop Mega'], ['marked', 'Coop Marked'], ['matkroken', 'Matkroken']]) if (s.includes(k)) return name;
  return 'Coop';
};

/** Rows (from CSV or JSON) → receipts with source "coop". Returns null if the rows don't look like Coop data. */
export function parseCoopRows(rows) {
  if (!Array.isArray(rows) || !rows.length || typeof rows[0] !== 'object') return null;
  const m = colMap(Object.keys(rows[0]));
  if (!m.date || !(m.total || m.amount)) return null;
  const perLine = !!m.item;
  const groups = new Map();
  for (const r of rows) {
    const when = parseWhen(r[m.date]);
    if (!when) continue;
    const time = (m.time && /^\d{1,2}[:.]\d{2}/.test(r[m.time]) ? r[m.time].replace('.', ':').slice(0, 5).padStart(5, '0') : null) || when.time;
    const store = String((m.store && r[m.store]) || 'Coop').trim();
    const key = perLine ? (m.receipt && r[m.receipt] ? `n:${r[m.receipt]}` : `${when.date}|${time || ''}|${store}`) : `row:${groups.size}`;
    let g = groups.get(key);
    if (!g) { g = { no: m.receipt ? r[m.receipt] : null, date: when.date, time, store, total: null, lines: [] }; groups.set(key, g); }
    if (m.total && toNumber(r[m.total]) != null) g.total = toNumber(r[m.total]);
    if (perLine) {
      const amount = toNumber(r[m.amount]) ?? 0;
      const ean = m.ean && /^\d{8,14}$/.test(String(r[m.ean]).trim()) ? String(r[m.ean]).trim() : null;
      g.lines.push({ name: String(r[m.item] || 'Ukjent vare').trim(), ean, qty: m.qty ? toNumber(r[m.qty]) : null, amount, group: (m.group && r[m.group]) || null });
    } else if (g.total == null) g.total = toNumber(r[m.amount]);
  }
  const out = [];
  for (const g of groups.values()) {
    const total = g.total ?? g.lines.reduce((s, l) => s + l.amount, 0);
    if (!Number.isFinite(total)) continue;
    out.push({
      id: `coop-${g.no || `${g.date}-${g.time || ''}-${g.store}-${Math.round(total * 100)}`}`,
      source: 'coop', chain: coopChain(g.store), store: g.store, date: g.date, time: g.time,
      total: Math.round(total * 100) / 100, currency: 'NOK', lines: g.lines,
    });
  }
  return out.length ? out : null;
}

/* ---------- the same purchase from two sources (e.g. Trumf innsyn + trumf.py, or a manual copy) ---------- */
const CHAIN_KEYS = ['rema', 'kiwi', 'meny', 'eurospar', 'spar', 'joker', 'extra', 'obs', 'prix', 'mega', 'coop', 'bunnpris', 'oda'];
const chainKey = (r) => {
  const s = `${r.chain || ''} ${r.store || ''}`.toLowerCase();
  return CHAIN_KEYS.find((k) => s.includes(k)) || s.replace(/[^a-zæøå]/g, '').slice(0, 10);
};
const richness = (r) => (r.lines || []).filter((l) => l.ean).length * 1000 + (r.lines || []).length * 10 + (r.source === 'manual' ? 0 : 1);
const minutes = (t) => (t && /^\d{2}:\d{2}/.test(t) ? Number(t.slice(0, 2)) * 60 + Number(t.slice(3, 5)) : null);

/** Collapse receipts that are the same purchase (same day, chain and total; times, if both known, within 3 min).
 * Keeps the richest copy (most barcodes, then most lines). Returns {receipts, removed: [ids]}. */
export function dedupeReceipts(list) {
  const groups = new Map();
  for (const r of list) {
    if (!r || !r.date || !Number.isFinite(r.total)) continue;
    const k = `${r.date}|${Math.round(r.total * 100)}|${chainKey(r)}`;
    if (!groups.has(k)) groups.set(k, []);
    groups.get(k).push(r);
  }
  const drop = new Set();
  for (const g of groups.values()) {
    if (g.length < 2) continue;
    const sorted = [...g].sort((a, b) => richness(b) - richness(a));
    const kept = [];
    for (const r of sorted) {
      const twin = kept.find((k) => { const a = minutes(k.time), b = minutes(r.time); return a == null || b == null || Math.abs(a - b) <= 3; });
      if (twin) drop.add(r.id); else kept.push(r);
    }
  }
  return { receipts: list.filter((r) => !drop.has(r && r.id)), removed: [...drop] };
}

/** Detect file type. Returns {kind:'backup'|'spending'|'trumf'|'coop', data} or throws a Norwegian error. */
export function detectImport(json) {
  if (json && json.schema === BACKUP_SCHEMA) return { kind: 'backup', data: json };
  if (json && json.schema === SPENDING_SCHEMA) return { kind: 'spending', data: parseSpending(json) || [] };
  const t = parseTrumf(json);
  if (t && t.length) return { kind: 'trumf', data: t };
  const s = parseSpending(json);
  if (s && s.length) return { kind: 'spending', data: s };
  const rows = findArray(json, (r) => r && typeof r === 'object' && !Array.isArray(r) && colMap(Object.keys(r)).date);
  const c = parseCoopRows(rows);
  if (c) return { kind: 'coop', data: c };
  throw new Error('Fant ingen kvitteringer i fila. Støttet: Trumf-innsyn (JSON), Coop-innsyn (CSV/JSON), Matkassa spending.json eller Matkassa-backup.');
}

/** Text file → same as detectImport. JSON first; otherwise CSV (Coop innsyn). */
export function detectImportText(text) {
  let json;
  try { json = JSON.parse(text); } catch (e) {
    const rows = parseCSV(text);
    const c = rows.length ? parseCoopRows(rows) : null;
    if (c) return { kind: 'coop', data: c };
    throw new Error(rows.length ? 'Fant ingen kvitteringer i CSV-fila (trenger minst dato og beløp).' : 'Fila er ikke gyldig JSON eller CSV');
  }
  return detectImport(json);
}

/** Merge receipts by id, then collapse the same purchase from different sources. Returns {receipts, added, updated, duplicates}. */
export function mergeReceipts(existing, incoming) {
  const map = new Map(existing.map((r) => [r.id, r]));
  let added = 0;
  let updated = 0;
  for (const r of incoming) {
    if (map.has(r.id)) updated++;
    else added++;
    map.set(r.id, r);
  }
  const { receipts: unique, removed } = dedupeReceipts([...map.values()]);
  const newIds = new Set(incoming.map((r) => r.id));
  const droppedNew = removed.filter((id) => newIds.has(id) && !existing.some((r) => r.id === id)).length;
  const receipts = unique.sort((a, b) => (b.date + (b.time || '')).localeCompare(a.date + (a.time || '')));
  return { receipts, added: added - droppedNew, updated, duplicates: removed.length };
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
