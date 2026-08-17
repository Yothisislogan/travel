// Frontier / GoWild! provider.
// Live GoWild availability is not exposed via a public API (the booking site is
// bot-protected), so this provider: (1) probes reachability of the search page,
// (2) maintains the route map (seed, user-refreshable), (3) computes what is
// bookable *right now* under GoWild day-before rules, and (4) emits prefilled
// search deep links for the flights you should check in the app.
import {
  loadJSON, fetchJSON, readSnapshot, writeSection,
  haversineMiles, estimateFlightHours, todayISO, addDaysISO,
} from '../util.js';

const rules = loadJSON('src/data/gowild.json');
const seedRoutes = loadJSON('src/data/frontier-routes.json');
const sources = loadJSON('src/data/sources.json');
const airports = loadJSON('src/data/airports.json');

export function gowildRules() {
  return rules;
}

export function routeMap() {
  const snap = readSnapshot().sections.frontier;
  return snap?.data?.routes ? { ...seedRoutes, ...snap.data } : seedRoutes;
}

export function fill(template, params) {
  return template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(params[k] ?? ''));
}

export function searchLink(origin, dest, date) {
  return fill(sources.frontier.deepLink, { origin, dest, date });
}

// Is `date` (ISO) bookable under GoWild right now? Domestic: opens the day
// before departure (Eastern time).
export function bookingWindow(dateISO) {
  const today = todayISO();
  const opensOn = addDaysISO(dateISO, -1);
  const canBookNow = today >= opensOn && today <= dateISO;
  return {
    date: dateISO,
    opensOn,
    canBookNow,
    note: canBookNow
      ? 'Inside the GoWild booking window - book now if a GoWild fare shows.'
      : today < opensOn
        ? `GoWild booking for ${dateISO} opens ${opensOn} (Eastern time).`
        : 'Date is in the past.',
  };
}

export function isBlackout(dateISO) {
  for (const b of rules.blackoutDates ?? []) {
    const [start, end] = b.range.split('/');
    if (dateISO >= start && dateISO <= end) return b;
  }
  return null;
}

function place(code) {
  return airports.places[code];
}

function flightLeg(from, to) {
  const a = place(from);
  const b = place(to);
  const miles = a && b ? haversineMiles(a, b) : null;
  return { from, to, distanceMiles: miles ? Math.round(miles) : null, hours: miles ? estimateFlightHours(miles) : null };
}

// Nonstop + one-stop Frontier paths between airport sets, from the route map.
export function findGowildPaths(fromList, toList, { maxConnections = 1 } = {}) {
  const { routes } = routeMap();
  const paths = [];
  for (const from of fromList) {
    const direct = routes[from] ?? [];
    for (const to of toList) {
      if (direct.includes(to)) {
        paths.push({ from, to, via: null, segments: [flightLeg(from, to)] });
      }
    }
    if (maxConnections >= 1) {
      for (const via of direct) {
        if (toList.includes(via)) continue;
        const onward = routes[via] ?? [];
        for (const to of toList) {
          if (to !== from && onward.includes(to)) {
            paths.push({ from, to, via, segments: [flightLeg(from, via), flightLeg(via, to)] });
          }
        }
      }
    }
  }
  // Total time: segments + 1.25h connection when there is a via.
  for (const p of paths) {
    const flying = p.segments.reduce((s, x) => s + (x.hours ?? 0), 0);
    p.totalHours = +(flying + (p.via ? 1.25 : 0)).toFixed(2);
    const seg = rules.typicalCostPerSegmentUSD;
    p.estCostUSD = { min: seg.min * p.segments.length, max: seg.max * p.segments.length };
  }
  paths.sort((x, y) => x.totalHours - y.totalHours);
  return paths;
}

// Decorate paths with booking-window state and deep links for a date.
export function gowildOptions(fromList, toList, dateISO) {
  const window = bookingWindow(dateISO);
  const blackout = isBlackout(dateISO);
  const paths = findGowildPaths(fromList, toList).map((p) => ({
    ...p,
    mode: 'gowild',
    searchLink: searchLink(p.from, p.to, dateISO),
  }));
  return { date: dateISO, window, blackout, paths, freshness: routeMap().asOf, warning: routeMap().freshnessWarning };
}

// Sync: probe the booking site (reachability only - honest about what a probe
// can prove) and record which trip pairs to check, with prefilled links for
// the next bookable day.
export async function sync({ date } = {}) {
  const checkDate = date ?? addDaysISO(todayISO(), 1);
  const pairs = [
    ['RIC', 'LAS'], ['ORF', 'LAS'], ['LAS', 'SFO'],
    ['SFO', 'RIC'], ['SFO', 'ORF'], ['LAS', 'RIC'], ['LAS', 'ORF'],
  ];
  const probes = [];
  for (const attempt of sources.frontier.attempts ?? []) {
    const url = fill(attempt.url, { origin: 'RIC', dest: 'LAS', date: checkDate });
    const res = await fetchJSON(url, { timeoutMs: 12000 });
    probes.push({ name: attempt.name, url, reachable: res.status > 0, httpStatus: res.status, notes: attempt.notes });
  }
  const reachable = probes.some((p) => p.reachable && p.httpStatus < 500);
  const checklist = pairs.map(([o, d]) => ({
    pair: `${o}-${d}`,
    date: checkDate,
    window: bookingWindow(checkDate),
    searchLink: searchLink(o, d, checkDate),
  }));
  return writeSection('frontier', {
    status: reachable ? 'live' : 'seed',
    data: { routes: seedRoutes.routes, asOf: seedRoutes.asOf, probes, checklist },
    notes: reachable
      ? 'Frontier site reachable. GoWild fares must be confirmed logged-in (site/app) - use the checklist links.'
      : 'Could not reach Frontier from here (offline/blocked). Using seed route map; use the checklist links from your own device.',
  });
}
