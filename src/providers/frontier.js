// Frontier / GoWild! provider.
// Live GoWild availability is not exposed via a public API (the booking site is
// bot-protected), so this provider: (1) probes reachability of the search page,
// (2) maintains the route map (seed, user-refreshable), (3) computes what is
// bookable *right now* under GoWild day-before rules, and (4) emits prefilled
// search deep links for the flights you should check in the app.
import {
  loadJSON, fetchJSON, readSnapshot, writeSection,
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

// Frontier's booking URL wants 'Aug 18, 2026'-style dates, not ISO.
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
export function frontierDate(iso) {
  const [y, m, d] = iso.split('-').map(Number);
  return `${MONTHS[m - 1]} ${d}, ${y}`;
}

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

// Decorate paths with booking-window state and deep links for a date.
export function gowildOptions(fromList, toList, dateISO) {
  const window = bookingWindow(dateISO);
  const blackout = isBlackout(dateISO);
  const checklist = readSnapshot().sections.frontier?.data?.checklist ?? [];
  const paths = findGowildPaths(fromList, toList).map((p) => {
    // Does every segment with named operating days run on this date's weekday?
    const segOps = p.segments.map((s) => operatesOn(frequencyOf(s.from, s.to)?.days, dateISO));
    const operatesOnDate = segOps.some((x) => x === false) ? false : segOps.every((x) => x === true) ? true : null;
    const live = checklist.find((c) => c.pair === `${p.from}-${p.to}` && c.date === dateISO && c.status === 'live');
    return {
      ...p,
      mode: 'gowild',
      operatesOnDate,
      dayOfWeek: dayOfWeek(dateISO),
      searchLink: searchLink(p.from, p.to, dateISO),
      live: live
        ? { gowildFlights: live.gowildFlights, flights: live.flights.filter((f) => f.gowildEnabled).slice(0, 6) }
        : null,
    };
  });
  return {
    date: dateISO,
    window,
    blackout,
    paths,
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

const HTML_ENTITIES = { '&quot;': '"', '&#34;': '"', '&amp;': '&', '&#38;': '&', '&lt;': '<', '&gt;': '>', '&#39;': "'" };
function unescapeHTML(s) {
  return s.replace(/&quot;|&#34;|&amp;|&#38;|&lt;|&gt;|&#39;/g, (m) => HTML_ENTITIES[m]);
}

// Extract the first balanced JSON array starting at text[start] === '['.
function balancedArray(text, start) {
  let depth = 0;
  let inStr = false;
  for (let i = start; i < text.length; i++) {
    const c = text[i];
    if (inStr) {
      if (c === '\\') i++;
      else if (c === '"') inStr = false;
    } else if (c === '"') inStr = true;
    else if (c === '[' || c === '{') depth++;
    else if (c === ']' || c === '}') {
      depth--;
      if (depth === 0) return text.slice(start, i + 1);
    }
  }
  return null;
}

// Parse GoWild flight data out of an InternalSelect response (HTML or JSON).
// Returns [] when the payload isn't found (blocked page, layout change).
export function parseGowildFlights(body) {
  if (typeof body !== 'string') body = JSON.stringify(body);
  let text = body.includes('&quot;') ? unescapeHTML(body) : body;
  const key = text.indexOf('"journeys"');
  if (key === -1) return [];
  const arrStart = text.indexOf('[', key);
  if (arrStart === -1) return [];
  const arr = balancedArray(text, arrStart);
  if (!arr) return [];
  let journeys;
  try {
    journeys = JSON.parse(arr);
  } catch {
    return [];
  }
  const flights = [];
  for (const j of Array.isArray(journeys) ? journeys : []) {
    for (const f of j?.flights ?? []) {
      flights.push({
        flightNumber: f.flightNumber ?? f.flightCode ?? null,
        departure: f.departureDate ?? f.std ?? null,
        arrival: f.arrivalDate ?? f.sta ?? null,
        stops: f.stopsText ?? (Array.isArray(f.legs) ? `${f.legs.length - 1} stop(s)` : null),
        duration: f.duration ?? null,
        gowildEnabled: !!f.isGoWildFareEnabled,
        goWildFare: f.goWildFare ?? null,
        goWildSeatsRemaining: f.goWildFareSeatsRemaining ?? null,
      });
    }
  }
  return flights;
}

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
