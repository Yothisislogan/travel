// Backup cash flights (non-Frontier). Live prices, in order of preference:
//   1. SerpAPI google_flights (SERPAPI_KEY) - covers essentially ALL carriers
//      incl. AA/DL/Southwest/Breeze, which matter most for this backup plan.
//   2. Amadeus Self-Service (AMADEUS_CLIENT_ID/SECRET) - free tier, but its
//      content typically EXCLUDES AA, DL, Southwest, Breeze and LCCs, so
//      prices skew United-and-friends only.
//   3. Seed estimates + prefilled Google Flights/Kayak links.
import {
  loadJSON, fetchJSON, loadEnv, readSnapshot, writeSection, usableSection,
  haversineMiles, estimateFlightHours, todayISO, addDaysISO,
} from '../util.js';
import { fill } from './frontier.js';

const seed = loadJSON('src/data/backup-flights.json');
const sources = loadJSON('src/data/sources.json');
const airports = loadJSON('src/data/airports.json');

const EAST_TARGETS = ['RIC', 'ORF', 'DCA', 'IAD', 'BWI', 'RDU'];
const WEST_ORIGINS = ['LAS', 'SFO'];

function marketKey(from, to) {
  return `${from}-${to}`;
}

function estimateHours(from, to, nonstop) {
  const a = airports.places[from];
  const b = airports.places[to];
  if (!a || !b) return null;
  const direct = estimateFlightHours(haversineMiles(a, b));
  return +(nonstop ? direct : direct + 2.5).toFixed(2);
}

export function deepLinks(from, to, date) {
  return {
    googleFlights: fill(sources.deepLinks.googleFlights, { origin: from, dest: to, date }),
    kayak: fill(sources.deepLinks.kayak, { origin: from, dest: to, date }),
  };
}

// Options for one origin, merged live-over-seed.
export function backupCashOptions(from, date) {
  // A price fetched for another day is not this day's price. The planner has
  // always checked this; the backup card - the screen you actually buy from
  // when stranded - did not, so the two disagreed and the confident-looking
  // one was wrong.
  const sec = usableSection(readSnapshot().sections.flights);
  const searchDate = sec?.data?.searchDate ?? null;
  const dateMatches = !!date && searchDate === date;
  const live = dateMatches ? sec.data?.offers ?? {} : {};
  const options = [];
  for (const to of EAST_TARGETS) {
    const key = marketKey(from, to);
    const m = seed.markets[key];
    if (!m) continue;
    const liveOffer = live[key];
    options.push({
      mode: 'flight',
      from,
      to,
      nonstop: m.nonstop,
      airlines: m.airlines,
      costUSD: liveOffer ? { min: liveOffer.priceUSD, max: liveOffer.priceUSD } : m.typicalCashUSD,
      liveOffer: liveOffer ?? null,
      hours: liveOffer?.durationHours ?? estimateHours(from, to, m.nonstop),
      dataStatus: liveOffer ? 'live' : 'estimate',
      links: deepLinks(from, to, date),
    });
  }
  options.sort((a, b) => (a.costUSD.min + a.costUSD.max) - (b.costUSD.min + b.costUSD.max));
  return { from, date, options, positioningTips: seed.positioningTips };
}

// ---- Amadeus Self-Service ----

async function amadeusToken() {
  const base = process.env.AMADEUS_ENV === 'production'
    ? 'https://api.amadeus.com'
    : 'https://test.api.amadeus.com';
  const res = await fetchJSON(`${base}/v1/security/oauth2/token`, {
    method: 'POST',
    headers: { 'content-type': 'application/x-www-form-urlencoded' },
    body: new URLSearchParams({
      grant_type: 'client_credentials',
      client_id: process.env.AMADEUS_CLIENT_ID,
      client_secret: process.env.AMADEUS_CLIENT_SECRET,
    }).toString(),
  });
  if (!res.ok) throw new Error(`Amadeus auth failed (${res.status}): ${JSON.stringify(res.data).slice(0, 200)}`);
  return { token: res.data.access_token, base };
}

function isoDurationToHours(iso) {
  const m = /PT(?:(\d+)H)?(?:(\d+)M)?/.exec(iso ?? '');
  if (!m) return null;
  return +(((+m[1] || 0) + (+m[2] || 0) / 60)).toFixed(2);
}

async function amadeusSearch(auth, from, to, date) {
  const url = `${auth.base}/v2/shopping/flight-offers?originLocationCode=${from}&destinationLocationCode=${to}&departureDate=${date}&adults=1&currencyCode=USD&max=5&nonStop=false`;
  const res = await fetchJSON(url, { headers: { authorization: `Bearer ${auth.token}` }, timeoutMs: 20000 });
  if (!res.ok || !Array.isArray(res.data?.data) || res.data.data.length === 0) return null;
  const cheapest = res.data.data
    .map((o) => ({
      priceUSD: +o.price?.grandTotal,
      carrier: o.validatingAirlineCodes?.[0],
      durationHours: isoDurationToHours(o.itineraries?.[0]?.duration),
      stops: (o.itineraries?.[0]?.segments?.length ?? 1) - 1,
    }))
    .filter((o) => Number.isFinite(o.priceUSD))
    .sort((a, b) => a.priceUSD - b.priceUSD)[0];
  return cheapest ?? null;
}

// ---- SerpAPI google_flights ----
// departure_id/arrival_id accept COMMA-SEPARATED airport codes, and the whole
// multi-airport query is billed as ONE search. So all 11 of this trip's markets
// are priced in a single call instead of 11 - roughly 11x more syncs per quota.
// Each returned itinerary names its own airports, so results map back to their
// market; any market Google omits simply stays a seed estimate.

export function parseSerpFlights(data, { allowedMarkets = null } = {}) {
  const all = [...(data?.best_flights ?? []), ...(data?.other_flights ?? [])];
  const offers = {};
  for (const o of all) {
    const legs = Array.isArray(o?.flights) ? o.flights : [];
    if (!legs.length) continue;
    const from = legs[0]?.departure_airport?.id;
    const to = legs[legs.length - 1]?.arrival_airport?.id;
    const priceUSD = +o?.price;
    if (!from || !to || !Number.isFinite(priceUSD)) continue;
    const key = `${from}-${to}`;
    if (allowedMarkets && !allowedMarkets.has(key)) continue;
    if (offers[key] && offers[key].priceUSD <= priceUSD) continue;
    offers[key] = {
      priceUSD,
      carrier: legs[0]?.airline ?? null,
      durationHours: Number.isFinite(+o?.total_duration) ? +(+o.total_duration / 60).toFixed(2) : null,
      stops: legs.length - 1,
    };
  }
  return offers;
}

async function serpApiBatchSearch(origins, dests, date) {
  const url = 'https://serpapi.com/search.json?engine=google_flights'
    + `&departure_id=${origins.join('%2C')}&arrival_id=${dests.join('%2C')}`
    + `&outbound_date=${date}&type=2&currency=USD&hl=en&gl=us&api_key=${process.env.SERPAPI_KEY}`;
  const res = await fetchJSON(url, { timeoutMs: 30000 });
  if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);
  if (res.data?.error) throw new Error(`SerpAPI: ${res.data.error}`);
  const allowed = new Set(Object.keys(seed.markets));
  return parseSerpFlights(res.data, { allowedMarkets: allowed });
}

async function priceAllMarkets(searchOne) {
  const offers = {};
  const errors = [];
  for (const from of WEST_ORIGINS) {
    for (const to of EAST_TARGETS) {
      if (!seed.markets[marketKey(from, to)]) continue;
      try {
        const best = await searchOne(from, to);
        if (best) offers[marketKey(from, to)] = best;
      } catch (err) {
        errors.push(`${from}-${to}: ${err.message}`);
      }
    }
  }
  return { offers, errors };
}

export async function sync({ date } = {}) {
  loadEnv();
  const searchDate = date ?? addDaysISO(todayISO(), 1);

  if (process.env.SERPAPI_KEY) {
    let offers = {};
    const errors = [];
    try {
      offers = await serpApiBatchSearch(WEST_ORIGINS, EAST_TARGETS, searchDate);
    } catch (err) {
      errors.push(err.message);
    }
    const n = Object.keys(offers).length;
    return writeSection('flights', {
      status: n ? 'live' : 'error',
      data: { searchDate, offers, errors, source: 'serpapi', searchesUsed: 1 },
      notes: n
        ? `SerpAPI (Google Flights) for ${searchDate}: ${n} markets priced from 1 batched search (all carriers).`
        : `SerpAPI returned no priced markets for ${searchDate}${errors.length ? ` (${errors[0]})` : ''}. Using seed estimates.`,
    });
  }

  if (process.env.AMADEUS_CLIENT_ID && process.env.AMADEUS_CLIENT_SECRET) {
    try {
      const auth = await amadeusToken();
      const { offers, errors } = await priceAllMarkets((f, t) => amadeusSearch(auth, f, t, searchDate));
      return writeSection('flights', {
        status: Object.keys(offers).length ? 'live' : 'error',
        data: { searchDate, offers, errors, source: 'amadeus' },
        notes: `Amadeus live search for ${searchDate}: ${Object.keys(offers).length} markets priced. CAVEAT: Amadeus Self-Service typically excludes AA/Delta/Southwest/Breeze - cross-check the deep links.`,
      });
    } catch (err) {
      return writeSection('flights', {
        status: 'error',
        data: { searchDate },
        notes: `Amadeus sync failed: ${err.message}. Using seed estimates.`,
      });
    }
  }

  return writeSection('flights', {
    status: 'seed',
    data: { searchDate },
    notes: 'No SERPAPI_KEY or Amadeus keys configured (.env) - using seed estimates + deep links. SerpAPI covers all carriers; Amadeus free tier misses AA/DL/WN/Breeze.',
  });
}
