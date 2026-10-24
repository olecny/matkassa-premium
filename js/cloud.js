// Optional account + sync with Supabase (free tier), plain REST, no library.
// The app is local-first: everything works without an account. With one, each item (receipt, list item, category,
// rule) is a row {id, data, updated_at, deleted} in the user's own rows (RLS: user_id = auth.uid()).
// The project URL and anon key are public by design (they go in js/cloud-config.js). The service_role key is never
// in this app. The GitHub sync key is never sent: only the whitelisted settings below leave the device.
import { CLOUD } from './cloud-config.js';

export const COLLECTIONS = ['receipts', 'list_items', 'categories', 'rules'];
export const SETTINGS_KEYS = ['area', 'chains', 'hiddenChains']; // never `sync` (GitHub key) or `geo` (per device)
const CHUNK = 200;

export const cloudConfigured = (c = CLOUD) =>
  !!(c && typeof c.url === 'string' && /^https:\/\/[a-z0-9-]+\.supabase\.co$/.test(c.url.replace(/\/$/, '')) && typeof c.anonKey === 'string' && c.anonKey.length > 20);

/** Stable JSON (sorted keys) so the same item always hashes the same. */
export function stable(v) {
  if (Array.isArray(v)) return '[' + v.map(stable).join(',') + ']';
  if (v && typeof v === 'object') return '{' + Object.keys(v).sort().filter((k) => v[k] !== undefined).map((k) => JSON.stringify(k) + ':' + stable(v[k])).join(',') + '}';
  return JSON.stringify(v ?? null);
}
export function hash(v) {
  const s = stable(v);
  let h1 = 0x811c9dc5, h2 = 0;
  for (let i = 0; i < s.length; i++) { const c = s.charCodeAt(i); h1 = Math.imul(h1 ^ c, 16777619); h2 = (h2 * 31 + c) | 0; }
  return (h1 >>> 0).toString(36) + (h2 >>> 0).toString(36) + s.length.toString(36);
}

export const pickSettings = (s) => Object.fromEntries(SETTINGS_KEYS.filter((k) => s && k in s).map((k) => [k, s[k]]));

/**
 * Reconcile one collection. Pure.
 * local: items with .id; known: {id: hash} as of the last sync; rows: remote rows changed since the last pull.
 * Rules: an item changed here since the last sync wins (it is pushed); otherwise the remote version is taken.
 * A remote tombstone removes an unchanged local item. A local delete becomes a tombstone.
 * replace: drop local-only data first ("use the account's data" on first login).
 */
export function reconcile(local, known, rows, { replace = false } = {}) {
  const k = { ...(known || {}) };
  let items = replace ? [] : [...(local || [])].filter((x) => x && x.id != null);
  if (replace) for (const id of Object.keys(k)) delete k[id];
  const byId = new Map(items.map((x) => [String(x.id), x]));
  const dirty = new Set([...byId].filter(([id, x]) => k[id] !== hash(x)).map(([id]) => id));
  const localDeleted = new Set(Object.keys(k).filter((id) => !byId.has(id)));
  for (const r of rows || []) {
    const id = String(r.id);
    if (dirty.has(id)) continue; // changed here: ours wins and is pushed below
    if (r.deleted) {
      byId.delete(id);
      delete k[id];
      localDeleted.delete(id);
      continue;
    }
    if (localDeleted.has(id)) continue; // deleted here: the tombstone is pushed below
    const data = r.data && typeof r.data === 'object' ? { ...r.data, id: r.data.id ?? r.id } : null;
    if (!data) continue;
    byId.set(id, data);
    k[id] = hash(data);
  }
  const push = [];
  for (const id of dirty) { const x = byId.get(id); push.push({ id, data: x, deleted: false }); }
  for (const id of localDeleted) push.push({ id, data: {}, deleted: true });
  // keep local order, then new remote items
  const order = new Map(items.map((x, i) => [String(x.id), i]));
  const next = [...byId.values()].sort((a, b) => (order.get(String(a.id)) ?? 1e9) - (order.get(String(b.id)) ?? 1e9));
  return { next, known: k, push, pushedHashes: Object.fromEntries(push.map((p) => [p.id, p.deleted ? null : hash(p.data)])) };
}

/* ---------- REST client ---------- */
export class Cloud {
  constructor({ config = CLOUD, fetchImpl = (...a) => fetch(...a), loadSession, saveSession } = {}) {
    this.base = (config.url || '').replace(/\/$/, '');
    this.key = config.anonKey;
    this.fetch = fetchImpl;
    this.loadSession = loadSession;
    this.saveSession = saveSession;
    this.session = null;
  }

  async init() {
    this.session = (await this.loadSession()) || null;
    return this.session;
  }

  get user() { return this.session && this.session.user; }

  async auth(path, body) {
    const res = await this.fetch(`${this.base}/auth/v1/${path}`, {
      method: 'POST',
      headers: { apikey: this.key, 'Content-Type': 'application/json' },
      body: JSON.stringify(body),
    });
    const j = await res.json().catch(() => ({}));
    if (!res.ok) throw new Error(authMessage(j, res.status));
    return j;
  }

  async setSession(j) {
    if (!j || !j.access_token || !j.refresh_token) throw new Error('Innloggingen ga ingen gyldig økt');
    const user = j.user || (await this.getUser(j.access_token));
    this.session = {
      access_token: j.access_token,
      refresh_token: j.refresh_token,
      expires_at: Date.now() + (Number(j.expires_in) || 3600) * 1000,
      user: { id: user.id, email: user.email || '' },
    };
    await this.saveSession(this.session);
    return this.session;
  }

  async getUser(token) {
    const res = await this.fetch(`${this.base}/auth/v1/user`, { headers: { apikey: this.key, Authorization: `Bearer ${token}` } });
    if (!res.ok) throw new Error('Fant ikke brukeren');
    return res.json();
  }

  signIn(email, password) { return this.auth('token?grant_type=password', { email, password }).then((j) => this.setSession(j)); }

  async signUp(email, password) {
    const j = await this.auth('signup', { email, password });
    if (j.access_token) return this.setSession(j); // email confirmation turned off
    return null; // confirmation email sent
  }

  sendMagicLink(email, redirectTo) { return this.auth(`otp?redirect_to=${encodeURIComponent(redirectTo)}`, { email, create_user: true }); }

  /** Magic-link return: #access_token=…&refresh_token=…&expires_in=…&type=magiclink */
  async fromRedirect(hash) {
    const p = new URLSearchParams(String(hash || '').replace(/^#/, ''));
    if (p.get('error_description')) throw new Error(p.get('error_description'));
    if (!p.get('access_token')) return null;
    return this.setSession({ access_token: p.get('access_token'), refresh_token: p.get('refresh_token'), expires_in: p.get('expires_in') });
  }

  async token() {
    if (!this.session) throw new Error('Ikke logget inn');
    if (this.session.expires_at - Date.now() < 60000) {
      try {
        await this.setSession({ ...(await this.auth('token?grant_type=refresh_token', { refresh_token: this.session.refresh_token })), user: this.session.user });
      } catch (e) {
        if (/invalid|expired|not found|revoked/i.test(e.message)) { await this.signOut(true); throw new Error('Innloggingen er utløpt. Logg inn igjen.'); }
        throw e;
      }
    }
    return this.session.access_token;
  }

  async signOut(localOnly = false) {
    const s = this.session;
    this.session = null;
    await this.saveSession(null);
    if (!localOnly && s) {
      try { await this.fetch(`${this.base}/auth/v1/logout`, { method: 'POST', headers: { apikey: this.key, Authorization: `Bearer ${s.access_token}` } }); } catch { /* offline: the local session is gone anyway */ }
    }
  }

  async rest(path, { method = 'GET', body, prefer, range } = {}) {
    const headers = { apikey: this.key, Authorization: `Bearer ${await this.token()}` };
    if (body !== undefined) headers['Content-Type'] = 'application/json';
    if (prefer) headers.Prefer = prefer;
    if (range) headers.Range = range;
    const res = await this.fetch(`${this.base}/rest/v1/${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    if (res.status === 401) { this.session.expires_at = 0; throw new Error('Innloggingen må fornyes – prøv igjen'); }
    if (!res.ok) { const j = await res.json().catch(() => ({})); throw new Error(`Sky-feil ${res.status}${j.message ? ': ' + j.message : ''}`); }
    return res.status === 204 ? null : res.json().catch(() => null);
  }

  /** Every row of a collection changed after `since` (ISO string or null), oldest first, paged. */
  async pull(table, since) {
    const out = [];
    for (let offset = 0; ; offset += 1000) {
      const q = `${table}?select=id,data,updated_at,deleted&order=updated_at.asc,id.asc${since ? `&updated_at=gt.${encodeURIComponent(since)}` : ''}&limit=1000&offset=${offset}`;
      const rows = (await this.rest(q)) || [];
      out.push(...rows);
      if (rows.length < 1000) break;
    }
    return out;
  }

  /** Upsert rows; returns the newest server updated_at among them. */
  async push(table, rows) {
    let newest = null;
    const uid = this.user.id;
    for (let i = 0; i < rows.length; i += CHUNK) {
      const chunk = rows.slice(i, i + CHUNK).map((r) => ({ user_id: uid, id: r.id, data: r.data, deleted: !!r.deleted }));
      const back = (await this.rest(`${table}?on_conflict=user_id,id&select=id,updated_at`, { method: 'POST', body: chunk, prefer: 'resolution=merge-duplicates,return=representation' })) || [];
      for (const b of back) if (!newest || b.updated_at > newest) newest = b.updated_at;
    }
    return newest;
  }

  async pullSettings() {
    const rows = (await this.rest('settings?select=data,updated_at')) || [];
    return rows[0] || null;
  }

  async pushSettings(data) {
    const back = await this.rest('settings?on_conflict=user_id&select=updated_at', { method: 'POST', body: [{ user_id: this.user.id, data: pickSettings(data) }], prefer: 'resolution=merge-duplicates,return=representation' });
    return back && back[0] ? back[0].updated_at : null;
  }

  async connections() {
    return (await this.rest('chain_connections?select=chain,status,connected_at,last_fetch_at,last_error')) || [];
  }

  disconnect(chain) { return this.rest(`chain_connections?chain=eq.${encodeURIComponent(chain)}`, { method: 'DELETE' }); }

  /** "Slett dataene mine i skyen": every row of this user (RLS limits the delete to them). */
  async wipe() {
    for (const t of [...COLLECTIONS, 'settings', 'chain_connections']) await this.rest(`${t}?user_id=eq.${this.user.id}`, { method: 'DELETE' });
  }
}

function authMessage(j, status) {
  const m = String(j.error_description || j.msg || j.message || j.error || '');
  if (/invalid login credentials|invalid_grant/i.test(m)) return 'Feil e-post eller passord';
  if (/email not confirmed/i.test(m)) return 'Bekreft e-postadressen først (sjekk innboksen)';
  if (/already registered|already exists/i.test(m)) return 'Det finnes alt en konto med denne e-posten – logg inn';
  if (/password should be|weak/i.test(m)) return 'Passordet er for svakt (minst 8 tegn)';
  if (status === 429 || /rate limit/i.test(m)) return 'For mange forsøk – vent litt og prøv igjen';
  return m ? `Innlogging feilet: ${m}` : `Innlogging feilet (${status})`;
}
