// Amtrak provider. Schedules/fares are seed data (Amtrak has no public fare
// API); live train status comes free from the community Amtraker API.
import { loadJSON, fetchJSON, readSnapshot, writeSection } from '../util.js';
import { fill } from './frontier.js';

const ground = loadJSON('src/data/ground.json');
const sources = loadJSON('src/data/sources.json');
const airports = loadJSON('src/data/airports.json');

// Prefilled Amtrak booking link when both ends have Amtrak station codes.
export function amtrakLink(fromPlace, toPlace, date) {
  const o = airports.places[fromPlace]?.amtrakCode;
  const d = airports.places[toPlace]?.amtrakCode;
  if (!o || !d) return 'https://www.amtrak.com/tickets/departure.html';
  return fill(sources.deepLinks.amtrak, { origin: o, dest: d, date });
}

// Long-distance trains relevant to a west->east return.
const RELEVANT = [
  { match: /zephyr/i, id: 'zephyr' },
  { match: /southwest chief/i, id: 'sw-chief' },
  { match: /cardinal/i, id: 'cardinal' },
  { match: /capitol limited|floridian/i, id: 'floridian' },
  { match: /coast starlight/i, id: 'coast-starlight' },
  { match: /northeast regional/i, id: 'regional' },
];

export function trainLegs() {
  return ground.trainLegs;
}

export function liveStatus() {
  const snap = readSnapshot().sections.amtrak;
  return snap?.status === 'live' ? snap.data?.trains ?? [] : [];
}

export async function sync() {
  const res = await fetchJSON(sources.amtraker.trains, { timeoutMs: 20000 });
  if (!res.ok || typeof res.data !== 'object') {
    return writeSection('amtrak', {
      status: 'error',
      data: {},
      notes: `Amtraker unreachable (${res.status || res.error}). Seed schedules/fares still available.`,
    });
  }
  const trains = [];
  for (const list of Object.values(res.data)) {
    for (const t of Array.isArray(list) ? list : []) {
      const hit = RELEVANT.find((r) => r.match.test(t.routeName ?? ''));
      if (!hit) continue;
      trains.push({
        legId: hit.id,
        route: t.routeName,
        trainNum: t.trainNum,
        heading: t.heading,
        lastStation: t.eventName,
        status: t.trainState,
        minutesLate: typeof t.trainTimely === 'string' ? t.trainTimely : t.statusMsg ?? null,
      });
    }
  }
  return writeSection('amtrak', {
    status: 'live',
    data: { trains },
    notes: `Amtraker live: tracking ${trains.length} relevant trains (Zephyr, Chief, Cardinal, Chicago-DC, Regionals).`,
  });
}
