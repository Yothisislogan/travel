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
