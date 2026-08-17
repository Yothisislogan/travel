// Backup cash flights (non-Frontier). Live prices via the Amadeus Self-Service
// API when AMADEUS_CLIENT_ID/SECRET are configured; otherwise seed estimates
// plus prefilled Google Flights/Kayak links.
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

export async function sync({ date } = {}) {
  loadEnv();
  const searchDate = date ?? addDaysISO(todayISO(), 1);
  if (!process.env.AMADEUS_CLIENT_ID || !process.env.AMADEUS_CLIENT_SECRET) {
    return writeSection('flights', {
      status: 'seed',
      data: { searchDate },
      notes: 'No Amadeus keys configured (.env) - using seed estimates + deep links. Add free Self-Service keys for live prices.',
    });
  }
  try {
    const auth = await amadeusToken();
    const offers = {};
    const errors = [];
    for (const from of WEST_ORIGINS) {
      for (const to of EAST_TARGETS) {
        if (!seed.markets[marketKey(from, to)]) continue;
        try {
          const best = await amadeusSearch(auth, from, to, searchDate);
          if (best) offers[marketKey(from, to)] = best;
        } catch (err) {
          errors.push(`${from}-${to}: ${err.message}`);
        }
      }
    }
    return writeSection('flights', {
      status: Object.keys(offers).length ? 'live' : 'error',
      data: { searchDate, offers, errors },
      notes: `Amadeus live search for ${searchDate}: ${Object.keys(offers).length} markets priced.`,
    });
  } catch (err) {
    return writeSection('flights', {
      status: 'error',
      data: { searchDate },
      notes: `Amadeus sync failed: ${err.message}. Using seed estimates.`,
    });
  }
}
