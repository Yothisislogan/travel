import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

export const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const CACHE_DIR = path.join(ROOT, 'cache');

export function loadJSON(relPath) {
  return JSON.parse(readFileSync(path.join(ROOT, relPath), 'utf8'));
}

export function saveJSON(relPath, obj) {
  const abs = path.join(ROOT, relPath);
  mkdirSync(path.dirname(abs), { recursive: true });
  writeFileSync(abs, JSON.stringify(obj, null, 2));
}

// Minimal .env loader (no dependency). Existing process.env wins.
export function loadEnv() {
  const envPath = path.join(ROOT, '.env');
  if (!existsSync(envPath)) return;
  for (const line of readFileSync(envPath, 'utf8').split('\n')) {
    const m = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (!m || line.trim().startsWith('#')) continue;
    if (process.env[m[1]] === undefined || process.env[m[1]] === '') {
      process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
    }
  }
}

// Browser-like headers: several public APIs sit behind Cloudflare or similar,
// which can 403 obviously-scripted user agents while allowing normal traffic.
export const BROWSER_HEADERS = {
  'user-agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36',
  accept: 'application/json,text/html;q=0.9,*/*;q=0.8',
  'accept-language': 'en-US,en;q=0.9',
};

// fetch JSON with a hard timeout; returns { ok, status, data | error }.
export async function fetchJSON(url, { method = 'GET', headers = {}, body, timeoutMs = 15000 } = {}) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      method,
      headers: { accept: 'application/json', 'user-agent': 'gowild-trip-agent/1.0', ...headers },
      body,
      signal: ctrl.signal,
    });
    const text = await res.text();
    let data;
    try { data = JSON.parse(text); } catch { data = text; }
    return { ok: res.ok, status: res.status, data };
  } catch (err) {
    return { ok: false, status: 0, error: err.name === 'AbortError' ? 'timeout' : String(err.message || err) };
  } finally {
    clearTimeout(timer);
  }
}

// ---- geometry / flight-time estimation ----

const EARTH_RADIUS_MI = 3958.8;

export function haversineMiles(a, b) {
  const rad = (d) => (d * Math.PI) / 180;
  const dLat = rad(b.lat - a.lat);
  const dLon = rad(b.lon - a.lon);
  const s =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(rad(a.lat)) * Math.cos(rad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * EARTH_RADIUS_MI * Math.asin(Math.sqrt(s));
}

// Block-time estimate: taxi/climb overhead + cruise at ~460 mph ground speed.
export function estimateFlightHours(distanceMiles) {
  return +(0.6 + distanceMiles / 460).toFixed(2);
}

// ---- formatting ----

export function fmtHours(h) {
  if (h == null || Number.isNaN(h)) return '?';
  const totalMin = Math.round(h * 60);
  const hh = Math.floor(totalMin / 60);
  const mm = totalMin % 60;
  return mm === 0 ? `${hh}h` : `${hh}h${String(mm).padStart(2, '0')}m`;
}

export function fmtMoney(cost) {
  if (cost == null) return '?';
  if (typeof cost === 'number') return `$${Math.round(cost)}`;
  if (cost.min != null && cost.max != null) {
    return cost.min === cost.max ? `$${Math.round(cost.min)}` : `$${Math.round(cost.min)}-$${Math.round(cost.max)}`;
  }
  return '?';
}

export function costMidpoint(cost) {
  if (cost == null) return Infinity;
  if (typeof cost === 'number') return cost;
  if (cost.min != null && cost.max != null) return (cost.min + cost.max) / 2;
  return Infinity;
}

export function addCosts(a, b) {
  const lo = (c) => (typeof c === 'number' ? c : c?.min ?? 0);
  const hi = (c) => (typeof c === 'number' ? c : c?.max ?? 0);
  return { min: lo(a) + lo(b), max: hi(a) + hi(b) };
}

export function todayISO(tz = 'America/New_York') {
  return new Date().toLocaleDateString('en-CA', { timeZone: tz });
}

export function addDaysISO(iso, days) {
  const d = new Date(`${iso}T12:00:00Z`);
  d.setUTCDate(d.getUTCDate() + days);
  return d.toISOString().slice(0, 10);
}

// ---- cache snapshot ----

const SNAPSHOT_PATH = path.join(CACHE_DIR, 'snapshot.json');

export function readSnapshot() {
  try {
    return JSON.parse(readFileSync(SNAPSHOT_PATH, 'utf8'));
  } catch {
    return { sections: {} };
  }
}

export function writeSection(name, payload) {
  const snap = readSnapshot();
  snap.sections[name] = { ...payload, fetchedAt: new Date().toISOString() };
  mkdirSync(CACHE_DIR, { recursive: true });
  writeFileSync(SNAPSHOT_PATH, JSON.stringify(snap, null, 2));
  return snap.sections[name];
}

export function sectionAge(section) {
  if (!section?.fetchedAt) return null;
  return (Date.now() - Date.parse(section.fetchedAt)) / 3600000;
}

export function freshnessLabel(section, staleAfterHours = 6) {
  if (!section) return 'never synced';
  const age = sectionAge(section);
  const ageStr = age == null ? '' : age < 1 ? `${Math.round(age * 60)}m ago` : `${age.toFixed(1)}h ago`;
  const base = section.status === 'live' ? 'live' : section.status === 'error' ? 'seed (live fetch failed)' : 'seed estimates';
  const stale = age != null && age > staleAfterHours ? ', stale' : '';
  return `${base}, synced ${ageStr}${stale}`;
}
