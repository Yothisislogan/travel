// Amtrak provider. Schedules/fares are seed data (Amtrak has no public fare
// API); live train status comes free from the community Amtraker API.
import { loadJSON, fetchJSON, readSnapshot, writeSection, BROWSER_HEADERS } from '../util.js';
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
  // Browser-like headers first; plain retry as fallback. Amtraker is an open
  // API, so a 403 nearly always means a middlebox (Cloudflare bot filter,
  // corporate proxy, VPN egress) rather than the API itself.
  let res = await fetchJSON(sources.amtraker.trains, { headers: BROWSER_HEADERS, timeoutMs: 20000 });
  if (!res.ok) {
    res = await fetchJSON(sources.amtraker.trains, { timeoutMs: 20000 });
  }
  if (!res.ok || typeof res.data !== 'object') {
    const why = res.status === 403
      ? 'blocked with 403 - likely a network proxy/VPN or bot filter on this connection; try another network. (The static dashboard fetches Amtraker from the browser and is unaffected.)'
      : `unreachable (${res.status || res.error})`;
    return writeSection('amtrak', {
      status: 'error',
      data: {},
      notes: `Amtraker ${why} Live train status is optional - seed schedules/fares still power the planner.`,
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
