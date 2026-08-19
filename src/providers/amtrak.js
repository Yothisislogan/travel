// Amtrak provider. Schedules/fares are seed data (Amtrak has no public fare
// API); live train status comes free from the community Amtraker API.
import { loadJSON, fetchJSON, readSnapshot, writeSection, keepLastGood, usableSection, BROWSER_HEADERS } from '../util.js';
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
  const snap = usableSection(readSnapshot().sections.amtrak);
  return snap ? snap.data?.trains ?? [] : [];
}

// Amtrak reports lateness as prose ("12 minutes late", "2 hours, 5 minutes
// late", "On Time", "3 minutes early"). Returns minutes: + late, - early,
// 0 on time, null when unparseable.
export function parseDelayMinutes(text) {
  if (text == null) return null;
  const s = String(text).trim().toLowerCase();
  if (!s) return null;
  if (/on\s*time|ontime/.test(s)) return 0;
  const h = /(\d+)\s*hour/.exec(s);
  const m = /(\d+)\s*min/.exec(s);
  if (!h && !m) return null;
  const mins = (h ? +h[1] * 60 : 0) + (m ? +m[1] : 0);
  return /early/.test(s) ? -mins : mins;
}

function diffMinutes(sched, actual) {
  const a = Date.parse(sched || '');
  const b = Date.parse(actual || '');
  if (!Number.isFinite(a) || !Number.isFinite(b)) return null;
  return Math.round((b - a) / 60000);
}

// Authoritative delay for a stop, matching what Amtraker's own icon-colour math
// does: (estimated|actual) - scheduled. The prose fields (arrCmnt/depCmnt/
// trainTimely) are DEPRECATED in Amtraker v3 and always come back as empty
// strings, so they are not used - and note `||` not `??`, because "" is the
// empty case here, not null.
export function stationDelay(st) {
  return diffMinutes(st?.schArr || st?.schDep, st?.arr || st?.dep);
}

const isDeparted = (st) => /departed/i.test(String(st?.status ?? ''));

// A blocked IP is served a poisoned payload (a fake train 9997 "Error Train")
// rather than an HTTP error, so filter it or the UI shows nonsense.
export function isPoisonedTrain(t) {
  return String(t?.trainNum) === '9997' || /error train/i.test(String(t?.routeName ?? ''));
}

// Normalize one /v3/trains payload into the trains we care about, each with a
// delay in minutes and ETAs at the stations this trip actually uses.
export function parseAmtrakTrains(payload, watchStations = []) {
  const out = [];
  for (const list of Object.values(payload ?? {})) {
    for (const t of Array.isArray(list) ? list : []) {
      const hit = RELEVANT.find((r) => r.match.test(t?.routeName ?? ''));
      if (!hit || isPoisonedTrain(t)) continue;
      const stations = Array.isArray(t.stations) ? t.stations : [];
      // Headline delay = delay at the next stop the train hasn't reached yet,
      // which is how Amtraker itself decides a train's status. If it has
      // finished its run, use the last stop. (statusMsg is a last resort; a
      // not-yet-departed train reports arr == schArr, i.e. zero delay.)
      const nextStop = stations.find((s) => !isDeparted(s)) ?? stations[stations.length - 1];
      let delayMinutes = stationDelay(nextStop);
      if (delayMinutes == null) delayMinutes = parseDelayMinutes(t.statusMsg);
      out.push({
        legId: hit.id,
        route: t.routeName ?? null,
        trainNum: t.trainNum ?? null,
        heading: t.heading ?? null,
        status: t.trainState ?? null,
        statusText: t.trainTimely ?? t.statusMsg ?? null,
        delayMinutes,
        lastStation: t.eventName ?? null,
        stops: stations
          .filter((s) => watchStations.includes(s?.code))
          .map((s) => ({
            code: s.code,
            scheduled: s.schArr ?? s.schDep ?? null,
            estimated: s.arr ?? s.dep ?? null,
            delayMinutes: stationDelay(s),
            status: s.status ?? null,
          })),
      });
    }
  }
  return out;
}

// Median delay per route leg, so one badly-late train doesn't skew a route that
// runs several times a day (e.g. Northeast Regional).
export function delaysByLeg(trains) {
  const byLeg = {};
  for (const t of trains) {
    if (t.delayMinutes == null) continue;
    (byLeg[t.legId] ??= []).push(t.delayMinutes);
  }
  return Object.fromEntries(
    Object.entries(byLeg).map(([leg, arr]) => {
      const sorted = [...arr].sort((a, b) => a - b);
      const mid = Math.floor(sorted.length / 2);
      const median = sorted.length % 2 ? sorted[mid] : Math.round((sorted[mid - 1] + sorted[mid]) / 2);
      return [leg, { medianDelayMinutes: median, worstDelayMinutes: Math.max(...sorted), trainsTracked: sorted.length }];
    }),
  );
}

// Live delay for a train leg, from the last sync.
export function liveDelay(legId) {
  const snap = usableSection(readSnapshot().sections.amtrak);
  return snap?.data?.delays?.[legId] ?? null;
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
    // Delays from 20 minutes ago still beat no delays at all.
    const kept = keepLastGood('amtrak', `Amtraker ${why}`);
    if (kept) return kept;
    return writeSection('amtrak', {
      status: 'error',
      data: {},
      notes: `Amtraker ${why} Live train status is optional - seed schedules/fares still power the planner.`,
    });
  }
  // Stations this trip actually routes through - ETAs at these are what matter.
  const watch = ['EMY', 'LAX', 'CHI', 'WAS', 'CVS', 'RVR', 'NFK', 'KNG', 'ALX'];
  const trains = parseAmtrakTrains(res.data, watch);
  const delays = delaysByLeg(trains);
  const late = Object.values(delays).filter((d) => d.medianDelayMinutes >= 15).length;
  return writeSection('amtrak', {
    status: 'live',
    data: { trains, delays, watch },
    notes: `Amtraker live: ${trains.length} relevant trains tracked, ${Object.keys(delays).length} routes with delay data`
      + (late ? `, ${late} route(s) running 15min+ late - planner times adjusted.` : ', all near schedule.'),
  });
}
