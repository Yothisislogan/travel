// Miles/award backup options. Live availability via the Seats.aero Partner API
// when SEATS_AERO_API_KEY is set; otherwise seed program estimates + links to
// each program's award search.
import { loadJSON, fetchJSON, loadEnv, readSnapshot, writeSection, todayISO, addDaysISO } from '../util.js';

const seed = loadJSON('src/data/backup-flights.json');

const EAST_TARGETS = ['RIC', 'ORF', 'DCA', 'IAD', 'BWI', 'RDU'];

// Seats.aero Route.Source uses lowercase program ids; map them to the program
// names used in backup-flights.json.
const SEATS_AERO_PROGRAMS = {
  american: 'American AAdvantage',
  united: 'United MileagePlus',
  delta: 'Delta SkyMiles',
  alaska: 'Atmos Rewards',
  southwest: 'Southwest Rapid Rewards',
};

export function awardOptions(from) {
  const snap = readSnapshot().sections.awards;
  const live = snap?.status === 'live' ? snap.data?.availability ?? [] : [];
  const options = [];
  for (const to of EAST_TARGETS) {
    const m = seed.markets[`${from}-${to}`];
    if (!m?.typicalMiles) continue;
    for (const [program, miles] of Object.entries(m.typicalMiles)) {
      const liveHit = live.find((a) => a.from === from && a.to === to && a.program === program);
      options.push({
        mode: 'award',
        from,
        to,
        program,
        miles: liveHit?.miles ?? miles,
        feesUSD: { min: 6, max: 15 },
        dataStatus: liveHit ? 'live' : 'estimate',
        searchLink: seed.milesPrograms[program]?.searchLink,
        notes: seed.milesPrograms[program]?.notes,
      });
    }
  }
  options.sort((a, b) => a.miles - b.miles);
  return { from, closeInFees: seed.closeInFees, options };
}

export async function sync({ date } = {}) {
  loadEnv();
  const searchDate = date ?? addDaysISO(todayISO(), 1);
  const key = process.env.SEATS_AERO_API_KEY;
  if (!key) {
    return writeSection('awards', {
      status: 'seed',
      data: { searchDate },
      notes: 'No Seats.aero API key configured - using seed award estimates + program search links.',
    });
  }
  try {
    const availability = [];
    const errors = [];
    for (const from of ['LAS', 'SFO']) {
      const url = `https://seats.aero/partnerapi/search?origin_airport=${from}&destination_airport=${EAST_TARGETS.join('%2C')}&start_date=${searchDate}&end_date=${addDaysISO(searchDate, 2)}&cabin=economy`;
      const res = await fetchJSON(url, { headers: { 'Partner-Authorization': key }, timeoutMs: 20000 });
      if (!res.ok) {
        errors.push(`${from}: HTTP ${res.status}`);
        continue;
      }
      for (const item of res.data?.data ?? []) {
        if (item.YAvailable) {
          const source = (item.Route?.Source ?? '').toLowerCase();
          availability.push({
            from: item.Route?.OriginAirport ?? from,
            to: item.Route?.DestinationAirport,
            program: SEATS_AERO_PROGRAMS[source] ?? item.Route?.Source,
            source,
            miles: item.YMileageCost ? +item.YMileageCost : null,
            date: item.Date,
          });
        }
      }
    }
    return writeSection('awards', {
      status: availability.length ? 'live' : 'error',
      data: { searchDate, availability, errors },
      notes: `Seats.aero: ${availability.length} economy award hits near ${searchDate}.`,
    });
  } catch (err) {
    return writeSection('awards', {
      status: 'error',
      data: { searchDate },
      notes: `Seats.aero sync failed: ${err.message}. Using seed estimates.`,
    });
  }
}
