// Chain connections ("Koble til REMA") with a swappable LOGIN PROVIDER.
//
// The UI (Mer → Kjeder) only talks to a connection made by createConnection(chain, provider). The provider is the
// one platform-specific piece: how the chain's own login is started, where its tokens live, and how a sync is run.
//
//   Provider interface (all methods async, none may throw: problems come back as a Status):
//     id                    'mac-helper' (today: ingest/helper.py on 127.0.0.1) | 'unsupported' (phone in a browser)
//                           | later 'capacitor-ios' (in-app web login, tokens in the iPhone Keychain)
//     needsPairing          true when the UI must ask for a pairing code first (mac-helper only)
//     status(chainId)       → Status
//     pair(code)            → Status   (only if needsPairing) remember and check the code
//     login(chainId)        → Status   start the chain's OWN login (REMA's page; the user logs in, never us)
//     sync(chainId)         → Status   fetch receipts now and deliver them (Supabase account / private data repo)
//     disconnect(chainId)   → Status   forget the chain login on that device
//
//   Status = { state, syncing?: boolean, lastSync?: ISO string, lastSyncOk?: boolean, message?: string },
//            state ∈ STATES.
//
// A new provider (e.g. Capacitor on iOS) implements those methods and is returned by pickProvider(); the button,
// the states, the polling and the Supabase status stay as they are. Never put tokens in a Status.
import { macHelperProvider } from './mac-helper.js';

export const STATES = Object.freeze({
  UNSUPPORTED: 'unsupported', // this device can't do it (a phone in the browser): "Gjøres fra Mac-en"
  NOT_INSTALLED: 'not-installed', // the Mac helper doesn't answer
  NEEDS_PAIRING: 'needs-pairing', // helper answers, but we don't have (the right) pairing code
  DISCONNECTED: 'disconnected', // "Ikke koblet"
  CONNECTING: 'connecting', // login window open: "Kobler til …"
  CONNECTED: 'connected', // "Koblet"
  EXPIRED: 'expired', // "Utløpt"
  ERROR: 'error',
});

/** Phone or tablet browser (incl. iPadOS, which reports itself as a Mac with touch). */
export function isMobileDevice(nav = globalThis.navigator) {
  if (!nav) return false;
  const ua = nav.userAgent || '';
  return /iPhone|iPod|iPad|Android|Mobile/i.test(ua) || (/Macintosh/.test(ua) && (nav.maxTouchPoints || 0) > 1);
}

export const unsupportedProvider = () => {
  const st = async () => ({ state: STATES.UNSUPPORTED });
  return { id: 'unsupported', needsPairing: false, status: st, login: st, sync: st, disconnect: st };
};

/** The provider for this device. A native shell (window.Capacitor) would return its own provider here. */
export function pickProvider({ nav = globalThis.navigator, storage, fetchImpl } = {}) {
  if (isMobileDevice(nav)) return unsupportedProvider();
  return macHelperProvider({ storage, fetchImpl });
}

/**
 * One chain's connection: current status, and actions that update it. Polls the provider while a login or a sync
 * is running. onChange(status, prev) runs on every update; onSynced(status) when a sync has finished.
 */
export function createConnection(chain, provider, { onChange = () => {}, onSynced = () => {}, pollMs = 2000, loginTimeoutMs = 10 * 60e3, syncTimeoutMs = 30 * 60e3, timers = globalThis } = {}) {
  let status = { state: null, syncing: false };
  let timer = null;
  let pollUntil = 0;
  let syncAfterLogin = false;

  const safe = async (fn) => {
    try { return (await fn()) || { state: STATES.ERROR }; } catch { return { state: STATES.ERROR, message: 'Noe gikk galt. Prøv igjen.' }; }
  };
  const stopPolling = () => { if (timer) timers.clearTimeout(timer); timer = null; };
  const set = (s) => {
    const prev = status;
    status = { ...s, syncing: !!s.syncing };
    onChange(status, prev);
    if (prev.syncing && !status.syncing) onSynced(status);
    if (prev.state === STATES.CONNECTING && status.state === STATES.CONNECTED && syncAfterLogin) { syncAfterLogin = false; conn.sync(); }
    if ((status.state === STATES.CONNECTING || status.syncing) && Date.now() < pollUntil) {
      if (!timer) timer = timers.setTimeout(async () => { timer = null; set(await safe(() => provider.status(chain.id))); }, pollMs);
    } else if (status.state !== STATES.CONNECTING && !status.syncing) stopPolling();
    return status;
  };

  const conn = {
    chain,
    provider,
    get status() { return status; },
    refresh: async () => set(await safe(() => provider.status(chain.id))),
    pair: async (code) => set(await safe(() => provider.pair(code))),
    /** Opens the chain's own login. When it ends connected, the first sync starts by itself. */
    login: async ({ thenSync = true } = {}) => {
      pollUntil = Date.now() + loginTimeoutMs;
      syncAfterLogin = thenSync;
      return set(await safe(() => provider.login(chain.id)));
    },
    sync: async () => {
      pollUntil = Date.now() + syncTimeoutMs;
      return set(await safe(() => provider.sync(chain.id)));
    },
    disconnect: async () => { syncAfterLogin = false; return set(await safe(() => provider.disconnect(chain.id))); },
    stop: stopPolling,
  };
  return conn;
}
