// Frontier / GoWild! provider.
// Live GoWild availability is not exposed via a public API (the booking site is
// bot-protected), so this provider: (1) probes reachability of the search page,
// (2) maintains the route map (seed, user-refreshable), (3) computes what is
// bookable *right now* under GoWild day-before rules, and (4) emits prefilled
// search deep links for the flights you should check in the app.
import {
  loadJSON, fetchJSON, readSnapshot, writeSection, keepLastGood,
  haversineMiles, estimateFlightHours, todayISO, addDaysISO, BROWSER_HEADERS,
} from '../util.js';

const rules = loadJSON('src/data/gowild.json');
const seedRoutes = loadJSON('src/data/frontier-routes.json');
const sources = loadJSON('src/data/sources.json');
const airports = loadJSON('src/data/airports.json');
const config = loadJSON('trip.config.json');

export function gowildRules() {
  return rules;
}

export function routeMap() {
  const snap = readSnapshot().sections.frontier;
  return snap?.data?.routes ? { ...seedRoutes, ...snap.data } : seedRoutes;
}

// Nonstops run both directions, but the data file lists each city's relevant
// destinations only once - symmetrize into a full adjacency map.
export function adjacency() {
  const adj = {};
  const add = (a, b) => {
    (adj[a] ??= new Set()).add(b);
    (adj[b] ??= new Set()).add(a);
  };
  for (const [from, dests] of Object.entries(routeMap().routes)) {
    for (const to of dests) add(from, to);
  }
  return Object.fromEntries(Object.entries(adj).map(([k, v]) => [k, [...v]]));
}

export function fill(template, params) {
  return template.replace(/\{(\w+)\}/g, (_, k) => encodeURIComponent(params[k] ?? ''));
}

// Date formatting and payload parsing live in ../gowild-parse.js, which has no
// Node dependencies so the edge relay (src/worker.js) can share them verbatim.
import { frontierDate, parseGowildFlights, summarizeGowild } from '../gowild-parse.js';
export { frontierDate, parseGowildFlights, summarizeGowild };

export function searchLink(origin, dest, date) {
  return fill(sources.frontier.deepLink, { origin, dest, date: frontierDate(date) });
}

// Days-per-week info for a nonstop, if known (checked in both directions).
export function frequencyOf(from, to) {
  const f = routeMap().frequencies ?? seedRoutes.frequencies ?? {};
  return f[`${from}-${to}`] ?? f[`${to}-${from}`] ?? null;
}

// Is `date` (ISO) bookable under GoWild right now? Domestic: opens the day
// before departure (Eastern time; community reports put inventory release
// around midnight ET, unofficially). Promo passes may allow advance booking -
// set trip.config.json gowild.promoAdvanceBookingThrough.
export function bookingWindow(dateISO) {
  const today = todayISO();
  const opensOn = addDaysISO(dateISO, -1);
  const promoThrough = config.gowild?.promoAdvanceBookingThrough ?? null;
  if (promoThrough && dateISO <= promoThrough && today <= dateISO) {
    return {
      date: dateISO,
      opensOn: today,
      canBookNow: true,
      promo: true,
      note: `Bookable NOW under your pass promo (advance booking through ${promoThrough}; early-booking fee may apply).`,
    };
  }
  const canBookNow = today >= opensOn && today <= dateISO;
  return {
    date: dateISO,
    opensOn,
    canBookNow,
    note: canBookNow
      ? 'Inside the GoWild booking window - book now if a GoWild fare shows.'
      : today < opensOn
        ? `GoWild booking for ${dateISO} opens ${opensOn} (Eastern time, ~midnight per community reports).`
        : 'Date is in the past.',
  };
}

const DAY_NAMES = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];
export function dayOfWeek(dateISO) {
  return DAY_NAMES[new Date(`${dateISO}T12:00:00Z`).getUTCDay()];
}

// true/false when the frequency data names weekdays, null when unknown.
export function operatesOn(freqDays, dateISO) {
  if (!freqDays) return null;
  const named = DAY_NAMES.filter((d) => freqDays.includes(d));
  if (!named.length) return null;
  return named.includes(dayOfWeek(dateISO));
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
  const routes = adjacency();
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
    const fees = rules.fareFeesUSD;
    const extra = p.segments.length - 1;
    p.estCostUSD = {
      min: fees.nonstop.min + fees.perExtraSegment.min * extra,
      max: fees.nonstop.max + fees.perExtraSegment.max * extra,
    };
    // Frequency: a path only works on days every segment operates.
    const freqs = p.segments.map((s) => frequencyOf(s.from, s.to)).filter(Boolean);
    if (freqs.length) {
      p.daysPerWeek = Math.min(...freqs.map((f) => f.daysPerWeek ?? 7));
      p.frequencyNote = freqs.map((f) => `${f.days}${f.note ? ` (${f.note})` : ''}`).join('; ');
    }
  }
  paths.sort((x, y) => x.totalHours - y.totalHours);
  return paths;
}

// Resolve live seat data SEGMENT BY SEGMENT.
//
// Matching a checklist entry on endpoints alone pasted the RIC-LAS nonstop's
// seat count onto RIC->DEN->LAS and RIC->MCO->LAS as well, so one flight with
// five seats rendered as three bookable options and fifteen seats. A connection
// is only confirmed when every one of its segments was actually searched, and
// its bookable count is the scarcest segment, not the sum.
export function liveForPath(path, checklist, dateISO) {
  const hit = (from, to) => checklist.find((c) => c.pair === `${from}-${to}` && c.date === dateISO && c.status === 'live');
  const segments = path.segments.map((s) => {
    const c = hit(s.from, s.to);
    if (!c) return { from: s.from, to: s.to, checked: false };
    return {
      from: s.from,
      to: s.to,
      checked: true,
      gowildFlights: c.gowildFlights,
      flights: (c.flights ?? []).filter((f) => f.gowildEnabled).slice(0, 6),
    };
  });
  const checked = segments.filter((s) => s.checked);
  if (!checked.length) return null;
  return {
    segments,
    complete: checked.length === segments.length,
    checkedSegments: checked.length,
    totalSegments: segments.length,
    // The whole path is only bookable as often as its scarcest checked segment.
    gowildFlights: Math.min(...checked.map((s) => s.gowildFlights)),
    // Only a nonstop can carry a flat flight list without implying a
    // connection nobody verified.
    flights: segments.length === 1 ? segments[0].flights : [],
  };
}

// Decorate paths with booking-window state and deep links for a date.
export function gowildOptions(fromList, toList, dateISO) {
  const window = bookingWindow(dateISO);
  const blackout = isBlackout(dateISO);
  const section = readSnapshot().sections.frontier;
  const checklist = section?.data?.checklist ?? [];
  const paths = findGowildPaths(fromList, toList).map((p) => {
    // Does every segment with named operating days run on this date's weekday?
    const segOps = p.segments.map((s) => operatesOn(frequencyOf(s.from, s.to)?.days, dateISO));
    const operatesOnDate = segOps.some((x) => x === false) ? false : segOps.every((x) => x === true) ? true : null;
    // On a blackout date the fee estimate is not the price: the Peak Day Charge
    // is what makes the date flyable at all, so fold it in per segment rather
    // than printing "$19-35" under a warning that says "+$79-159".
    const peak = blackout ? rules.peakDayChargeUSD ?? null : null;
    const estCostUSD = peak
      ? {
        min: p.estCostUSD.min + peak.min * p.segments.length,
        max: p.estCostUSD.max + peak.max * p.segments.length,
      }
      : p.estCostUSD;
    return {
      ...p,
      mode: 'gowild',
      operatesOnDate,
      estCostUSD,
      peakDayChargeUSD: peak,
      dayOfWeek: dayOfWeek(dateISO),
      searchLink: searchLink(p.from, p.to, dateISO),
      live: liveForPath(p, checklist, dateISO),
    };
  });
  return {
    date: dateISO,
    window,
    blackout,
    paths,
    // When the live seats were actually captured - not when the file was last
    // written. Renderers must show this next to any 'live' badge.
    capturedAt: paths.some((p) => p.live) ? section?.fetchedAt ?? null : null,
    dataStatus: section?.status ?? 'never',
    trackers: sources.frontier.communityTrackers ?? [],
    freshness: routeMap().asOf,
    warning: routeMap().freshnessWarning,
  };
}

// ---- live GoWild availability ----
// Frontier's own booking search (booking.flyfrontier.com/Flight/InternalSelect)
// embeds a JSON payload with per-flight GoWild fields - isGoWildFareEnabled,
// goWildFare, goWildFareSeatsRemaining - visible WITHOUT login. This is the
// same data community trackers (1491 Club, GoWilder, WildFares) poll at scale.
// We fetch it only for this trip's own pairs, at a polite pace, and fail
// honestly when bot protection blocks us. Note: automated access sits outside
// Frontier's ToS - keep usage personal and low-volume (see docs/API-OPTIONS.md).

const PAGE_HEADERS = { ...BROWSER_HEADERS, accept: 'text/html,application/xhtml+xml,application/json;q=0.9,*/*;q=0.8' };

export async function checkGowildAvailability(origin, dest, dateISO) {
  const url = searchLink(origin, dest, dateISO);
  const res = await fetchJSON(url, { headers: PAGE_HEADERS, timeoutMs: 20000 });
  if (res.status === 0) return { status: 'unreachable', url, flights: [] };
  if (res.status >= 400) return { status: 'blocked', httpStatus: res.status, url, flights: [] };
  const flights = parseGowildFlights(res.data);
  return { status: flights.length ? 'live' : 'no-data', httpStatus: res.status, url, flights };
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// Sync: pull live GoWild availability for this trip's own pairs (politely
// paced), falling back to a reachability report + checklist links when blocked.
export async function sync({ date } = {}) {
  const checkDate = date ?? addDaysISO(todayISO(), 1);
  const pairs = [
    ['RIC', 'LAS'], ['ORF', 'LAS'], ['LAS', 'SFO'],
    ['SFO', 'RIC'], ['SFO', 'ORF'], ['LAS', 'RIC'], ['LAS', 'ORF'],
  ];
  const checklist = [];
  let liveCount = 0;
  let blocked = false;
  let unreachable = false;
  for (const [o, d] of pairs) {
    const check = await checkGowildAvailability(o, d, checkDate);
    if (check.status === 'live') liveCount++;
    if (check.status === 'blocked') blocked = true;
    if (check.status === 'unreachable') unreachable = true;
    checklist.push({
      pair: `${o}-${d}`,
      date: checkDate,
      window: bookingWindow(checkDate),
      searchLink: check.url,
      status: check.status,
      flights: check.flights,
      gowildFlights: check.flights.filter((f) => f.gowildEnabled).length,
    });
    // Polite pacing between requests; stop hammering once clearly blocked.
    if (blocked || unreachable) break;
    await sleep(2000 + Math.floor(Math.random() * 2000));
  }
  // A block is the EXPECTED outcome from a datacenter IP, and it is exactly why
  // publish.js and worker.js exist - so don't let it delete seats we already
  // have. Only a run that actually saw fares may replace the section.
  if (liveCount === 0) {
    const kept = keepLastGood('frontier', blocked
      ? 'Frontier blocked this refresh (bot protection).'
      : unreachable
        ? 'Could not reach Frontier from here.'
        : 'Reached Frontier but found no fare data in the response.');
    if (kept) return kept;
  }
  return writeSection('frontier', {
    status: liveCount > 0 ? 'live' : 'seed',
    data: { routes: seedRoutes.routes, asOf: seedRoutes.asOf, checklist },
    notes: liveCount > 0
      ? `Live GoWild availability parsed for ${liveCount}/${pairs.length} pairs on ${checkDate}. Seats shown are goWildFareSeatsRemaining from Frontier's own search.`
      : blocked
        ? 'Frontier blocked the request (bot protection) - open the checklist links in your own browser; from a residential IP this usually works.'
        : unreachable
          ? 'Could not reach Frontier from here (offline/blocked network). Using seed route map; use the checklist links from your own device.'
          : 'Reached Frontier but could not find fare data in the response (page layout may have changed) - use the checklist links.',
  });
}
