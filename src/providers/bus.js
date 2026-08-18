// Intercity bus provider. Greyhound has run on FlixBus's booking platform
// since 2023, so FlixBus's own search API covers both brands. It needs no key
// and no auth, so live bus fares work with zero setup - unlike Amtrak, which
// publishes no fare API at all (see docs/API-OPTIONS.md).
import { loadJSON, fetchJSON, writeSection, readSnapshot, todayISO, addDaysISO, BROWSER_HEADERS } from '../util.js';
import { fill } from './frontier.js';

const ground = loadJSON('src/data/ground.json');
const sources = loadJSON('src/data/sources.json');
const airports = loadJSON('src/data/airports.json');

export function busLegs() {
  return ground.busLegs;
}

export function busLink(fromPlace, toPlace, date) {
  const fromCity = airports.places[fromPlace]?.city?.split(',')[0] ?? fromPlace;
  const toCity = airports.places[toPlace]?.city?.split(',')[0] ?? toPlace;
  return fill(sources.flixbus.deepLink, { fromCity, toCity, date });
}

// Live fare for one leg, keyed by leg id, from the last sync.
export function liveFare(legId) {
  const snap = readSnapshot().sections.bus;
  if (snap?.status !== 'live') return null;
  return snap.data?.fares?.[legId] ?? null;
}

// FlixBus wants DD.MM.YYYY on the v4 search endpoint.
export function flixDate(iso) {
  const [y, m, d] = iso.split('-');
  return `${d}.${m}.${y}`;
}

// Tolerant parse of a v4 search response: pull the cheapest priced, available
// trip. Shapes vary between API versions, so accept several.
export function parseFlixTrips(data) {
  const trips = Array.isArray(data?.trips) ? data.trips : [];
  const candidates = [];
  for (const t of trips) {
    const results = t?.results;
    const list = Array.isArray(results) ? results : results && typeof results === 'object' ? Object.values(results) : [];
    for (const r of list) {
      const price = r?.price?.total ?? r?.price?.amount ?? r?.priceTotal ?? r?.total_price;
      const n = typeof price === 'string' ? parseFloat(price) : price;
      if (!Number.isFinite(n)) continue;
      const status = String(r?.status ?? r?.available ?? '').toLowerCase();
      if (status.includes('unavailable') || status.includes('sold')) continue;
      const durMin = r?.duration?.hours != null
        ? (+r.duration.hours) * 60 + (+(r.duration.minutes ?? 0))
        : Number.isFinite(+r?.duration) ? +r.duration / 60 : null;
      candidates.push({
        priceUSD: +n.toFixed(2),
        hours: durMin != null && Number.isFinite(durMin) ? +(durMin / 60).toFixed(2) : null,
        departure: r?.departure?.date ?? r?.departure ?? null,
        transfers: r?.transfer_type === 'direct' ? 0 : r?.transfers ?? null,
      });
    }
  }
  candidates.sort((a, b) => a.priceUSD - b.priceUSD);
  return candidates[0] ?? null;
}

async function flixCityId(name) {
  const base = sources.flixbus?.autocomplete ?? 'https://global.api.flixbus.com/search/autocomplete/cities';
  const res = await fetchJSON(`${base}?q=${encodeURIComponent(name)}&lang=en&country=US`, {
    headers: BROWSER_HEADERS,
    timeoutMs: 15000,
  });
  if (!res.ok) throw new Error(`autocomplete HTTP ${res.status}`);
  const list = Array.isArray(res.data) ? res.data : res.data?.cities ?? [];
  const hit = list.find((c) => c?.id || c?.uuid);
  if (!hit) throw new Error(`no city match for "${name}"`);
  return hit.id ?? hit.uuid;
}

async function flixSearch(fromId, toId, dateISO) {
  const base = sources.flixbus?.search ?? 'https://global.api.flixbus.com/search/service/v4/search';
  const url = `${base}?from_city_id=${encodeURIComponent(fromId)}&to_city_id=${encodeURIComponent(toId)}`
    + `&departure_date=${flixDate(dateISO)}&products=%7B%22adult%22%3A1%7D&currency=USD&locale=en_US`
    + '&search_by=cities&include_after_midnight_rides=1';
  const res = await fetchJSON(url, { headers: BROWSER_HEADERS, timeoutMs: 25000 });
  if (!res.ok) throw new Error(`search HTTP ${res.status}`);
  return parseFlixTrips(res.data);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export async function sync({ date } = {}) {
  const searchDate = date ?? addDaysISO(todayISO(), 1);
  const cityNames = sources.flixbus?.cityNames ?? {};
  const idCache = { ...(sources.flixbus?.cityIds ?? {}) };
  const fares = {};
  const errors = [];

  // Only price legs whose endpoints we can name to FlixBus.
  const legs = ground.busLegs.filter((l) => cityNames[l.from] && cityNames[l.to]);

  for (const leg of legs) {
    try {
      for (const code of [leg.from, leg.to]) {
        if (!idCache[code]) idCache[code] = await flixCityId(cityNames[code]);
      }
      const best = await flixSearch(idCache[leg.from], idCache[leg.to], searchDate);
      if (best) fares[leg.id] = best;
    } catch (err) {
      errors.push(`${leg.id}: ${err.message}`);
      // A blocked/unreachable network fails every leg the same way - stop early.
      if (/HTTP 4|HTTP 5|timeout|fetch failed/i.test(err.message) && errors.length >= 2) break;
    }
    await sleep(600);
  }

  const n = Object.keys(fares).length;
  return writeSection('bus', {
    status: n ? 'live' : 'seed',
    data: { searchDate, fares, cityIds: idCache, errors, legsPriced: n, legsTried: legs.length },
    notes: n
      ? `FlixBus/Greyhound live fares for ${searchDate}: ${n}/${legs.length} legs priced (no API key needed).`
      : `No live bus fares${errors.length ? ` (${errors[0]})` : ''} - using seed estimates + booking links.`,
  });
}
