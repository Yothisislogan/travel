// Backup cash flights (non-Frontier). Live prices, in order of preference:
//   1. SerpAPI google_flights (SERPAPI_KEY) - covers essentially ALL carriers
//      incl. AA/DL/Southwest/Breeze, which matter most for this backup plan.
//   2. Amadeus Self-Service (AMADEUS_CLIENT_ID/SECRET) - free tier, but its
//      content typically EXCLUDES AA, DL, Southwest, Breeze and LCCs, so
//      prices skew United-and-friends only.
//   3. Seed estimates + prefilled Google Flights/Kayak links.
import {
  loadJSON, fetchJSON, loadEnv, readSnapshot, writeSection,
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
  const snap = readSnapshot().sections.flights;
  const live = snap?.status === 'live' ? snap.data?.offers ?? {} : {};
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

async function serpApiSearch(from, to, date) {
  const url = `https://serpapi.com/search.json?engine=google_flights&departure_id=${from}&arrival_id=${to}&outbound_date=${date}&type=2&currency=USD&hl=en&api_key=${process.env.SERPAPI_KEY}`;
  const res = await fetchJSON(url, { timeoutMs: 25000 });
  if (!res.ok) throw new Error(`SerpAPI HTTP ${res.status}`);
  const all = [...(res.data?.best_flights ?? []), ...(res.data?.other_flights ?? [])];
  const cheapest = all
    .map((o) => ({
      priceUSD: +o.price,
      carrier: o.flights?.[0]?.airline,
      durationHours: o.total_duration ? +(o.total_duration / 60).toFixed(2) : null,
      stops: (o.flights?.length ?? 1) - 1,
    }))
    .filter((o) => Number.isFinite(o.priceUSD))
    .sort((a, b) => a.priceUSD - b.priceUSD)[0];
  return cheapest ?? null;
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
    const { offers, errors } = await priceAllMarkets((f, t) => serpApiSearch(f, t, searchDate));
    return writeSection('flights', {
      status: Object.keys(offers).length ? 'live' : 'error',
      data: { searchDate, offers, errors, source: 'serpapi' },
      notes: `SerpAPI (Google Flights) for ${searchDate}: ${Object.keys(offers).length} markets priced (all carriers).`,
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
