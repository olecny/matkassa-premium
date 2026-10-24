// A tiny in-memory stand-in for Supabase Auth (GoTrue) + PostgREST, for the e2e tests. FAKE: no real accounts,
// no network. It mimics what the app relies on: password/refresh/magic-link auth, per-user rows (like RLS on
// user_id = auth.uid()), upsert on (user_id, id), server-set updated_at, tombstones, and the settings token guard.
export const FAKE_SUPABASE_HOST = 'matkassa-fake.supabase.co';
export const FAKE_ANON = 'FAKE-anon-key-not-real-0123456789abcdef';

export function makeFakeSupabase() {
  const users = new Map(); // email → {id, email, password}
  const access = new Map(); // access token → user id
  const refresh = new Map(); // refresh token → user id
  const tables = { receipts: [], list_items: [], categories: [], rules: [], settings: [], chain_connections: [] };
  const log = []; // every request: {method, path, auth, body}
  let n = 0;
  let clock = Date.parse('2026-10-24T08:00:00Z');
  const tick = () => new Date((clock += 1000)).toISOString();
  const json = (status, body) => ({ status, type: 'application/json', body: body === undefined ? '' : JSON.stringify(body) });
  const session = (u) => {
    const at = `FAKE-AT-${++n}`;
    const rt = `FAKE-RT-${n}`;
    access.set(at, u.id);
    refresh.set(rt, u.id);
    return { access_token: at, refresh_token: rt, expires_in: 3600, token_type: 'bearer', user: { id: u.id, email: u.email } };
  };
  const userById = (id) => [...users.values()].find((u) => u.id === id);

  function addUser(email, password) {
    const u = { id: `00000000-0000-0000-0000-${String(users.size + 1).padStart(12, '0')}`, email, password };
    users.set(email, u);
    return u;
  }
  function seed(table, userId, id, data, extra = {}) {
    tables[table].push({ user_id: userId, id, data, updated_at: tick(), deleted: false, ...extra });
  }
  /** Simulate another device writing a row. */
  function remoteWrite(table, userId, id, data, deleted = false) {
    const rows = tables[table];
    const r = rows.find((x) => x.user_id === userId && x.id === id);
    if (r) Object.assign(r, { data, deleted, updated_at: tick() });
    else rows.push({ user_id: userId, id, data, deleted, updated_at: tick() });
  }
  function magicLinkToken(email) { return session(users.get(email)); }

  function handle(url, method, headers, body) {
    const u = new URL(url);
    if (u.hostname !== FAKE_SUPABASE_HOST) return null;
    if (method === 'OPTIONS') return { status: 204, type: 'text/plain', body: '' };
    const h = Object.fromEntries(Object.entries(headers || {}).map(([k, v]) => [k.toLowerCase(), v]));
    log.push({ method, path: u.pathname + u.search, auth: h.authorization || '', apikey: h.apikey || '', body: body || '' });
    if (h.apikey !== FAKE_ANON) return json(401, { message: 'Invalid API key' });
    const b = body ? JSON.parse(body) : {};

    if (u.pathname === '/auth/v1/token') {
      const g = u.searchParams.get('grant_type');
      if (g === 'password') {
        const usr = users.get(b.email);
        if (!usr || usr.password !== b.password) return json(400, { error: 'invalid_grant', error_description: 'Invalid login credentials' });
        return json(200, session(usr));
      }
      if (g === 'refresh_token') {
        const id = refresh.get(b.refresh_token);
        if (!id) return json(400, { error: 'invalid_grant', error_description: 'Invalid Refresh Token: Refresh Token Not Found' });
        refresh.delete(b.refresh_token);
        return json(200, session(userById(id)));
      }
    }
    if (u.pathname === '/auth/v1/signup') {
      if (users.has(b.email)) return json(422, { msg: 'User already registered' });
      const usr = addUser(b.email, b.password);
      return json(200, { id: usr.id, email: usr.email, confirmation_sent_at: new Date().toISOString() }); // confirm by email first
    }
    if (u.pathname === '/auth/v1/otp') return json(200, {});
    const uid = access.get((h.authorization || '').replace(/^Bearer /, ''));
    if (u.pathname === '/auth/v1/user') return uid ? json(200, { id: uid, email: userById(uid).email }) : json(401, { msg: 'invalid JWT' });
    if (u.pathname === '/auth/v1/logout') { access.delete((h.authorization || '').replace(/^Bearer /, '')); return json(204); }

    const m = /^\/rest\/v1\/(\w+)$/.exec(u.pathname);
    if (!m || !tables[m[1]]) return json(404, { message: 'not found' });
    if (!uid) return json(401, { message: 'JWT expired' });
    const t = m[1];
    const p = u.searchParams;
    const filters = [...p.entries()].filter(([k]) => !['select', 'order', 'limit', 'offset', 'on_conflict'].includes(k));
    const match = (r) => r.user_id === uid && filters.every(([k, v]) => {
      const [op, val] = [v.slice(0, v.indexOf('.')), v.slice(v.indexOf('.') + 1)];
      return op === 'eq' ? String(r[k]) === val : op === 'gt' ? r[k] > val : true;
    });
    const project = (r) => {
      const cols = (p.get('select') || '*').split(',');
      if (t === 'chain_connections' && (cols.includes('*') || cols.includes('secret_id'))) return null; // column grant
      return cols.includes('*') ? { ...r } : Object.fromEntries(cols.map((c) => [c, r[c]]));
    };
    if (method === 'GET') {
      let rows = tables[t].filter(match).sort((a, b) => (a.updated_at < b.updated_at ? -1 : a.updated_at > b.updated_at ? 1 : String(a.id) < String(b.id) ? -1 : 1));
      const off = Number(p.get('offset') || 0);
      rows = rows.slice(off, off + Number(p.get('limit') || 1000));
      const out = rows.map(project);
      if (out.includes(null)) return json(403, { code: '42501', message: 'permission denied for table chain_connections' });
      return json(200, out);
    }
    if (method === 'POST') {
      if (t === 'chain_connections') return json(403, { code: '42501', message: 'permission denied' });
      const out = [];
      for (const row of Array.isArray(b) ? b : [b]) {
        if (row.user_id && row.user_id !== uid) return json(403, { code: '42501', message: 'new row violates row-level security policy' });
        if (t === 'settings' && (row.data && ('sync' in row.data || /token/i.test(JSON.stringify(row.data))))) return json(400, { code: '23514', message: 'violates check constraint "settings_no_token"' });
        const key = t === 'settings' ? (r) => r.user_id === uid : (r) => r.user_id === uid && r.id === row.id;
        let r = tables[t].find(key);
        if (r) Object.assign(r, row, { user_id: uid, updated_at: tick() });
        else { r = { deleted: false, ...row, user_id: uid, updated_at: tick() }; tables[t].push(r); }
        out.push(project(r));
      }
      return json(201, out);
    }
    if (method === 'DELETE') {
      tables[t] = tables[t].filter((r) => !match(r));
      return json(204);
    }
    return json(405, { message: 'method not allowed' });
  }

  return { addUser, seed, remoteWrite, magicLinkToken, handle, tables, log, users };
}
