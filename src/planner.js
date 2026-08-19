// Multimodal return planner: combines GoWild flights, backup cash flights,
// award flights, Amtrak, intercity bus, and local transit into complete
// itineraries from the west coast back to Richmond/Norfolk, sorted by total
// travel time then cost (or cost then time).
import { loadJSON, readSnapshot, haversineMiles, estimateFlightHours, costMidpoint, addCosts, addDaysISO } from './util.js';
import { routeMap, gowildRules, searchLink, frequencyOf, operatesOn, isBlackout, dayOfWeek } from './providers/frontier.js';
import { deepLinks } from './providers/flights.js';
import { busLink, liveFare } from './providers/bus.js';
import { amtrakLink, liveDelay } from './providers/amtrak.js';

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
  const snap = readSnapshot();
  const snapFlights = snap.sections.flights;
  // Only treat synced prices as live for the date they were actually searched -
  // a price fetched for another day is an estimate, not this itinerary's price.
  const liveOffers = snapFlights?.status === 'live' && snapFlights.data?.searchDate === date
    ? snapFlights.data?.offers ?? {}
    : {};
  // Live GoWild fares captured by the Frontier check, keyed pair+date.
  const gowildLive = {};
  for (const c of snap.sections.frontier?.data?.checklist ?? []) {
    if (c.status !== 'live' || c.date !== date) continue;
    const fares = (c.flights ?? []).filter((f) => f.gowildEnabled && f.goWildFare != null).map((f) => +f.goWildFare);
    if (fares.length) gowildLive[c.pair] = { fare: Math.min(...fares), seats: (c.flights ?? []).find((f) => f.gowildEnabled)?.goWildSeatsRemaining ?? null };
  }

  // GoWild flight edges: every nonstop in the route map, both directions.
  if (allow.has('gowild')) {
    const { routes } = routeMap();
    // Each planner gowild edge is its own one-way booking -> nonstop fees.
    const seg = gowildRules().fareFeesUSD.nonstop;
    // Since 2026 a blackout is not a wall, it is a price: the Peak Day Charge
    // unlocks the date. Ignoring it made blackout itineraries look 6-10x cheaper
    // than they are, and win the cost sort on exactly the dates where cost
    // matters most.
    const blackout = isBlackout(date);
    const peak = blackout ? gowildRules().peakDayChargeUSD ?? { min: 79, max: 159 } : null;
    const seen = new Set();
    for (const [from, dests] of Object.entries(routes)) {
      for (const to of dests) {
        for (const [a, b] of [[from, to], [to, from]]) {
          const key = `${a}>${b}`;
          if (seen.has(key) || !place(a) || !place(b)) continue;
          seen.add(key);
          const freq = frequencyOf(a, b);
          const live = gowildLive[`${a}-${b}`];
          const base = live ? { min: live.fare, max: live.fare } : { min: seg.min, max: seg.max };
          // A route that has not launched yet cannot be flown on this date, no
          // matter what its days-per-week says.
          const notLaunched = !!(freq?.startsOn && date < freq.startsOn);
          edges.push({
            mode: 'gowild',
            from: a,
            to: b,
            operator: freq?.days ? `Frontier GoWild (${freq.days})` : 'Frontier (GoWild pass)',
            hours: flightHours(a, b),
            costUSD: peak ? addCosts(base, peak) : base,
            seedCostUSD: peak ? addCosts({ min: seg.min, max: seg.max }, peak) : { min: seg.min, max: seg.max },
            daysPerWeek: freq?.daysPerWeek,
            // false = this route definitively does not fly on this weekday.
            operatesOnDate: notLaunched ? false : operatesOn(freq?.days, date),
            notLaunchedUntil: notLaunched ? freq.startsOn : null,
            peakDayChargeUSD: peak,
            dataStatus: live ? 'live' : 'estimate',
            seatsRemaining: live?.seats ?? null,
            bookLink: searchLink(a, b, date),
            notes: notLaunched
              ? `Route does not start until ${freq.startsOn}.`
              : peak
                ? `${blackout.label}: blackout date - flyable only with the Peak Day Charge ($${peak.min}-$${peak.max}), included above.`
                : 'Bookable day before departure; availability capacity-controlled.',
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
      // A twice-weekly Breeze nonstop was being credited full nonstop block time
      // on every date, so it swept rank 1 on the five days a week it doesn't
      // fly. Carry the frequency so those itineraries can be marked and ranked
      // behind ones that actually operate.
      const perWeek = m.nonstopDaysPerWeek ?? null;
      edges.push({
        mode: 'flight',
        from,
        to,
        operator: live?.carrier ? `${live.carrier} (live)` : m.airlines[0],
        hours: live?.durationHours ?? +((flightHours(from, to) ?? 5) + (m.nonstop ? 0 : 2.5)).toFixed(2),
        costUSD: live ? { min: live.priceUSD, max: live.priceUSD } : m.typicalCashUSD,
        seedCostUSD: m.typicalCashUSD,
        daysPerWeek: m.nonstop ? perWeek ?? undefined : undefined,
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
      // Amtrak long-distance trains routinely run late; when live status shows
      // a delay on this route, add it to the leg so the ranking is realistic.
      const d = liveDelay(t.id);
      const delayH = d && Number.isFinite(d.medianDelayMinutes) ? d.medianDelayMinutes / 60 : 0;
      edges.push({
        mode: 'train',
        from: t.from,
        to: t.to,
        operator: delayH > 0.25 ? `${t.operator} (running ~${Math.round(delayH * 60)}m late)` : t.operator,
        hours: +(t.hours + Math.max(0, delayH)).toFixed(2),
        scheduledHours: t.hours,
        delayMinutes: d?.medianDelayMinutes ?? null,
        costUSD: t.costUSD,
        // The TIME is live even though the FARE is still an estimate.
        dataStatus: 'estimate',
        timeStatus: d ? 'live' : 'scheduled',
        bookLink: amtrakLink(t.from, t.to, date),
        notes: t.notes,
        daysPerWeek: t.daysPerWeek,
      });
    }
  }
  if (allow.has('bus')) {
    const busSnap = snap.sections.bus;
    const busLive = busSnap?.status === 'live' && busSnap.data?.searchDate === date ? busSnap.data.fares ?? {} : {};
    for (const b of ground.busLegs) {
      const live = busLive[b.id];
      edges.push({
        mode: 'bus',
        from: b.from,
        to: b.to,
        operator: live ? `${b.operator} (live)` : b.operator,
        hours: live?.hours ?? b.hours,
        costUSD: live ? { min: live.priceUSD, max: live.priceUSD } : b.costUSD,
        seedCostUSD: b.costUSD,
        dataStatus: live ? 'live' : 'estimate',
        bookLink: busLink(b.from, b.to, date),
        notes: b.notes,
        daysPerWeek: b.daysPerWeek,
      });
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

// Booking links are rebuilt per leg, because the day you board leg 4 of a 55-hour
// chain is not the day you started. Award links are undated program search pages.
function bookLinkFor(edge, dateISO) {
  switch (edge.mode) {
    case 'gowild': return searchLink(edge.from, edge.to, dateISO);
    case 'flight': return deepLinks(edge.from, edge.to, dateISO).googleFlights;
    case 'train': return amtrakLink(edge.from, edge.to, dateISO);
    case 'bus': return busLink(edge.from, edge.to, dateISO);
    default: return edge.bookLink ?? null;
  }
}

// Walk an itinerary in time: stamp each leg with the date you actually reach it,
// re-link it to that date, and refuse to call a price "live" when it was fetched
// for a different day. Fares climb toward departure, so a stale price is
// systematically the cheap-looking one - exactly the error that flips a ranking.
export function resolveLegs(legs, startDate) {
  let elapsed = 0;
  return legs.map((leg, i) => {
    if (i > 0) elapsed += transferBuffer(legs[i - 1].mode, leg.mode);
    const dayOffset = Math.floor(elapsed / 24);
    const legDate = startDate ? addDaysISO(startDate, dayOffset) : null;
    elapsed += leg.hours;
    const priceIsForAnotherDay = leg.dataStatus === 'live' && dayOffset > 0;
    return {
      ...leg,
      legDate,
      dayOffset,
      bookLink: legDate ? bookLinkFor(leg, legDate) : leg.bookLink,
      costUSD: priceIsForAnotherDay ? leg.seedCostUSD ?? leg.costUSD : leg.costUSD,
      dataStatus: priceIsForAnotherDay ? 'estimate' : leg.dataStatus,
      priceNote: priceIsForAnotherDay
        ? `live price was checked for ${startDate}; you board this leg ${legDate}, so the estimate range is shown`
        : undefined,
    };
  });
}

// ---- itinerary search ----

export function planReturn({ from = 'SFO', date, to = null, sort = 'time', maxLegs, maxResults, allowModes } = {}) {
  maxLegs = maxLegs ?? config.return.maxLegs;
  maxResults = maxResults ?? config.return.maxResults;

  const destGroups = to
    ? [metro(to)]
    : ['richmond', 'norfolk'];
  const destSet = new Set(destGroups.flatMap((g) => airports.cityGroups[g] ?? [g]));

  const dayName = date ? dayOfWeek(date) : 'that day';
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
      results.push(finishItinerary(legs, node));
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

  // Totals are recomputed from the RESOLVED legs, not from what the search
  // accumulated, because resolution can change a leg's price (a live fare that
  // turns out to belong to a different day falls back to its estimate range).
  function finishItinerary(rawLegs, arrivalNode) {
    const legs = resolveLegs(rawLegs, date);
    let hours = 0;
    let cost = { min: 0, max: 0 };
    let miles = 0;
    legs.forEach((l, i) => {
      if (i > 0) hours += transferBuffer(legs[i - 1].mode, l.mode);
      hours += l.hours;
      cost = addCosts(cost, l.costUSD ?? 0);
      miles += l.miles ?? 0;
    });

    const arrivalMetro = metro(arrivalNode);
    const modes = [...new Set(legs.map((l) => l.mode))];
    // An itinerary is only real if every leg actually operates on the day you
    // would board it. Anything with a leg that definitively does not run gets
    // ranked below everything that does, however fast or cheap it looks.
    const grounded = legs.filter((l) => l.operatesOnDate === false);
    const flyable = grounded.length === 0;
    const blackoutLegs = legs.filter((l) => l.peakDayChargeUSD);

    const badges = [];
    if (legs.every((l) => l.mode === 'gowild' || l.mode === 'transit')) badges.push('all-GoWild');
    if (!flyable) badges.push(grounded[0].notLaunchedUntil ? `route starts ${grounded[0].notLaunchedUntil}` : `no ${dayName} service`);
    if (blackoutLegs.length) badges.push('peak-day-charge');
    if (legs.some((l) => l.daysPerWeek && l.daysPerWeek < 7)) badges.push('not-daily');
    if (miles > 0) badges.push('uses-miles');

    const dayOffset = Math.floor(hours / 24);
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
      // "61h06m" answers the wrong question; "arrive Sun Aug 23 (+3 days)"
      // answers the one the traveler is actually asking.
      arrivalDate: date ? addDaysISO(date, dayOffset) : null,
      daysSpanned: dayOffset,
      flyable,
      groundedLegs: grounded.map((l) => `${l.from}-${l.to}`),
      modes,
      badges,
    };
  }

  dfs(from, [], 0, { min: 0, max: 0 }, 0, new Set([startMetro]), new Set([from]));

  // Rank: prefer fewer legs among near-identical totals; primary sort per flag.
  // Flyable first, always: a 2x-weekly chain that does not run on this date is
  // not a faster option, it is not an option. Then the requested sort.
  const rank = (a, b) =>
    (a.flyable === b.flyable ? 0 : a.flyable ? -1 : 1)
    || (sort === 'cost'
      ? a.sortCost - b.sortCost || a.totalHours - b.totalHours
      : a.totalHours - b.totalHours || a.sortCost - b.sortCost);
  results.sort(rank);

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
  kept.sort(rank);
  return {
    from,
    date,
    sort,
    note: `Sorted by ${sort === 'cost' ? 'cost, then travel time' : 'total travel time, then cost'}. Award miles valued at ${CENTS_PER_MILE}c/mile for cost ranking. Times include transfer buffers, not overnight waits between separately-booked legs.`,
    itineraries: kept,
  };
}
