// Settings shape, validation and restore rules (pure, unit-tested).
export const DEFAULT_SYNC = { repo: '', path: 'spending.json', token: '', lastSync: null, lastTry: null, lastError: null };
// No personal defaults: every user points the app at their own private data repo (or none) in Mer.
// geo: first-run location flow. null = never asked, 'asked' = asked once without an answer (offer the button, don't
// prompt again), 'done' = area found or the user said no (then the default area is used).
export const defaultSettings = () => ({ chains: [], hiddenChains: [], area: null, geo: null, sync: { ...DEFAULT_SYNC } });
const GEO_STATES = new Set(['asked', 'done']);
const validGeo = (v) => (GEO_STATES.has(v) ? v : null);

const strings = (v) => (Array.isArray(v) ? v.filter((x) => typeof x === 'string' && x.length < 64) : []);
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/** A usable area {name, lat, lng, radius} or null (then the app uses its default area). */
export function validArea(a) {
  if (!a || typeof a !== 'object') return null;
  const lat = num(a.lat);
  const lng = num(a.lng);
  if (lat == null || lng == null || Math.abs(lat) > 90 || Math.abs(lng) > 180) return null;
  const radius = num(a.radius);
  return {
    name: typeof a.name === 'string' && a.name.trim() ? a.name.trim().slice(0, 60) : 'Eget område',
    lat, lng,
    radius: radius && radius > 0 && radius <= 100000 ? radius : 30000,
  };
}

function validSync(s) {
  const o = s && typeof s === 'object' ? s : {};
  const str = (v, d) => (typeof v === 'string' ? v : d);
  return {
    repo: str(o.repo, ''),
    path: str(o.path, DEFAULT_SYNC.path) || DEFAULT_SYNC.path,
    token: str(o.token, ''),
    lastSync: num(o.lastSync),
    lastTry: num(o.lastTry),
    lastError: typeof o.lastError === 'string' ? o.lastError : null,
  };
}

/**
 * Merge stored or restored settings into the current ones.
 * fromBackup: the sync block (repo, token, …) is device-local and always kept from `current`, so a restored or
 * shared backup can never point this device's token at another repo. Everything is type-checked, so a broken
 * file can't produce e.g. r_lat=undefined in the Tjek call.
 */
export function mergeSettings(current, incoming, { fromBackup = false } = {}) {
  const cur = current || defaultSettings();
  const inc = incoming && typeof incoming === 'object' ? incoming : {};
  return {
    ...cur,
    chains: 'chains' in inc ? strings(inc.chains) : strings(cur.chains),
    hiddenChains: 'hiddenChains' in inc ? strings(inc.hiddenChains) : strings(cur.hiddenChains),
    area: 'area' in inc ? validArea(inc.area) : validArea(cur.area),
    // Location permission is per device, like the sync key: a backup never changes it.
    geo: fromBackup || !('geo' in inc) ? validGeo(cur.geo) : validGeo(inc.geo),
    sync: fromBackup ? validSync(cur.sync) : validSync({ ...cur.sync, ...(inc.sync || {}) }),
  };
}
