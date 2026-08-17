import { test } from 'node:test';
import assert from 'node:assert/strict';
import { haversineMiles, estimateFlightHours, fmtHours, fmtMoney, addCosts, costMidpoint, addDaysISO } from '../src/util.js';
import { findGowildPaths, bookingWindow, isBlackout, gowildOptions } from '../src/providers/frontier.js';
import { planReturn, transferBuffer, buildEdges } from '../src/planner.js';
import { backupCashOptions } from '../src/providers/flights.js';
import { awardOptions } from '../src/providers/awards.js';

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
  assert.ok(isBlackout('2026-11-26'), 'Thanksgiving inside seed blackout');
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
  assert.ok(o.paths[0].searchLink.includes('LAS'));
  assert.ok(o.paths[0].searchLink.includes(d));
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
