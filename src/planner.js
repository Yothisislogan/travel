// Multimodal return planner: combines GoWild flights, backup cash flights,
// award flights, Amtrak, intercity bus, and local transit into complete
// itineraries from the west coast back to Richmond/Norfolk, sorted by total
// travel time then cost (or cost then time).
import { loadJSON, readSnapshot, haversineMiles, estimateFlightHours, costMidpoint, addCosts } from './util.js';
import { routeMap, gowildRules, searchLink, frequencyOf } from './providers/frontier.js';
import { deepLinks } from './providers/flights.js';
import { busLink } from './providers/bus.js';

const airports = loadJSON('src/data/airports.json');
const ground = loadJSON('src/data/ground.json');
const backup = loadJSON('src/data/backup-flights.json');
const config = loadJSON('trip.config.json');

// Assumed value of a mile/point when comparing award cost against cash.
export const CENTS_PER_MILE = 1.3;

const metroOf = {};
for (const [group, members] of Object.entries(airports.cityGroups)) {
  for (const m of members) metroOf[m] = group;
}
function metro(node) {
  return metroOf[node] ?? node;
}

function place(code) {
  return airports.places[code];
}

function flightHours(from, to) {
  const a = place(from);
  const b = place(to);
  return a && b ? estimateFlightHours(haversineMiles(a, b)) : null;
}

// ---- edge construction ----

export function buildEdges({ date, allowModes }) {
  const edges = [];
  const allow = new Set(allowModes ?? config.return.allowModes);
  const snapFlights = readSnapshot().sections.flights;
  const liveOffers = snapFlights?.status === 'live' ? snapFlights.data?.offers ?? {} : {};

  // GoWild flight edges: every nonstop in the route map, both directions.
  if (allow.has('gowild')) {
    const { routes } = routeMap();
    const seg = gowildRules().typicalCostPerSegmentUSD;
    const seen = new Set();
    for (const [from, dests] of Object.entries(routes)) {
      for (const to of dests) {
        for (const [a, b] of [[from, to], [to, from]]) {
          const key = `${a}>${b}`;
          if (seen.has(key) || !place(a) || !place(b)) continue;
          seen.add(key);
          const freq = frequencyOf(a, b);
          edges.push({
            mode: 'gowild',
            from: a,
            to: b,
            operator: freq?.days ? `Frontier GoWild (${freq.days})` : 'Frontier (GoWild pass)',
            hours: flightHours(a, b),
            costUSD: { min: seg.min, max: seg.max },
            daysPerWeek: freq?.daysPerWeek,
            dataStatus: 'estimate',
            bookLink: searchLink(a, b, date),
            notes: 'Bookable day before departure; availability capacity-controlled.',
          });
        }
      }
    }
  }

  // Backup cash flights (single ticket, connections baked in) from LAS/SFO.
  if (allow.has('flight')) {
    for (const [key, m] of Object.entries(backup.markets)) {
      const [from, to] = key.split('-');
      const live = liveOffers[key];
      edges.push({
        mode: 'flight',
        from,
        to,
        operator: live?.carrier ? `${live.carrier} (live)` : m.airlines[0],
        hours: live?.durationHours ?? +((flightHours(from, to) ?? 5) + (m.nonstop ? 0 : 2.5)).toFixed(2),
        costUSD: live ? { min: live.priceUSD, max: live.priceUSD } : m.typicalCashUSD,
        dataStatus: live ? 'live' : 'estimate',
        bookLink: deepLinks(from, to, date).googleFlights,
        notes: m.airlines.join(', '),
      });
    }
  }

  // Award flights: cheapest program per market.
  if (allow.has('award')) {
    for (const [key, m] of Object.entries(backup.markets)) {
      if (!m.typicalMiles) continue;
      const [from, to] = key.split('-');
      const [program, miles] = Object.entries(m.typicalMiles).sort((x, y) => x[1] - y[1])[0];
      // The program's airline may not operate the market's nonstop (e.g. Atmos
      // can't book Breeze) - only credit nonstop timing when it can.
      const awardNonstop = m.nonstopPrograms?.includes(program) ?? false;
      edges.push({
        mode: 'award',
        from,
        to,
        operator: `${program}`,
        hours: +((flightHours(from, to) ?? 5) + (awardNonstop ? 0 : 2.5)).toFixed(2),
        costUSD: { min: 6, max: 15 },
        miles,
        dataStatus: 'estimate',
        bookLink: backup.milesPrograms[program]?.searchLink,
        notes: `~${miles.toLocaleString()} miles + taxes`,
      });
    }
  }

  // Trains and buses (directional as encoded - eastbound legs).
  if (allow.has('train')) {
    for (const t of ground.trainLegs) {
      edges.push({ mode: 'train', from: t.from, to: t.to, operator: t.operator, hours: t.hours, costUSD: t.costUSD, dataStatus: 'estimate', bookLink: t.bookLink, notes: t.notes, daysPerWeek: t.daysPerWeek });
    }
  }
  if (allow.has('bus')) {
    for (const b of ground.busLegs) {
      edges.push({ mode: 'bus', from: b.from, to: b.to, operator: b.operator, hours: b.hours, costUSD: b.costUSD, dataStatus: 'estimate', bookLink: busLink(b.from, b.to, date), notes: b.notes, daysPerWeek: b.daysPerWeek });
    }
  }

  // Local transit links, both directions.
  if (allow.has('transit')) {
    for (const l of airports.localLinks) {
      for (const [a, b] of [[l.a, l.b], [l.b, l.a]]) {
        edges.push({ mode: 'transit', from: a, to: b, operator: l.how, hours: l.hours, costUSD: typeof l.costUSD === 'number' ? { min: l.costUSD, max: l.costUSD } : l.costUSD, dataStatus: 'estimate', notes: 'local transfer' });
      }
    }
  }

  return edges;
}

// Buffer added between two consecutive separately-booked legs.
export function transferBuffer(prevMode, nextMode) {
  const air = (m) => m === 'gowild' || m === 'flight' || m === 'award';
  if (prevMode === 'transit' || nextMode === 'transit') return 0.5;
  if (air(prevMode) && air(nextMode)) return 2.0;
  if (air(prevMode) || air(nextMode)) return 1.5;
  return 1.0;
}

const AIR = new Set(['gowild', 'flight', 'award']);

// ---- itinerary search ----

export function planReturn({ from = 'SFO', date, to = null, sort = 'time', maxLegs, maxResults, allowModes } = {}) {
  maxLegs = maxLegs ?? config.return.maxLegs;
  maxResults = maxResults ?? config.return.maxResults;

  const destGroups = to
    ? [metro(to)]
    : ['richmond', 'norfolk'];
  const destSet = new Set(destGroups.flatMap((g) => airports.cityGroups[g] ?? [g]));

  const edges = buildEdges({ date, allowModes });
  const byFrom = new Map();
  for (const e of edges) {
    if (e.hours == null) continue;
    if (!byFrom.has(e.from)) byFrom.set(e.from, []);
    byFrom.get(e.from).push(e);
  }

  const results = [];
  const startMetro = metro(from);

  function dfs(node, legs, hours, cost, miles, visitedMetros, visitedNodes) {
    if (destSet.has(node) && legs.length > 0) {
      // The path is complete the moment it reaches the destination metro.
      results.push(finishItinerary(legs, hours, cost, miles, node));
      return;
    }
    if (legs.length >= maxLegs) return;
    for (const e of byFrom.get(node) ?? []) {
      if (visitedNodes.has(e.to)) continue;
      const destMetro = metro(e.to);
      // Moving within the current metro is fine (e.g. SFO -> Emeryville for
      // the train); re-entering a metro we already left is not.
      if (destMetro !== metro(node) && visitedMetros.has(destMetro)) continue;
      const buffer = legs.length === 0 ? 0 : transferBuffer(legs[legs.length - 1].mode, e.mode);
      const nextLegs = [...legs, e];
      const nextHours = hours + buffer + e.hours;
      const nextCost = addCosts(cost, e.costUSD ?? 0);
      const nextMiles = miles + (e.miles ?? 0);
      dfs(e.to, nextLegs, nextHours, nextCost, nextMiles, new Set([...visitedMetros, destMetro]), new Set([...visitedNodes, e.to]));
    }
  }

  function finishItinerary(legs, hours, cost, miles, arrivalNode) {
    const arrivalMetro = metro(arrivalNode);
    const modes = [...new Set(legs.map((l) => l.mode))];
    const badges = [];
    if (legs.every((l) => l.mode === 'gowild' || l.mode === 'transit')) badges.push('all-GoWild');
    if (legs.some((l) => l.daysPerWeek && l.daysPerWeek < 7)) badges.push('not-daily');
    if (miles > 0) badges.push('uses-miles');
    const sortCost = costMidpoint(cost) + (miles * CENTS_PER_MILE) / 100;
    return {
      from,
      arrival: arrivalNode,
      arrivalMetro,
      legs,
      totalHours: +hours.toFixed(1),
      totalCostUSD: { min: Math.round(cost.min), max: Math.round(cost.max) },
      totalMiles: miles || 0,
      sortCost: Math.round(sortCost),
      modes,
      badges,
    };
  }

  dfs(from, [], 0, { min: 0, max: 0 }, 0, new Set([startMetro]), new Set([from]));

  // Rank: prefer fewer legs among near-identical totals; primary sort per flag.
  results.sort((a, b) =>
    sort === 'cost'
      ? a.sortCost - b.sortCost || a.totalHours - b.totalHours
      : a.totalHours - b.totalHours || a.sortCost - b.sortCost,
  );

  // Dedupe identical leg-sequences, then take the top N - but guarantee mode
  // diversity: even when flights sweep the top of the list, always surface the
  // best train-based and best bus-based itinerary as alternatives.
  const seen = new Set();
  const unique = [];
  for (const r of results) {
    const key = r.legs.map((l) => `${l.mode}:${l.from}>${l.to}`).join('|');
    if (seen.has(key)) continue;
    seen.add(key);
    unique.push(r);
  }
  const kept = unique.slice(0, maxResults);
  for (const mustHave of ['train', 'bus']) {
    if (!kept.some((it) => it.modes.includes(mustHave))) {
      const best = unique.find((it) => it.modes.includes(mustHave));
      if (best) kept.push(best);
    }
  }
  // Re-sort so diversity picks land in their proper ranked position.
  kept.sort((a, b) =>
    sort === 'cost'
      ? a.sortCost - b.sortCost || a.totalHours - b.totalHours
      : a.totalHours - b.totalHours || a.sortCost - b.sortCost,
  );
  return {
    from,
    date,
    sort,
    note: `Sorted by ${sort === 'cost' ? 'cost, then travel time' : 'total travel time, then cost'}. Award miles valued at ${CENTS_PER_MILE}c/mile for cost ranking. Times include transfer buffers, not overnight waits between separately-booked legs.`,
    itineraries: kept,
  };
}
