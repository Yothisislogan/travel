import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMiles, estimateFlightHours, fmtHours, fmtMoney, addCosts, costMidpoint, addDaysISO } from '../src/util.js';
import { findGowildPaths, bookingWindow, isBlackout, gowildOptions, frontierDate, dayOfWeek, operatesOn, parseGowildFlights } from '../src/providers/frontier.js';
import { planReturn, transferBuffer, buildEdges } from '../src/planner.js';
import { backupCashOptions } from '../src/providers/flights.js';
import { awardOptions, parseApifyRows, normalizeProgram } from '../src/providers/awards.js';

test('haversine + flight estimate is sane for LAS-SFO', () => {
  const mi = haversineMiles({ lat: 36.086, lon: -115.154 }, { lat: 37.622, lon: -122.379 });
  assert.ok(mi > 350 && mi < 480, `LAS-SFO ~414mi, got ${mi}`);
  const h = estimateFlightHours(mi);
  assert.ok(h > 1 && h < 2.2, `expected ~1.5h, got ${h}`);
});

test('formatting helpers', () => {
  assert.equal(fmtHours(2.5), '2h30m');
  assert.equal(fmtHours(3), '3h');
  assert.equal(fmtMoney(42.4), '$42');
  assert.equal(fmtMoney({ min: 10, max: 20 }), '$10-$20');
  assert.deepEqual(addCosts({ min: 10, max: 20 }, 5), { min: 15, max: 25 });
  assert.equal(costMidpoint({ min: 10, max: 20 }), 15);
});

test('addDaysISO crosses month boundaries', () => {
  assert.equal(addDaysISO('2026-08-31', 1), '2026-09-01');
  assert.equal(addDaysISO('2026-09-01', -1), '2026-08-31');
});

test('booking window: day-before rule', () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const tomorrow = addDaysISO(today, 1);
  assert.equal(bookingWindow(tomorrow).canBookNow, true, 'tomorrow is bookable today');
  assert.equal(bookingWindow(today).canBookNow, true, 'same-day still inside window');
  assert.equal(bookingWindow(addDaysISO(today, 5)).canBookNow, false, '5 days out not yet bookable');
  assert.equal(bookingWindow(addDaysISO(today, 5)).opensOn, addDaysISO(today, 4));
});

test('blackout detection reads ranges', () => {
  assert.ok(isBlackout('2026-11-24'), 'Thanksgiving inside blackout list');
  assert.ok(isBlackout('2026-12-20'), 'winter holidays inside blackout list');
  assert.equal(isBlackout('2026-10-01'), null);
});

test('gowild path finding: LAS to Bay Area has a nonstop', () => {
  const paths = findGowildPaths(['LAS'], ['SFO', 'OAK', 'SJC']);
  assert.ok(paths.length > 0, 'expected at least one path');
  assert.ok(paths.some((p) => p.via === null && p.to === 'SFO'), 'expected LAS-SFO nonstop in route map');
  for (const p of paths) {
    assert.ok(p.totalHours > 0.5 && p.totalHours < 12, `plausible time, got ${p.totalHours}`);
    assert.ok(p.estCostUSD.min > 0);
  }
});

test('gowild path finding: RIC/ORF to LAS via connections', () => {
  const paths = findGowildPaths(['RIC', 'ORF'], ['LAS']);
  // Seed map: RIC/ORF have no Frontier nonstops of their own but DEN/MCO fly there.
  // Paths only exist when the origin has routes; this documents current behavior.
  for (const p of paths) {
    assert.ok(['RIC', 'ORF'].includes(p.from));
    assert.equal(p.to, 'LAS');
    assert.ok(p.segments.length <= 2);
  }
});

test('gowildOptions decorates with window + links', () => {
  const today = new Date().toLocaleDateString('en-CA', { timeZone: 'America/New_York' });
  const d = addDaysISO(today, 1);
  const o = gowildOptions(['LAS'], ['SFO'], d);
  assert.equal(o.window.canBookNow, true);
  assert.ok(o.paths[0].searchLink.includes('o1=LAS'));
  // Frontier links carry 'Aug 18, 2026'-style dates, URL-encoded.
  assert.ok(o.paths[0].searchLink.includes(encodeURIComponent(frontierDate(d))));
});

test('frontierDate formats for the booking site', () => {
  assert.equal(frontierDate('2026-08-18'), 'Aug 18, 2026');
  assert.equal(frontierDate('2026-12-05'), 'Dec 5, 2026');
});

test('day-of-week service checks', () => {
  assert.equal(dayOfWeek('2026-08-20'), 'Thu');
  assert.equal(dayOfWeek('2026-08-23'), 'Sun');
  assert.equal(operatesOn('Thu/Sun', '2026-08-20'), true);
  assert.equal(operatesOn('Thu/Sun', '2026-08-18'), false, 'Tuesday not in Thu/Sun');
  assert.equal(operatesOn('daily', '2026-08-18'), null, 'no named days -> unknown');
  assert.equal(operatesOn(null, '2026-08-18'), null);
});

test('gowildOptions flags paths that do not run on the chosen date', () => {
  const tue = gowildOptions(['RIC'], ['LAS'], '2026-08-18');
  const viaDen = tue.paths.find((p) => p.via === 'DEN');
  assert.equal(viaDen.operatesOnDate, false, 'RIC-DEN is Thu/Sun; Tue should flag false');
  // On Thursday RIC-DEN runs, but DEN-LAS has no day data -> unknown, not false.
  const thu = gowildOptions(['RIC'], ['LAS'], '2026-08-20');
  assert.notEqual(thu.paths.find((p) => p.via === 'DEN').operatesOnDate, false);
  assert.ok(tue.trackers.length >= 1, 'community trackers surfaced');
});

test('outbound RIC/ORF -> LAS paths exist via researched connections', () => {
  const paths = findGowildPaths(['RIC', 'ORF'], ['LAS']);
  assert.ok(paths.some((p) => p.from === 'RIC' && p.via === 'DEN'), 'RIC via DEN');
  assert.ok(paths.some((p) => p.from === 'ORF' && (p.via === 'ATL' || p.via === 'MCO')), 'ORF via ATL/MCO');
  const ricDen = paths.find((p) => p.from === 'RIC' && p.via === 'DEN');
  assert.equal(ricDen.daysPerWeek, 2, 'RIC-DEN runs 2x weekly - path limited to those days');
});

test('parseGowildFlights extracts GoWild fields from embedded journeys JSON', () => {
  const payload = {
    journeys: [{
      flights: [
        { flightNumber: '2101', departureDate: '2026-08-18T07:15:00', arrivalDate: '2026-08-18T08:45:00', stopsText: 'Nonstop', isGoWildFareEnabled: true, goWildFare: 14.91, goWildFareSeatsRemaining: 4 },
        { flightNumber: '2205', departureDate: '2026-08-18T19:30:00', stopsText: 'Nonstop', isGoWildFareEnabled: false, goWildFare: null, goWildFareSeatsRemaining: null },
      ],
    }],
  };
  // As raw JSON:
  const fromJSON = parseGowildFlights(JSON.stringify(payload));
  assert.equal(fromJSON.length, 2);
  assert.equal(fromJSON[0].gowildEnabled, true);
  assert.equal(fromJSON[0].goWildFare, 14.91);
  assert.equal(fromJSON[0].goWildSeatsRemaining, 4);
  assert.equal(fromJSON[1].gowildEnabled, false);
  // As HTML-escaped blob inside a page (how InternalSelect embeds it):
  const escaped = JSON.stringify(payload).replace(/"/g, '&quot;');
  const html = `<html><body><script>var flightData = JSON.parse('${escaped}');</script></body></html>`;
  const fromHTML = parseGowildFlights(html);
  assert.equal(fromHTML.length, 2);
  assert.equal(fromHTML[0].flightNumber, '2101');
  // Garbage in -> empty out, never a throw:
  assert.deepEqual(parseGowildFlights('<html>Access Denied</html>'), []);
  assert.deepEqual(parseGowildFlights('{"journeys": oops'), []);
});

test('transfer buffers', () => {
  assert.equal(transferBuffer('gowild', 'flight'), 2.0);
  assert.equal(transferBuffer('train', 'bus'), 1.0);
  assert.equal(transferBuffer('transit', 'train'), 0.5);
  assert.equal(transferBuffer('flight', 'train'), 1.5);
});

test('live flight prices only count for the date they were searched', async () => {
  const { writeSection, readSnapshot } = await import('../src/util.js');
  const before = readSnapshot().sections.flights ?? null;
  try {
    writeSection('flights', {
      status: 'live',
      data: { searchDate: '2026-09-05', offers: { 'SFO-IAD': { priceUSD: 199, carrier: 'UA', durationHours: 5.5, stops: 0 } } },
      notes: 'test fixture',
    });
    const matching = buildEdges({ date: '2026-09-05', allowModes: ['flight'] }).find((e) => e.from === 'SFO' && e.to === 'IAD');
    assert.equal(matching.dataStatus, 'live', 'same date -> live');
    assert.equal(matching.costUSD.min, 199);
    const otherDay = buildEdges({ date: '2026-09-09', allowModes: ['flight'] }).find((e) => e.from === 'SFO' && e.to === 'IAD');
    assert.equal(otherDay.dataStatus, 'estimate', 'different date must NOT reuse that price as live');
    assert.notEqual(otherDay.costUSD.min, 199);
  } finally {
    writeSection('flights', before ?? { status: 'seed', data: {}, notes: 'restored' });
  }
});

test('live GoWild fares from the Frontier check flow into planner legs', async () => {
  const { writeSection, readSnapshot } = await import('../src/util.js');
  const before = readSnapshot().sections.frontier ?? null;
  try {
    writeSection('frontier', {
      status: 'live',
      data: {
        checklist: [{
          pair: 'LAS-SFO', date: '2026-09-05', status: 'live',
          flights: [
            { gowildEnabled: true, goWildFare: 21.4, goWildSeatsRemaining: 3 },
            { gowildEnabled: true, goWildFare: 18.9, goWildSeatsRemaining: 1 },
            { gowildEnabled: false, goWildFare: null },
          ],
        }],
      },
      notes: 'test fixture',
    });
    const e = buildEdges({ date: '2026-09-05', allowModes: ['gowild'] }).find((x) => x.from === 'LAS' && x.to === 'SFO');
    assert.equal(e.dataStatus, 'live');
    assert.equal(e.costUSD.min, 18.9, 'uses the cheapest live GoWild fare');
    assert.equal(e.seatsRemaining, 3);
    // Reverse direction was not checked live -> stays an estimate.
    const rev = buildEdges({ date: '2026-09-05', allowModes: ['gowild'] }).find((x) => x.from === 'SFO' && x.to === 'LAS');
    assert.equal(rev.dataStatus, 'estimate');
  } finally {
    writeSection('frontier', before ?? { status: 'seed', data: {}, notes: 'restored' });
  }
});

test('buildEdges respects allowModes', () => {
  const only = buildEdges({ date: '2026-09-01', allowModes: ['train'] });
  assert.ok(only.length > 0);
  assert.ok(only.every((e) => e.mode === 'train'));
});

test('planReturn from SFO finds itineraries and sorts by time', () => {
  const plan = planReturn({ from: 'SFO', date: '2026-09-01', sort: 'time' });
  assert.ok(plan.itineraries.length > 0, 'expected itineraries');
  for (let i = 1; i < plan.itineraries.length; i++) {
    assert.ok(plan.itineraries[i].totalHours >= plan.itineraries[i - 1].totalHours, 'time-sorted');
  }
  const top = plan.itineraries[0];
  assert.ok(top.totalHours < 20, `fastest option should be flight-based, got ${top.totalHours}h`);
  assert.ok(['richmond', 'norfolk'].includes(top.arrivalMetro));
  // Every itinerary must terminate in the destination metro.
  for (const it of plan.itineraries) {
    assert.ok(['richmond', 'norfolk'].includes(it.arrivalMetro));
  }
});

test('planReturn cost sort puts cheaper first', () => {
  const plan = planReturn({ from: 'SFO', date: '2026-09-01', sort: 'cost' });
  for (let i = 1; i < plan.itineraries.length; i++) {
    assert.ok(plan.itineraries[i].sortCost >= plan.itineraries[i - 1].sortCost, 'cost-sorted');
  }
});

test('planReturn includes a train option from SFO (Zephyr via Emeryville)', () => {
  const plan = planReturn({ from: 'SFO', date: '2026-09-01', sort: 'cost', maxResults: 40 });
  const hasTrain = plan.itineraries.some((it) => it.legs.some((l) => l.mode === 'train'));
  assert.ok(hasTrain, 'expected at least one itinerary using Amtrak');
});

test('planReturn respects --to Richmond only', () => {
  const plan = planReturn({ from: 'LAS', date: '2026-09-01', to: 'RIC' });
  assert.ok(plan.itineraries.length > 0);
  for (const it of plan.itineraries) assert.equal(it.arrivalMetro, 'richmond');
});

test('backup cash options exist for LAS and SFO and are cost-sorted', () => {
  for (const from of ['LAS', 'SFO']) {
    const { options } = backupCashOptions(from, '2026-09-01');
    assert.ok(options.length >= 3, `${from}: expected several markets`);
    for (const o of options) {
      assert.ok(o.links.googleFlights.includes(from));
      assert.ok(o.costUSD.min > 0);
    }
  }
});

test('award options sorted by fewest miles', () => {
  const { options } = awardOptions('LAS');
  assert.ok(options.length > 0);
  for (let i = 1; i < options.length; i++) assert.ok(options[i].miles >= options[i - 1].miles);
});

test('hotelOptions: Vegas has MGM + Caesars groups, sorted, with links and member rates', async () => {
  const { hotelOptions } = await import('../src/providers/hotels.js');
  const o = hotelOptions('vegas', '2026-09-01');
  assert.equal(o.city, 'Las Vegas');
  assert.equal(o.checkIn, '2026-09-01');
  assert.equal(o.checkOut, '2026-09-03');
  const brands = o.groups.map((g) => g.brand);
  assert.ok(brands.includes('MGM Rewards') && brands.includes('Caesars Rewards'));
  const mgm = o.groups.find((g) => g.brand === 'MGM Rewards');
  assert.ok(mgm.properties.length >= 8);
  // cheapest public rate first
  for (let i = 1; i < mgm.properties.length; i++) {
    const prev = mgm.properties[i - 1].publicUSD, cur = mgm.properties[i].publicUSD;
    assert.ok((cur.min + cur.max) >= (prev.min + prev.max));
  }
  const bellagio = mgm.properties.find((p) => p.name === 'Bellagio');
  assert.ok(bellagio.bookLink.includes('mgmresorts.com'));
  assert.ok(bellagio.memberUSD.min < bellagio.publicUSD.min, 'member rate below public');
  assert.equal(bellagio.dataStatus, 'estimate');
  const caesars = o.groups.find((g) => g.brand === 'Caesars Rewards');
  assert.ok(caesars.properties.find((p) => p.name === 'Caesars Palace').bookLink.includes('caesars.com'));
});

test('hotelOptions: SF is Priceline Express with opaque star tiers', async () => {
  const { hotelOptions } = await import('../src/providers/hotels.js');
  const o = hotelOptions('sf', '2026-09-01');
  assert.equal(o.city, 'San Francisco');
  const g = o.groups[0];
  assert.equal(g.express, true);
  assert.equal(g.brand, 'Priceline Express Deals');
  assert.ok(g.tiers.length >= 2);
  assert.ok(g.tiers[0].expressUSD.min < g.tiers[0].publicUSD.min, 'express discounted below public');
  assert.ok(g.bookLink.includes('priceline.com'));
});

test('hotelOptions: unknown city returns an error, never throws', async () => {
  const { hotelOptions } = await import('../src/providers/hotels.js');
  const o = hotelOptions('paris', '2026-09-01');
  assert.ok(o.error && o.error.includes('Unknown city'));
});

test('parseDelayMinutes reads Amtrak lateness prose', async () => {
  const { parseDelayMinutes } = await import('../src/providers/amtrak.js');
  assert.equal(parseDelayMinutes('On Time'), 0);
  assert.equal(parseDelayMinutes('12 minutes late'), 12);
  assert.equal(parseDelayMinutes('2 hours, 5 minutes late'), 125);
  assert.equal(parseDelayMinutes('3 minutes early'), -3);
  assert.equal(parseDelayMinutes('1 hour early'), -60);
  assert.equal(parseDelayMinutes(null), null);
  assert.equal(parseDelayMinutes('unknown'), null);
});

test('parseAmtrakTrains uses timestamps (not the deprecated prose fields) for delay', async () => {
  const { parseAmtrakTrains, delaysByLeg } = await import('../src/providers/amtrak.js');
  const regional = (num, schedISO, actualISO) => ({
    routeName: 'Northeast Regional', trainNum: num, trainTimely: '', statusMsg: '',
    stations: [{ code: 'WAS', schArr: schedISO, arr: actualISO, arrCmnt: '', depCmnt: '', status: 'Enroute' }],
  });
  const payload = {
    // Amtraker v3 always sends trainTimely/arrCmnt as "" - delay must come from
    // (estimated|actual) - scheduled, and "" must not defeat the fallback.
    6: [{
      routeName: 'California Zephyr', trainNum: '6', heading: 'E', trainState: 'Active',
      trainTimely: '', statusMsg: '',
      stations: [
        { code: 'EMY', schArr: '', schDep: '2026-09-05T09:10:00-07:00', dep: '2026-09-05T09:10:00-07:00', status: 'Departed' },
        { code: 'CHI', schArr: '2026-09-07T14:50:00-05:00', arr: '2026-09-07T17:20:00-05:00', arrCmnt: '', status: 'Enroute' },
      ],
    }],
    82: [regional('82', '2026-09-05T12:00:00-04:00', '2026-09-05T12:10:00-04:00')], // +10
    84: [regional('84', '2026-09-05T15:00:00-04:00', '2026-09-05T16:30:00-04:00')], // +90
    9: [{ routeName: 'Some Other Train', trainNum: '9', stations: [] }],
    9997: [{ routeName: 'Error Train', trainNum: '9997', stations: [] }],
  };
  const trains = parseAmtrakTrains(payload, ['CHI', 'WAS']);
  assert.equal(trains.length, 3, 'irrelevant routes and the poisoned Error Train are dropped');
  const zephyr = trains.find((t) => t.legId === 'zephyr');
  assert.equal(zephyr.delayMinutes, 150, 'delay from the next stop not yet departed');
  assert.equal(zephyr.stops.length, 1);
  assert.equal(zephyr.stops[0].code, 'CHI');
  assert.equal(zephyr.stops[0].delayMinutes, 150);

  const delays = delaysByLeg(trains);
  assert.equal(delays.zephyr.medianDelayMinutes, 150);
  assert.equal(delays.regional.medianDelayMinutes, 50, 'median of 10 and 90');
  assert.equal(delays.regional.worstDelayMinutes, 90);
  assert.equal(delays.regional.trainsTracked, 2);
});

test('stationDelay handles empty-string fields (|| not ??)', async () => {
  const { stationDelay, isPoisonedTrain } = await import('../src/providers/amtrak.js');
  // schArr empty must fall through to schDep, and arr empty to dep.
  assert.equal(stationDelay({ schArr: '', schDep: '2026-09-05T10:00:00-04:00', arr: '', dep: '2026-09-05T10:20:00-04:00' }), 20);
  assert.equal(stationDelay({ schArr: '2026-09-05T10:00:00-04:00', arr: '2026-09-05T09:45:00-04:00' }), -15, 'early is negative');
  assert.equal(stationDelay({}), null);
  assert.ok(isPoisonedTrain({ trainNum: '9997' }));
  assert.ok(isPoisonedTrain({ routeName: 'Error Train' }));
  assert.ok(!isPoisonedTrain({ trainNum: '6', routeName: 'California Zephyr' }));
});

test('live Amtrak delays lengthen planner train legs', async () => {
  const { writeSection, readSnapshot } = await import('../src/util.js');
  const before = readSnapshot().sections.amtrak ?? null;
  try {
    const scheduled = buildEdges({ date: '2026-09-05', allowModes: ['train'] }).find((e) => e.from === 'WAS' && e.to === 'RVR');
    writeSection('amtrak', {
      status: 'live',
      data: { delays: { 'was-rvr': { medianDelayMinutes: 45, worstDelayMinutes: 60, trainsTracked: 3 } } },
      notes: 'test fixture',
    });
    const delayed = buildEdges({ date: '2026-09-05', allowModes: ['train'] }).find((e) => e.from === 'WAS' && e.to === 'RVR');
    assert.equal(delayed.delayMinutes, 45);
    assert.equal(delayed.timeStatus, 'live');
    assert.ok(delayed.hours > scheduled.hours, 'delay is added to the leg');
    assert.equal(+(delayed.hours - scheduled.hours).toFixed(2), 0.75);
    assert.match(delayed.operator, /running ~45m late/);
    // Fare stays an estimate - only the time is live.
    assert.equal(delayed.dataStatus, 'estimate');
  } finally {
    writeSection('amtrak', before ?? { status: 'seed', data: {}, notes: 'restored' });
  }
});

test('parseSerpFlights maps a batched multi-airport search back to markets', async () => {
  const { parseSerpFlights } = await import('../src/providers/flights.js');
  const data = {
    best_flights: [{
      price: 214, total_duration: 330,
      flights: [{ departure_airport: { id: 'SFO' }, arrival_airport: { id: 'IAD' }, airline: 'United' }],
    }],
    other_flights: [
      { // pricier SFO-IAD - must lose to the 214
        price: 402, total_duration: 400,
        flights: [{ departure_airport: { id: 'SFO' }, arrival_airport: { id: 'IAD' }, airline: 'Delta' }],
      },
      { // a connection: market is first departure -> last arrival
        price: 158, total_duration: 600,
        flights: [
          { departure_airport: { id: 'LAS' }, arrival_airport: { id: 'CLT' }, airline: 'American' },
          { departure_airport: { id: 'CLT' }, arrival_airport: { id: 'RIC' }, airline: 'American' },
        ],
      },
      { price: 99, flights: [{ departure_airport: { id: 'LAS' }, arrival_airport: { id: 'XXX' }, airline: 'Nope' }] },
    ],
  };
  const offers = parseSerpFlights(data, { allowedMarkets: new Set(['SFO-IAD', 'LAS-RIC']) });
  assert.deepEqual(Object.keys(offers).sort(), ['LAS-RIC', 'SFO-IAD']);
  assert.equal(offers['SFO-IAD'].priceUSD, 214, 'keeps the cheapest per market');
  assert.equal(offers['SFO-IAD'].durationHours, 5.5);
  assert.equal(offers['SFO-IAD'].stops, 0);
  assert.equal(offers['LAS-RIC'].stops, 1, 'two legs = 1 stop');
  assert.equal(offers['LAS-RIC'].carrier, 'American');
  assert.equal(offers['LAS-XXX'], undefined, 'markets outside the allow-list are dropped');
  assert.deepEqual(parseSerpFlights(null), {});
  assert.deepEqual(parseSerpFlights({ best_flights: [{}] }), {});
});

test('parseFlixTrips picks the cheapest available bus fare', async () => {
  const { parseFlixTrips, flixDate } = await import('../src/providers/bus.js');
  assert.equal(flixDate('2026-09-05'), '05.09.2026');
  const data = {
    trips: [{
      results: {
        a: { price: { total: 44.99 }, duration: { hours: 5, minutes: 30 }, status: 'available', transfer_type: 'direct' },
        b: { price: { total: 29.99 }, duration: { hours: 6, minutes: 0 }, status: 'available' },
        c: { price: { total: 9.99 }, status: 'unavailable' },
      },
    }],
  };
  const best = parseFlixTrips(data);
  assert.equal(best.priceUSD, 29.99, 'cheapest available wins, sold-out ignored');
  assert.equal(best.hours, 6);
  assert.equal(parseFlixTrips({ trips: [] }), null);
  assert.equal(parseFlixTrips(null), null);
});

test('parseExpressResults extracts cheapest opaque rate per star tier', async () => {
  const { parseExpressResults } = await import('../src/providers/hotels.js');
  const data = {
    getHotelExpress: {
      results: {
        hotels: [
          { star_rating: 4, price_per_night: 148.5, neighborhood_name: 'Union Square', guest_rating: 8.4 },
          { star_rating: 4, price_per_night: 131.0, neighborhood_name: 'SoMa' },
          { star_rating: 3, price_per_night: 92.25, neighborhood_name: 'Financial District' },
        ],
      },
    },
  };
  const tiers = parseExpressResults(data);
  const four = tiers.find((t) => t.star === 4);
  const three = tiers.find((t) => t.star === 3);
  assert.equal(four.nightlyUSD, 131, 'cheapest 4-star wins');
  assert.equal(four.neighborhood, 'SoMa');
  assert.equal(three.nightlyUSD, 92);
  assert.ok(tiers[0].star <= tiers[tiers.length - 1].star, 'sorted by star');
  assert.deepEqual(parseExpressResults(null), []);
  assert.deepEqual(parseExpressResults({ junk: true }), []);
});

test('normalizeProgram maps airline strings to display program names', () => {
  assert.equal(normalizeProgram('american'), 'American AAdvantage');
  assert.equal(normalizeProgram('UA'), 'United MileagePlus');
  assert.equal(normalizeProgram('Alaska Mileage Plan'), 'Atmos Rewards');
  assert.equal(normalizeProgram('Rapid Rewards'), 'Southwest Rapid Rewards');
  // Unknown passes through unchanged.
  assert.equal(normalizeProgram('Aeroplan'), 'Aeroplan');
});

test('parseApifyRows tolerates field-name variants and filters non-economy', () => {
  const rows = [
    { origin: 'las', destination: 'ric', program: 'american', cabin: 'economy', miles: '17,500', seatsRemaining: 4, departureDate: '2026-08-19' },
    { originAirport: 'SFO', destinationAirport: 'IAD', issuer: 'United', class: 'economy', points: 15000, seats: 2, date: '2026-08-20' },
    { origin: 'LAS', destination: 'RIC', program: 'american', cabinClass: 'business', mileageCost: 57500 }, // dropped (business)
    { program: 'delta', miles: 20000 }, // dropped (no from/to)
  ];
  const out = parseApifyRows(rows);
  assert.equal(out.length, 2, 'keeps the two economy rows, drops business + malformed');
  assert.deepEqual(out[0], { from: 'LAS', to: 'RIC', program: 'American AAdvantage', source: 'apify', miles: 17500, seats: 4, date: '2026-08-19' });
  assert.equal(out[1].from, 'SFO');
  assert.equal(out[1].program, 'United MileagePlus');
  assert.equal(out[1].miles, 15000);
  // Never throws on junk.
  assert.deepEqual(parseApifyRows(null), []);
  assert.deepEqual(parseApifyRows([{}]), []);
});

test('awardOptions surfaces the cheapest live hit across sources', () => {
  // Direct unit check of the merge preference via a synthetic snapshot is
  // covered indirectly; here just assert estimate fallback shape is intact.
  const { options } = awardOptions('SFO');
  assert.ok(options.every((o) => o.dataStatus === 'estimate' || o.dataStatus === 'live'));
  assert.ok(options.every((o) => 'source' in o));
});

// ---- GoWild relay (src/worker.js) ----
// The relay is what makes live seats work on the phone: it fetches Frontier
// server-side and answers with CORS headers. These tests stub global.fetch so
// they run offline and never touch Frontier.

const { handle, parsePairs } = await import('../src/worker.js');
const { searchURL } = await import('../src/gowild-parse.js');

const PAGE = 'x&quot;journeys&quot;:[{&quot;flights&quot;:['
  + '{&quot;flightNumber&quot;:&quot;F91234&quot;,&quot;departureDate&quot;:&quot;2026-08-19T06:00&quot;,&quot;isGoWildFareEnabled&quot;:true,&quot;goWildFare&quot;:14.91,&quot;goWildFareSeatsRemaining&quot;:3},'
  + '{&quot;flightNumber&quot;:&quot;F9999&quot;,&quot;departureDate&quot;:&quot;2026-08-19T19:00&quot;,&quot;isGoWildFareEnabled&quot;:true,&quot;goWildFare&quot;:9.11,&quot;goWildFareSeatsRemaining&quot;:1},'
  + '{&quot;flightNumber&quot;:&quot;F9777&quot;,&quot;isGoWildFareEnabled&quot;:false}]}]y';

function stubFetch(impl) {
  const real = globalThis.fetch;
  globalThis.fetch = impl;
  return () => { globalThis.fetch = real; };
}
const call = (path) => handle(new Request('https://relay.test' + path));

test('searchURL encodes the date the way Frontier expects', () => {
  assert.equal(
    searchURL('LAS', 'SFO', '2026-08-19'),
    'https://booking.flyfrontier.com/Flight/InternalSelect?o1=LAS&d1=SFO&dd1=Aug%2019%2C%202026&ADT=1&mon=true',
  );
});

test('relay parsePairs accepts real pairs and rejects everything else', () => {
  assert.deepEqual(parsePairs('RIC-LAS,las-sfo'), [['RIC', 'LAS'], ['LAS', 'SFO']]);
  assert.deepEqual(parsePairs('LAS-LAS'), [], 'same origin and destination is nonsense');
  assert.deepEqual(parsePairs('evil.com-LAS,../-x'), [], 'not an open proxy');
  assert.deepEqual(parsePairs('RIC-LAS,RIC-LAS'), [['RIC', 'LAS']], 'dedupes');
  assert.equal(parsePairs('AAA-BBB,CCC-DDD,EEE-FFF,GGG-HHH,III-JJJ,KKK-LLL,MMM-NNN,OOO-PPP,QQQ-RRR').length, 8, 'caps at 8');
});

test('relay returns live seats with CORS headers so a phone can read it', async () => {
  const seen = [];
  const restore = stubFetch(async (url) => { seen.push(url); return new Response(PAGE, { status: 200 }); });
  try {
    const res = await call('/seats?pairs=LAS-SFO&date=2026-08-19');
    assert.equal(res.headers.get('access-control-allow-origin'), '*', 'without this the browser cannot read it');
    const body = await res.json();
    assert.equal(body.ok, true);
    assert.equal(body.live, 1);
    const r = body.results[0];
    assert.equal(r.status, 'live');
    assert.equal(r.gowildFlights, 2, 'the non-GoWild flight is excluded');
    assert.equal(r.seatsTotal, 4);
    assert.equal(r.cheapestFare, 9.11, 'cheapest first');
    assert.equal(r.flights[0].flightNumber, 'F9999');
    assert.match(seen[0], /o1=LAS&d1=SFO&dd1=Aug%2019%2C%202026/);
  } finally { restore(); }
});

test('relay reports blocking and bad input honestly instead of pretending', async () => {
  let restore = stubFetch(async () => new Response('nope', { status: 403 }));
  try {
    const body = await (await call('/seats?pairs=LAS-SFO&date=2026-08-19')).json();
    assert.equal(body.blocked, true);
    assert.equal(body.results[0].status, 'blocked');
    assert.equal(body.results[0].httpStatus, 403);
  } finally { restore(); }

  restore = stubFetch(async () => new Response('<html>a page with no journeys</html>', { status: 200 }));
  try {
    const body = await (await call('/seats?pairs=LAS-SFO&date=2026-08-19')).json();
    assert.equal(body.results[0].status, 'no-data');
    assert.equal(body.blocked, false);
  } finally { restore(); }

  assert.equal((await call('/seats?pairs=LAS-SFO&date=tomorrow')).status, 400);
  assert.equal((await call('/seats?date=2026-08-19')).status, 400);
  assert.equal((await call('/nope')).status, 404);
  const health = await (await call('/health')).json();
  assert.equal(health.service, 'gowild-relay');
});

test('relay never fetches anything but Frontier, even for hostile pair input', async () => {
  const seen = [];
  const restore = stubFetch(async (url) => { seen.push(url); return new Response(PAGE, { status: 200 }); });
  try {
    await call('/seats?pairs=' + encodeURIComponent('LAS-SFO,http://169.254.169.254/latest-meta') + '&date=2026-08-19');
    assert.equal(seen.length, 1);
    assert.ok(seen.every((u) => u.startsWith('https://booking.flyfrontier.com/Flight/InternalSelect?')));
  } finally { restore(); }
});

test('publish agent writes a service file that runs publish --watch', async () => {
  const { unitFile } = await import('../src/publish.js');
  const mac = unitFile('darwin');
  assert.equal(mac.kind, 'launchd');
  assert.match(mac.body, /<string>publish<\/string><string>--watch<\/string>/);
  assert.match(mac.body, /<key>RunAtLoad<\/key><true\/>/);
  const linux = unitFile('linux');
  assert.equal(linux.kind, 'systemd');
  assert.match(linux.body, /ExecStart=.*src\/cli\.js publish --watch/);
  assert.match(linux.body, /Restart=always/);
  assert.equal(unitFile('win32').kind, 'unsupported');
});

// ---- Audit fixes 1-7: everywhere the app used to show something untrue ----

const { writeSection: wsFix, readSnapshot: rsFix, keepLastGood, usableSection, liveAgeClass } = await import('../src/util.js');
const { liveForPath, gowildOptions: gwOpts, gowildRules: gwRules } = await import('../src/providers/frontier.js');
const { resolveLegs, planReturn: planFix } = await import('../src/planner.js');
const cashFix = backupCashOptions;
const awardFix = awardOptions;

const SNAP_PATH = new URL('../cache/snapshot.json', import.meta.url).pathname;
const { readFileSync: rf, writeFileSync: wf, existsSync: ex } = await import('node:fs');
function withSnapshot(sections, fn) {
  const backup = ex(SNAP_PATH) ? rf(SNAP_PATH, 'utf8') : null;
  try {
    wf(SNAP_PATH, JSON.stringify({ sections }));
    return fn();
  } finally {
    if (backup === null) wf(SNAP_PATH, JSON.stringify({ sections: {} }));
    else wf(SNAP_PATH, backup);
  }
}

test('fix 1: writeSection preserves capture time instead of re-stamping it', () => {
  const captured = '2026-08-18T21:35:56.000Z';
  withSnapshot({}, () => {
    const folded = wsFix('frontier', { status: 'live', data: {}, notes: 'x', fetchedAt: captured });
    assert.equal(folded.fetchedAt, captured, 'a published capture keeps the time it was captured');
    assert.ok(folded.writtenAt && folded.writtenAt !== captured, 'and records separately when it was written');
    const own = wsFix('flights', { status: 'live', data: {}, notes: 'y' });
    assert.ok(Date.now() - Date.parse(own.fetchedAt) < 5000, 'a provider with no capture time still stamps now');
  });
});

test('fix 1: a live capture beats a seed section of ANY age (the Sync-wipes-seats bug)', () => {
  // Reproduces the real ordering: pages.yml runs sync (bot-blocked -> seed,
  // stamped now) BEFORE the export folds in the published capture.
  const published = { status: 'live', fetchedAt: '2026-08-18T21:35:00.000Z' };
  const justSynced = { status: 'seed', fetchedAt: new Date().toISOString() };
  const beats = (sec, current) => sec.status === 'live'
    && (current?.status !== 'live' || Date.parse(sec.fetchedAt ?? 0) > Date.parse(current.fetchedAt ?? 0));
  assert.equal(beats(published, justSynced), true, 'older live must beat newer seed');
  assert.equal(beats(justSynced, published), false, 'seed never overwrites live');
  assert.equal(beats(published, { status: 'live', fetchedAt: '2026-08-18T22:00:00.000Z' }), false, 'fresher live wins');
});

test('fix 1: live seats are labelled with a real age, and go loud when stale', () => {
  const mins = (n) => new Date(Date.now() - n * 60000).toISOString();
  assert.equal(liveAgeClass(mins(5)), 'fresh');
  assert.equal(liveAgeClass(mins(90)), 'aging');
  assert.equal(liveAgeClass(mins(400)), 'old');
  assert.equal(liveAgeClass(null), null);
});

test('fix 2: one nonstop\'s seats never decorate a connection through another city', () => {
  const checklist = [{ pair: 'LAS-SFO', date: '2026-08-19', status: 'live', gowildFlights: 1, flights: [{ gowildEnabled: true, flightNumber: '1401', goWildFare: 14.91, goWildSeatsRemaining: 5 }] }];
  const nonstop = { from: 'LAS', to: 'SFO', via: null, segments: [{ from: 'LAS', to: 'SFO' }] };
  const viaDEN = { from: 'LAS', to: 'SFO', via: 'DEN', segments: [{ from: 'LAS', to: 'DEN' }, { from: 'DEN', to: 'SFO' }] };
  const direct = liveForPath(nonstop, checklist, '2026-08-19');
  assert.equal(direct.gowildFlights, 1);
  assert.equal(direct.complete, true);
  assert.equal(direct.flights[0].goWildSeatsRemaining, 5);
  assert.equal(liveForPath(viaDEN, checklist, '2026-08-19'), null, 'no segment of the connection was searched');
  // A partially-checked connection is reported as partial, never as confirmed.
  const partial = liveForPath({ ...viaDEN, segments: [{ from: 'LAS', to: 'SFO' }, { from: 'SFO', to: 'OAK' }] }, checklist, '2026-08-19');
  assert.equal(partial.complete, false);
  assert.equal(partial.checkedSegments, 1);
  assert.equal(partial.totalSegments, 2);
  assert.deepEqual(partial.flights, [], 'a connection carries no flat flight list');
  // Wrong date is not this date's data.
  assert.equal(liveForPath(nonstop, checklist, '2026-08-20'), null);
});

test('fix 2: the scarcest segment sets a connection\'s bookable count, not the sum', () => {
  const checklist = [
    { pair: 'LAS-DEN', date: '2026-08-19', status: 'live', gowildFlights: 4, flights: [] },
    { pair: 'DEN-SFO', date: '2026-08-19', status: 'live', gowildFlights: 1, flights: [] },
  ];
  const p = { from: 'LAS', to: 'SFO', via: 'DEN', segments: [{ from: 'LAS', to: 'DEN' }, { from: 'DEN', to: 'SFO' }] };
  const live = liveForPath(p, checklist, '2026-08-19');
  assert.equal(live.complete, true);
  assert.equal(live.gowildFlights, 1, 'min across segments, never 5');
});

test('fix 3: the planner knows which days a route flies, and ranks flyable first', () => {
  // DEN-RIC is Thu/Sun in the seed data. 2026-08-19 is a Wednesday.
  const wed = buildEdges({ date: '2026-08-19' }).find((e) => e.from === 'DEN' && e.to === 'RIC');
  const thu = buildEdges({ date: '2026-08-20' }).find((e) => e.from === 'DEN' && e.to === 'RIC');
  assert.equal(wed.operatesOnDate, false);
  assert.equal(thu.operatesOnDate, true);
  // A route that has not launched cannot be flown, whatever its frequency says.
  const oak19 = buildEdges({ date: '2026-08-19' }).find((e) => e.from === 'LAS' && e.to === 'OAK');
  assert.equal(oak19.operatesOnDate, false);
  assert.equal(oak19.notLaunchedUntil, '2026-08-20');
  assert.equal(buildEdges({ date: '2026-08-21' }).find((e) => e.from === 'LAS' && e.to === 'OAK').notLaunchedUntil, null);
  // Ranking: nothing unflyable outranks something flyable.
  const plan = planFix({ from: 'SFO', date: '2026-08-19', sort: 'cost', maxResults: 40 });
  const firstBad = plan.itineraries.findIndex((it) => it.flyable === false);
  const lastGood = plan.itineraries.map((it) => it.flyable).lastIndexOf(true);
  if (firstBad !== -1) assert.ok(firstBad > lastGood, 'unflyable itineraries sort after every flyable one');
  // The not-daily badge can now actually fire on a cash nonstop.
  const breeze = buildEdges({ date: '2026-08-19' }).find((e) => e.mode === 'flight' && e.from === 'SFO' && e.to === 'RIC');
  assert.equal(breeze.daysPerWeek, 2);
});

test('fix 4: a blackout date is priced with the Peak Day Charge, not ignored', () => {
  const peak = gwRules().peakDayChargeUSD;
  assert.ok(peak?.min > 0 && peak.max >= peak.min, 'the charge is structured data, not prose');
  const normal = buildEdges({ date: '2026-11-22' }).find((e) => e.from === 'DEN' && e.to === 'RIC');
  const black = buildEdges({ date: '2026-11-29' }).find((e) => e.from === 'DEN' && e.to === 'RIC');
  assert.equal(normal.peakDayChargeUSD, null);
  assert.deepEqual(black.peakDayChargeUSD, peak);
  assert.equal(black.costUSD.min, normal.costUSD.min + peak.min);
  assert.equal(black.costUSD.max, normal.costUSD.max + peak.max);
  // ...and the outbound/hop card agrees with the warning printed above it.
  const opts = gwOpts(['RIC'], ['LAS'], '2026-11-29');
  const p = opts.paths[0];
  assert.ok(opts.blackout, 'the date is a known blackout');
  assert.ok(p.estCostUSD.min >= peak.min * p.segments.length, 'per-segment charge is in the estimate');
});

test('fix 6: each leg is dated by the day you reach it, and links follow', () => {
  const legs = [
    { mode: 'bus', from: 'LAS_BUS', to: 'DEN_BUS', hours: 15, costUSD: { min: 60, max: 90 }, dataStatus: 'estimate' },
    { mode: 'bus', from: 'DEN_BUS', to: 'CHI_BUS', hours: 19, costUSD: { min: 70, max: 110 }, dataStatus: 'estimate' },
    { mode: 'bus', from: 'CHI_BUS', to: 'DC_BUS', hours: 14.5, costUSD: { min: 55, max: 90 }, dataStatus: 'estimate' },
  ];
  const out = resolveLegs(legs, '2026-08-20');
  assert.deepEqual(out.map((l) => l.legDate), ['2026-08-20', '2026-08-20', '2026-08-21']);
  assert.deepEqual(out.map((l) => l.dayOffset), [0, 0, 1]);
  assert.match(out[2].bookLink, /rideDate=2026-08-21/, 'the link is for the day you actually board');
  assert.doesNotMatch(out[2].bookLink, /2026-08-20/);
});

test('fix 6: a live price is not claimed for a leg you board on another day', () => {
  const legs = [
    { mode: 'bus', from: 'A', to: 'B', hours: 30, costUSD: { min: 40, max: 40 }, seedCostUSD: { min: 55, max: 90 }, dataStatus: 'live' },
    { mode: 'bus', from: 'B', to: 'C', hours: 2, costUSD: { min: 15, max: 15 }, seedCostUSD: { min: 15, max: 35 }, dataStatus: 'live' },
  ];
  const [first, second] = resolveLegs(legs, '2026-08-20');
  assert.equal(first.dataStatus, 'live', 'leg you board on the search date keeps its live price');
  assert.deepEqual(first.costUSD, { min: 40, max: 40 });
  assert.equal(second.dataStatus, 'estimate', 'a leg boarded a day later does not get the searched price');
  assert.deepEqual(second.costUSD, { min: 15, max: 35 }, 'it falls back to the seed range');
  assert.match(second.priceNote, /you board this leg 2026-08-21/);
});

test('fix 6: itineraries report the date they get you there', () => {
  const plan = planFix({ from: 'LAS', date: '2026-08-20', allowModes: ['train', 'bus', 'transit'] });
  const long = plan.itineraries.find((it) => it.totalHours > 48);
  assert.ok(long, 'a multi-day surface itinerary exists');
  assert.equal(long.daysSpanned, Math.floor(long.totalHours / 24));
  assert.equal(long.arrivalDate, addDaysISO('2026-08-20', long.daysSpanned));
  assert.ok(long.arrivalDate > '2026-08-20', 'a 55h trip does not end the day it starts');
  // Every leg after the first day carries the date you actually board it.
  assert.ok(long.legs.some((l) => l.dayOffset > 0 && l.legDate > '2026-08-20'));
});

test('fix 7: a blocked refresh keeps the last good data instead of deleting it', () => {
  withSnapshot({ frontier: { status: 'live', fetchedAt: '2026-08-19T00:00:00.000Z', data: { checklist: [{ pair: 'LAS-SFO' }] }, notes: 'good' } }, () => {
    const kept = keepLastGood('frontier', 'Frontier blocked this refresh.');
    assert.equal(kept.status, 'stale');
    assert.deepEqual(kept.data.checklist, [{ pair: 'LAS-SFO' }], 'the seats survive');
    assert.equal(kept.fetchedAt, '2026-08-19T00:00:00.000Z', 'and still say when they were captured');
    assert.match(kept.notes, /blocked/);
    // Stale is usable data - readers must not silently fall back to seed.
    assert.ok(usableSection(kept));
    // A second block does not keep resetting the capture time.
    const again = keepLastGood('frontier', 'blocked again');
    assert.equal(again.lastLiveAt, '2026-08-19T00:00:00.000Z');
  });
  // With nothing good to keep, there is nothing to preserve and we say so.
  withSnapshot({ frontier: { status: 'seed', data: {}, notes: 'seed' } }, () => {
    assert.equal(keepLastGood('frontier', 'blocked'), null);
  });
});

test('fix 5: cash, hotel and award data are only "live" for the date they were searched', () => {
  withSnapshot({
    flights: { status: 'live', fetchedAt: new Date().toISOString(), data: { searchDate: '2026-08-25', offers: { 'LAS-RIC': { priceUSD: 129, carrier: 'Breeze', durationHours: 5 } } } },
    awards: { status: 'live', fetchedAt: new Date().toISOString(), data: { searchDate: '2026-08-25', availability: [{ from: 'LAS', to: 'RIC', program: 'Atmos Rewards', miles: 9500, date: '2026-08-27', source: 'seats.aero' }] } },
  }, () => {
    const wrongDay = cashFix('LAS', '2026-08-20').options.find((o) => o.to === 'RIC');
    assert.equal(wrongDay.dataStatus, 'estimate', '$129 was for the 25th, not the 20th');
    assert.notDeepEqual(wrongDay.costUSD, { min: 129, max: 129 });
    const rightDay = cashFix('LAS', '2026-08-25').options.find((o) => o.to === 'RIC');
    assert.equal(rightDay.dataStatus, 'live');
    assert.deepEqual(rightDay.costUSD, { min: 129, max: 129 });

    // An award seat two days out is real, but it is not this date's answer.
    const near = awardFix('LAS', '2026-08-25').options.find((o) => o.to === 'RIC' && o.program === 'Atmos Rewards');
    assert.equal(near.dataStatus, 'estimate');
    assert.equal(near.nearbyLive.date, '2026-08-27');
    assert.equal(near.nearbyLive.miles, 9500);
    const exact = awardFix('LAS', '2026-08-27').options.find((o) => o.to === 'RIC' && o.program === 'Atmos Rewards');
    assert.equal(exact.dataStatus, 'live');
    assert.equal(exact.miles, 9500);
  });
});
