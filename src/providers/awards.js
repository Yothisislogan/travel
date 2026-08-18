// Miles/award backup options. Live availability from any configured source,
// merged: Seats.aero Partner API (SEATS_AERO_API_KEY) and/or the Apify
// flight-award-scraper actor (APIFY_TOKEN). With neither, seed program
// estimates + links to each program's award search.
import { loadJSON, fetchJSON, loadEnv, readSnapshot, writeSection, todayISO, addDaysISO } from '../util.js';

const seed = loadJSON('src/data/backup-flights.json');
const sources = loadJSON('src/data/sources.json');

const EAST_TARGETS = ['RIC', 'ORF', 'DCA', 'IAD', 'BWI', 'RDU'];

// Normalize any program/airline string to the display names used in
// backup-flights.json, so live hits from any source match the seed markets.
const PROGRAM_ALIASES = {
  american: 'American AAdvantage', aa: 'American AAdvantage', aadvantage: 'American AAdvantage', 'american airlines': 'American AAdvantage',
  united: 'United MileagePlus', ua: 'United MileagePlus', mileageplus: 'United MileagePlus', 'united airlines': 'United MileagePlus',
  delta: 'Delta SkyMiles', dl: 'Delta SkyMiles', skymiles: 'Delta SkyMiles', 'delta air lines': 'Delta SkyMiles',
  southwest: 'Southwest Rapid Rewards', wn: 'Southwest Rapid Rewards', 'rapid rewards': 'Southwest Rapid Rewards',
  alaska: 'Atmos Rewards', as: 'Atmos Rewards', atmos: 'Atmos Rewards', 'mileage plan': 'Atmos Rewards', 'alaska mileage plan': 'Atmos Rewards', 'atmos rewards': 'Atmos Rewards',
};
export function normalizeProgram(s) {
  const k = String(s ?? '').trim().toLowerCase();
  return PROGRAM_ALIASES[k] ?? s;
}

const pick = (obj, keys) => {
  for (const k of keys) if (obj?.[k] != null && obj[k] !== '') return obj[k];
  return null;
};
const toInt = (v) => {
  if (v == null) return null;
  const n = parseInt(String(v).replace(/[^0-9]/g, ''), 10);
  return Number.isFinite(n) ? n : null;
};

export function awardOptions(from) {
  const snap = readSnapshot().sections.awards;
  const live = snap?.status === 'live' ? snap.data?.availability ?? [] : [];
  const options = [];
  for (const to of EAST_TARGETS) {
    const m = seed.markets[`${from}-${to}`];
    if (!m?.typicalMiles) continue;
    for (const [program, miles] of Object.entries(m.typicalMiles)) {
      // Cheapest live hit for this exact market+program across all sources.
      const hits = live.filter((a) => a.from === from && a.to === to && a.program === program && a.miles != null);
      const best = hits.sort((a, b) => a.miles - b.miles)[0];
      options.push({
        mode: 'award',
        from,
        to,
        program,
        miles: best?.miles ?? miles,
        feesUSD: { min: 6, max: 15 },
        dataStatus: best ? 'live' : 'estimate',
        source: best?.source ?? null,
        seats: best?.seats ?? null,
        searchLink: seed.milesPrograms[program]?.searchLink,
        notes: seed.milesPrograms[program]?.notes,
      });
    }
  }
  options.sort((a, b) => a.miles - b.miles);
  return { from, closeInFees: seed.closeInFees, options };
}

// ---- Seats.aero ----
const SEATS_AERO_PROGRAMS = {
  american: 'American AAdvantage', united: 'United MileagePlus', delta: 'Delta SkyMiles',
  alaska: 'Atmos Rewards', southwest: 'Southwest Rapid Rewards',
};

async function fetchSeatsAero(key, searchDate) {
  const availability = [];
  const errors = [];
  for (const from of ['LAS', 'SFO']) {
    const url = `https://seats.aero/partnerapi/search?origin_airport=${from}&destination_airport=${EAST_TARGETS.join('%2C')}&start_date=${searchDate}&end_date=${addDaysISO(searchDate, 2)}&cabin=economy`;
    const res = await fetchJSON(url, { headers: { 'Partner-Authorization': key }, timeoutMs: 20000 });
    if (!res.ok) { errors.push(`seats.aero ${from}: HTTP ${res.status}`); continue; }
    for (const item of res.data?.data ?? []) {
      if (item.YAvailable) {
        const src = (item.Route?.Source ?? '').toLowerCase();
        availability.push({
          from: item.Route?.OriginAirport ?? from,
          to: item.Route?.DestinationAirport,
          program: SEATS_AERO_PROGRAMS[src] ?? item.Route?.Source,
          source: 'seats.aero',
          miles: toInt(item.YMileageCost),
          seats: null,
          date: item.Date,
        });
      }
    }
  }
  return { availability, errors };
}

// ---- Apify flight-award-scraper ----
// Uses the actor's run-sync-get-dataset-items endpoint: one authenticated POST
// per origin/destination pair returns the dataset rows directly as JSON. The
// input field names live in sources.json (apify.inputTemplate) so they can be
// corrected without code changes if the actor's schema differs. Output is
// parsed tolerantly across common field-name variants.
function buildApifyInput(template, { origin, destination, startDate, endDate }) {
  const vars = { origin, destination, startDate, endDate };
  const out = {};
  for (const [k, v] of Object.entries(template)) {
    out[k] = typeof v === 'string' ? v.replace(/\{(\w+)\}/g, (_, name) => vars[name] ?? v) : v;
  }
  return out;
}

export function parseApifyRows(rows) {
  const out = [];
  for (const item of Array.isArray(rows) ? rows : []) {
    const cabin = String(pick(item, ['cabin', 'cabinClass', 'class', 'fareClass']) ?? 'economy').toLowerCase();
    // Keep economy (or unlabeled) rows to match the backup section's framing.
    if (cabin && !/econ|coach|main|^y$|basic|standard/.test(cabin)) continue;
    const from = pick(item, ['origin', 'from', 'originAirport', 'departureAirport', 'fromAirport', 'originCode']);
    const to = pick(item, ['destination', 'to', 'destinationAirport', 'arrivalAirport', 'toAirport', 'destinationCode']);
    const program = normalizeProgram(pick(item, ['program', 'source', 'issuer', 'loyaltyProgram', 'mileageProgram', 'frequentFlyerProgram', 'airline']));
    const miles = toInt(pick(item, ['miles', 'mileageCost', 'points', 'mileage', 'pointsCost', 'award', 'awardMiles']));
    const seats = toInt(pick(item, ['seats', 'seatsRemaining', 'remainingSeats', 'availableSeats', 'seatsAvailable']));
    const date = pick(item, ['date', 'departureDate', 'departDate', 'flightDate', 'departure']);
    if (!from || !to) continue;
    out.push({ from: String(from).toUpperCase().slice(0, 3), to: String(to).toUpperCase().slice(0, 3), program, source: 'apify', miles, seats, date });
  }
  return out;
}

async function fetchApify(token, searchDate) {
  const cfg = sources.apify ?? {};
  const endpoint = (cfg.endpoint ?? 'https://api.apify.com/v2/acts/{actor}/run-sync-get-dataset-items')
    .replace('{actor}', cfg.actor ?? 'igolaizola~flight-award-scraper');
  const url = `${endpoint}?token=${encodeURIComponent(token)}`;
  const endDate = addDaysISO(searchDate, cfg.dateWindowDays ?? 2);
  const dests = (cfg.destinations ?? EAST_TARGETS).slice(0, cfg.maxDestinations ?? 6);
  const origins = cfg.origins ?? ['LAS', 'SFO'];
  const availability = [];
  const errors = [];
  let runs = 0;
  const maxRuns = cfg.maxRuns ?? 8; // bound Apify usage per sync
  for (const origin of origins) {
    for (const destination of dests) {
      if (runs >= maxRuns) break;
      runs++;
      const input = buildApifyInput(cfg.inputTemplate ?? { origin: '{origin}', destination: '{destination}', startDate: '{startDate}', endDate: '{endDate}', cabin: 'economy' }, { origin, destination, startDate: searchDate, endDate });
      const res = await fetchJSON(url, { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(input), timeoutMs: 90000 });
      if (!res.ok) { errors.push(`apify ${origin}-${destination}: HTTP ${res.status}`); continue; }
      availability.push(...parseApifyRows(res.data));
    }
  }
  return { availability, errors, runs };
}

export async function sync({ date } = {}) {
  loadEnv();
  const searchDate = date ?? addDaysISO(todayISO(), 1);
  const seatsKey = process.env.SEATS_AERO_API_KEY;
  const apifyToken = process.env.APIFY_TOKEN;

  if (!seatsKey && !apifyToken) {
    return writeSection('awards', {
      status: 'seed',
      data: { searchDate },
      notes: 'No SEATS_AERO_API_KEY or APIFY_TOKEN configured - using seed award estimates + program search links.',
    });
  }

  const availability = [];
  const errors = [];
  const used = [];
  try {
    if (seatsKey) {
      const r = await fetchSeatsAero(seatsKey, searchDate);
      availability.push(...r.availability); errors.push(...r.errors); used.push('Seats.aero');
    }
    if (apifyToken) {
      const r = await fetchApify(apifyToken, searchDate);
      availability.push(...r.availability); errors.push(...r.errors); used.push(`Apify (${r.runs} runs)`);
    }
    return writeSection('awards', {
      status: availability.length ? 'live' : (errors.length ? 'error' : 'seed'),
      data: { searchDate, availability, errors, sources: used },
      notes: availability.length
        ? `${used.join(' + ')}: ${availability.length} economy award hits near ${searchDate}.`
        : `${used.join(' + ')} returned no matches near ${searchDate}${errors.length ? ` (${errors.slice(0, 2).join('; ')})` : ''}. Using seed estimates.`,
    });
  } catch (err) {
    return writeSection('awards', {
      status: 'error',
      data: { searchDate, errors },
      notes: `Award sync failed: ${err.message}. Using seed estimates.`,
    });
  }
}
