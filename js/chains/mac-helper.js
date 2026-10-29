// Login provider "mac-helper": the Matkassa helper on this Mac (mattilbud-app/ingest/helper.py, launchd) on
// http://127.0.0.1:47321. It runs `rema auth login` (REMA's own login page in the browser) and ingest/sync.sh.
// See ./index.js for the provider interface.
//
// Pairing: the helper only answers requests that carry its pairing code ("python3 ingest/helper.py pair"). The code
// is kept in localStorage on this device only: not in backups, not in the account, never sent anywhere but 127.0.0.1.
// Until the user taps "Koble til REMA" (or has paired before) nothing is sent to 127.0.0.1 at all, so people who never
// use it get no local-network prompt from the browser.
const KEY = 'matkassa.helperPairing';
export const HELPER_URL = 'http://127.0.0.1:47321';

const store = (s) => {
  try { return s || globalThis.localStorage || null; } catch { return null; }
};

export function macHelperProvider({ base = HELPER_URL, storage, fetchImpl, timeoutMs = 4000 } = {}) {
  const ls = store(storage);
  const doFetch = fetchImpl || ((...a) => globalThis.fetch(...a));
  const getCode = () => { try { return (ls && ls.getItem(KEY)) || ''; } catch { return ''; } };
  let engaged = !!getCode();
  const setCode = (c) => { try { c ? ls.setItem(KEY, c) : ls.removeItem(KEY); } catch { /* private mode: ask again next time */ } };

  async function call(method, path, code = getCode()) {
    if (!code) {
      // No code yet: still check that the helper is there, so the UI can tell "install" from "pair".
      try { await doFetch(base + '/status', { method: 'GET', signal: AbortSignal.timeout(timeoutMs) }); } catch { return { state: 'not-installed' }; }
      return { state: 'needs-pairing' };
    }
    let res;
    try {
      res = await doFetch(base + path, { method, headers: { Authorization: `Bearer ${code}` }, signal: AbortSignal.timeout(timeoutMs) });
    } catch {
      return { state: 'not-installed' };
    }
    if (res.status === 401) return { state: 'needs-pairing', message: 'Koden stemmer ikke. Kjør «python3 ingest/helper.py pair» på Mac-en og lim inn koden.' };
    if (res.status === 429) return { state: 'needs-pairing', message: 'For mange feil koder. Vent ett minutt og prøv igjen.' };
    let j = null;
    try { j = await res.json(); } catch { /* not the helper */ }
    if (!j || j.helper !== 'matkassa' || !j.rema) return { state: 'error', message: 'Fikk et uventet svar fra hjelperen på Mac-en.' };
    const r = j.rema;
    return { state: r.state, syncing: !!j.syncing, lastSync: r.lastSync || null, lastSyncOk: r.lastSyncOk ?? null, message: r.message || null };
  }

  return {
    id: 'mac-helper',
    needsPairing: true,
    status: () => (engaged || getCode() ? call('GET', '/status') : Promise.resolve({ state: 'disconnected' })),
    async pair(code) {
      engaged = true;
      const c = String(code || '').toUpperCase().replace(/[^A-Z0-9]/g, '');
      if (c.length < 12) return { state: 'needs-pairing', message: 'Koden ser ikke riktig ut. Den har fire grupper med fire tegn.' };
      const s = await call('GET', '/status', c);
      if (s.state !== 'needs-pairing' && s.state !== 'not-installed' && s.state !== 'error') setCode(c);
      return s;
    },
    unpair: () => setCode(''),
    login: (chainId) => { engaged = true; return call('POST', `/${chainId}/login`); },
    sync: () => call('POST', '/sync'),
    disconnect: (chainId) => call('POST', `/${chainId}/logout`),
  };
}
